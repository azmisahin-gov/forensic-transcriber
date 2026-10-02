'use strict';

/**
 * WER / CER measurement.
 *
 *   node scripts/wer.js --ref reference.txt --hyp hypothesis.txt [--json]
 *
 * Both files are plain UTF-8 text. Normalisation follows common ASR practice:
 * lowercase, Unicode NFKC, punctuation removed, whitespace collapsed. Turkish
 * dotted/dotless i is preserved by NFKC (we do not force ASCII).
 *
 * WER = (S + D + I) / N   over words
 * CER = (S + D + I) / N   over characters
 */

const fs = require('node:fs');

function normalise(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'“”‘’«»…—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeWords(text) {
  const n = normalise(text);
  return n.length ? n.split(' ') : [];
}

function tokenizeChars(text) {
  return [...normalise(text).replace(/ /g, '')];
}

/** Levenshtein alignment returning substitution/insertion/deletion counts. */
function editCounts(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  // Full DP table with backtrace. Transcripts are bounded in size; the table
  // is (n+1)*(m+1) integers which is acceptable for realistic inputs.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j - 1] + cost, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }
  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        if (cost === 1) substitutions += 1;
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deletions += 1;
      i -= 1;
      continue;
    }
    insertions += 1;
    j -= 1;
  }
  return { distance: dp[n][m], substitutions, deletions, insertions, refLength: n };
}

function measure(refText, hypText, tokenizer) {
  const ref = tokenizer(refText);
  const hyp = tokenizer(hypText);
  const c = editCounts(ref, hyp);
  return {
    reference_units: c.refLength,
    hypothesis_units: hyp.length,
    substitutions: c.substitutions,
    deletions: c.deletions,
    insertions: c.insertions,
    rate: c.refLength ? c.distance / c.refLength : null,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const refPath = arg('--ref');
  const hypPath = arg('--hyp');
  if (!refPath || !hypPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/wer.js --ref reference.txt --hyp hypothesis.txt [--json]');
    process.exit(1);
  }
  const refText = fs.readFileSync(refPath, 'utf8');
  const hypText = fs.readFileSync(hypPath, 'utf8');

  const result = {
    reference: refPath,
    hypothesis: hypPath,
    WER: measure(refText, hypText, tokenizeWords),
    CER: measure(refText, hypText, tokenizeChars),
  };

  if (argv.includes('--json')) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(`WER = ${(result.WER.rate * 100).toFixed(2)}%  (S=${result.WER.substitutions} D=${result.WER.deletions} I=${result.WER.insertions} / ${result.WER.reference_units} words)`);
    // eslint-disable-next-line no-console
    console.log(`CER = ${(result.CER.rate * 100).toFixed(2)}%  (S=${result.CER.substitutions} D=${result.CER.deletions} I=${result.CER.insertions} / ${result.CER.reference_units} chars)`);
  }
}

if (require.main === module) main();

module.exports = { normalise, tokenizeWords, tokenizeChars, editCounts, measure };
