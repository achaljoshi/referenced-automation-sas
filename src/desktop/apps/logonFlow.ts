import * as crypto from 'node:crypto';
import { AdapterError, getLogger } from '@automation/referenced-automation-utils';
import { LogonRejected } from '../errors';
import { guarded } from '../guard';
import type { DesktopLocator, WindowLocator } from '../locator';
import { describeScreen } from '../screenHints';
import type { DesktopApp } from '../session';
import { waitUntil, type SasCredentials } from './support';

const log = getLogger('desktop-logon');

/** What an application's logon looks like, as the shared flow needs it. Each app layer fills this from its LOCATORS table. */
export interface LogonFlowSpec {
  app: DesktopApp;
  /** For messages and the guard: 'smc', 'eg'. */
  appName: string;
  credentials: SasCredentials;
  profile?: string;
  timeoutMs: number;
  /** The guard driver name. */
  driver: string;
  profileDialog: WindowLocator;
  logonDialog: WindowLocator;
  errorDialog: WindowLocator;
  profileItem(dialog: WindowLocator, profile: string): DesktopLocator;
  profileOk(dialog: WindowLocator): DesktopLocator;
  userField(dialog: WindowLocator): DesktopLocator;
  passwordField(dialog: WindowLocator): DesktopLocator;
  logonOk(dialog: WindowLocator): DesktopLocator;
  logonCancel(dialog: WindowLocator): DesktopLocator;
  errorOk(dialog: WindowLocator): DesktopLocator;
  /** What a rejected logon says ("Invalid user ID or password", "account is locked"). */
  failureText: RegExp;
  /** The application is logged on and ready (its main window, with its tree, is there). */
  isDone(): Promise<boolean>;
  /** Starts the logon when the application does not show its dialogs by itself (Enterprise Guide: click Connect). */
  trigger?(): Promise<void>;
}

/**
 * Logons that were rejected during this process, by a fingerprint of application + profile + user + password (never the password). A
 * second attempt with the very same credentials is refused here without touching the application: this is the desktop layer's own last
 * line of defence. The cross-run protection (a cooldown that survives a CI re-run) is the logon guard in src/core, which the caller
 * feeds with the LogonRejected error.
 */
const rejected = new Set<string>();

function fingerprint(flow: Pick<LogonFlowSpec, 'appName' | 'profile' | 'credentials'>): string {
  return crypto
    .createHash('sha256')
    .update([flow.appName, flow.profile ?? '', flow.credentials.user.toLowerCase(), flow.credentials.password].join('\n'))
    .digest('hex');
}

/** Forget the rejections of this process (for a fixture that was told by the logon guard that the cooldown is over). */
export function clearRejectedLogons(): void {
  rejected.clear();
}

async function failureMessage(dialog: WindowLocator, pattern: RegExp): Promise<string | undefined> {
  try {
    const texts = await dialog.getByRole('Text').candidates(50);
    return texts.map((t) => t.name).find((name) => pattern.test(name));
  } catch {
    return undefined; // the dialog is not there (or is ambiguous): no message from it
  }
}

/**
 * Runs the logon: chooses the profile, types the user and password, presses OK, and decides what happened.
 *
 *  - accepted: the application's main window is ready -> returns.
 *  - rejected (the application showed a message like "Invalid user ID or password", inline or in a message box): the message box and the
 *    logon dialog are closed so nothing waits for a second try, and LogonRejected is thrown. The credentials are remembered as
 *    rejected for this process and NEVER tried again.
 *  - neither within the timeout: the logon dialog is cancelled and an error is thrown - also without retrying.
 *
 * The password is typed into a secret field: masked in logs, never read back, never in an error.
 */
export async function runLogon(flow: LogonFlowSpec): Promise<void> {
  const { session } = flow.app;
  const key = fingerprint(flow);
  return guarded(session.guard, { driver: flow.driver, operation: 'logon', kind: 'read', target: `${flow.appName} ${flow.profile ?? ''}`.trim() }, async () => {
    if (rejected.has(key)) {
      throw new LogonRejected(flow.appName, flow.credentials.user, flow.profile, 'these credentials were already rejected earlier in this run: not tried again');
    }
    if (await flow.isDone()) return;
    if (flow.trigger && !(await flow.profileDialog.exists()) && !(await flow.logonDialog.exists())) await flow.trigger();

    const deadline = Date.now() + flow.timeoutMs;
    let submitted = false;
    while (Date.now() < deadline) {
      if (submitted) {
        const reason = (await failureMessage(flow.errorDialog, flow.failureText)) ?? (await failureMessage(flow.logonDialog, flow.failureText));
        if (reason !== undefined) {
          rejected.add(key);
          await closeAfterRejection(flow);
          log.warn(`[${flow.appName}] logon of ${flow.credentials.user} was rejected: ${reason} - not retried`);
          throw new LogonRejected(flow.appName, flow.credentials.user, flow.profile, reason);
        }
      }
      if (await flow.isDone()) return;
      if (!submitted) {
        if (await flow.profileDialog.exists()) {
          if (!flow.profile) {
            throw new AdapterError(flow.driver, 'logon', `${flow.appName} asks for a profile but none is configured: set ${flow.appName === 'smc' ? 'SAS_SMC_PROFILE' : 'SAS_EG_PROFILE'} (the profile name exactly as the list shows it)`);
          }
          await flow.profileItem(flow.profileDialog, flow.profile).select();
          await flow.profileOk(flow.profileDialog).click();
          continue;
        }
        if (await flow.logonDialog.exists()) {
          await flow.userField(flow.logonDialog).fill(flow.credentials.user);
          await flow.passwordField(flow.logonDialog).fill(flow.credentials.password, { secret: true });
          submitted = true; // from here on, nothing types a password again
          await flow.logonOk(flow.logonDialog).click({ idleAfter: false }); // the application may be busy logging on: the loop below judges the outcome
          continue;
        }
      }
      await session.pause();
    }
    // Unknown outcome: leave nothing waiting for another try.
    const screen = await describeScreen(session, flow.logonDialog);
    await closeAfterRejection(flow).catch(() => undefined);
    throw new AdapterError(
      flow.driver,
      'logon',
      `${flow.appName} did not finish logging on within ${flow.timeoutMs}ms and showed no message the framework recognises as a rejection. ` +
        `The logon was NOT retried and its dialog was cancelled where the application allowed it. If the credentials were wrong this counts against the account - check them before running again.\n${screen}`,
    );
  });
}

/** Closes a message box and cancels the logon dialog, so the application is not left waiting for a second attempt. */
async function closeAfterRejection(flow: LogonFlowSpec): Promise<void> {
  if (await flow.errorDialog.exists().catch(() => false)) {
    await flow.errorOk(flow.errorDialog).click().catch(() => undefined);
    await waitUntil(flow.app.session, 'the error message to close', async () => ((await flow.errorDialog.exists().catch(() => false)) ? undefined : true), 3_000).catch(() => undefined);
  }
  if (await flow.logonDialog.exists().catch(() => false)) {
    await flow.logonCancel(flow.logonDialog).click().catch(() => undefined);
  }
}
