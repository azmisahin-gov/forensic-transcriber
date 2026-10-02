'use strict';

/**
 * Lightweight project linter / static check.
 *
 *  - syntax-checks every JavaScript file with `node --check`
 *  - enforces a few project-specific safety rules that matter for a forensic
 *    desktop tool: no shell execution, no remote code loading, no hardcoded
 *    credentials, no telemetry endpoints.
 *
 * Exits non-zero on any violation so it can gate a build.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts', 'tests'];
const SKIP = new Set(['node_modules', '.git', 'release', 'vendor', 'build']);

const RULES = [
  {
    id: 'no-shell-exec',
    // Matches bare child_process exec/execSync calls, not SQLite's db.exec().
    pattern: /(?<![.\w])exec(?:Sync)?\s*\(|shell\s*:\s*true/,
    message: 'Child processes must be spawned with an argument array, never a shell string.',
    allowFiles: [/scripts[\\/]/],
  },
  {
    id: 'no-eval',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    message: 'Dynamic code evaluation is not permitted.',
  },
  {
    id: 'no-remote-script',
    pattern: /<script[^>]+src\s*=\s*["']https?:/i,
    message: 'The renderer must not load remote scripts.',
  },
  {
    id: 'no-hardcoded-secret',
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i,
    message: 'Possible hardcoded credential.',
    allowFiles: [/tests[\\/]/, /package-lock\.json/],
  },
  {
    id: 'no-telemetry-endpoint',
    pattern: /https?:\/\/(?!huggingface\.co|github\.com|raw\.githubusercontent\.com|static\.rust-lang\.org|docs\.|localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i,
    message: 'Unexpected remote endpoint (telemetry/analytics are not permitted at runtime).',
    allowFiles: [/tests[\\/]/, /docs[\\/]/, /site[\\/]/, /scripts[\\/]/, /\.md$/],
  },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) yield full;
  }
}

function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return (err.stderr || err.stdout || Buffer.from('syntax error')).toString().trim();
  }
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(REPO_ROOT, dir);
    if (fs.existsSync(full)) files.push(...walk(full));
  }

  const problems = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const syntaxError = syntaxCheck(file);
    if (syntaxError) {
      problems.push({ file: rel, rule: 'syntax', message: syntaxError.split('\n')[0] });
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (const rule of RULES) {
      if (rule.allowFiles && rule.allowFiles.some((re) => re.test(rel))) continue;
      lines.forEach((line, i) => {
        // Ignore comment-only lines for pattern rules to reduce false positives.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (rule.pattern.test(line)) {
          problems.push({ file: rel, line: i + 1, rule: rule.id, message: rule.message });
        }
      });
    }
  }

  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(`Lint failed with ${problems.length} problem(s):`);
    for (const p of problems) {
      // eslint-disable-next-line no-console
      console.error(`  ${p.file}${p.line ? `:${p.line}` : ''} [${p.rule}] ${p.message}`);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Lint OK — ${files.length} file(s) checked.`);
}

main();
