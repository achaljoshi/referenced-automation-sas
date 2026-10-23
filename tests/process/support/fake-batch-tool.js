#!/usr/bin/env node
/* A stand-in for a command-line batch tool: it does what its arguments say, so tests can check exit codes, output, timeouts and
   process-tree kills without SAS. Arguments: key=value tokens, processed in order.
     argv            print the received arguments as JSON
     out=TEXT        write TEXT to stdout        err=TEXT   write TEXT to stderr
     env=NAME        print ENV[NAME]=<value|<unset>>        cwd   print the working directory
     stdin           read standard input and print STDIN[<text>]
     child=FILE      start a descendant that sleeps and write its pid to FILE (its stdio is detached)
     child-inherit=FILE   same, but the descendant keeps this program's stdout open
     ignoreterm      ignore SIGTERM (only SIGKILL ends it)
     big=N           write N bytes of "x" to stdout
     sleep=MS        wait         exit=N   exit with code N
*/
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const tokens = process.argv.slice(2);
if (tokens.includes('ignoreterm')) process.on('SIGTERM', () => undefined);

function startChild(file, inherit) {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)'], { stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'ignore' });
  fs.writeFileSync(file, String(child.pid));
  child.unref();
}

async function main() {
  let code = 0;
  for (const token of tokens) {
    const [key, ...rest] = token.split('=');
    const value = rest.join('=');
    if (key === 'argv') process.stdout.write(`${JSON.stringify(tokens)}\n`);
    else if (key === 'out') process.stdout.write(`${value}\n`);
    else if (key === 'err') process.stderr.write(`${value}\n`);
    else if (key === 'env') process.stdout.write(`ENV[${value}]=${process.env[value] ?? '<unset>'}\n`);
    else if (key === 'cwd') process.stdout.write(`${process.cwd()}\n`);
    else if (key === 'stdin') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      process.stdout.write(`STDIN[${Buffer.concat(chunks).toString('utf8')}]\n`);
    } else if (key === 'child') startChild(value, false);
    else if (key === 'child-inherit') startChild(value, true);
    else if (key === 'big') process.stdout.write('x'.repeat(Number(value)));
    else if (key === 'sleep') await new Promise((resolve) => setTimeout(resolve, Number(value)));
    else if (key === 'exit') code = Number(value);
  }
  process.exitCode = code;
}
main();
