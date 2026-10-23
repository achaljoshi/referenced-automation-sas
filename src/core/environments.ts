import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSensitiveKey, loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { ConfigurationError, PolicyViolation } from './errors';

/**
 * Named SAS environments. A team declares them ONCE in a committed JSON file (SAS_ENVIRONMENTS_FILE, no secrets) and a run selects
 * one by name (SAS_ENVIRONMENT, default: the ENV name). Each environment has a kind - `nonprod` or `prod` - and an allow-list of
 * host patterns for everything a driver may contact: metadata servers, web addresses, UNC paths. A driver refuses a host that is
 * not on the list of the selected environment.
 *
 * The kind and the hosts come ONLY from the file (or from code that builds a registry), never from an environment variable: a
 * variable in somebody's shell must not be able to turn a production system into a "nonprod" one.
 *
 * File shape:
 *   { "environments": { "dev": { "kind": "nonprod", "hosts": ["sasmeta.dev.example.com", "**.dev.example.com:8561"], "description": "..." } } }
 *
 * Host patterns (case-insensitive, matched against the host name only; a pattern with `:port` also needs that port):
 *   `*`  stands for part of ONE name label (no dots):   `meta-*.dev.example.com` matches `meta-1.dev.example.com`, not `a.b.dev.example.com`
 *   `**` stands for anything including dots:             `**.dev.example.com` matches `a.b.dev.example.com`
 * A pattern must name its domain (`*.corp` and `**.com` are refused as too broad; `*.sas.corp` is fine).
 */

export type EnvironmentKind = 'nonprod' | 'prod';

export interface SasEnvironment {
  readonly name: string;
  readonly kind: EnvironmentKind;
  /** Host patterns a driver may contact in this environment. */
  readonly hosts: readonly string[];
  readonly description?: string;
}

export const DEFAULT_ENVIRONMENTS_FILE = 'env/sas-environments.json';
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** SAS_ENVIRONMENT: the selected environment's name (default: the ENV name, e.g. qa). Lower case. */
export function selectedEnvironmentName(env: ConfigReader = loadEnv()): string {
  const name = env.get('SAS_ENVIRONMENT', env.envName).trim().toLowerCase();
  if (!NAME_PATTERN.test(name))
    throw new ConfigurationError('environment', `SAS_ENVIRONMENT "${name}" is not a valid environment name (letters, digits, "_" and "-", starting with a letter, up to 32 characters)`);
  return name;
}

function validatePattern(pattern: string, where: string): string {
  const text = pattern.trim().toLowerCase();
  const bad = (why: string) => new ConfigurationError('environments', `${where}: host pattern "${pattern}" ${why}`);
  const match = /^([a-z0-9.*_-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) throw bad('is not valid (use letters, digits, ".", "-", "_", "*" and an optional ":port")');
  const labels = (match[1] as string).split('.');
  if (labels.some((label) => label === '')) throw bad('has an empty label (a leading, trailing or doubled ".")');
  const literal = (label: string) => label.replace(/\*/g, '').length;
  if (labels.length === 1) {
    if (literal(labels[0] as string) < 3) throw bad('is too broad: a single name needs at least 3 literal characters');
  } else {
    if (literal(labels[labels.length - 1] as string) !== (labels[labels.length - 1] as string).length)
      throw bad('must end in a literal label (the top-level part cannot be a wildcard)');
    if (labels.filter((label) => literal(label) >= 2).length < 2) throw bad('is too broad: name at least the domain, e.g. "*.sas.corp" (not "*.corp" or "**.com")');
  }
  return text;
}

/** Validates the parsed content of an environments file. Throws ConfigurationError naming the environment and the problem. */
export function parseEnvironments(json: unknown, source = 'environments'): SasEnvironment[] {
  const fail = (message: string) => new ConfigurationError('environments', `${source}: ${message}`);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw fail('expected an object with an "environments" map');
  const map = (json as Record<string, unknown>).environments;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) throw fail('missing the "environments" map');
  const out: SasEnvironment[] = [];
  const seen = new Set<string>();
  for (const [rawName, raw] of Object.entries(map as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) throw fail(`"${rawName}" is not a valid environment name`);
    if (seen.has(name)) throw fail(`environment "${name}" is declared twice`);
    seen.add(name);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail(`environment "${name}" must be an object`);
    const entry = raw as Record<string, unknown>;
    const secretKey = Object.keys(entry).find((key) => isSensitiveKey(key));
    if (secretKey) throw fail(`environment "${name}" has a "${secretKey}" entry: this file is committed and holds no secrets`);
    const unknown = Object.keys(entry).filter((key) => !['kind', 'hosts', 'description'].includes(key));
    if (unknown.length > 0) throw fail(`environment "${name}": unknown entries ${unknown.map((k) => `"${k}"`).join(', ')} (allowed: kind, hosts, description)`);
    if (entry.kind !== 'nonprod' && entry.kind !== 'prod') throw fail(`environment "${name}": "kind" must be exactly "nonprod" or "prod" (found ${JSON.stringify(entry.kind)}) - there is no default, a missing kind must not mean "safe to change"`);
    if (!Array.isArray(entry.hosts) || entry.hosts.length === 0 || entry.hosts.some((h) => typeof h !== 'string'))
      throw fail(`environment "${name}": "hosts" must be a non-empty list of host patterns`);
    const hosts = (entry.hosts as string[]).map((pattern) => validatePattern(pattern, `${source}: environment "${name}"`));
    if (entry.description !== undefined && typeof entry.description !== 'string') throw fail(`environment "${name}": "description" must be text`);
    out.push({ name, kind: entry.kind, hosts, ...(entry.description ? { description: entry.description as string } : {}) });
  }
  return out;
}

export class EnvironmentRegistry {
  private readonly byName = new Map<string, SasEnvironment>();

