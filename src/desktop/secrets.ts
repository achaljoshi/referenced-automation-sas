import type { DesktopCommand } from './types';

/** What replaces a secret wherever text could be written down: logs, dumps, errors, journal entries, evidence metadata. */
export const REDACTED = '[REDACTED]';

/** Names that look like they hold a secret: Password, Kennwort-style labels are not guessed, only the common English words. */
const SECRET_NAME = /passw(or)?d|passphrase|passcode|\bpwd\b|pwd|secret|token|credential|api[ _-]?key|\bpin\b/i;

/** True when a control's name or automation id suggests it holds a secret ("Password:", "txtPassword", "API key"). */
export function looksSecret(...names: Array<string | undefined>): boolean {
  return names.some((name) => name !== undefined && name !== '' && SECRET_NAME.test(name));
}

/**
 * A copy of a command that is safe to log: typed text, keys, COM arguments and values are replaced when the command is marked
 * `secret`. Everything that is logged about a request goes through this function.
 */
export function redactCommand(command: DesktopCommand): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...command };
  if ('secret' in command && command.secret) {
    if ('text' in copy) copy.text = REDACTED;
    if ('keys' in copy) copy.keys = REDACTED;
    if ('value' in copy) copy.value = REDACTED;
    if ('args' in copy && Array.isArray(copy.args)) copy.args = (copy.args as unknown[]).map(() => REDACTED);
  }
  return copy;
}

/** A short text for a log line: `setText e12 "abc"` - and `setText e12 "[REDACTED]"` for a secret. */
export function describeCommand(command: DesktopCommand): string {
  const c = redactCommand(command);
  const parts: string[] = [command.op];
  for (const key of ['ref', 'handle', 'progId', 'method', 'path', 'text', 'keys', 'value', 'args']) {
    if (c[key] !== undefined) parts.push(`${key}=${typeof c[key] === 'string' ? JSON.stringify(c[key]) : JSON.stringify(c[key])}`);
  }
  return parts.join(' ');
}

/** `text` with every given secret value replaced - for an error message that may have been built from user input. */
export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 3) out = out.split(secret).join(REDACTED);
  }
  return out;
}
