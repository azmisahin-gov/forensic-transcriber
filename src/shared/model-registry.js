'use strict';

/**
 * Model registry.
 *
 * Models are never committed to the repository. Each entry documents source,
 * revision, license and checksum so a download can be verified. The checksums
 * below are the SHA-256 values published by the upstream Hugging Face
 * repositories (LFS object ids) and were re-verified during development.
 *
 * See docs/model-notes.md for the full provenance record.
 */

const MODEL_REGISTRY = [
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Whisper large-v3-turbo (q5_0)',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    kind: 'asr',
    sizeBytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    source: 'https://huggingface.co/ggerganov/whisper.cpp',
    revision: 'main@2026-10',
    license: 'MIT (whisper.cpp); OpenAI Whisper weights MIT',
    recommended: true,
    description:
      'Recommended default. Near large-v3 Turkish accuracy with roughly twice the throughput; fits comfortably in 6 GB VRAM.',
  },
  {
    id: 'large-v3-turbo-q8_0',
    label: 'Whisper large-v3-turbo (q8_0)',
    fileName: 'ggml-large-v3-turbo-q8_0.bin',
    kind: 'asr',
    sizeBytes: 874188075,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    source: 'https://huggingface.co/ggerganov/whisper.cpp',
    revision: 'main@2026-10',
    license: 'MIT (whisper.cpp); OpenAI Whisper weights MIT',
    recommended: false,
    description:
      'Higher-precision quantization. Larger download and VRAM footprint; useful when accuracy matters more than speed.',
  },
  {
    id: 'large-v3-turbo-f16',
    label: 'Whisper large-v3-turbo (f16)',
    fileName: 'ggml-large-v3-turbo.bin',
    kind: 'asr',
    sizeBytes: 1624555275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    source: 'https://huggingface.co/ggerganov/whisper.cpp',
    revision: 'main@2026-10',
    license: 'MIT (whisper.cpp); OpenAI Whisper weights MIT',
    recommended: false,
    description: 'Unquantized weights. Largest footprint, marginally different output.',
  },
  {
    id: 'small-q5_1',
    label: 'Whisper small (q5_1)',
    fileName: 'ggml-small-q5_1.bin',
    kind: 'asr',
    sizeBytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    source: 'https://huggingface.co/ggerganov/whisper.cpp',
    revision: 'main@2026-10',
    license: 'MIT (whisper.cpp); OpenAI Whisper weights MIT',
    recommended: false,
    description:
      'Small fallback model for low-memory machines. Turkish accuracy is substantially lower than large-v3-turbo.',
  },
  {
    id: 'silero-vad-5.1.2',
    label: 'Silero VAD v5.1.2',
    fileName: 'ggml-silero-v5.1.2.bin',
    kind: 'vad',
    sizeBytes: 885098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
    source: 'https://huggingface.co/ggml-org/whisper-vad',
    revision: 'main@2026-10',
    license: 'MIT (Silero VAD)',
    recommended: true,
    description: 'Voice activity detection used to tighten segment boundaries to the original timeline.',
  },
];

const DEFAULT_ASR_MODEL_ID = 'large-v3-turbo-q5_0';
const DEFAULT_VAD_MODEL_ID = 'silero-vad-5.1.2';

function getModel(id) {
  return MODEL_REGISTRY.find((m) => m.id === id) || null;
}

module.exports = {
  MODEL_REGISTRY,
  DEFAULT_ASR_MODEL_ID,
  DEFAULT_VAD_MODEL_ID,
  getModel,
};
