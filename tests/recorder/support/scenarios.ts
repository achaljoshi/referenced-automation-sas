import type { UserAction } from '../../../src/recorder';

/** The people at the keyboard for the two example recordings. The logon values come from the fake program's own account (never written in a file). */
export interface Account {
  user: string;
  password: string;
}

/** Management Console: choose the profile, log on, open the User Manager, create a user. */
export function smcCreateUser(account: Account, profile: string): UserAction[] {
  return [
    { do: 'select', window: '^Connection Profile$', find: profile },
    { do: 'click', window: '^Connection Profile$', find: { name: 'OK', controlType: 'Button' } },
    { do: 'type', window: '^Log On$', find: { name: 'User ID:' }, text: account.user },
    { do: 'type', window: '^Log On$', find: { name: 'Password:' }, text: account.password, commit: 'enter' },
    { do: 'click', window: '^Log On$', find: { name: 'OK', controlType: 'Button' } },
    { do: 'expand', window: '^SAS Management Console$', find: { name: 'Environment Management', controlType: 'TreeItem' } },
    { do: 'select', window: '^SAS Management Console$', find: { name: 'User Manager', controlType: 'TreeItem' } },
    { do: 'click', window: '^SAS Management Console$', find: 'New User...' },
    { do: 'type', window: '^New User Properties$', find: { name: 'Name:' }, text: 'AUTO_demo_user' },
    { do: 'type', window: '^New User Properties$', find: { name: 'Display Name:' }, text: 'AUTO demo user' },
    { do: 'click', window: '^New User Properties$', find: { name: 'OK', controlType: 'Button' } },
  ];
}

/** Enterprise Guide: dismiss the tip, connect and log on, open a project with Ctrl+O, choose a program, run it. */
export function egRunProject(account: Account, profile: string, projectPath: string): UserAction[] {
  return [
    { do: 'click', window: '^Tip of the Day$', find: { name: 'Close', controlType: 'Button' } },
    { do: 'click', window: '^SAS Enterprise Guide$', find: { automationId: 'ConnectButton' } },
    { do: 'select', window: '^Select Profile$', find: profile },
    { do: 'click', window: '^Select Profile$', find: { name: 'OK', controlType: 'Button' } },
    { do: 'type', window: '^SAS Logon$', find: { automationId: 'userIdField' }, text: account.user },
    { do: 'type', window: '^SAS Logon$', find: { automationId: 'passwordField' }, text: account.password, commit: 'enter' },
    { do: 'click', window: '^SAS Logon$', find: { name: 'OK', controlType: 'Button' } },
    { do: 'key', window: 'SAS Enterprise Guide$', keys: 'ctrl+o' },
    { do: 'type', window: '^Open$', find: { automationId: '1148' }, text: projectPath },
    { do: 'click', window: '^Open$', find: { automationId: '1' } },
    { do: 'select', window: 'Sales - SAS Enterprise Guide$', find: 'Summary' },
    { do: 'click', window: 'Sales - SAS Enterprise Guide$', find: { automationId: 'RunButton' } },
  ];
}
