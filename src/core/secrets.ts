import { scrubText } from '@automation/referenced-automation-utils';

/** What a secret is replaced by in every log line, error message, audit record and result. */
export const MASK = '***';

/**
 * Secrets this process knows about (a password read from the configuration is registered by `Credentials`). Anything that writes
 * text for a person to read - an audit record, an error, a process result - passes it through `maskSecrets`, which removes these
 * values wherever they appear in free text. This is the second line of defence: the first is never to put a secret into text.
 */
const known = new Set<string>();
const MIN_REGISTERED_LENGTH = 4;

/**
 * Registers a secret so `maskSecrets` removes it from text. Values shorter than 4 characters are not registered (they would blank
 * out ordinary words in every log line); a secret that short does not belong in a real system anyway.
 */
export function registerSecret(value: string): void {
  if (value.length >= MIN_REGISTERED_LENGTH) known.add(value);
}

/** Forgets every registered secret (tests). */
export function clearRegisteredSecrets(): void {
  known.clear();
}

/** The forms a secret can take when a tool or a log writes it down: as is, URL-encoded, JSON-escaped, base64 of the plain text. */
export function secretVariants(secret: string): string[] {
  if (secret === '') return [];
  const forms = new Set<string>([secret]);
  forms.add(encodeURIComponent(secret));
  forms.add(JSON.stringify(secret).slice(1, -1));
  forms.add(Buffer.from(secret, 'utf8').toString('base64'));
  return [...forms].filter((form) => form !== '');
}

/**
 * Replaces every registered secret and every value in `extra` (any non-empty length - the caller said it is a secret) with `***`,
 * then removes credential-looking text (Bearer tokens, `password=...`, URL passwords) with the shared logger's scrubber.
 */
export function maskSecrets(text: string, extra: readonly string[] = []): string {
  const secrets = [...known, ...extra].flatMap(secretVariants);
  // longest first: a secret that contains another must not be left half-visible
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) out = out.split(secret).join(MASK);
  return scrubText(out);
}

/**
 * For output that was cut at a size limit: a secret may straddle the cut, leaving its first characters at the end of the text.
 * Removes a trailing partial secret (3 or more characters of any secret's start).
 */
export function dropPartialSecretAtEnd(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, out.length); length >= 3; length--) {
      if (out.endsWith(secret.slice(0, length))) {
        out = out.slice(0, out.length - length);
        break;
      }
    }
  }
  return out;
}
