/**
 * The COM class allow-list. The bridge enforces its own copy (given at start with -AllowProgIds, from SAS_COM_PROGIDS) and the
 * TypeScript side checks the same rule before sending, so a refused class fails fast with a clear message - but only the bridge's check
 * is the security boundary: it cannot be widened by a protocol command.
 *
 * A pattern is a ProgID in which `*` matches anything; matching is case-insensitive and whole-name. A ProgID may only contain letters,
 * digits, underscores and dots (so a class cannot be smuggled in as a path, a CLSID or a moniker).
 */
export function isValidProgId(progId: string): boolean {
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(progId);
}

export function isValidProgIdPattern(pattern: string): boolean {
  return /^[A-Za-z0-9_.*]+$/.test(pattern);
}

export function progIdMatches(patterns: readonly string[], progId: string): boolean {
  if (!isValidProgId(progId)) return false;
  return patterns.some((pattern) => {
    if (!isValidProgIdPattern(pattern)) return false;
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`, 'i').test(progId);
  });
}
