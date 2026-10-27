#!/usr/bin/env node
'use strict';
/**
 * Setup pre-flight: can Node.js verify the HTTPS certificates of the hosts setup downloads from?
 *
 *   node scripts/check-tls.js [--browsers]
 *
 * Checks the npm registry (the one `npm config get registry` answers) and, with --browsers, the host Playwright downloads
 * its browsers from (PLAYWRIGHT_DOWNLOAD_HOST, else cdn.playwright.dev). Exit code 0: fine, or the hosts could not be reached
 * (a proxy, VPN or offline machine is not a certificate problem, and npm may still get through). Exit code 1: a host presents
 * a certificate Node does not trust.
 *
 * The usual cause is a company proxy that re-signs HTTPS traffic with its own root certificate. The fix is to give Node that
 * certificate (NODE_EXTRA_CA_CERTS), never to switch verification off (NODE_TLS_REJECT_UNAUTHORIZED=0 turns it off for every
 * Node program started from that shell, npm included). This script says so, and it checks WITH verification on even when that
 * variable is set, so it tells the truth about the machine rather than about the workaround.
 */
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_BROWSER_HOST = 'https://cdn.playwright.dev';
const PROBE_TIMEOUT_MS = 10_000;

/** Codes OpenSSL/Node report when the chain does not lead to a root Node trusts. */
const UNTRUSTED_ROOT = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);
/** Other certificate problems: a different cause, so the advice about a root certificate does not apply. */
const isCertificateCode = (code) => UNTRUSTED_ROOT.has(code) || /^(CERT_|ERR_TLS_CERT_)/.test(code ?? '');

function registryUrl() {
  const answer = spawnSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const value = answer.status === 0 ? answer.stdout.trim() : '';
  return /^https:\/\//.test(value) ? value : DEFAULT_REGISTRY;
}

/** Resolves to { host, code } where code is undefined when the certificate was accepted (any HTTP answer counts). */
function probe(url) {
  const { origin, host } = new URL(url);
  return new Promise((resolve) => {
    const request = https.request(origin, { method: 'HEAD', timeout: PROBE_TIMEOUT_MS, rejectUnauthorized: true }, (response) => {
      response.resume();
      resolve({ host });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => resolve({ host, code: error.code ?? 'UNKNOWN', message: error.message }));
    request.end();
  });
}

function explain(failures, verificationOff) {
  const lines = [
    '',
    `Setup cannot trust the HTTPS certificate of: ${failures.map((f) => `${f.host} (${f.code})`).join(', ')}.`,
  ];
  if (failures.some((f) => UNTRUSTED_ROOT.has(f.code))) {
    lines.push(
      'This usually means a company proxy re-signs HTTPS traffic with its own root certificate, which Node.js does not know.',
      'Give Node that certificate once, with verification left on:',
      '  1. Get the company root CA certificate as a .pem file (ask IT, or export it from the operating system certificate store).',
      '  2. Point Node and npm at it:',
      '       macOS / Linux:  export NODE_EXTRA_CA_CERTS=/path/to/company-root-ca.pem',
      '       PowerShell:     $env:NODE_EXTRA_CA_CERTS = "C:\\path\\to\\company-root-ca.pem"',
      '       cmd.exe:        set NODE_EXTRA_CA_CERTS=C:\\path\\to\\company-root-ca.pem',
      '     Put it in your shell profile (or the Windows user environment variables) to keep it.',
      '  3. Run setup again.',
      'Node 22.15 or newer can read the operating system certificate store instead: NODE_OPTIONS=--use-system-ca',
      '(https://nodejs.org/en/learn/http/enterprise-network-configuration).',
    );
  } else {
    lines.push('That is a different certificate problem (expired, or issued for another name); a root certificate will not fix it. Ask whoever runs that host or proxy.');
  }
  lines.push(
    verificationOff
      ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set in this shell: certificate checking is OFF for every Node program here, npm included. Unset it once the certificate above is in place.'
      : 'Do not set NODE_TLS_REJECT_UNAUTHORIZED=0: it turns certificate checking off for every Node program started from that shell, npm included.',
  );
  return lines.join('\n');
}

async function main() {
  const targets = [registryUrl()];
  if (process.argv.includes('--browsers')) targets.push(process.env.PLAYWRIGHT_DOWNLOAD_HOST || DEFAULT_BROWSER_HOST);

  const results = await Promise.all(targets.map(probe));
  for (const r of results) {
    if (!r.code) process.stdout.write(`TLS check: ${r.host} - certificate trusted\n`);
    else if (isCertificateCode(r.code)) process.stdout.write(`TLS check: ${r.host} - certificate NOT trusted (${r.code})\n`);
    else process.stdout.write(`TLS check: ${r.host} - not checked, could not connect (${r.code}); a proxy or VPN may be needed\n`);
  }

  const failures = results.filter((r) => r.code && isCertificateCode(r.code));
  if (failures.length === 0) return 0;

  const verificationOff = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
  process.stderr.write(`${explain(failures, verificationOff)}\n`);
  // With verification switched off in this shell, setup would still get through: warn, do not stop someone mid-work.
  return verificationOff ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`TLS check could not run: ${error.message}\n`);
  process.exit(0);
});
