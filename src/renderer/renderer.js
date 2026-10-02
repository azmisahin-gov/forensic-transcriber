'use strict';

/* global FT_CONSTANTS, FT_FORMAT, FT_TRANSCRIPT_STORE, FT_AUDIO, FT_WAVEFORM */
(function () {
  const { SEGMENT_STATUS } = FT_CONSTANTS;
  const { formatClock, formatBytes, formatDuration, relativeTime } = FT_FORMAT;
  const { TranscriptStore } = FT_TRANSCRIPT_STORE;
  const { AudioController } = FT_AUDIO;
  const { drawWaveform, resamplePeaks, xToTime } = FT_WAVEFORM;

  const api = window.ft;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    appInfo: null,
    cases: [],
    caseRecord: null,
    evidence: [],
    activeEvidenceId: null,
    store: null,
    transcriptMeta: null,
    activeSegmentId: null,
    editingSegmentId: null,
    speakers: ['SPEAKER_01', 'SPEAKER_02', 'SPEAKER_03', 'SPEAKER_04'],
    models: [],
    duration: 0,
    peaks: [],
    busy: false,
    progressUnsub: null,
    pollTimer: null,
    engineProbe: null,
    lastRunMode: null,
  };

  // ---------------------------------------------------------------- utilities
  async function call(promise) {
    const res = await promise;
    if (!res || res.ok !== true) {
      const err = new Error(res && res.error ? res.error.message : 'Operation failed.');
      if (res && res.error) {
        err.code = res.error.code;
        err.detail = res.error.detail;
      }
      throw err;
    }
    return res.data;
  }

  let toastTimer = null;
  function toast(message, kind = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 7000 : 4000);
  }

  function confirmDialog(title, message) {
    return new Promise((resolve) => {
      const dlg = $('#dialog-confirm');
      $('#confirm-title').textContent = title;
      $('#confirm-message').textContent = message;
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'default');
      };
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  function errText(err) {
    const code = err && err.code ? ` (${err.code})` : '';
    return `${err && err.message ? err.message : String(err)}${code}`;
  }

  // ------------------------------------------------------------------ app init
  async function init() {
    try {
      state.appInfo = await call(api.app.info());
    } catch (err) {
      toast(`Startup error: ${errText(err)}`, 'error');
      return;
    }
    $('#scope-label').textContent = state.appInfo.scope;
    updateModelBadge();
    $('#storage-info').textContent =
      `${state.appInfo.storage.cases} cases · ${state.appInfo.storage.evidence} files`;
    if (!state.appInfo.media.ffmpeg || !state.appInfo.media.ffprobe) {
      toast('FFmpeg decoder not found. Import and transcription will not work.', 'error');
    }
    state.progressUnsub = api.transcribe.onProgress(handleProgress);
    await refreshModels();
    await refreshCases();
    $('#app').setAttribute('aria-hidden', 'false');
  }

  function updateModelBadge() {
    const badge = $('#model-badge');
    if (state.appInfo && state.appInfo.modelReady) {
      badge.textContent = 'Model ready';
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = 'Model not installed';
      badge.className = 'badge badge-warn';
    }
  }

  /**
   * Show what the ASR runtimes can really do and which device the last run used.
   * "CUDA-capable" (a GPU runtime is bundled and loads a CUDA backend) is kept
   * distinct from "GPU in use" (a GPU was actually selected for a run). The
   * presence of an NVIDIA device on the host is never treated as GPU support.
   */
  function renderEngineStatus(probe, lastRun) {
    const el = $('#engine-status');
    if (!el) return;
    const parts = [];
    if (!probe) {
      parts.push('Engine capability not checked yet.');
    } else {
      const cpu = probe.cpuBinary || {};
      if (!cpu.ok) {
        parts.push('Engine check unavailable. Install a model, then check again.');
      } else if (!probe.gpuRuntimeBundled) {
        parts.push('Engine: CPU runtime only (no GPU runtime bundled).');
      } else {
        const gpu = probe.gpuBinary || {};
        if (gpu.cudaCapable && gpu.gpuDeviceFound) {
          parts.push(`Engine: CUDA runtime bundled, GPU detected (${gpu.gpuName || 'GPU'}).`);
        } else if (gpu.cudaCapable) {
          parts.push('Engine: CUDA runtime bundled, but no GPU detected on this machine.');
        } else {
          parts.push('Engine: GPU runtime bundled but not CUDA-capable.');
        }
      }
    }
    if (lastRun) {
      parts.push(lastRun.mode === 'gpu' ? 'Last run: GPU.' : `Last run: CPU (${lastRun.reason || 'fallback'}).`);
    }
    el.textContent = parts.join(' ');
    el.className = `engine-status small ${probe && probe.gpuUsable ? 'ok' : 'muted'}`;
  }

  async function checkEngine(force = false) {
    try {
      const probe = await call(api.app.probeEngine(force));
      state.engineProbe = probe;
      renderEngineStatus(probe, state.appInfo && state.appInfo.lastRunMode);
      return probe;
    } catch (err) {
      renderEngineStatus(null, null);
      toast(`Engine check failed: ${errText(err)}`, 'error');
      return null;
    }
  }

  async function refreshModels() {
    try {
      state.models = await call(api.models.list());
    } catch {
      state.models = [];
    }
    const select = $('#select-model');
    const asr = state.models.filter((m) => m.kind === 'asr');
    select.innerHTML = '';
    for (const m of asr) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label}${m.installed ? (m.verified ? '' : ' (unverified)') : ' — not installed'}`;
      if (m.id === state.appInfo.defaultModelId) opt.selected = true;
      select.appendChild(opt);
    }
    const ready = asr.some((m) => m.installed && m.verified);
    if (state.appInfo) state.appInfo.modelReady = ready;
    updateModelBadge();
    renderModelDialog();
    // Once a verified model exists, probe the engine so the operator can see
    // whether the binary is CUDA-capable and which device was selected.
    if (ready && !state.engineProbe) {
      checkEngine(false).catch(() => {});
    } else {
      renderEngineStatus(state.engineProbe, state.lastRunMode);
    }
  }

  function renderModelDialog() {
    const list = $('#model-list');
    list.innerHTML = '';
    for (const m of state.models) {
      const row = document.createElement('div');
      row.className = 'model-row';
      const status = m.installed
        ? m.verified
          ? '<span class="badge badge-ok">verified</span>'
          : '<span class="badge badge-warn">checksum mismatch</span>'
        : '<span class="badge badge-warn">not installed</span>';
      row.innerHTML = `
        <div class="top"><span class="name"></span><span>${status}</span></div>
        <p class="desc"></p>
        <p class="prov"></p>
        <div class="actions"></div>`;
      row.querySelector('.name').textContent = `${m.label} · ${formatBytes(m.expectedSizeBytes)}`;
      row.querySelector('.desc').textContent = m.description;
      row.querySelector('.prov').textContent = `${m.license} · ${m.source}`;
      const actions = row.querySelector('.actions');
      if (m.kind === 'asr' || m.kind === 'vad') {
        const dl = document.createElement('button');
        dl.className = 'btn btn-small';
        dl.textContent = m.installed ? 'Reinstall' : 'Install';
        dl.addEventListener('click', () => installModel(m.id, dl));
        actions.appendChild(dl);

        const imp = document.createElement('button');
        imp.className = 'btn btn-small';
        imp.textContent = 'Import file…';
        imp.addEventListener('click', () => importModelFile(m.id));
        actions.appendChild(imp);
      }
      list.appendChild(row);
    }
  }

  async function installModel(modelId, button) {
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      await call(api.models.install(modelId));
      toast('Model installed and verified.', 'success');
    } catch (err) {
      toast(`Model install failed: ${errText(err)}`, 'error');
    } finally {
      button.disabled = false;
      await refreshModels();
    }
  }

  async function importModelFile(modelId) {
    try {
      const res = await call(api.models.importFile(modelId));
      if (res && res.canceled) return;
      toast('Model file imported and verified.', 'success');
    } catch (err) {
      toast(`Model import failed: ${errText(err)}`, 'error');
    } finally {
      await refreshModels();
    }
  }

  // ----------------------------------------------------------------- case list
  async function refreshCases() {
    try {
      state.cases = await call(api.cases.list());
    } catch (err) {
      toast(`Could not list cases: ${errText(err)}`, 'error');
      return;
    }
    renderCaseList();
  }

  function renderCaseList() {
    const ul = $('#case-list');
    ul.innerHTML = '';
    if (!state.cases.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.style.padding = '10px';
      li.textContent = 'No cases yet.';
      ul.appendChild(li);
      return;
    }
    for (const c of state.cases) {
      const li = document.createElement('li');
      li.className = `case-item${state.caseRecord && state.caseRecord.case_id === c.case_id ? ' active' : ''}`;
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = c.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${c.evidence_count} file(s) · ${relativeTime(c.updated_at)}`;
      li.append(title, meta);
      li.addEventListener('click', () => openCase(c.case_id));
      ul.appendChild(li);
    }
  }

  async function openCase(caseId) {
    if (state.store && state.store.dirty) {
      const ok = await confirmDialog('Discard unsaved edits?', 'This case has unsaved transcript edits.');
      if (!ok) return;
    }
    stopPlayback();
    try {
      const data = await call(api.cases.open(caseId));
      state.caseRecord = data.case;
      state.evidence = data.evidence;
      state.activeEvidenceId = null;
      state.transcriptMeta = null;
      state.store = null;
      $('#empty-state').classList.add('hidden');
      $('#case-view').classList.remove('hidden');
      $('#case-title').textContent = state.caseRecord.title;
      $('#case-subtitle').textContent = `${state.caseRecord.case_id} · ${state.caseRecord.notes || 'no notes'}`;
      renderEvidenceList();
      showReview(null);
      renderCaseList();
      $('#btn-save').disabled = true;
      $('#btn-export').disabled = true;
    } catch (err) {
      toast(`Could not open case: ${errText(err)}`, 'error');
    }
  }

  // ------------------------------------------------------------- evidence list
  function renderEvidenceList() {
    const ul = $('#evidence-list');
    ul.innerHTML = '';
    if (!state.evidence.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.style.padding = '10px';
      li.textContent = 'No recordings imported.';
      ul.appendChild(li);
      return;
    }
    for (const ev of state.evidence) {
      const li = document.createElement('li');
      li.className = `evidence-item${state.activeEvidenceId === ev.evidence_id ? ' active' : ''}`;
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = ev.original_name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${formatBytes(ev.size_bytes)} · ${ev.duration_seconds ? formatDuration(ev.duration_seconds) : 'unknown length'}`;
      li.append(name, meta);
      li.addEventListener('click', () => selectEvidence(ev.evidence_id));
      ul.appendChild(li);
    }
  }

  async function importPaths(paths) {
    if (!state.caseRecord) {
      toast('Create or open a case first.', 'error');
      return;
    }
    if (!paths || !paths.length) return;
    try {
      const res = await call(api.evidence.importFiles(state.caseRecord.case_id, paths));
      state.evidence = await call(api.evidence.list(state.caseRecord.case_id));
      renderEvidenceList();
      if (res.imported.length) toast(`Imported ${res.imported.length} file(s).`, 'success');
      if (res.failures.length) {
        toast(`${res.failures.length} file(s) could not be imported: ${res.failures[0].error.message}`, 'error');
      }
      const first = res.imported[0];
      if (first) selectEvidence(first.evidence_id);
    } catch (err) {
      toast(`Import failed: ${errText(err)}`, 'error');
    }
  }

  // --------------------------------------------------------------- evidence view
  async function selectEvidence(evidenceId) {
    state.activeEvidenceId = evidenceId;
    state.editingSegmentId = null;
    state.activeSegmentId = null;
    renderEvidenceList();
    const ev = state.evidence.find((e) => e.evidence_id === evidenceId);
    if (!ev) return;
    showReview(ev);
    renderEvidenceMeta(ev);

    stopPlayback();
    audio.load(api.evidence.playbackUrl(evidenceId));
    state.peaks = [];
    renderWaveform();
    api.evidence
      .waveform(evidenceId, 1600)
      .then((res) => {
        if (res && res.ok) {
          state.peaks = res.data.peaks || [];
          renderWaveform();
        }
      })
      .catch(() => {});

    await loadTranscript(evidenceId);
  }

  function showReview(ev) {
    $('#review-placeholder').classList.toggle('hidden', !!ev);
    $('#review').classList.toggle('hidden', !ev);
  }

  function renderEvidenceMeta(ev) {
    $('#ev-name').textContent = ev.original_name;
    const grid = $('#ev-meta');
    grid.innerHTML = '';
    const rows = [
      ['File name', ev.original_name],
      ['Size', formatBytes(ev.size_bytes)],
      ['Container', ev.format || 'unknown'],
      ['Codec', ev.codec || 'unknown'],
      ['Duration', ev.duration_seconds != null ? formatClock(ev.duration_seconds) : 'unknown'],
      ['Sample rate', ev.sample_rate ? `${ev.sample_rate} Hz` : 'unknown'],
      ['Channels', ev.channels != null ? String(ev.channels) : 'unknown'],
      ['Bit depth', ev.bit_depth ? `${ev.bit_depth} bit` : 'n/a'],
      ['SHA-256', ev.sha256],
      ['Imported', new Date(ev.imported_at).toLocaleString()],
    ];
    for (const [k, v] of rows) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      wrap.append(dt, dd);
      grid.appendChild(wrap);
    }
  }

  // ------------------------------------------------------------------ transcript
  async function loadTranscript(evidenceId) {
    let data = null;
    try {
      data = await call(api.transcript.get(state.caseRecord.case_id, evidenceId));
    } catch (err) {
      toast(`Could not load transcript: ${errText(err)}`, 'error');
    }
    if (data) {
      state.transcriptMeta = data.transcript;
      state.store = new TranscriptStore(data.segments);
    } else {
      state.transcriptMeta = null;
      state.store = new TranscriptStore([]);
    }
    state.store.onChange(renderTranscript);
    renderTranscript();
    $('#btn-save').disabled = false;
    $('#btn-export').disabled = !state.transcriptMeta;
  }

  function renderTranscript() {
    const list = $('#transcript-list');
    list.innerHTML = '';
    const segs = state.store ? state.store.segments : [];
    const stats = $('#transcript-stats');
    if (!segs.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = state.transcriptMeta
        ? 'Transcript is empty.'
        : 'No transcript yet. Choose a model and press Transcribe.';
      list.appendChild(p);
    } else {
      for (const seg of segs) list.appendChild(renderSegment(seg));
      const edited = segs.filter((s) => s.status !== SEGMENT_STATUS.AUTOMATIC).length;
      stats.textContent = `${segs.length} segments · ${edited} human-reviewed`;
    }
    $('#btn-undo').disabled = !state.store || !state.store.canUndo;
    $('#btn-redo').disabled = !state.store || !state.store.canRedo;
    $('#btn-save').disabled = !state.store || !state.store.dirty;
    $('#btn-export').disabled = !state.transcriptMeta && !(state.store && state.store.segments.length);
  }

  function renderSegment(seg) {
    const el = document.createElement('div');
    el.className = `seg ${seg.status.toLowerCase()}${state.activeSegmentId === seg.segment_id ? ' active' : ''}`;
    el.dataset.id = seg.segment_id;

    const head = document.createElement('div');
    head.className = 'seg-head';

    const startBtn = document.createElement('button');
    startBtn.className = 'ts';
    startBtn.textContent = formatClock(seg.start);
    startBtn.title = 'Play from here';
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playSegment(seg);
    });

    const sep = document.createElement('span');
    sep.textContent = '–';

    const endSpan = document.createElement('span');
    endSpan.className = 'ts';
    endSpan.textContent = formatClock(seg.end);

    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.textContent = seg.speaker;

    const status = document.createElement('span');
    status.className = `status ${seg.status}`;
    status.textContent = seg.status;

    head.append(startBtn, sep, endSpan, speaker, status);

    if (seg.confidence != null) {
      const conf = document.createElement('span');
      conf.className = 'conf';
      conf.textContent = `conf ${seg.confidence.toFixed(2)}`;
      conf.title = 'Mean token probability from the ASR engine';
      head.appendChild(conf);
    }

    el.appendChild(head);

    if (state.editingSegmentId === seg.segment_id) {
      const ta = document.createElement('textarea');
      ta.className = 'seg-edit';
      ta.value = seg.text;
      const save = () => {
        state.editingSegmentId = null;
        state.store.editText(seg.segment_id, ta.value);
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          state.editingSegmentId = null;
          renderTranscript();
        }
      });
      el.appendChild(ta);
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.value.length;
      }, 0);
    } else {
      const body = document.createElement('div');
      body.className = 'seg-body';
      body.textContent = seg.text;
      el.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'seg-actions';
    actions.append(
      actionButton('Edit', () => {
        state.editingSegmentId = seg.segment_id;
        renderTranscript();
      }),
      actionButton('Play', () => playSegment(seg)),
      actionButton('Split at cursor', () => splitSegment(seg)),
      actionButton('Merge next', () => mergeNext(seg)),
      actionButton('Mark reviewed', () => state.store.setStatus(seg.segment_id, SEGMENT_STATUS.REVIEWED)),
      actionButton('Mark verified', () => state.store.setStatus(seg.segment_id, SEGMENT_STATUS.VERIFIED)),
      actionButton('Speaker', () => cycleSpeaker(seg)),
      actionButton('Delete', () => state.store.deleteSegment(seg.segment_id))
    );
    el.appendChild(actions);

    el.addEventListener('click', () => {
      state.activeSegmentId = seg.segment_id;
      renderTranscript();
      renderWaveform();
    });

    return el;
  }

  function actionButton(label, handler) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
    return b;
  }

  function splitSegment(seg) {
    const at = audio.currentTime > seg.start && audio.currentTime < seg.end ? audio.currentTime : (seg.start + seg.end) / 2;
    if (!state.store.splitSegment(seg.segment_id, at)) {
      toast('Cannot split here: playhead must be inside the segment.', 'error');
    }
  }

  function mergeNext(seg) {
    if (!state.store.mergeWithNext(seg.segment_id)) toast('No following segment to merge.', 'error');
  }

  function cycleSpeaker(seg) {
    const idx = state.speakers.indexOf(seg.speaker);
    const next = state.speakers[(idx + 1) % state.speakers.length];
    state.store.setSpeaker(seg.segment_id, next);
  }

  // --------------------------------------------------------------------- player
  const audioEl = document.getElementById('audio-el') || (() => {
    const a = document.createElement('audio');
    a.id = 'audio-el';
    document.body.appendChild(a);
    return a;
  })();

  const audio = new AudioController(audioEl, {
    onTime: (t) => {
      $('#time-display').textContent = formatClock(t);
      renderWaveform();
    },
    onState: (s) => {
      $('#btn-play').textContent = s === 'playing' ? '⏸' : '▶';
    },
    onDuration: (d) => {
      state.duration = d;
      renderWaveform();
    },
  });

  function playSegment(seg) {
    state.activeSegmentId = seg.segment_id;
    renderTranscript();
    audio.playSegment(seg.start, seg.end);
  }

  function stopPlayback() {
    audio.pause();
    audio.stopAtSegmentEnd();
  }

  const canvas = $('#waveform');
  const ctx2d = canvas.getContext('2d');

  function renderWaveform() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = 96;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.height = `${height}px`;
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const active = state.store && state.activeSegmentId ? state.store.getById(state.activeSegmentId) : null;
    const duration = state.duration || 0;
    drawWaveform(ctx2d, {
      width,
      height,
      peaks: resamplePeaks(state.peaks, width),
      duration,
      currentTime: audio.currentTime,
      selection: active && duration > 0 ? { start: active.start, end: active.end } : null,
    });
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const duration = state.duration;
    if (!duration) return;
    const t = xToTime(e.clientX - rect.left, duration, rect.width);
    audio.seek(t);
  });

  // ------------------------------------------------------------------ progress
  function handleProgress(payload) {
    if (!payload) return;
    if (payload.kind === 'model-download') {
      const pct = payload.total ? Math.round((payload.received / payload.total) * 100) : 0;
      $('#progress-wrap').classList.remove('hidden');
      $('#progress-bar').style.width = `${pct}%`;
      $('#progress-label').textContent = `Downloading model ${payload.modelId} — ${pct}%`;
      return;
    }
    if (payload.kind === 'stage') {
      $('#progress-wrap').classList.remove('hidden');
      if (typeof payload.percent === 'number') $('#progress-bar').style.width = `${payload.percent}%`;
      const labels = {
        preparing: 'Preparing working copy…',
        decoding: 'Decoding audio…',
        'loading-model': 'Loading model…',
        runtime: `Runtime: ${(payload.runtimeMode || 'cpu').toUpperCase()}`,
        transcribing: 'Transcribing…',
        done: 'Done',
      };
      $('#progress-label').textContent = labels[payload.stage] || payload.stage;
    }
  }

  async function startTranscription() {
    if (!state.caseRecord || !state.activeEvidenceId) return;
    const modelId = $('#select-model').value;
    const model = state.models.find((m) => m.id === modelId);
    if (!model || !model.installed || !model.verified) {
      toast('Model not installed. Open Models to install a model package to begin.', 'error');
      return;
    }
    state.busy = true;
    $('#btn-transcribe').disabled = true;
    $('#btn-cancel').classList.remove('hidden');
    $('#transcribe-error').classList.add('hidden');
    $('#progress-wrap').classList.remove('hidden');
    $('#progress-bar').style.width = '2%';
    $('#progress-label').textContent = 'Preparing…';
    try {
      const res = await call(
        api.transcribe.start({
          caseId: state.caseRecord.case_id,
          evidenceId: state.activeEvidenceId,
          modelId,
          language: 'tr',
          useGpu: $('#chk-gpu').checked,
          useVad: $('#chk-vad').checked,
        })
      );
      state.transcriptMeta = res.transcript;
      state.store.replaceAll(res.segments);
      renderTranscript();
      $('#btn-export').disabled = false;
      if (res.runtimeSelection) {
        state.lastRunMode = {
          mode: res.runtimeSelection.mode,
          reason: res.runtimeSelection.reason,
          gpuRuntimeBundled: res.runtimeSelection.gpuRuntimeBundled,
        };
      }
      renderEngineStatus(state.engineProbe, state.lastRunMode);
      const mode = res.runtimeSelection ? res.runtimeSelection.mode.toUpperCase() : null;
      toast(
        `Transcription complete${mode ? ` (${mode})` : ''}. Review each segment against the audio.`,
        'success'
      );
    } catch (err) {
      const el = $('#transcribe-error');
      el.textContent = errText(err) + (err.detail ? `\n${err.detail}` : '');
      el.classList.remove('hidden');
      toast(`Transcription failed: ${errText(err)}`, 'error');
    } finally {
      state.busy = false;
      $('#btn-transcribe').disabled = false;
      $('#btn-cancel').classList.add('hidden');
      setTimeout(() => $('#progress-wrap').classList.add('hidden'), 1200);
      await refreshCases();
    }
  }

  async function cancelTranscription() {
    try {
      await call(api.transcribe.cancel());
      toast('Cancelling…');
    } catch (err) {
      toast(`Cancel failed: ${errText(err)}`, 'error');
    }
  }

  // ----------------------------------------------------------------------- save
  async function saveTranscript() {
    if (!state.store || !state.caseRecord || !state.activeEvidenceId) return;
    if (!state.store.segments.length) {
      toast('Nothing to save.', 'error');
      return;
    }
    try {
      const res = await call(
        api.transcript.save(state.caseRecord.case_id, state.activeEvidenceId, {
          language: (state.transcriptMeta && state.transcriptMeta.language) || 'tr',
          modelId: state.transcriptMeta ? state.transcriptMeta.model_id : null,
          engine: state.transcriptMeta ? state.transcriptMeta.engine : null,
          segments: state.store.toPayload(),
          source: 'review',
        })
      );
      state.transcriptMeta = res.transcript;
      state.store.markSaved();
      renderTranscript();
      toast('Transcript saved.', 'success');
    } catch (err) {
      toast(`Save failed: ${errText(err)}`, 'error');
    }
  }

  // --------------------------------------------------------------------- export
  function openExportDialog() {
    if (!state.transcriptMeta && !(state.store && state.store.segments.length)) {
      toast('No transcript to export.', 'error');
      return;
    }
    $('#dialog-export').showModal();
  }

  async function runExport() {
    const formats = Array.from(document.querySelectorAll('.exp-format:checked')).map((c) => c.value);
    if (!formats.length) {
      toast('Select at least one format.', 'error');
      return;
    }
    if (state.store && state.store.dirty) {
      const ok = await confirmDialog('Save before export?', 'The transcript has unsaved edits. Save them now?');
      if (ok) await saveTranscript();
    }
    try {
      const files = await call(
        api.exports.run(state.caseRecord.case_id, state.activeEvidenceId, { formats })
      );
      toast(`Exported ${files.length} file(s) to the case exports folder.`, 'success');
    } catch (err) {
      toast(`Export failed: ${errText(err)}`, 'error');
    }
  }

  // ---------------------------------------------------------------- interactions
  function wireEvents() {
    $('#btn-new-case').addEventListener('click', () => {
      $('#new-case-title').value = '';
      $('#new-case-notes').value = '';
      $('#dialog-new-case').showModal();
    });

    $('#dialog-new-case').addEventListener('close', async (e) => {
      const dlg = $('#dialog-new-case');
      if (dlg.returnValue !== 'default') return;
      const title = $('#new-case-title').value.trim();
      if (!title) {
        toast('Case title is required.', 'error');
        return;
      }
      try {
        const created = await call(api.cases.create({ title, notes: $('#new-case-notes').value }));
        await refreshCases();
        await openCase(created.case_id);
      } catch (err) {
        toast(`Could not create case: ${errText(err)}`, 'error');
      }
    });

    $('#btn-refresh-cases').addEventListener('click', refreshCases);
    $('#btn-open-datadir').addEventListener('click', async () => {
      try {
        const paths = await call(api.app.paths());
        await call(api.dialog.openDirectory());
        toast(`Data folder: ${paths.dataDir}`);
      } catch {
        /* ignore */
      }
    });

    $('#btn-import').addEventListener('click', async () => {
      try {
        const paths = await call(api.dialog.openFiles());
        await importPaths(paths);
      } catch (err) {
        toast(`Could not open file picker: ${errText(err)}`, 'error');
      }
    });

    const dropZone = $('#drop-zone');
    ['dragenter', 'dragover'].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover'))
    );
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      const paths = files.map((f) => f.path).filter(Boolean);
      if (!paths.length) {
        toast('Could not read dropped file paths.', 'error');
        return;
      }
      importPaths(paths);
    });

    $('#btn-transcribe').addEventListener('click', startTranscription);
    $('#btn-check-engine').addEventListener('click', async () => {
      toast('Checking engine capability…');
      await checkEngine(true);
    });
    $('#btn-cancel').addEventListener('click', cancelTranscription);
    $('#btn-save').addEventListener('click', saveTranscript);
    $('#btn-export').addEventListener('click', openExportDialog);
    $('#btn-run-export').addEventListener('click', (e) => {
      e.preventDefault();
      $('#dialog-export').close();
      runExport();
    });

    $('#btn-play').addEventListener('click', () => audio.toggle());
    $('#btn-back5').addEventListener('click', () => audio.skip(-5));
    $('#btn-fwd5').addEventListener('click', () => audio.skip(5));
    $('#select-speed').addEventListener('change', (e) => audio.setPlaybackRate(e.target.value));

    $('#speaker-input').addEventListener('change', (e) => {
      const list = e.target.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length) state.speakers = list;
    });

    $('#btn-undo').addEventListener('click', () => state.store && state.store.undo());
    $('#btn-redo').addEventListener('click', () => state.store && state.store.redo());

    $('#btn-models').addEventListener('click', () => $('#dialog-models').showModal());
    $('#dialog-models').addEventListener('close', refreshModels);

    $('#btn-reveal').addEventListener('click', () => {
      if (state.activeEvidenceId) api.evidence.reveal(state.activeEvidenceId);
    });

    $('#btn-delete-evidence').addEventListener('click', async () => {
      if (!state.activeEvidenceId) return;
      const ok = await confirmDialog(
        'Remove evidence?',
        'The imported copy and its transcript will be removed from this case. The original file on disk is not affected.'
      );
      if (!ok) return;
      try {
        await call(api.evidence.remove(state.activeEvidenceId));
        state.activeEvidenceId = null;
        state.evidence = await call(api.evidence.list(state.caseRecord.case_id));
        renderEvidenceList();
        showReview(null);
        toast('Evidence removed.', 'success');
      } catch (err) {
        toast(`Remove failed: ${errText(err)}`, 'error');
      }
    });

    window.addEventListener('resize', () => renderWaveform());

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if (typing) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveTranscript();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveTranscript();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        state.store && state.store.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        state.store && state.store.undo();
      } else if (e.code === 'Space') {
        e.preventDefault();
        audio.toggle();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        audio.skip(-5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        audio.skip(5);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSegment(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSegment(1);
      }
    });
  }

  function moveSegment(delta) {
    if (!state.store || !state.store.segments.length) return;
    const segs = state.store.segments;
    let idx = state.activeSegmentId ? state.store.indexOf(state.activeSegmentId) : -1;
    idx = Math.max(0, Math.min(segs.length - 1, idx + delta));
    const seg = segs[idx];
    state.activeSegmentId = seg.segment_id;
    renderTranscript();
    playSegment(seg);
  }

  wireEvents();
  init();
})();
