'use strict';

/**
 * Download links resolve to the tested release assets through GitHub's stable
 * "latest/download" path, so they are correct for every release without the
 * page hard-coding a version number. The asset names must match what the release
 * workflow publishes (see .github/workflows/release.yml and package.json
 * build.artifactName); the model package name is derived from the API rather
 * than hard-coded.
 *
 * The release version and notes are read from the public GitHub Releases API.
 * The request carries no case data and no credentials; it is the same public
 * data any browser fetches when it opens the releases page. If the request
 * fails, the page keeps its static fallback text.
 */
(function () {
  const REPO = 'azmisahin-gov/forensic-transcriber';
  const LATEST = `https://github.com/${REPO}/releases/latest/download`;

  // --- static asset links (no version needed) ------------------------------
  const assets = {
    'download-btn': 'ForensicTranscriber-Setup-x64.exe',
    'download-btn-card': 'ForensicTranscriber-Setup-x64.exe',
    'download-portable': 'ForensicTranscriber-Portable-x64.zip',
    'download-portable-card': 'ForensicTranscriber-Portable-x64.zip',
    'download-sha': 'SHA256SUMS.txt',
  };
  for (const [id, asset] of Object.entries(assets)) {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute('href', `${LATEST}/${asset}`);
      el.setAttribute('rel', 'noopener');
    }
  }

  // --- language toggle ------------------------------------------------------
  const langButtons = Array.from(document.querySelectorAll('[data-set-lang]'));
  function setLang(lang) {
    const want = lang === 'en' ? 'en' : 'tr';
    document.documentElement.lang = want;
    for (const block of document.querySelectorAll('[data-lang-block]')) {
      block.hidden = block.getAttribute('data-lang-block') !== want;
    }
    for (const btn of langButtons) {
      btn.classList.toggle('active', btn.getAttribute('data-set-lang') === want);
    }
    try {
      localStorage.setItem('ft-site-lang', want);
    } catch (_) {
      /* storage may be disabled; the page still switches for this visit */
    }
  }
  for (const btn of langButtons) {
    btn.addEventListener('click', () => setLang(btn.getAttribute('data-set-lang')));
  }
  let initial = 'tr';
  try {
    const saved = localStorage.getItem('ft-site-lang');
    if (saved) initial = saved;
    else if (navigator.language && !navigator.language.toLowerCase().startsWith('tr')) initial = 'en';
  } catch (_) {
    /* ignore */
  }
  setLang(initial);

  // --- release version + notes (derived, never hard-coded) ------------------
  const versionEl = document.getElementById('release-version');
  const versionEnEl = document.getElementById('release-version-en');
  const dateEl = document.getElementById('release-date');
  const linkEl = document.getElementById('release-link');
  const linkEnEl = document.getElementById('release-link-en');
  const notesWrap = document.getElementById('release-notes');
  const notesBody = document.getElementById('release-notes-body');

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Minimal, safe rendering of the GitHub release body: keep line breaks and
  // bullet structure as text. No HTML from the API is injected as markup.
  function renderNotes(body) {
    if (!body) return;
    const lines = String(body).split(/\r?\n/);
    const html = lines
      .map((line) => {
        const t = line.trim();
        if (!t) return '';
        if (/^#{1,6}\s/.test(t)) return `<p class="rel-h">${escapeHtml(t.replace(/^#{1,6}\s/, ''))}</p>`;
        if (/^[-*]\s+/.test(t)) return `<p class="rel-li">• ${escapeHtml(t.replace(/^[-*]\s+/, ''))}</p>`;
        return `<p>${escapeHtml(t)}</p>`;
      })
      .join('');
    notesBody.innerHTML = html;
    notesWrap.hidden = false;
  }

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !rel.tag_name) return;
      const version = String(rel.tag_name).replace(/^v/, '');
      if (versionEl) versionEl.textContent = version;
      if (versionEnEl) versionEnEl.textContent = version;
      if (dateEl && rel.published_at) {
        const d = new Date(rel.published_at);
        if (!Number.isNaN(d.getTime())) dateEl.textContent = d.toISOString().slice(0, 10);
      }
      if (linkEl) linkEl.setAttribute('href', rel.html_url);
      if (linkEnEl) linkEnEl.setAttribute('href', rel.html_url);

      const modelAsset = (rel.assets || []).find((a) => /ModelPack-.*\.zip$/i.test(a.name));
      const modelHref = modelAsset ? modelAsset.browser_download_url : `${LATEST}/ForensicTranscriber-ModelPack-${version}.zip`;
      for (const id of ['download-modelpack', 'download-modelpack-card']) {
        const el = document.getElementById(id);
        if (el) {
          el.setAttribute('href', modelHref);
          el.setAttribute('rel', 'noopener');
        }
      }

      renderNotes(rel.body);
    })
    .catch(() => {
      /* offline or rate-limited: keep the static fallback and the /releases link */
    });
})();
