/**
 * The tests under tests/real log on to the REAL SAS programs (smoke) or start the real bridge (conformance). They must never run just
 * because a machine happens to be able to reach a desktop: a plain `npm test` on the Windows WorkSpace would otherwise open Management
 * Console and type a personal login. They run when the person asks for them (`npm run test:conformance`, `npm run test:real-smoke`
 * set SAS_REAL_TESTS=true) or against the stand-in desktop (SAS_DESKTOP_SIMULATOR=true), which is how the pipeline keeps them honest.
 */
export const REAL_TESTS_OPT_IN =
  'the tests of the real SAS programs only run when asked for: use `npm run test:conformance` or `npm run test:real-smoke` (they set SAS_REAL_TESTS=true), or SAS_DESKTOP_SIMULATOR=true to run them against the stand-in desktop';

/** Why a real-system test is skipped, or undefined when it may run. */
export function realTestsSkipReason(facts: { realTests?: string | undefined; simulated: boolean }): string | undefined {
  if (facts.simulated) return undefined;
  return /^(1|true|yes)$/i.test((facts.realTests ?? '').trim()) ? undefined : REAL_TESTS_OPT_IN;
}
