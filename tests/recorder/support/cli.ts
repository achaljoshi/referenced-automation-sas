import { startFakeDesktop } from '../../../src/desktop';
import { runConvertCli as convert, type CliIo } from '../../../src/recorder/cli/convert';
import { runImportCli as importScript } from '../../../src/recorder/cli/importScript';
import { runRecordCli as record } from '../../../src/recorder/cli/record';

/** The command-line tools as functions, with what they print captured. */
function captured(): { io: CliIo; text: () => { out: string; err: string } } {
  let out = '';
  let err = '';
  return { io: { out: (t) => void (out += t), err: (t) => void (err += t) }, text: () => ({ out, err }) };
}

export function runConvertCli(args: string[]): { code: number; out: string; err: string } {
  const c = captured();
  const code = convert(args, c.io);
  return { code, ...c.text() };
}

export function runImportCli(args: string[]): { code: number; out: string; err: string } {
  const c = captured();
  const code = importScript(args, c.io);
  return { code, ...c.text() };
}

export async function runRecordCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const c = captured();
  const code = await record(args, c.io);
  return { code, ...c.text() };
}

/** A fake desktop, to read the account of its fake programs from. */
export const startFakeDesktopForTests = startFakeDesktop;
