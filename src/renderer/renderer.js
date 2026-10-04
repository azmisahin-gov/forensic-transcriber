'use strict';

/* global FT_CONSTANTS, FT_I18N, FT_FORMAT, FT_TRANSCRIPT_STORE, FT_AUDIO, FT_WAVEFORM, FT_SEARCH */
(function () {
  const { SEGMENT_STATUS } = FT_CONSTANTS;
  const { formatClock, formatBytes, formatDuration, relativeTime } = FT_FORMAT;
  const { TranscriptStore } = FT_TRANSCRIPT_STORE;
  const { AudioController } = FT_AUDIO;
  const { drawWaveform, resamplePeaks, xToTime } = FT_WAVEFORM;
  const { FILTERS, filterSegments, highlightParts } = FT_SEARCH;
  const { translate, normalize: normalizeLocale, DEFAULT_LOCALE } = FT_I18N;
  const { apply: applyTheme, normalizeTheme, normalizeAccent } = FT_THEME;

  const FLAG_OPTIONS = ['UNCLEAR', 'REVISIT', 'REVIEW'];

  const api = window.ft;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    appInfo: null,
    locale: DEFAULT_LOCALE,
    theme: normalizeTheme('light'),
    accent: normalizeAccent('blue'),
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
    dashboard: null,
    notes: [],
    findings: [],
    report: null,
    revisions: [],
    searchQuery: '',
    filter: FILTERS.ALL,
    importQueue: [],
    importActive: false,
  };

  /** Translate with the active locale. */
  function t(key, vars) {
    return translate(state.locale, key, vars);
  }

  /**
   * Apply every `data-i18n` / `data-i18n-attr` node in the document. Called once
   * on boot and whenever the language changes, so the static markup follows the
   * selected locale without a per-button maintenance burden.
   */
  function applyTranslations() {
    document.documentElement.lang = state.locale;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.getAttribute('data-i18n'));
    }
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      const spec = el.getAttribute('data-i18n-attr') || '';
      for (const pair of spec.split(',')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
  }

  // ------------------------------------------------------------- appearance
  /** Reflect the active theme/accent on the document root and the switches. */
  function renderPrefControls() {
    const applied = applyTheme(document.documentElement, { theme: state.theme, accent: state.accent });
    state.theme = applied.theme;
    state.accent = applied.accent;
    const light = $('#btn-theme-light');
    const dark = $('#btn-theme-dark');
    if (light) light.classList.toggle('active', state.theme === 'light');
    if (dark) dark.classList.toggle('active', state.theme === 'dark');
    for (const dot of document.querySelectorAll('.accent-dots button[data-accent]')) {
      dot.classList.toggle('active', dot.getAttribute('data-accent') === state.accent);
    }
  }

  async function setTheme(theme) {
    state.theme = normalizeTheme(theme);
    renderPrefControls();
    try { await call(api.preferences.set('theme', state.theme)); } catch { /* best-effort */ }
  }

  async function setAccent(accent) {
    state.accent = normalizeAccent(accent);
    renderPrefControls();
    try { await call(api.preferences.set('accent', state.accent)); } catch { /* best-effort */ }
  }

  async function setLocale(locale) {
    state.locale = normalizeLocale(locale);
    const sel = $('#select-locale');
    if (sel) sel.value = state.locale;
    applyTranslations();
    renderDashboard();
    renderWorkflow();
    renderRuntimePanel();
    renderCaseList();
    try {
      await call(api.preferences.set('locale', state.locale));
    } catch {
      /* preference persistence is best-effort; the in-memory locale still applies */
    }
  }

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
      markBootFailed(`app.info failed: ${errText(err)}`);
      toast(`${t('error.startup')}: ${errText(err)}`, 'error');
      return;
    }
    $('#scope-label').textContent = state.appInfo.scope;
    const versionEl = $('#app-version');
    if (versionEl) versionEl.textContent = `v${state.appInfo.version}`;
    updateModelBadge();
    // Locale must be resolved before the first dynamic render so counts and
    // labels appear in the saved language on launch.
    try {
      const prefs = await call(api.preferences.all());
      if (prefs && prefs.locale) state.locale = normalizeLocale(prefs.locale);
      if (prefs && prefs.theme) state.theme = normalizeTheme(prefs.theme);
      if (prefs && prefs.accent) state.accent = normalizeAccent(prefs.accent);
    } catch {
      /* preferences are optional */
    }
    renderPrefControls();
    applyTranslations();
    const localeSel = $('#select-locale');
    if (localeSel) localeSel.value = state.locale;
    $('#storage-info').textContent = `${state.appInfo.storage.cases} ${t('nav.casesCount')} · ${state.appInfo.storage.evidence} ${t('nav.filesSuffix')}`;
    if (!state.appInfo.media.ffmpeg || !state.appInfo.media.ffprobe) {
      toast(t('error.ffmpegMissing'), 'error');
    }
    state.progressUnsub = api.transcribe.onProgress(handleProgress);
    api.evidence.onImportProgress(handleImportProgress);
    initUpdaterUi();
    renderRuntimePanel();
    await refreshModels();
    await refreshCases();
    markBootReady();
  }

  /**
   * Boot signal read by the packaged startup test (and useful for support).
   * It records whether the renderer script actually ran to completion, which
   * dependency globals were defined, and whether the primary controls were
   * wired to handlers. A crashed renderer leaves this object absent or failed.
   */
  function markBootReady() {
    const requiredGlobals = ['FT_CONSTANTS', 'FT_I18N', 'FT_FORMAT', 'FT_TRANSCRIPT_STORE', 'FT_AUDIO', 'FT_WAVEFORM', 'FT_SEARCH', 'FT_THEME'];
    const missingGlobals = requiredGlobals.filter((name) => typeof window[name] === 'undefined');
    const requiredControls = [
      'btn-new-case', 'btn-models', 'btn-about', 'btn-update-check',
      'btn-first-run-install', 'btn-first-run-models', 'btn-import',
      'btn-transcribe', 'btn-save', 'btn-export', 'btn-diagnostics',
      'btn-open-exports', 'btn-open-datadir', 'btn-archive-export', 'btn-archive-import',
      'btn-notes', 'btn-report', 'btn-delivery', 'btn-support', 'btn-edit-case',
      'select-locale', 'btn-theme-light', 'btn-theme-dark',
    ];
    const wired = window.__FT_WIRED_CONTROLS__ || new Set();
    const controls = {};
    let unwired = 0;
    for (const id of requiredControls) {
      const el = document.getElementById(id);
      const isWired = Boolean(el) && wired.has(id);
      controls[id] = { present: Boolean(el), wired: isWired };
      if (!el || !isWired) unwired += 1;
    }
    window.__FT_RENDERER_STATE__ = {
      booted: true,
      failed: false,
      error: null,
      version: state.appInfo ? state.appInfo.version : null,
      locale: state.locale,
      missingGlobals,
      controls,
      unwiredControlCount: unwired,
      workflowSteps: document.querySelectorAll('#workflow-list .wf-step').length,
      runtimeChips: document.querySelectorAll('#runtime-panel .runtime-chip').length,
      modelReady: Boolean(state.appInfo && state.appInfo.modelReady),
      at: new Date().toISOString(),
    };
    // Reveal the workspace. The booting class hides it visually rather than
    // using aria-hidden on a container that holds focusable controls, which
    // browsers block and which is an accessibility anti-pattern for the root.
    const app = $('#app');
    if (app) app.classList.remove('booting');
  }

  function markBootFailed(message) {
    window.__FT_RENDERER_STATE__ = {
      booted: false,
      failed: true,
      error: String(message),
      at: new Date().toISOString(),
    };
  }

  // A fatal error before init() completes must be observable, not silent.
  window.addEventListener('error', (event) => {
    if (!window.__FT_RENDERER_STATE__ || !window.__FT_RENDERER_STATE__.booted) {
      markBootFailed(event.message || 'uncaught error during startup');
    }
  });

  // ------------------------------------------------------------------ updates
  // Application auto-update UI. It never downloads or installs on its own; the
  // user chooses to download and separately chooses to restart and install.
  const UPDATE_LABELS = {
    idle: 'update.idle',
    checking: 'update.checking',
    'not-available': 'update.notAvailable',
    available: 'update.available',
    postponed: 'update.postponed',
    downloading: 'update.downloading',
    downloaded: 'update.downloaded',
    error: 'update.error',
  };

  function initUpdaterUi() {
    api.updates.onStatus(renderUpdateState);
    api.updates.state().then((s) => {
      if (s && s.ok) renderUpdateState(s.data);
    }).catch(() => {});
  }

  function renderUpdateState(s) {
    if (!s) return;
    const statusEl = $('#update-status');
    const badge = $('#update-badge');
    const btnTop = $('#btn-update');
    const dlBtn = $('#btn-update-download');
    const postBtn = $('#btn-update-postpone');
    const instBtn = $('#btn-update-install');
    const notesBtn = $('#btn-update-release-notes');
    const progressWrap = $('#update-progress-wrap');

    statusEl.textContent = t(UPDATE_LABELS[s.status] || s.status);
    if (s.availableVersion && s.status !== 'not-available') {
      statusEl.textContent += ` (v${s.availableVersion})`;
    }

    const available = s.status === 'available';
    const postponed = s.status === 'postponed';
    const downloading = s.status === 'downloading';
    const downloaded = s.status === 'downloaded';

    badge.classList.toggle('hidden', !(available || postponed || downloaded));
    badge.textContent = downloaded ? t('update.ready') : available || postponed ? t('update.availableShort') : '';
    badge.className = `badge ${downloaded ? 'badge-ok' : 'badge-warn'}`;

    btnTop.classList.toggle('hidden', !(available || postponed || downloaded));

    dlBtn.classList.toggle('hidden', !available);
    postBtn.classList.toggle('hidden', !available);
    instBtn.classList.toggle('hidden', !downloaded);
    notesBtn.classList.toggle('hidden', !(available || postponed || downloaded));
    progressWrap.classList.toggle('hidden', !downloading);
    if (downloading) {
      $('#update-progress-bar').style.width = `${s.downloadPercent || 0}%`;
      $('#update-progress-label').textContent = `${s.downloadPercent || 0}%`;
    }

    const errEl = $('#update-error');
    if (s.status === 'error' && s.error) {
      errEl.textContent = `Update error: ${s.error}`;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
  }

  function renderDiagnostics() {
    const info = state.appInfo || {};
    const engine = info.engine || {};
    const probe = state.engineProbe;
    const dl = $('#diagnostics-info');
    if (!dl) return;
    dl.innerHTML = '';
    const rows = [
      [t('diag.appVersion'), info.version || 'unknown'],
      [t('diag.platform'), `${info.platform || ''} ${info.arch || ''}`.trim()],
      [t('diag.electronNode'), `${info.electron || ''} / ${info.node || ''}`],
      [t('diag.engine'), engine.engine || 'whisper.cpp'],
      [t('diag.engineVersion'), info.engineVersion || 'unknown'],
      [t('diag.cpuRuntime'), (probe && probe.cpuBinaryPath) || engine.binaryPath || 'unknown'],
      [t('diag.gpuBundled'), probe ? String(Boolean(probe.gpuRuntimeBundled)) : t('diag.notChecked')],
      [t('diag.gpuUsable'), probe ? String(Boolean(probe.gpuUsable)) : t('diag.notChecked')],
      [t('diag.ffmpeg'), `${Boolean(info.media && info.media.ffmpeg)} / ${Boolean(info.media && info.media.ffprobe)}`],
      [t('diag.dataDir'), info.dataDir || ''],
      [t('diag.modelsDir'), info.modelsDir || ''],
    ];
    for (const [k, v] of rows) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      wrap.append(dt, dd);
      dl.appendChild(wrap);
    }
    renderEngineStatus(state.engineProbe, state.lastRunMode);
  }

  function renderAbout() {
    const info = state.appInfo || {};
    const dl = $('#about-info');
    dl.innerHTML = '';
    const rows = [
      [t('diag.application'), `${info.name || 'Forensic Transcriber'} ${info.version || ''}`.trim()],
      [t('diag.scope'), info.scope || '56.12'],
      [t('diag.platform'), `${info.platform || ''} ${info.arch || ''}`.trim()],
      [t('diag.electronNode'), `${info.electron || ''} / ${info.node || ''}`],
      [t('diag.dataDir'), info.dataDir || ''],
      [t('diag.modelsDir'), info.modelsDir || ''],
    ];
    for (const [k, v] of rows) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      wrap.append(dt, dd);
      dl.appendChild(wrap);
    }
  }

  function updateModelBadge() {
    const badge = $('#model-badge');
    if (state.appInfo && state.appInfo.modelReady) {
      badge.textContent = t('badge.modelReady');
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = t('badge.modelMissing');
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
    const diag = $('#diagnostics-engine-status');
    if (!el && !diag) return;
    const parts = [];
    if (!probe) {
      parts.push(t('runtime.engineNotChecked'));
    } else {
      const cpu = probe.cpuBinary || {};
      if (!cpu.ok) {
        parts.push(t('runtime.engineUnavailable'));
      } else if (!probe.gpuRuntimeBundled) {
        parts.push(t('runtime.cpuOnly'));
      } else {
        const gpu = probe.gpuBinary || {};
        if (gpu.cudaCapable && gpu.gpuDeviceFound) {
          parts.push(t('runtime.cudaDetected', { name: gpu.gpuName || 'GPU' }));
        } else if (gpu.cudaCapable) {
          parts.push(t('runtime.cudaNoDevice'));
        } else {
          parts.push(t('runtime.gpuNotCuda'));
        }
      }
    }
    if (lastRun) {
      parts.push(lastRun.mode === 'gpu' ? t('runtime.lastGpu') : t('runtime.lastCpu', { reason: lastRun.reason || 'fallback' }));
    }
    const text = parts.join(' ');
    const cls = `engine-status small ${probe && probe.gpuUsable ? 'ok' : 'muted'}`;
    if (el) { el.textContent = text; el.className = cls; }
    if (diag) { diag.textContent = text; diag.className = cls; }
    renderRuntimePanel();
  }

  /**
   * Distinguish three separate facts that must never be conflated: whether a GPU
   * runtime is *available*, which runtime was *selected* for the last run, and
   * which one was *actually used*. The presence of an NVIDIA device is never
   * treated as GPU support on its own.
   */
  function renderRuntimePanel() {
    const wrap = $('#runtime-panel');
    if (!wrap) return;
    wrap.innerHTML = '';
    const probe = state.engineProbe;
    const gpuAvailable = Boolean(probe && probe.gpuRuntimeBundled && probe.gpuBinary && probe.gpuBinary.cudaCapable && probe.gpuBinary.gpuDeviceFound);
    const used = state.lastRunMode ? (state.lastRunMode.mode === 'gpu' ? t('runtime.gpu') : t('runtime.cpu')) : t('runtime.notRun');
    const rows = [
      [t('runtime.available'), gpuAvailable ? t('runtime.gpu') : t('runtime.cpu'), gpuAvailable ? 'ok' : ''],
      [t('runtime.selected'), $('#chk-gpu') && $('#chk-gpu').checked && gpuAvailable ? t('runtime.gpu') : t('runtime.cpu'), ''],
      [t('runtime.used'), used, state.lastRunMode && state.lastRunMode.mode === 'gpu' ? 'ok' : ''],
    ];
    for (const [label, value, cls] of rows) {
      const chip = document.createElement('span');
      chip.className = `runtime-chip${cls ? ` ${cls}` : ''}`;
      const l = document.createElement('span');
      l.className = 'runtime-chip-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'runtime-chip-value';
      v.textContent = value;
      chip.append(l, v);
      wrap.appendChild(chip);
    }
  }

  async function checkEngine(force = false) {
    try {
      const probe = await call(api.app.probeEngine(force));
      state.engineProbe = probe;
      renderEngineStatus(probe, state.appInfo && state.appInfo.lastRunMode);
      return probe;
    } catch (err) {
      renderEngineStatus(null, null);
      toast(`${t('error.engineCheck')}: ${errText(err)}`, 'error');
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
    renderFirstRun(ready);
    // Once a verified model exists, probe the engine so the operator can see
    // whether the binary is CUDA-capable and which device was selected.
    if (ready && !state.engineProbe) {
      checkEngine(false).catch(() => {});
    } else {
      renderEngineStatus(state.engineProbe, state.lastRunMode);
    }
  }

  /** Make the "install a model first" step obvious on first launch. */
  function renderFirstRun(ready) {
    const el = $('#first-run-model');
    if (!el) return;
    el.classList.toggle('hidden', ready);
  }

  function renderModelDialog() {
    const list = $('#model-list');
    list.innerHTML = '';
    for (const m of state.models) {
      const row = document.createElement('div');
      row.className = 'model-row';
      const status = m.installed
        ? m.verified
          ? `<span class="badge badge-ok">${t('models.verified')}</span>`
          : `<span class="badge badge-warn">${t('models.checksumMismatch')}</span>`
        : `<span class="badge badge-warn">${t('models.notInstalled')}</span>`;
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
        dl.textContent = m.installed ? t('models.reinstall') : t('models.install');
        dl.addEventListener('click', () => installModel(m.id, dl));
        actions.appendChild(dl);

        const imp = document.createElement('button');
        imp.className = 'btn btn-small';
        imp.textContent = t('models.importFile');
        imp.addEventListener('click', () => importModelFile(m.id));
        actions.appendChild(imp);
      }
      list.appendChild(row);
    }
  }

  async function installModel(modelId, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = t('models.downloading');
    resetModelProgress();
    try {
      await call(api.models.install(modelId));
      const result = $('#model-progress-result');
      if (result) result.textContent = `✓ ${t('models.installedOk')} ✓ SHA-256 ✓ ${t('models.verified')}`;
      toast(t('models.installedOk'), 'success');
    } catch (err) {
      const wrap = $('#model-progress');
      if (wrap) wrap.classList.remove('hidden');
      const result = $('#model-progress-result');
      if (result) result.textContent = `${t('error.modelInstallFailed')}: ${errText(err)}`;
      toast(`${t('error.modelInstallFailed')}: ${errText(err)}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
      await refreshModels();
    }
  }

  async function importModelFile(modelId) {
    try {
      const res = await call(api.models.importFile(modelId));
      if (res && res.canceled) return;
      toast(t('msg.modelImported'), 'success');
    } catch (err) {
      toast(`${t('error.modelImport')}: ${errText(err)}`, 'error');
    } finally {
      await refreshModels();
    }
  }

  // ----------------------------------------------------------------- case list
  async function refreshCases() {
    try {
      state.cases = await call(api.cases.list());
    } catch (err) {
      toast(`${t('error.listCases')}: ${errText(err)}`, 'error');
      return;
    }
    renderCaseList();
    updateStorageInfo();
    if (state.caseRecord) await refreshDashboard();
  }

  /**
   * The counts in the sidebar must reflect the live list, not a snapshot taken
   * once at startup. Previously the header showed "0 cases · 0 files" while the
   * list beside it already showed cases and files.
   */
  function updateStorageInfo() {
    const el = $('#storage-info');
    if (!el) return;
    const caseCount = state.cases.length;
    const fileCount = state.cases.reduce((n, c) => n + (Number(c.evidence_count) || 0), 0);
    el.textContent = `${caseCount} ${t('nav.casesCount')} · ${fileCount} ${t('nav.filesSuffix')}`;
  }

  function renderCaseList() {
    const ul = $('#case-list');
    ul.innerHTML = '';
    if (!state.cases.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.style.padding = '10px';
      li.textContent = t('nav.noCases');
      ul.appendChild(li);
      return;
    }
    for (const c of state.cases) {
      const li = document.createElement('li');
      const active = state.caseRecord && state.caseRecord.case_id === c.case_id;
      li.className = `case-item${active ? ' active' : ''}`;
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = c.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const line = [
        c.file_number || null,
        c.authority || null,
        `${c.evidence_count} ${t('nav.filesSuffix')}`,
      ].filter(Boolean).join(' · ');
      meta.textContent = line;
      const sub = document.createElement('div');
      sub.className = 'meta sub';
      sub.textContent = `${t('dash.lastActivity')}: ${relativeTime(c.updated_at)}${c.due_date ? ` · ${t('dash.deadline')}: ${c.due_date}` : ''}`;
      li.append(title, meta, sub);
      li.addEventListener('click', () => openCase(c.case_id));
      ul.appendChild(li);
    }
  }

  function caseSubtitle(c) {
    const parts = [c.case_id];
    if (c.file_number) parts.push(c.file_number);
    if (c.authority) parts.push(c.authority);
    if (c.due_date) parts.push(`${t('dash.deadline')}: ${c.due_date}`);
    return parts.join(' · ');
  }

  async function openCase(caseId) {
    if (state.store && state.store.dirty) {
      const ok = await confirmDialog(t('unsaved.discardTitle'), t('unsaved.discardBody'));
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
      state.searchQuery = '';
      $('#empty-state').classList.add('hidden');
      $('#case-view').classList.remove('hidden');
      $('#case-title').textContent = state.caseRecord.title;
      $('#case-subtitle').textContent = caseSubtitle(state.caseRecord);
      renderEvidenceList();
      showReview(null);
      renderCaseList();
      $('#btn-save').disabled = true;
      $('#btn-export').disabled = true;
      reportIntegrity(data.integrity, data.databaseHealth);
      await refreshDashboard();
    } catch (err) {
      toast(`${t('case.openFailed')}: ${errText(err)}`, 'error');
    }
  }

  // --------------------------------------------------------------- dashboard
  async function refreshDashboard() {
    if (!state.caseRecord) return;
    try {
      state.dashboard = await call(api.cases.dashboard(state.caseRecord.case_id));
    } catch (err) {
      state.dashboard = null;
    }
    renderDashboard();
  }

  function renderDashboard() {
    const grid = $('#dash-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const d = state.dashboard;
    $('#dash-updated').textContent = d ? `${t('dash.lastActivity')}: ${relativeTime(d.updated_at)}` : '';
    if (!d) return;
    const integrityOk = !(d.failed_runs > 0);
    const rows = [
      ['evidence', t('dash.evidence'), d.evidence, ''],
      ['transcribed', t('dash.transcribed'), `${d.transcribed}/${d.evidence}`, d.transcribed === d.evidence && d.evidence > 0 ? 'ok' : ''],
      ['reviewed', t('dash.reviewed'), d.reviewed, ''],
      ['verified', t('dash.verified'), d.verified, d.verified > 0 ? 'ok' : ''],
      ['unclear', t('dash.unclear'), d.unclear_segments, d.unclear_segments > 0 ? 'warn' : ''],
      ['report', t('dash.report'), d.has_report ? '✓' : '—', d.has_report ? 'ok' : 'warn'],
      ['delivery', t('dash.delivery'), d.deliveries > 0 ? d.deliveries : '—', d.deliveries > 0 ? 'ok' : ''],
      ['deadline', t('dash.deadline'), d.due_date || t('dash.noDeadline'), deadlineClass(d.due_date)],
      ['integrity', t('dash.integrity'), integrityOk ? t('dash.integrityOk') : `${d.failed_runs}`, integrityOk ? 'ok' : 'warn'],
      ['notes', t('dash.notes'), d.notes, ''],
      ['findings', t('dash.findings'), d.findings, d.findings > 0 ? 'ok' : ''],
      ['revisions', t('dash.revisions'), d.revisions, ''],
      ['reportRevisions', t('dash.reportRevisions'), d.report_revisions, ''],
      ['missingFields', t('dash.missingFields'), d.missing_assignment_fields, d.missing_assignment_fields > 0 ? 'warn' : 'ok'],
    ];
    for (const [metric, label, value, cls] of rows) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (cls) dd.className = cls;
      if (metric) dd.dataset.metric = metric;
      dd.textContent = String(value);
      wrap.append(dt, dd);
      grid.appendChild(wrap);
    }
    renderWorkflow();
  }

  function deadlineClass(dueDate) {
    if (!dueDate) return 'warn';
    const due = new Date(`${dueDate}T23:59:59`);
    if (Number.isNaN(due.getTime())) return '';
    const days = (due.getTime() - Date.now()) / 86400000;
    if (days < 0) return 'bad';
    if (days <= 3) return 'warn';
    return 'ok';
  }

  /**
   * The eight-step expert workflow (Görevlendirme → Teslim). Step status is
   * derived from the live dashboard counts so it always matches the case, and
   * the first step that still has work is marked as the current step.
   */
  function renderWorkflow() {
    const ol = $('#workflow-list');
    if (!ol) return;
    ol.innerHTML = '';
    const d = state.dashboard;
    const steps = [
      { n: '01', label: t('workflow.01'), status: !d ? 'pending' : d.missing_assignment_fields === 0 ? 'done' : 'current' },
      { n: '02', label: t('workflow.02'), status: !d || d.evidence === 0 ? 'current' : 'done' },
      { n: '03', label: t('workflow.03'), status: !d || d.evidence === 0 ? 'pending' : d.transcribed === d.evidence ? 'done' : 'current' },
      { n: '04', label: t('workflow.04'), status: !d || d.transcribed === 0 ? 'pending' : d.reviewed + d.verified >= d.transcribed ? 'done' : 'current' },
      { n: '05', label: t('workflow.05'), status: !d || d.transcribed === 0 ? 'pending' : d.unclear_segments > 0 ? 'warn' : d.reviewed + d.verified >= d.transcribed ? 'done' : 'current' },
      { n: '06', label: t('workflow.06'), status: !d ? 'pending' : d.has_report ? 'done' : d.transcribed > 0 ? 'current' : 'pending' },
      { n: '07', label: t('workflow.07'), status: !d ? 'pending' : d.failed_runs > 0 ? 'warn' : d.has_report ? 'current' : 'pending' },
      { n: '08', label: t('workflow.08'), status: !d ? 'pending' : d.deliveries > 0 ? 'done' : d.has_report ? 'current' : 'pending' },
    ];
    for (const step of steps) {
      const li = document.createElement('li');
      li.className = `wf-step ${step.status}`;
      const num = document.createElement('span');
      num.className = 'wf-num';
      num.textContent = step.n;
      const label = document.createElement('span');
      label.className = 'wf-label';
      label.textContent = step.label;
      const badge = document.createElement('span');
      badge.className = 'wf-badge';
      badge.textContent = t(`workflow.${step.status === 'current' ? 'current' : step.status === 'warn' ? 'warn' : step.status === 'done' ? 'done' : 'pending'}`);
      li.append(num, label, badge);
      ol.appendChild(li);
    }
  }

  // ------------------------------------------------------------- case intake
  function openCaseEdit() {
    if (!state.caseRecord) return;
    const c = state.caseRecord;
    $('#edit-case-title').value = c.title || '';
    $('#edit-case-file-number').value = c.file_number || '';
    $('#edit-case-authority').value = c.authority || '';
    $('#edit-case-type').value = c.case_type || '';
    $('#edit-case-assignment-date').value = c.assignment_date || '';
    $('#edit-case-due').value = c.due_date || '';
    $('#edit-case-scope').value = c.scope || '';
    $('#edit-case-description').value = c.assignment_description || '';
    $('#edit-case-questions').value = c.requested_questions || '';
    $('#dialog-case-edit').showModal();
  }

  async function saveCaseEdit() {
    if (!state.caseRecord) return;
    const patch = {
      title: $('#edit-case-title').value.trim() || state.caseRecord.title,
      file_number: $('#edit-case-file-number').value.trim(),
      authority: $('#edit-case-authority').value.trim(),
      case_type: $('#edit-case-type').value.trim(),
      assignment_date: $('#edit-case-assignment-date').value || null,
      due_date: $('#edit-case-due').value || null,
      scope: $('#edit-case-scope').value.trim(),
      assignment_description: $('#edit-case-description').value.trim(),
      requested_questions: $('#edit-case-questions').value.trim(),
    };
    try {
      state.caseRecord = await call(api.cases.update(state.caseRecord.case_id, patch));
      $('#case-title').textContent = state.caseRecord.title;
      $('#case-subtitle').textContent = `${state.caseRecord.case_id} · ${state.caseRecord.notes || 'no notes'}`;
      await refreshCases();
      await refreshDashboard();
      toast(t('msg.caseSaved'), 'success');
    } catch (err) {
      toast(`${t('error.saveCase')}: ${errText(err)}`, 'error');
    }
  }

  // ---------------------------------------------------------------- notes
  async function openNotes() {
    if (!state.caseRecord) return;
    try {
      state.notes = await call(api.notes.list(state.caseRecord.case_id));
    } catch (err) {
      state.notes = [];
    }
    renderNotes();
    $('#note-body').value = '';
    $('#note-category').value = '';
    $('#dialog-notes').showModal();
  }

  function renderNotes() {
    const ul = $('#notes-list');
    ul.innerHTML = '';
    if (!state.notes.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = t('note.empty');
      ul.appendChild(li);
      return;
    }
    for (const n of state.notes) {
      const li = document.createElement('li');
      li.className = 'note-row';
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = n.body;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const stamp = document.createElement('span');
      const where = n.at_seconds != null ? ` · ${formatClock(n.at_seconds)}` : '';
      stamp.textContent = `${n.kind === 'BOOKMARK' ? `${t('note.bookmark')} · ` : ''}${new Date(n.created_at).toLocaleString()}${where}`;
      meta.appendChild(stamp);
      if (n.category) {
        const cat = document.createElement('span');
        cat.className = 'cat';
        cat.textContent = n.category;
        meta.appendChild(cat);
      }
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      meta.appendChild(spacer);
      const del = actionButton(t('note.delete'), async () => {
        try {
          await call(api.notes.remove(n.note_id));
          state.notes = state.notes.filter((x) => x.note_id !== n.note_id);
          renderNotes();
          await refreshDashboard();
        } catch (err) {
          toast(`${t('error.deleteNote')}: ${errText(err)}`, 'error');
        }
      });
      meta.appendChild(del);
      li.append(body, meta);
      ul.appendChild(li);
    }
  }

  async function addNote() {
    if (!state.caseRecord) return;
    const body = $('#note-body').value.trim();
    if (!body) {
      toast(t('error.writeFirst'), 'error');
      return;
    }
    try {
      const note = await call(api.notes.create(state.caseRecord.case_id, {
        body,
        category: $('#note-category').value.trim() || null,
        evidenceId: state.activeEvidenceId || null,
        atSeconds: audio ? audio.currentTime : null,
      }));
      state.notes.push(note);
      renderNotes();
      $('#note-body').value = '';
      $('#note-category').value = '';
      await refreshDashboard();
    } catch (err) {
      toast(`${t('error.addNote')}: ${errText(err)}`, 'error');
    }
  }

  // ---------------------------------------------------------------- report
  async function openReport() {
    if (!state.caseRecord) return;
    $('#dialog-report').showModal();
    await refreshChecklist();
    await renderReportRevisions();
  }

  async function refreshChecklist() {
    const ul = $('#report-checklist');
    ul.innerHTML = '';
    try {
      const checklist = await call(api.report.checklist(state.caseRecord.case_id));
      for (const item of checklist.items) {
        const li = document.createElement('li');
        const stateEl = document.createElement('span');
        const cls = item.manual ? 'manual' : item.status === 'ok' ? 'ok' : 'pending';
        stateEl.className = `state ${cls}`;
        stateEl.textContent = item.manual ? 'manual' : item.status === 'ok' ? 'ok' : 'pending';
        const label = document.createElement('span');
        label.textContent = item.label;
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.detail || '';
        li.append(stateEl, label, detail);
        ul.appendChild(li);
      }
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = `Checklist unavailable: ${errText(err)}`;
      ul.appendChild(li);
    }
  }

  async function exportReport() {
    if (!state.caseRecord) return;
    try {
      const res = await call(api.report.export(state.caseRecord.case_id, {}));
      toast(t('msg.reportWritten', { n: res.files.length }), 'success');
      const open = await confirmDialog(t('confirm.openExportsTitle'), t('confirm.openExportsBody'));
      if (open) await call(api.exports.reveal(state.caseRecord.case_id));
    } catch (err) {
      toast(`${t('error.reportExport')}: ${errText(err)}`, 'error');
    }
  }

  // Every report save appends an immutable revision. Restoring one makes it the
  // working draft again without deleting the newer snapshots.
  async function renderReportRevisions() {
    const ul = $('#report-revisions');
    if (!ul || !state.caseRecord) return;
    ul.innerHTML = '';
    let revisions = [];
    try {
      revisions = await call(api.report.revisions(state.caseRecord.case_id));
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = errText(err);
      ul.appendChild(li);
      return;
    }
    if (!revisions.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = t('report.noRevisions');
      ul.appendChild(li);
      return;
    }
    for (const rev of revisions) {
      const li = document.createElement('li');
      li.className = 'revision-row';
      const label = document.createElement('span');
      label.className = 'rev-state';
      label.textContent = `${rev.state}${rev.is_current ? ` · ${t('report.current')}` : ''}`;
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = `${rev.title || '—'} · ${new Date(rev.created_at).toLocaleString()}`;
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      li.append(label, meta, spacer);
      if (!rev.is_current) {
        li.appendChild(actionButton(t('report.restore'), async () => {
          try {
            await call(api.report.setRevision(state.caseRecord.case_id, rev.revision_id));
            toast(t('msg.reportRevisionRestored'), 'success');
            await refreshChecklist();
            await renderReportRevisions();
          } catch (err) {
            toast(`${t('error.reportRevision')}: ${errText(err)}`, 'error');
          }
        }));
      }
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- findings
  async function openFindings() {
    if (!state.caseRecord) return;
    $('#dialog-findings').showModal();
    await loadFindings();
  }

  async function loadFindings() {
    try {
      state.findings = await call(api.findings.list(state.caseRecord.case_id));
    } catch (err) {
      state.findings = [];
    }
    renderFindings();
    $('#finding-title').value = '';
    $('#finding-observation').value = '';
    $('#finding-at').value = audio ? String(audio.currentTime.toFixed(1)) : '';
  }

  function renderFindings() {
    const ul = $('#findings-list');
    ul.innerHTML = '';
    if (!state.findings.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = t('finding.empty');
      ul.appendChild(li);
      return;
    }
    for (const f of state.findings) {
      const li = document.createElement('li');
      li.className = 'finding-row';
      const title = document.createElement('div');
      title.className = 'body';
      title.textContent = f.title || '—';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const bits = [];
      if (f.evidence_id) bits.push(f.evidence_id);
      if (f.at_seconds != null) bits.push(formatClock(f.at_seconds));
      bits.push(new Date(f.created_at).toLocaleString());
      const stamp = document.createElement('span');
      stamp.textContent = bits.join(' · ');
      meta.appendChild(stamp);
      if (f.observation) {
        const obs = document.createElement('span');
        obs.className = 'cat';
        obs.textContent = f.observation;
        meta.appendChild(obs);
      }
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      meta.appendChild(spacer);
      meta.appendChild(actionButton(t('note.delete'), async () => {
        try {
          await call(api.findings.remove(f.finding_id));
          state.findings = state.findings.filter((x) => x.finding_id !== f.finding_id);
          renderFindings();
          await refreshDashboard();
        } catch (err) {
          toast(`${t('error.findingDelete')}: ${errText(err)}`, 'error');
        }
      }));
      li.append(title, meta);
      ul.appendChild(li);
    }
  }

  async function addFinding() {
    if (!state.caseRecord) return;
    const title = $('#finding-title').value.trim();
    if (!title) {
      toast(t('error.writeFirst'), 'error');
      return;
    }
    const atRaw = $('#finding-at').value.trim();
    // Bind the finding to the transcript revision it was observed against, so a
    // later machine run cannot silently re-attach it to different text.
    let revisionId = null;
    if (state.activeEvidenceId) {
      try {
        const revs = await call(api.transcript.revisions(state.caseRecord.case_id, state.activeEvidenceId));
        revisionId = revs && revs.currentRevision ? revs.currentRevision.revision_id : null;
      } catch (err) {
        revisionId = null;
      }
    }
    try {
      const finding = await call(api.findings.create(state.caseRecord.case_id, {
        title,
        observation: $('#finding-observation').value.trim(),
        evidenceId: state.activeEvidenceId || null,
        revisionId,
        atSeconds: atRaw === '' ? null : Number(atRaw),
      }));
      state.findings.push(finding);
      renderFindings();
      $('#finding-title').value = '';
      $('#finding-observation').value = '';
      await refreshDashboard();
    } catch (err) {
      toast(`${t('error.findingAdd')}: ${errText(err)}`, 'error');
    }
  }

  // ------------------------------------------------------------ case search
  function openCaseSearch() {
    if (!state.caseRecord) return;
    $('#dialog-search').showModal();
    $('#case-search-input').focus();
  }

  async function runCaseSearch() {
    const query = $('#case-search-input').value.trim();
    const ul = $('#case-search-results');
    ul.innerHTML = '';
    if (!query) return;
    try {
      const res = await call(api.search.case(state.caseRecord.case_id, query));
      if (!res.hits.length) {
        const li = document.createElement('li');
        li.className = 'muted small';
        li.textContent = t('search.noResults');
        ul.appendChild(li);
        return;
      }
      for (const hit of res.hits) {
        const li = document.createElement('li');
        li.className = 'search-row';
        const type = document.createElement('span');
        type.className = 'rev-state';
        type.textContent = hit.type;
        const text = document.createElement('span');
        text.className = 'body';
        const where = hit.start != null ? `${formatClock(hit.start)} · ` : '';
        text.textContent = `${where}${hit.snippet || hit.body || hit.text || ''}`;
        li.append(type, text);
        if (hit.evidence_id) {
          li.appendChild(actionButton(t('search.open'), async () => {
            $('#dialog-search').close();
            await selectEvidence(hit.evidence_id);
          }));
        }
        ul.appendChild(li);
      }
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = `${t('error.search')}: ${errText(err)}`;
      ul.appendChild(li);
    }
  }

  async function prepareUyap() {
    if (!state.caseRecord) return;
    try {
      const res = await call(api.uyap.prepare(state.caseRecord.case_id, {}));
      toast(t('msg.uyapPrepared', { n: res.files.length }), 'success');
      const open = await confirmDialog(t('confirm.openExportsTitle'), t('confirm.openExportsBody'));
      if (open) await call(api.exports.reveal(state.caseRecord.case_id));
    } catch (err) {
      toast(`${t('error.uyap')}: ${errText(err)}`, 'error');
    }
  }

  // ---------------------------------------------------------------- delivery
  async function runDelivery() {
    if (!state.caseRecord) return;
    try {
      const res = await call(api.delivery.build(state.caseRecord.case_id, {
        includeEvidence: $('#chk-delivery-evidence').checked,
      }));
      if (res && res.canceled) return;
      toast(t('msg.deliveryWritten', { size: formatBytes(res.bytes) }), 'success');
      await refreshDashboard();
    } catch (err) {
      toast(`${t('error.delivery')}: ${errText(err)}`, 'error');
    }
  }

  // ---------------------------------------------------------------- support
  async function runSupportBundle() {
    try {
      const res = await call(api.diagnostics.bundle({}));
      if (res && res.canceled) return;
      toast(t('msg.supportWritten', { size: formatBytes(res.bytes) }), 'success');
    } catch (err) {
      toast(`${t('error.support')}: ${errText(err)}`, 'error');
    }
  }

  /**
   * P0: surface evidence or database integrity drift. This is a warning only —
   * the app never silently re-hashes an evidence file or edits the database.
   */
  function reportIntegrity(integrity, databaseHealth) {
    if (databaseHealth && databaseHealth.ok === false) {
      toast(t('msg.dbIntegrity'), 'error');
    }
    if (!Array.isArray(integrity)) return;
    const bad = integrity.filter((i) => i.status !== 'OK');
    if (!bad.length) return;
    const names = bad
      .map((b) => {
        const ev = state.evidence.find((e) => e.evidence_id === b.evidence_id);
        return `${ev ? ev.original_name : b.evidence_id} (${b.status})`;
      })
      .join(', ');
    toast(t('msg.integrityWarning', { names }), 'error');
  }

  async function backUpCase() {
    if (!state.caseRecord) return;
    try {
      const res = await call(api.cases.archiveExport(state.caseRecord.case_id));
      if (res && res.canceled) return;
      toast(t('msg.backupDone', { bytes: res.bytes, sha: res.sha256.slice(0, 16) }), 'success');
    } catch (err) {
      toast(`${t('error.backup')}: ${errText(err)}`, 'error');
    }
  }

  async function restoreCase() {
    try {
      const res = await call(api.cases.archiveImport());
      if (res && res.canceled) return;
      await refreshCases();
      toast(t('msg.caseRestored'), 'success');
      await openCase(res.caseId);
    } catch (err) {
      toast(`${t('error.restore')}: ${errText(err)}`, 'error');
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
      li.textContent = t('evidence.none');
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
      meta.textContent = `${formatBytes(ev.size_bytes)} · ${ev.duration_seconds ? formatDuration(ev.duration_seconds) : t('evidence.unknownLength')}`;
      li.append(name, meta);
      li.addEventListener('click', () => selectEvidence(ev.evidence_id));
      ul.appendChild(li);
    }
  }

  async function importPaths(paths) {
    if (!state.caseRecord) {
      toast(t('import.needCase'), 'error');
      return;
    }
    if (!paths || !paths.length) return;
    // Show the import queue with per-file status from the real import events.
    state.importQueue = paths.map((p) => ({ path: p, name: baseName(p), stage: 'queued', error: null }));
    state.importActive = true;
    renderImportQueue();
    $('#dialog-import-progress').showModal();
    await runImport(paths);
  }

  function baseName(p) {
    return String(p).split(/[\\/]/).pop();
  }

  function renderImportQueue() {
    const ul = $('#import-queue');
    if (!ul) return;
    ul.innerHTML = '';
    let done = 0;
    for (const item of state.importQueue) {
      const li = document.createElement('li');
      li.className = `import-row ${item.stage}`;
      const name = document.createElement('span');
      name.className = 'import-name';
      name.textContent = item.name;
      const status = document.createElement('span');
      status.className = `import-status ${item.stage}`;
      status.textContent = t(`progress.${item.stage === 'queued' ? 'queued' : item.stage}`);
      li.append(name, status);
      if (item.error) {
        const detail = document.createElement('span');
        detail.className = 'import-error small';
        detail.textContent = item.error.message || '';
        li.appendChild(detail);
      }
      ul.appendChild(li);
      if (item.stage === 'complete' || item.stage === 'failed') done += 1;
    }
    const total = state.importQueue.length;
    $('#import-overall').textContent = `${done} / ${total}`;
    $('#import-overall-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
    const failed = state.importQueue.filter((i) => i.stage === 'failed');
    $('#btn-import-retry').classList.toggle('hidden', failed.length === 0 || state.importActive);
    $('#btn-import-cancel').classList.toggle('hidden', !state.importActive);
  }

  function handleImportProgress(p) {
    if (!p || p.kind !== 'import') return;
    const item = state.importQueue[p.index];
    if (!item) return;
    item.stage = p.stage;
    if (p.error) item.error = p.error;
    renderImportQueue();
  }

  async function runImport(paths) {
    try {
      const res = await call(api.evidence.importFiles(state.caseRecord.case_id, paths));
      state.evidence = await call(api.evidence.list(state.caseRecord.case_id));
      renderEvidenceList();
      if (res.imported.length) toast(t('import.done', { n: res.imported.length }), 'success');
      if (res.failures.length) {
        toast(`${res.failures.length} ${t('progress.failed')}: ${res.failures[0].error.message}`, 'error');
      }
      const first = res.imported[0];
      if (first) selectEvidence(first.evidence_id);
    } catch (err) {
      toast(`${t('error.importFailed')}: ${errText(err)}`, 'error');
    } finally {
      state.importActive = false;
      renderImportQueue();
      await refreshDashboard();
    }
  }

  async function retryFailedImports() {
    const failed = state.importQueue.filter((i) => i.stage === 'failed');
    if (!failed.length) return;
    state.importQueue = failed.map((i) => ({ ...i, stage: 'queued', error: null }));
    state.importActive = true;
    renderImportQueue();
    await runImport(failed.map((i) => i.path));
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
    const streamCount = ev.audio_stream_count != null ? Number(ev.audio_stream_count) : null;
    const rows = [
      [t('evidence.fileName'), ev.original_name],
      [t('evidence.size'), formatBytes(ev.size_bytes)],
      [t('evidence.container'), ev.format || 'unknown'],
      [t('evidence.codec'), ev.codec || 'unknown'],
      [t('evidence.duration'), ev.duration_seconds != null ? formatClock(ev.duration_seconds) : 'unknown'],
      [t('evidence.sampleRate'), ev.sample_rate ? `${ev.sample_rate} Hz` : 'unknown'],
      [t('evidence.channels'), ev.channels != null ? String(ev.channels) : 'unknown'],
      [t('evidence.bitDepth'), ev.bit_depth ? `${ev.bit_depth} bit` : 'n/a'],
      [t('evidence.streams'), streamCount != null ? String(streamCount) : 'unknown'],
      [t('evidence.sha'), ev.sha256],
      [t('evidence.imported'), new Date(ev.imported_at).toLocaleString()],
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
    // A container with more than one audio stream decodes stream order 0; say
    // so explicitly rather than transcribing a multi-track file silently.
    if (streamCount != null && streamCount > 1) {
      const warn = document.createElement('p');
      warn.className = 'multi-stream-warn small';
      warn.textContent = t('evidence.multiStream', { n: streamCount });
      grid.appendChild(warn);
    }
  }

  // ------------------------------------------------------------------ transcript
  async function loadTranscript(evidenceId) {
    let data = null;
    try {
      data = await call(api.transcript.get(state.caseRecord.case_id, evidenceId));
    } catch (err) {
      toast(`${t('error.loadTranscript')}: ${errText(err)}`, 'error');
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
    const visible = filterSegments(segs, state.filter, { placeholder: FT_CONSTANTS.UNCLEAR_PLACEHOLDER });
    if (!segs.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = state.transcriptMeta ? t('transcript.emptyAfter') : t('transcript.empty');
      list.appendChild(p);
    } else {
      for (const seg of visible) list.appendChild(renderSegment(seg));
      const edited = segs.filter((s) => s.status !== SEGMENT_STATUS.AUTOMATIC).length;
      stats.textContent = `${segs.length} ${t('transcript.segments')} · ${edited} ${t('transcript.humanReviewed')}`;
    }
    const note = $('#filter-note');
    if (state.filter !== FILTERS.ALL) {
      note.classList.remove('hidden');
      note.textContent = `${t('transcript.showing')} ${visible.length}/${segs.length}`;
    } else {
      note.classList.add('hidden');
    }
    $('#btn-undo').disabled = !state.store || !state.store.canUndo;
    $('#btn-redo').disabled = !state.store || !state.store.canRedo;
    $('#btn-save').disabled = !state.store || !state.store.dirty;
    $('#btn-export').disabled = !state.transcriptMeta && !(state.store && state.store.segments.length);
  }

  function renderSegment(seg) {
    const flagged = Array.isArray(seg.flags) && seg.flags.length > 0;
    const el = document.createElement('div');
    el.className = `seg ${seg.status.toLowerCase()}${flagged ? ' flagged' : ''}${state.activeSegmentId === seg.segment_id ? ' active' : ''}`;
    el.dataset.id = seg.segment_id;

    const head = document.createElement('div');
    head.className = 'seg-head';

    const startBtn = document.createElement('button');
    startBtn.className = 'ts';
    startBtn.textContent = formatClock(seg.start);
    startBtn.title = t('player.playFromHere');
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

    if (flagged) {
      const flags = document.createElement('span');
      flags.className = 'flags';
      for (const f of seg.flags) {
        const tag = document.createElement('span');
        tag.className = 'flag';
        tag.textContent = f;
        flags.appendChild(tag);
      }
      head.appendChild(flags);
    }

    if (seg.confidence != null) {
      const conf = document.createElement('span');
      conf.className = 'conf';
      conf.textContent = `${t('seg.confidence')} ${seg.confidence.toFixed(2)}`;
      conf.title = t('seg.confidenceTip');
      head.appendChild(conf);
    }

    el.appendChild(head);

    if (state.editingSegmentId === seg.segment_id) {
      // Explicit editing surface: nothing here relies on the operator guessing
      // that Ctrl+Enter saves. The Save/Cancel buttons are the primary path and
      // the keyboard equivalents are helpers.
      el.classList.add('editing');
      const ta = document.createElement('textarea');
      ta.className = 'seg-edit';
      ta.value = seg.text;
      let cancelled = false;
      const save = () => {
        state.editingSegmentId = null;
        state.store.editText(seg.segment_id, ta.value);
        toast(`${t('seg.save')} ✓`, 'success');
      };
      const cancel = () => {
        cancelled = true;
        state.editingSegmentId = null;
        renderTranscript();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      });
      el.appendChild(ta);
      const editActions = document.createElement('div');
      editActions.className = 'seg-edit-actions';
      const hint = document.createElement('span');
      hint.className = 'muted small';
      hint.textContent = t('seg.editHint');
      editActions.append(
        hint,
        actionButton(t('seg.save'), save, 'btn-primary'),
        actionButton(t('seg.cancel'), cancel)
      );
      el.appendChild(editActions);
      if (!cancelled) {
        setTimeout(() => {
          ta.focus();
          ta.selectionStart = ta.value.length;
        }, 0);
      }
    } else {
      const body = document.createElement('div');
      body.className = 'seg-body';
      const query = state.searchQuery.trim();
      if (query) {
        for (const part of highlightParts(seg.text, query)) {
          if (part.match) {
            const mark = document.createElement('mark');
            mark.textContent = part.text;
            body.appendChild(mark);
          } else {
            body.appendChild(document.createTextNode(part.text));
          }
        }
      } else {
        body.textContent = seg.text;
      }
      el.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'seg-actions';
    const flagButtons = FLAG_OPTIONS.map((flag) => {
      const active = Array.isArray(seg.flags) && seg.flags.includes(flag);
      const btn = actionButton(active ? `${flag} ✓` : flag, () => state.store.toggleFlag(seg.segment_id, flag), null, `flag-${flag}`);
      if (active) btn.classList.add('btn-primary');
      return btn;
    });
    const splitBtn = actionButton(t('seg.split'), () => splitSegment(seg), null, 'split');
    splitBtn.title = t('seg.splitTip');
    const mergeBtn = actionButton(t('seg.mergeNext'), () => mergeNext(seg), null, 'merge');
    mergeBtn.title = t('seg.mergeTip');
    actions.append(
      actionButton(t('seg.edit'), () => {
        state.editingSegmentId = seg.segment_id;
        renderTranscript();
      }, null, 'edit'),
      actionButton(t('seg.play'), () => playSegment(seg), null, 'play'),
      splitBtn,
      mergeBtn,
      actionButton(t('seg.markReviewed'), () => state.store.setStatus(seg.segment_id, SEGMENT_STATUS.REVIEWED), null, 'reviewed'),
      actionButton(t('seg.markVerified'), () => state.store.setStatus(seg.segment_id, SEGMENT_STATUS.VERIFIED), null, 'verified'),
      actionButton(t('seg.speaker'), () => cycleSpeaker(seg), null, 'speaker'),
      ...flagButtons,
      actionButton(t('seg.delete'), () => state.store.deleteSegment(seg.segment_id), null, 'delete')
    );
    el.appendChild(actions);

    el.addEventListener('click', () => {
      // Select the segment and move the playhead to its start so the audio, the
      // waveform cursor and the highlighted segment all agree. This is the core
      // audio/text sync action.
      state.activeSegmentId = seg.segment_id;
      if (state.duration > 0 && (audio.currentTime < seg.start || audio.currentTime > seg.end)) {
        audio.seek(seg.start);
      }
      renderTranscript();
      renderWaveform();
      scrollSegmentIntoView(seg.segment_id);
    });

    return el;
  }

  /**
   * Keep the active segment visible while moving through the transcript. Uses
   * scrollIntoView with block:'nearest' so following the audio never yanks the
   * whole page around.
   */
  function scrollSegmentIntoView(segmentId) {
    const el = document.querySelector(`.seg[data-id="${segmentId}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  function actionButton(label, handler, extraClass, action) {
    const b = document.createElement('button');
    b.className = `btn${extraClass ? ` ${extraClass}` : ''}`;
    b.type = 'button';
    b.textContent = label;
    if (action) b.dataset.action = action;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
    return b;
  }

  function splitSegment(seg) {
    const at = audio.currentTime > seg.start && audio.currentTime < seg.end ? audio.currentTime : (seg.start + seg.end) / 2;
    if (!state.store.splitSegment(seg.segment_id, at)) {
      toast(t('seg.split') + ': ' + t('seg.splitTip'), 'error');
    }
  }

  function mergeNext(seg) {
    if (!state.store.mergeWithNext(seg.segment_id)) toast(t('seg.mergeTip'), 'error');
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
      renderModelProgress(payload);
      return;
    }
    if (payload.kind === 'stage') {
      $('#progress-wrap').classList.remove('hidden');
      if (typeof payload.percent === 'number') $('#progress-bar').style.width = `${payload.percent}%`;
      const labels = {
        preparing: t('progress.preparing'),
        decoding: t('progress.decoding'),
        'loading-model': t('progress.loadingModel'),
        runtime: `Runtime: ${(payload.runtimeMode || 'cpu').toUpperCase()}`,
        transcribing: t('progress.transcribing'),
        done: t('progress.done'),
      };
      $('#progress-label').textContent = labels[payload.stage] || payload.stage;
    }
  }

  /**
   * Model install progress from the real download events. Every figure shown
   * (percent, downloaded/total, speed, ETA) is derived from the byte counts the
   * downloader reports — no fake timer.
   */
  let lastModelProgress = null;
  function renderModelProgress(p) {
    const wrap = $('#model-progress');
    if (!wrap) return;
    wrap.classList.remove('hidden');
    const received = Number(p.received) || 0;
    const total = Number(p.total) || 0;
    const pct = total ? Math.round((received / total) * 100) : 0;
    const now = Date.now();
    let speed = null;
    if (lastModelProgress && now > lastModelProgress.at && received >= lastModelProgress.received) {
      speed = ((received - lastModelProgress.received) / (now - lastModelProgress.at)) * 1000;
    }
    lastModelProgress = { received, at: now };
    const model = state.models.find((m) => m.id === p.modelId);
    $('#model-progress-name').textContent = model ? model.label : String(p.modelId || '');
    $('#model-progress-stage').textContent = t('progress.downloading');
    $('#model-progress-bar').style.width = `${pct}%`;
    $('#model-progress-bytes').textContent = total
      ? `${formatBytes(received)} / ${formatBytes(total)} (${pct}%)`
      : formatBytes(received);
    $('#model-progress-speed').textContent = speed && speed > 0 ? `${formatBytes(speed)}/s` : '';
    if (speed && speed > 0 && total > received) {
      const secs = Math.round((total - received) / speed);
      $('#model-progress-eta').textContent = `~${formatDuration(secs)} ${t('progress.remaining')}`;
    } else {
      $('#model-progress-eta').textContent = '';
    }
  }

  function resetModelProgress() {
    lastModelProgress = null;
    const wrap = $('#model-progress');
    if (wrap) wrap.classList.add('hidden');
  }

  async function startTranscription() {
    if (!state.caseRecord || !state.activeEvidenceId) return;
    const modelId = $('#select-model').value;
    const model = state.models.find((m) => m.id === modelId);
    if (!model || !model.installed || !model.verified) {
      toast(t('badge.modelMissing') + '. ' + t('models.install'), 'error');
      return;
    }
    state.busy = true;
    $('#btn-transcribe').disabled = true;
    $('#btn-cancel').classList.remove('hidden');
    hideTranscribeError();
    $('#progress-wrap').classList.remove('hidden');
    $('#progress-bar').style.width = '2%';
    $('#progress-label').textContent = t('progress.preparing');
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
      if (res.revisionBecameCurrent === false) {
        // The new machine transcript was stored as a separate revision so the
        // existing reviewed/edited/verified work was not overwritten. The
        // workspace still shows the human revision.
        toast(t('transcribe.preserved'), 'success');
      } else {
        toast(t('transcribe.complete', { mode: mode || 'CPU' }), 'success');
      }
    } catch (err) {
      showTranscribeError(err);
    } finally {
      state.busy = false;
      $('#btn-transcribe').disabled = false;
      $('#btn-cancel').classList.add('hidden');
      setTimeout(() => $('#progress-wrap').classList.add('hidden'), 1200);
      await refreshCases();
    }
  }

  /**
   * A failure must explain what happened, why, and what to do. The technical
   * string is available behind "Teknik ayrıntılar" rather than being the whole
   * message.
   */
  function showTranscribeError(err) {
    const box = $('#transcribe-error');
    if (!box) return;
    $('#transcribe-error-title').textContent = t('error.transcriptionFailed');
    $('#transcribe-error-body').textContent = t('error.transcriptionFailedBody');
    const codeEl = err && err.code ? ` (${err.code})` : '';
    const detail = `${err && err.message ? err.message : String(err)}${codeEl}${err && err.detail ? `\n${err.detail}` : ''}`;
    const detailEl = $('#transcribe-error-detail');
    detailEl.textContent = detail;
    detailEl.classList.add('hidden');
    box.classList.remove('hidden');
    toast(t('error.transcriptionFailed') + codeEl, 'error');
  }

  function hideTranscribeError() {
    const box = $('#transcribe-error');
    if (box) box.classList.add('hidden');
    const detail = $('#transcribe-error-detail');
    if (detail) detail.classList.add('hidden');
  }

  async function cancelTranscription() {
    try {
      await call(api.transcribe.cancel());
      toast(t('msg.cancelling'));
    } catch (err) {
      toast(`${t('error.cancelFailed')}: ${errText(err)}`, 'error');
    }
  }

  // ----------------------------------------------------------------------- save
  async function saveTranscript() {
    if (!state.store || !state.caseRecord || !state.activeEvidenceId) return;
    if (!state.store.segments.length) {
      toast(t('error.nothingToSave'), 'error');
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
      toast(t('msg.transcriptSaved'), 'success');
    } catch (err) {
      toast(`${t('error.saveFailed')}: ${errText(err)}`, 'error');
    }
  }

  // --------------------------------------------------------------------- export
  function openExportDialog() {
    if (!state.transcriptMeta && !(state.store && state.store.segments.length)) {
      toast(t('error.noTranscriptToExport'), 'error');
      return;
    }
    $('#dialog-export').showModal();
  }

  async function runExport() {
    const formats = Array.from(document.querySelectorAll('.exp-format:checked')).map((c) => c.value);
    if (!formats.length) {
      toast(t('error.selectFormat'), 'error');
      return;
    }
    if (state.store && state.store.dirty) {
      const ok = await confirmDialog(t('confirm.saveBeforeExportTitle'), t('confirm.saveBeforeExportBody'));
      if (ok) await saveTranscript();
    }
    try {
      const files = await call(
        api.exports.run(state.caseRecord.case_id, state.activeEvidenceId, { formats })
      );
      toast(t('msg.exported', { n: files.length }), 'success');
      // Keep the export folder one click away rather than a manual search.
      const reveal = await confirmDialog(
        t('confirm.openExportsTitle'),
        t('confirm.openExportsBody')
      );
      if (reveal) await openExportsFolder();
    } catch (err) {
      toast(`${t('error.exportFailed')}: ${errText(err)}`, 'error');
    }
  }

  async function openExportsFolder() {
    if (!state.caseRecord) return;
    try {
      const dir = await call(api.exports.reveal(state.caseRecord.case_id));
      toast(t('msg.exportsFolder', { dir }));
    } catch (err) {
      toast(`${t('error.openExports')}: ${errText(err)}`, 'error');
    }
  }

  // ---------------------------------------------------------------- interactions
  function wireEvents() {
    // Record control wiring so the packaged startup test can assert that the
    // primary buttons actually received a handler. addEventListener does not
    // leave an inspectable trace, so bind() records it.
    const wiredControls = new Set();
    const bind = (selector, event, handler) => {
      const el = $(selector);
      if (!el) return null;
      el.addEventListener(event, handler);
      wiredControls.add(el.id);
      return el;
    };
    window.__FT_WIRED_CONTROLS__ = wiredControls;
    bind('#btn-new-case', 'click', () => {
      $('#new-case-title').value = '';
      $('#new-case-notes').value = '';
      $('#dialog-new-case').showModal();
    });

    $('#dialog-new-case').addEventListener('close', async (e) => {
      const dlg = $('#dialog-new-case');
      if (dlg.returnValue !== 'default') return;
      const title = $('#new-case-title').value.trim();
      if (!title) {
        toast(t('error.titleRequired'), 'error');
        return;
      }
      try {
        const created = await call(api.cases.create({ title, notes: $('#new-case-notes').value }));
        await refreshCases();
        await openCase(created.case_id);
      } catch (err) {
        toast(`${t('error.createCase')}: ${errText(err)}`, 'error');
      }
    });

    $('#btn-refresh-cases').addEventListener('click', refreshCases);
    bind('#btn-open-datadir', 'click', async () => {
      try {
        const dir = await call(api.evidence.revealDataDir());
        toast(t('msg.dataDirOpened', { dir }));
      } catch (err) {
        toast(`${t('error.openDataDir')}: ${errText(err)}`, 'error');
      }
    });

    bind('#btn-import', 'click', async () => {
      try {
        const paths = await call(api.dialog.openFiles());
        await importPaths(paths);
      } catch (err) {
        toast(`${t('error.filePicker')}: ${errText(err)}`, 'error');
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
        toast(t('error.dropPaths'), 'error');
        return;
      }
      importPaths(paths);
    });

    bind('#btn-transcribe', 'click', startTranscription);
    bind('#btn-check-engine', 'click', async () => {
      toast(t('msg.engineChecking'));
      await checkEngine(true);
    });
    $('#btn-cancel').addEventListener('click', cancelTranscription);
    bind('#btn-save', 'click', saveTranscript);
    bind('#btn-export', 'click', openExportDialog);
    bind('#btn-archive-export', 'click', backUpCase);
    bind('#btn-archive-import', 'click', restoreCase);
    bind('#btn-notes', 'click', openNotes);
    bind('#btn-findings', 'click', openFindings);
    bind('#btn-report', 'click', openReport);
    bind('#btn-search', 'click', openCaseSearch);
    bind('#btn-uyap', 'click', prepareUyap);
    bind('#btn-delivery', 'click', () => $('#dialog-delivery').showModal());
    bind('#btn-support', 'click', () => $('#dialog-support').showModal());
    bind('#btn-edit-case', 'click', openCaseEdit);
    bind('#btn-add-note', 'click', addNote);
    bind('#btn-add-finding', 'click', addFinding);
    bind('#btn-case-search', 'click', runCaseSearch);
    bind('#btn-report-build', 'click', refreshChecklist);
    bind('#btn-report-export', 'click', exportReport);

    // Language selection. Default is Turkish; switching re-renders the static
    // markup and the dynamic lists without reloading the window.
    const localeSel = $('#select-locale');
    if (localeSel) {
      localeSel.addEventListener('change', (e) => setLocale(e.target.value));
      localeSel.value = state.locale;
      wiredControls.add(localeSel.id);
    }

    // Theme and accent switches. The choice is applied immediately and stored
    // locally; it never leaves the machine.
    bind('#btn-theme-light', 'click', () => setTheme('light'));
    bind('#btn-theme-dark', 'click', () => setTheme('dark'));
    for (const dot of document.querySelectorAll('.accent-dots button[data-accent]')) {
      dot.addEventListener('click', () => setAccent(dot.getAttribute('data-accent')));
    }

    // Import queue controls.
    bind('#btn-import-cancel', 'click', () => {
      // Per-file import is fast and runs to completion; the button honestly
      // reflects that there is nothing in-flight to cancel once the queue ends.
      state.importActive = false;
      renderImportQueue();
    });
    bind('#btn-import-retry', 'click', retryFailedImports);

    // Transcription failure box actions.
    bind('#btn-transcribe-retry', 'click', () => {
      hideTranscribeError();
      startTranscription();
    });
    bind('#btn-transcribe-error-details', 'click', () => {
      const d = $('#transcribe-error-detail');
      if (d) d.classList.toggle('hidden');
    });
    bind('#btn-transcribe-error-close', 'click', hideTranscribeError);

    $('#chk-gpu').addEventListener('change', renderRuntimePanel);

    $('#dialog-case-edit').addEventListener('close', async (e) => {
      if (e.target.returnValue !== 'default') return;
      await saveCaseEdit();
    });

    $('#dialog-delivery').addEventListener('close', async (e) => {
      if (e.target.returnValue !== 'default') return;
      await runDelivery();
    });

    $('#dialog-support').addEventListener('close', async (e) => {
      if (e.target.returnValue !== 'default') return;
      await runSupportBundle();
    });

    $('#select-filter').addEventListener('change', (e) => {
      state.filter = e.target.value;
      renderTranscript();
    });
    $('#search-input').addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderTranscript();
    });
    bind('#btn-open-exports', 'click', (e) => {
      e.preventDefault();
      openExportsFolder();
    });
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

    bind('#btn-models', 'click', () => $('#dialog-models').showModal());
    bind('#btn-diagnostics', 'click', () => {
      renderDiagnostics();
      $('#dialog-diagnostics').showModal();
    });
    bind('#btn-about', 'click', () => {
      renderAbout();
      $('#dialog-about').showModal();
    });
    $('#btn-update').addEventListener('click', () => {
      renderAbout();
      $('#dialog-about').showModal();
    });
    bind('#btn-update-check', 'click', async () => {
      try {
        await call(api.updates.check());
      } catch (err) {
        toast(`${t('error.updateCheck')}: ${errText(err)}`, 'error');
      }
    });
    $('#btn-update-download').addEventListener('click', async () => {
      try {
        await call(api.updates.download());
      } catch (err) {
        toast(`${t('error.updateDownload')}: ${errText(err)}`, 'error');
      }
    });
    $('#btn-update-postpone').addEventListener('click', async () => {
      try {
        await call(api.updates.postpone());
        toast(t('msg.updatePostponed'));
      } catch (err) {
        toast(`${t('error.postpone')}: ${errText(err)}`, 'error');
      }
    });
    bind('#btn-update-install', 'click', async () => {
      // P0: never restart out from under unsaved work. Offer to save first, and
      // let the user decline the update if they are not ready.
      if (state.store && state.store.dirty) {
        const save = await confirmDialog(
          t('confirm.updateUnsavedTitle'),
          t('confirm.updateUnsavedBody')
        );
        if (save) {
          await saveTranscript();
          if (state.store && state.store.dirty) {
            toast(t('error.saveFailed'), 'error');
            return;
          }
        } else {
          const proceed = await confirmDialog(
            t('confirm.updateDiscardTitle'),
            t('confirm.updateDiscardBody')
          );
          if (!proceed) return;
        }
      }
      const ok = await confirmDialog(
        t('confirm.updateRestartTitle'),
        t('confirm.updateRestartBody')
      );
      if (!ok) return;
      try {
        const res = await call(api.updates.install());
        if (res && res.ok === false) toast(t('confirm.updateNotReady'), 'error');
      } catch (err) {
        toast(`${t('error.updateStart')}: ${errText(err)}`, 'error');
      }
    });
    $('#btn-update-release-notes').addEventListener('click', () => {
      window.open('https://github.com/azmisahin-gov/forensic-transcriber/releases', '_blank', 'noopener');
    });
    bind('#btn-first-run-models', 'click', () => $('#dialog-models').showModal());
    bind('#btn-first-run-install', 'click', async (e) => {
      const btn = e.currentTarget;
      const recommended = state.models.find((m) => m.kind === 'asr' && m.recommended);
      if (!recommended) {
        toast(t('models.noneRecommended'), 'error');
        return;
      }
      btn.disabled = true;
      btn.textContent = t('models.downloading');
      resetModelProgress();
      try {
        await call(api.models.install(recommended.id));
        toast(t('models.installedOk'), 'success');
      } catch (err) {
        toast(`${t('error.modelImport')}: ${errText(err)}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = t('empty.installRecommended');
        await refreshModels();
      }
    });
    $('#dialog-models').addEventListener('close', refreshModels);

    $('#btn-reveal').addEventListener('click', () => {
      if (state.activeEvidenceId) api.evidence.reveal(state.activeEvidenceId);
    });

    $('#btn-delete-evidence').addEventListener('click', async () => {
      if (!state.activeEvidenceId) return;
      const ok = await confirmDialog(
        t('confirm.removeEvidenceTitle'),
        t('confirm.removeEvidenceBody')
      );
      if (!ok) return;
      try {
        await call(api.evidence.remove(state.activeEvidenceId));
        state.activeEvidenceId = null;
        state.evidence = await call(api.evidence.list(state.caseRecord.case_id));
        renderEvidenceList();
        showReview(null);
        toast(t('msg.evidenceRemoved'), 'success');
      } catch (err) {
        toast(`${t('error.removeEvidence')}: ${errText(err)}`, 'error');
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
      } else if (e.key === 'F2' && state.activeSegmentId) {
        e.preventDefault();
        state.editingSegmentId = state.activeSegmentId;
        renderTranscript();
      } else if (e.key === 'F3' && state.activeSegmentId) {
        e.preventDefault();
        state.store && state.store.toggleFlag(state.activeSegmentId, 'REVISIT');
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
