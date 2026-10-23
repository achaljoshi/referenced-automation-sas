import { SECRET_WORDS, secretKindOfName, secretKindOfTarget, type SecretKind, type Target } from '../desktop/recording';

export { looksSecretName, secretKindOfName, secretKindOfTarget, SECRET_WORDS, SECRET_WORDS_BY_KIND, wordsOf, type SecretKind } from '../desktop/recording';

/**
 * What a converted test reads instead of a recorded secret, by the kind of field. A recording never contains a secret: the recorder keeps only
 * the fact that something was typed into a secret field, and the converter writes an environment read. The variables are read by the GENERATED
 * test, not by this package; .env.example documents them (section "RECORDER", and the credentials section for SAS_PASSWORD and SAS_USER).
 */
export const SECRET_ENV_VAR: Readonly<Record<SecretKind, string>> = {
  password: 'SAS_PASSWORD',
  pin: 'SAS_PIN',
  otp: 'SAS_OTP',
  token: 'SAS_TOKEN',
  secret: 'SAS_SECRET',
  key: 'SAS_API_KEY',
};

/** What the logon user ID field is read from. */
export const USER_ENV_VAR = 'SAS_USER';

/** What the chosen connection profile is read from, by program. */
export const PROFILE_ENV_VAR: Readonly<Record<string, string>> = { smc: 'SAS_SMC_PROFILE', eg: 'SAS_EG_PROFILE' };

/** The kind of secret a recorded text entry is: its own `secretKind`, else what its control's name says, else password. */
export function secretKindOfEntry(entry: { secret?: boolean; secretKind?: SecretKind; target: Target }): SecretKind | undefined {
  if (entry.secretKind) return entry.secretKind;
  const byName = secretKindOfTarget(entry.target);
  if (byName) return byName;
  return entry.secret ? 'password' : undefined;
}

/** True when `word` is one of the words that make a name a secret's. */
export const isSecretWord = (word: string): boolean => Object.prototype.hasOwnProperty.call(SECRET_WORDS, word.toLowerCase());

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/**
 * Source text that is about to be copied into a comment or a warning (a line of a schedule script, an unsupported statement): string literals on
 * a line that handles a secret - or shaped like one (a JWT, a long token) - become "[REDACTED]".
 */
export function redactSource(text: string): string {
  const secretLine = secretKindOfName(text) !== undefined;
  return text.replace(STRING_LITERAL, (literal) => {
    const value = literal.slice(1, -1);
    if (value === '') return literal;
    const shaped = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value) || /^Bearer\s+\S{8,}/i.test(value) || /^[A-Za-z0-9+/=_-]{24,}$/.test(value);
    return secretLine || shaped ? '"[REDACTED]"' : literal;
  });
}
