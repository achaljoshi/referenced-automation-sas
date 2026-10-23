import * as fs from 'node:fs';
import * as path from 'node:path';

/** Helpers for the static checks of bridge/sas-desktop-bridge.ps1 (it cannot run on this machine: only its text can be tested). */
export const scriptFile = path.resolve(__dirname, '..', '..', 'bridge', 'sas-desktop-bridge.ps1');
export const scriptBytes = (): Buffer => fs.readFileSync(scriptFile);
export const scriptText = (): string => scriptBytes().toString('utf8').replace(/^\uFEFF/, '');

export interface Balance {
  ok: boolean;
  problem?: string;
  /** The text of every here-string, for checking the embedded C# separately. */
  hereStrings: string[];
}

/**
 * A small PowerShell tokenizer: skips comments, single- and double-quoted strings and here-strings, and checks that (), {} and [] are
 * balanced and properly nested in the code that is left. Not a parser; enough to catch a missing brace or an unterminated quote.
 */
export function checkBalanced(text: string): Balance {
  const stack: Array<{ ch: string; line: number }> = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  const hereStrings: string[] = [];
  let i = 0;
  let line = 1;
  const fail = (problem: string): Balance => ({ ok: false, problem: `${problem} (line ${line})`, hereStrings });
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '@' && (text[i + 1] === "'" || text[i + 1] === '"') && /^[ \t]*\r?\n/.test(text.slice(i + 2))) {
      const quote = text[i + 1] as string;
      const close = `\n${quote}@`;
      const end = text.indexOf(close, i + 2);
      if (end < 0) return fail('unterminated here-string');
      const body = text.slice(i + 2, end);
      hereStrings.push(body);
      line += (body.match(/\n/g) ?? []).length + 1;
      i = end + close.length;
      continue;
    }
    if (ch === "'") {
      i++;
      for (;;) {
        if (i >= text.length) return fail("unterminated single-quoted string");
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") break;
        else {
          if (text[i] === '\n') line++;
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      for (;;) {
        if (i >= text.length) return fail('unterminated double-quoted string');
        if (text[i] === '`') i += 2;
        else if (text[i] === '"' && text[i + 1] === '"') i += 2;
        else if (text[i] === '"') break;
        else {
          if (text[i] === '\n') line++;
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') stack.push({ ch, line });
    else if (ch === ')' || ch === '}' || ch === ']') {
      const open = stack.pop();
      if (!open || open.ch !== pairs[ch]) return fail(`unbalanced "${ch}"`);
    }
    i++;
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1] as { ch: string; line: number };
    return { ok: false, problem: `unclosed "${top.ch}" opened on line ${top.line}`, hereStrings };
  }
  return { ok: true, hereStrings };
}

/** The labels of the `switch` in Invoke-Op: the operations the script handles. */
export function dispatchedOps(text: string): string[] {
  const block = /# BEGIN-DISPATCH[^\n]*\n([\s\S]*?)# END-DISPATCH/.exec(text)?.[1] ?? '';
  return [...block.matchAll(/^\s*'([A-Za-z.]+)'\s*\{/gm)].map((m) => m[1] as string);
}

/** The body of one PowerShell function. */
export function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  let began = false;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') {
      depth++;
      began = true;
    } else if (text[i] === '}') depth--;
    if (began && depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`function ${name} is not closed`);
}
