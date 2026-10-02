'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TranscriptStore } = require('../../src/renderer/lib/transcript-store');
const { SEGMENT_STATUS, UNCLEAR_PLACEHOLDER } = require('../../src/shared/constants');

function base() {
  return [
    { segment_id: 'A', start: 0, end: 2, speaker: 'SPEAKER_01', text: 'Merhaba dünya', status: SEGMENT_STATUS.AUTOMATIC, confidence: 0.9, words: null },
    { segment_id: 'B', start: 2, end: 4, speaker: 'SPEAKER_01', text: 'ikinci satır', status: SEGMENT_STATUS.AUTOMATIC, confidence: 0.8, words: null },
    { segment_id: 'C', start: 4, end: 6, speaker: 'SPEAKER_02', text: 'üçüncü satır', status: SEGMENT_STATUS.AUTOMATIC, confidence: 0.7, words: null },
  ];
}

test('editing text preserves the automatic version in undo history', () => {
  const store = new TranscriptStore(base());
  assert.equal(store.editText('A', 'Merhaba buraya'), true);
  assert.equal(store.getById('A').text, 'Merhaba buraya');
  assert.equal(store.getById('A').status, SEGMENT_STATUS.EDITED);
  assert.equal(store.canUndo, true);

  store.undo();
  assert.equal(store.getById('A').text, 'Merhaba dünya');
  assert.equal(store.getById('A').status, SEGMENT_STATUS.AUTOMATIC);

  store.redo();
  assert.equal(store.getById('A').text, 'Merhaba buraya');
  assert.equal(store.getById('A').status, SEGMENT_STATUS.EDITED);
});

test('empty edit becomes the unclear placeholder, never silent invention', () => {
  const store = new TranscriptStore(base());
  store.editText('A', '   ');
  assert.equal(store.getById('A').text, UNCLEAR_PLACEHOLDER);
});

test('editing never downgrades a verified segment', () => {
  const store = new TranscriptStore(base());
  store.setStatus('A', SEGMENT_STATUS.VERIFIED);
  store.editText('A', 'yeni metin');
  assert.equal(store.getById('A').status, SEGMENT_STATUS.VERIFIED);
});

test('split creates two ordered segments covering the original interval', () => {
  const store = new TranscriptStore(base());
  assert.equal(store.splitSegment('A', 1.0), true);
  assert.equal(store.segments.length, 4);
  const [first, second] = store.segments;
  assert.equal(first.start, 0);
  assert.equal(first.end, 1.0);
  assert.equal(second.start, 1.0);
  assert.equal(second.end, 2);
  assert.equal(first.status, SEGMENT_STATUS.EDITED);
});

test('split rejects a cursor outside the segment', () => {
  const store = new TranscriptStore(base());
  assert.equal(store.splitSegment('A', 0), false);
  assert.equal(store.splitSegment('A', 2), false);
  assert.equal(store.segments.length, 3);
});

test('merge combines text and interval with the next segment', () => {
  const store = new TranscriptStore(base());
  assert.equal(store.mergeWithNext('A'), true);
  assert.equal(store.segments.length, 2);
  assert.equal(store.segments[0].text, 'Merhaba dünya ikinci satır');
  assert.equal(store.segments[0].end, 4);
  assert.equal(store.mergeWithNext('C'), false);
});

test('speaker change marks the segment as human-edited', () => {
  const store = new TranscriptStore(base());
  store.setSpeaker('A', 'SPEAKER_03');
  assert.equal(store.getById('A').speaker, 'SPEAKER_03');
  assert.equal(store.getById('A').status, SEGMENT_STATUS.EDITED);
});

test('bulk status update and undo', () => {
  const store = new TranscriptStore(base());
  assert.equal(store.setStatusBulk(['A', 'B'], SEGMENT_STATUS.VERIFIED), true);
  assert.equal(store.getById('A').status, SEGMENT_STATUS.VERIFIED);
  assert.equal(store.getById('B').status, SEGMENT_STATUS.VERIFIED);
  store.undo();
  assert.equal(store.getById('A').status, SEGMENT_STATUS.AUTOMATIC);
});

test('dirty flag clears only on markSaved', () => {
  const store = new TranscriptStore(base());
  assert.equal(store.dirty, false);
  store.editText('A', 'x');
  assert.equal(store.dirty, true);
  store.markSaved();
  assert.equal(store.dirty, false);
  assert.equal(store.canUndo, false);
});

test('toPayload round-trips through a new store without loss', () => {
  const store = new TranscriptStore(base());
  store.editText('B', 'düzenlendi');
  const payload = store.toPayload();
  const restored = new TranscriptStore(payload);
  assert.deepEqual(restored.segments.map((s) => s.text), store.segments.map((s) => s.text));
  assert.deepEqual(restored.segments.map((s) => s.status), store.segments.map((s) => s.status));
});

test('undo history is bounded', () => {
  const store = new TranscriptStore(base());
  for (let i = 0; i < 400; i += 1) store.editText('A', `metin ${i}`);
  assert.ok(store._undo.length <= 200);
});
