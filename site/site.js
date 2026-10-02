'use strict';

/**
 * The download button points directly at the tested release asset through
 * GitHub's stable "latest/download" path. No API call is made from the page,
 * so no visitor data is sent anywhere by this site.
 */
(function () {
  const REPO = 'azmisahin-gov/forensic-transcriber';
  const ASSET = 'ForensicTranscriber-Setup-x64.exe';
  const url = `https://github.com/${REPO}/releases/latest/download/${ASSET}`;
  const btn = document.getElementById('download-btn');
  if (btn) {
    btn.setAttribute('href', url);
    btn.setAttribute('rel', 'noopener');
  }
})();
