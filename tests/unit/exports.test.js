'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatSrtTime, formatClock, escapeHtml, toJson, toSrt, toHtml, toTxt } = require('../../src/main/services/exports');
const { SEGMENT_STATUS } = require('../../src/shared/constants');

const caseRecord = { case_id: 'CASE-1', title: 'Örnek Dava', notes: 'not' };
const evidence = { evidence_id: 'EV-1', original_name: 'kayıt m4a', sha256: 'abc123', duration_seconds: 12.5 };
const segments = [
  { segment_id: 'S1', start: 0, end: 2.5, speaker: 'SPEAKER_01', text: 'Merhaba <dünya> & "herkes"', status: SEGMENT_STATUS.AUTOMATIC, confidence: 0.9, words: null },
  { segment_id: 'S2', start: 2.5, end: 5, speaker: 'SPEAKER_02', text: 'İkinci satır', status: SEGMENT_STATUS.EDITED, confidence: null, words: null },
];
const ctx = { caseRecord, evidence, transcript: null, segments, language: 'tr', modelId: 'large-v3-turbo-q5_0', engine: 'whisper.cpp' };

test('SRT timestamps are correctly formatted', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(2.5), '00:00:02,500');
  assert.equal(formatSrtTime(3661.25), '01:01:01,250');
});

test('clock formatting matches the UI', () => {
  assert.equal(formatClock(0), '00:00:00.000');
  assert.equal(formatClock(12.345), '00:00:12.345');
});

test('JSON export keeps the canonical schema and status distinction', () => {
  const parsed = JSON.parse(toJson(ctx));
  assert.equal(parsed.schema_version, '1.0');
  assert.equal(parsed.case_id, 'CASE-1');
  assert.equal(parsed.evidence_id, 'EV-1');
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].status, 'AUTOMATIC');
  assert.equal(parsed.segments[1].status, 'EDITED');
  assert.equal(parsed.human_reviewed_segment_count, 1);
  assert.match(parsed.tool_note, /does not constitute a forensic opinion/);
});

test('SRT export indexes segments and carries status', () => {
  const srt = toSrt(ctx);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,500/m);
  assert.match(srt, /\[SPEAKER_01\]/);
  assert.match(srt, /\{EDITED\}/);
});

test('HTML export is self-contained and escapes content', () => {
  const html = toHtml(ctx);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Merhaba &lt;dünya&gt; &amp; &quot;herkes&quot;/);
  assert.doesNotMatch(html, /<dünya>/);
  assert.doesNotMatch(html, /https?:\/\//); // no external resources
});

test('HTML escaping handles all dangerous characters', () => {
  assert.equal(escapeHtml('<script>"x"&\'y\''), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
});

test('TXT export includes evidence hash and disclaimer', () => {
  const txt = toTxt(ctx);
  assert.match(txt, /SHA-256: abc123/);
  assert.match(txt, /machine output, not expert opinion/);
});

test('exports tolerate an empty segment list', () => {
  const empty = { ...ctx, segments: [] };
  assert.equal(JSON.parse(toJson(empty)).segments.length, 0);
  assert.equal(toSrt(empty).trim(), '');
  assert.match(toHtml(empty), /<!doctype html>/i);
});
