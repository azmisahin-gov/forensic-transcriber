'use strict';

/**
 * Download links point directly at the tested release assets through GitHub's
 * stable "latest/download" path, so they resolve as soon as a release exists.
 * No API call is made from the page, so no visitor data is sent anywhere.
 *
 * The asset names here must match what the release workflow publishes
 * (see .github/workflows/release.yml and package.json build.artifactName).
 */
(function () {
  const REPO = 'azmisahin-gov/forensic-transcriber';
  const LATEST = `https://github.com/${REPO}/releases/latest/download`;
  const assets = {
    'download-btn': 'ForensicTranscriber-Setup-x64.exe',
    'download-portable': 'ForensicTranscriber-Portable-x64.zip',
    'download-modelpack': 'ForensicTranscriber-ModelPack-0.1.0.zip',
  };
  for (const [id, asset] of Object.entries(assets)) {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute('href', `${LATEST}/${asset}`);
      el.setAttribute('rel', 'noopener');
    }
  }
})();
