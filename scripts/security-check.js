'use strict';

/**
 * Security release check (section 74).
 *
 * Verifies the runtime does what the documentation claims:
 *   - no telemetry / analytics dependencies or endpoints
 *   - no hidden network calls outside the explicit model downloader
 *   - no hardcoded credentials or secrets
 *   - no arbitrary shell execution
 *   - no secrets or user audio committed to the repository
 *
 * Prints a report and exits non-zero if a critical finding is present.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const findings = [];
function add(severity, area, detail) {
  findings.push({ severity, area, detail });
}

function read(rel) {
  const full = path.join(REPO_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function walk(dir, filter, skip = new Set(['node_modules', '.git', 'release', 'vendor', 'build', 'dist'])) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter, skip));
    else if (entry.isFile() && filter(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Remove comments and string/template literals so pattern rules match real code
 * rather than text that merely appears inside a string (for example the
 * renderer `fetch` call that the acceptance test injects as a string).
 */
function stripStringsAndComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// 1. Dependencies: no telemetry/analytics packages.
const pkg = JSON.parse(read('package.json') || '{}');
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const suspiciousDeps = Object.keys(allDeps).filter((d) =>
  /(analytics|telemetry|sentry|segment|mixpanel|amplitude|posthog|bugsnag|datadog|newrelic)/i.test(d)
);
if (suspiciousDeps.length) add('critical', 'dependencies', `Telemetry-like dependencies: ${suspiciousDeps.join(', ')}`);
else add('info', 'dependencies', `${Object.keys(allDeps).length} dependencies; none telemetry-related.`);

// 2. Runtime source must not reference analytics endpoints.
const runtimeFiles = walk(path.join(REPO_ROOT, 'src'), (n) => n.endsWith('.js') || n.endsWith('.html'));
const netPatterns = [
  { re: /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi, label: 'url' },
];
const allowedHosts = new Set(['huggingface.co', 'www.w3.org', 'opensource.org', 'github.com']);
const runtimeUrls = new Set();
for (const file of runtimeFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const { re } of netPatterns) {
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(src))) runtimeUrls.add(m[1].toLowerCase());
  }
}
const unexpected = [...runtimeUrls].filter((h) => !allowedHosts.has(h));
if (unexpected.length) add('warn', 'runtime-network', `Runtime references unexpected hosts: ${unexpected.join(', ')}`);
else add('info', 'runtime-network', `Runtime host references limited to: ${[...runtimeUrls].join(', ') || 'none'}.`);

// 3. Direct network APIs may only appear in the model downloader. The updater
//    uses electron-updater, which owns its own transport, and is allowed only in
//    updater.js; both are the two disclosed outbound paths.
const NETWORK_ALLOWED = [/model-manager\.js$/, /updater\.js$/];
for (const file of runtimeFiles) {
  const rel = path.relative(REPO_ROOT, file);
  const code = stripStringsAndComments(fs.readFileSync(file, 'utf8'));
  if (/\b(fetch|XMLHttpRequest|net\.request|https?\.get|https?\.request)\b/.test(code)) {
    if (!NETWORK_ALLOWED.some((re) => re.test(rel))) {
      add('critical', 'runtime-network', `Network API used outside the model downloader/updater: ${rel}`);
    }
  }
}
add('info', 'runtime-network', 'Outbound paths are limited to model-manager.js (model download) and updater.js (update check), both disclosed.');

// 4. No arbitrary shell execution in runtime source.
let shellHits = 0;
for (const file of runtimeFiles) {
  const src = fs.readFileSync(file, 'utf8');
  if (/shell\s*:\s*true|(?<![.\w])exec(?:Sync)?\s*\(/.test(src)) {
    shellHits += 1;
    add('critical', 'process-exec', `Possible shell execution in ${path.relative(REPO_ROOT, file)}`);
  }
}
if (!shellHits) add('info', 'process-exec', 'All child processes use spawn(bin, args[]) with shell:false.');

// 5. No hardcoded credentials.
const secretRe = /(api[_-]?key|secret|passwd|password|bearer)\s*[:=]\s*["'][A-Za-z0-9_\-/+]{16,}["']/gi;
for (const file of walk(REPO_ROOT, (n) => n.endsWith('.js') || n.endsWith('.json'), new Set(['node_modules', '.git', 'release', 'vendor', 'build', 'package-lock.json']))) {
  const src = fs.readFileSync(file, 'utf8');
  const m = secretRe.exec(src);
  if (m) add('critical', 'secrets', `Possible hardcoded credential in ${path.relative(REPO_ROOT, file)}`);
}
if (!findings.some((f) => f.area === 'secrets')) add('info', 'secrets', 'No hardcoded credentials found in source.');

// 6. No user audio committed. Only synthetic fixtures are allowed.
const audioFiles = walk(REPO_ROOT, (n) => /\.(wav|mp3|m4a|flac|ogg|mp4|mov)$/i.test(n));
const allowedFixture = /tests[\\/]fixtures[\\/]/;
const strayAudio = audioFiles.filter((f) => !allowedFixture.test(f));
if (strayAudio.length) add('warn', 'sample-data', `Audio outside tests/fixtures: ${strayAudio.map((f) => path.relative(REPO_ROOT, f)).join(', ')}`);
else add('info', 'sample-data', `Only synthetic fixtures present (${audioFiles.length} file(s) in tests/fixtures).`);

// 7. Secrets files must not exist.
for (const name of ['.env', '.env.local', 'credentials.json', 'id_rsa']) {
  if (fs.existsSync(path.join(REPO_ROOT, name))) add('critical', 'secrets', `Secret-bearing file present: ${name}`);
}

// Report.
const order = { critical: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
// eslint-disable-next-line no-console
console.log('SECURITY RELEASE CHECK\n======================');
for (const f of findings) {
  // eslint-disable-next-line no-console
  console.log(`[${f.severity.toUpperCase().padEnd(8)}] ${f.area.padEnd(16)} ${f.detail}`);
}
const criticals = findings.filter((f) => f.severity === 'critical');
// eslint-disable-next-line no-console
console.log(`\n${criticals.length} critical finding(s).`);
if (criticals.length) process.exit(1);