  constructor(environments: readonly SasEnvironment[]) {
    for (const environment of environments) this.byName.set(environment.name, environment);
  }

  get names(): string[] {
    return [...this.byName.keys()].sort();
  }

  get(name: string): SasEnvironment | undefined {
    return this.byName.get(name.trim().toLowerCase());
  }

  /** The environment, or a PolicyViolation (rule unknown-environment) that says how to declare it. */
  require(name: string, driver = 'sas-core', operation = 'environment'): SasEnvironment {
    const found = this.get(name);
    if (found) return found;
    throw new PolicyViolation(
      'unknown-environment',
      driver,
      operation,
      `environment "${name}" is not declared (declared: ${this.names.join(', ') || 'none'}). A driver never works against an environment it does not know.`,
      `add "${name}" to the environments file (SAS_ENVIRONMENTS_FILE, default ${DEFAULT_ENVIRONMENTS_FILE}) with its kind and host patterns, or set SAS_ENVIRONMENT to a declared name.`,
    );
  }
}

/**
 * Reads SAS_ENVIRONMENTS_FILE (default `env/sas-environments.json`). When the variable is set the file must exist; when it is not
 * set and the default file is absent the registry is empty - which means every environment is "unknown" and every operation is refused.
 */
export function loadEnvironments(env: ConfigReader = loadEnv()): EnvironmentRegistry {
  const configured = env.getOptional('SAS_ENVIRONMENTS_FILE');
  const file = path.resolve(configured ?? DEFAULT_ENVIRONMENTS_FILE);
  if (!fs.existsSync(file)) {
    if (configured !== undefined) throw new ConfigurationError('environments', `SAS_ENVIRONMENTS_FILE points to ${file}, which does not exist`);
    return new EnvironmentRegistry([]);
  }
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigurationError('environments', `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new EnvironmentRegistry(parseEnvironments(json, file));
}

/** The selected environment (SAS_ENVIRONMENT, default ENV) looked up in the registry; PolicyViolation (unknown-environment) when it is not declared. */
export function selectedEnvironment(env: ConfigReader = loadEnv(), registry: EnvironmentRegistry = loadEnvironments(env)): SasEnvironment {
  return registry.require(selectedEnvironmentName(env));
}

// ------------------------------------------------------------------------------------------------------------ host matching

export interface ParsedLocation {
  host: string;
  port?: number;
}

/**
 * The host (and port) a location refers to: a URL, `host`, `host:port`, `host:port/path`, or a UNC path (`\\server\share`, `//server/share`).
 * undefined for anything that is not a network location (a drive path, an empty string, text with spaces or control characters).
 * Parsing is done with the platform URL parser, so `https://allowed.example.com@evil.example.net/` is the host evil.example.net.
 */
export function parseLocation(location: string): ParsedLocation | undefined {
  const text = location.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\s\u0000-\u001f]/.test(text)) return undefined;
  const unc = /^[\\/]{2}([^\\/]+)/.exec(text);
  if (unc) return normalise(unc[1] as string);
  if (/^[a-z]:[\\/]/i.test(text)) return undefined;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const url = new URL(text);
      return url.hostname === '' ? undefined : { host: url.hostname.replace(/\.$/, '').toLowerCase(), ...(url.port ? { port: Number(url.port) } : {}) };
    }
  } catch {
    return undefined;
  }
  const bare = /^([^\s/\\:@?#]+)(?::(\d{1,5}))?(?:[/?#].*)?$/.exec(text);
  if (!bare) return undefined;
  return normalise(`${bare[1]}${bare[2] ? `:${bare[2]}` : ''}`);
}

function normalise(hostAndPort: string): ParsedLocation | undefined {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(hostAndPort);
  if (!match) return undefined;
  const host = (match[1] as string).replace(/\.$/, '').toLowerCase();
  return host === '' ? undefined : { host, ...(match[2] ? { port: Number(match[2]) } : {}) };
}

/** The host name of a location (see parseLocation), or undefined. */
export function hostOf(location: string): string | undefined {
  return parseLocation(location)?.host;
}

/** Does one allow-list pattern match this host (and port)? A pattern without `:port` accepts any port. */
export function hostPatternMatches(pattern: string, location: ParsedLocation): boolean {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(pattern.trim().toLowerCase());
  if (!match) return false;
  if (match[2] !== undefined && Number(match[2]) !== location.port) return false;
  const source = (match[1] as string)
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '[a-z0-9._-]*' : part === '*' ? '[a-z0-9_-]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(location.host);
}

export function isHostAllowed(environment: SasEnvironment, location: string): boolean {
  const parsed = parseLocation(location);
  return parsed !== undefined && environment.hosts.some((pattern) => hostPatternMatches(pattern, parsed));
}

/** Throws PolicyViolation (host-not-allowed) unless the host of `location` is on the environment's allow-list. */
export function assertHostAllowed(environment: SasEnvironment, location: string, who: { driver?: string; operation?: string } = {}): void {
  if (isHostAllowed(environment, location)) return;
  const parsed = parseLocation(location);
  throw new PolicyViolation(
    'host-not-allowed',
    who.driver ?? 'sas-core',
    who.operation ?? 'host-check',
    parsed
      ? `host "${parsed.host}${parsed.port ? `:${parsed.port}` : ''}" is not on the allow-list of environment "${environment.name}" (${environment.kind}); allowed: ${environment.hosts.join(', ')}.`
      : `"${location}" is not a network location whose host can be determined, so it cannot be checked against the allow-list of environment "${environment.name}".`,
    `if the host really belongs to "${environment.name}", add a pattern for it to that environment in the environments file (a reviewed, committed change); otherwise point the run at the right environment (SAS_ENVIRONMENT).`,
  );
}
