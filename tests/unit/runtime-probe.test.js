'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRuntimeProbe, silentWavBuffer } = require('../../src/main/services/whisper');

// The samples below are synthetic strings that reproduce the exact stderr lines
// whisper.cpp v1.9.4 emits. They test the *parser*, not any particular machine.

const CPU_ONLY = `
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: gpu_device = 0
whisper_init_with_params_no_state: devices    = 1
whisper_init_with_params_no_state: backends   = 1
whisper_backend_init_gpu: device 0: CPU (type: 0)
whisper_backend_init_gpu: no GPU found
system_info: n_threads = 4 / 4 | WHISPER : VITISAI = 0 | COREML = 0 | OPENVINO = 0 | CPU : SSE3 = 1 | AVX2 = 1 | OPENMP = 1 | REPACK = 1 |
`;

const CUDA_WITH_GPU = `
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: devices    = 2
whisper_init_with_params_no_state: backends   = 2
whisper_backend_init_gpu: device 0: CPU (type: 0)
whisper_backend_init_gpu: device 1: NVIDIA GeForce RTX 3060 (type: 1)
whisper_backend_init_gpu: found GPU device 1: NVIDIA GeForce RTX 3060 (type: 1, cnt: 0)
whisper_backend_init_gpu: using CUDA0 backend
system_info: n_threads = 8 / 16 | WHISPER : VITISAI = 0 | COREML = 0 | OPENVINO = 0 | CUDA : ARCHS = 860 | USE_GRAPHS = 1 | CPU : AVX2 = 1 | OPENMP = 1 |
`;

const CUDA_NO_GPU_PRESENT = `
whisper_init_with_params_no_state: devices    = 1
whisper_init_with_params_no_state: backends   = 2
whisper_backend_init_gpu: device 0: CPU (type: 0)
whisper_backend_init_gpu: no GPU found
system_info: n_threads = 4 / 4 | WHISPER : VITISAI = 0 | COREML = 0 | OPENVINO = 0 | CUDA : ARCHS = 860 | USE_GRAPHS = 1 | CPU : AVX2 = 1 | OPENMP = 1 |
`;

test('CPU-only binary is not reported as CUDA-capable', () => {
  const r = parseRuntimeProbe(CPU_ONLY);
  assert.equal(r.cudaCapable, false);
  assert.equal(r.gpuDeviceFound, false);
  assert.equal(r.gpuSelected, false);
  assert.equal(r.backends, 1);
  assert.equal(r.devices, 1);
  assert.equal(r.gpuName, null);
  assert.equal(r.messages.noGpu, true);
});

test('CUDA binary with a GPU present reports capability and selection', () => {
  const r = parseRuntimeProbe(CUDA_WITH_GPU);
  assert.equal(r.cudaCapable, true);
  assert.equal(r.gpuDeviceFound, true);
  assert.equal(r.gpuSelected, true);
  assert.equal(r.gpuName, 'NVIDIA GeForce RTX 3060');
  assert.equal(r.backends, 2);
  assert.equal(r.usingBackend, 'CUDA0');
});

test('CUDA binary without a GPU reports capability but no selection', () => {
  const r = parseRuntimeProbe(CUDA_NO_GPU_PRESENT);
  assert.equal(r.cudaCapable, true, 'a CUDA-compiled binary is capable even with no GPU present');
  assert.equal(r.gpuDeviceFound, false);
  assert.equal(r.gpuSelected, false);
  assert.equal(r.messages.noGpu, true);
});

test('garbage input never throws and reports no capability', () => {
  for (const input of ['', 'not a whisper log', null, undefined]) {
    const r = parseRuntimeProbe(input);
    assert.equal(r.cudaCapable, false);
    assert.equal(r.gpuSelected, false);
  }
});

test('the probe WAV is a valid 16 kHz mono PCM header', () => {
  const buf = silentWavBuffer();
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt16LE(22), 1, 'mono');
  assert.equal(buf.readUInt32LE(24), 16000, 'sample rate');
  assert.equal(buf.readUInt16LE(34), 16, '16-bit');
  assert.ok(buf.length > 44);
});

test('version() returns the engine banner from a real executable', () => {
  // Regression: the banner used to be discarded because the buffer was scoped
  // inside the promise executor, so version() always returned null.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { WhisperAdapter } = require('../../src/main/services/whisper');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ver-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  fs.writeFileSync(fake, '#!/bin/sh\necho "whisper.cpp version: 1.9.4-test"\n');
  fs.chmodSync(fake, 0o755);

  const adapter = new WhisperAdapter({ binaryPath: fake });
  return adapter.version().then((v) => {
    assert.equal(v, 'whisper.cpp version: 1.9.4-test');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
