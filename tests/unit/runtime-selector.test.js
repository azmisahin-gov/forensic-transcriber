'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeSelector } = require('../../src/main/services/runtime-selector');

// A stub adapter lets us exercise the selection logic deterministically without
// any real binary. The selector only depends on probeRuntime().
function makeAdapter(probeResult) {
  return class {
    constructor(opts) {
      this.opts = opts;
      this.binaryPath = opts.binaryPath;
    }
    probeRuntime() {
      return Promise.resolve(probeResult);
    }
  };
}

function selectorWith({ cpuProbe, gpuProbe, gpuPath = '/fake/gpu/whisper-cli', cpuPath = '/fake/whisper-cli' }) {
  const WhisperAdapter = class {
    constructor(opts) {
      this.opts = opts;
      this.binaryPath = opts.binaryPath;
    }
    probeRuntime() {
      return Promise.resolve(this.binaryPath === gpuPath ? gpuProbe : cpuProbe);
    }
  };
  const s = new RuntimeSelector({ WhisperAdapter, modelPath: '/fake/model.bin' });
  s.cpuPath = cpuPath;
  s.gpuPath = gpuPath;
  return s;
}

const CPU_OK = { ok: true, cudaCapable: false, gpuDeviceFound: false, gpuSelected: false };
const GPU_CUDA_WITH_GPU = { ok: true, cudaCapable: true, gpuDeviceFound: true, gpuSelected: true, gpuName: 'RTX 3060' };
const GPU_CUDA_NO_GPU = { ok: true, cudaCapable: true, gpuDeviceFound: false, gpuSelected: false };
const GPU_NOT_CUDA = { ok: true, cudaCapable: false, gpuDeviceFound: true, gpuSelected: false };

test('operator choosing CPU never uses the GPU runtime', async () => {
  const s = selectorWith({ cpuProbe: CPU_OK, gpuProbe: GPU_CUDA_WITH_GPU });
  const sel = await s.selectAdapter(false);
  assert.equal(sel.mode, 'cpu');
  assert.equal(sel.reason, 'OPERATOR_SELECTED_CPU');
});

test('no bundled GPU runtime falls back to CPU with an explicit reason', async () => {
  const s = selectorWith({ cpuProbe: CPU_OK, gpuProbe: null, gpuPath: null });
  const sel = await s.selectAdapter(true);
  assert.equal(sel.mode, 'cpu');
  assert.equal(sel.reason, 'GPU_RUNTIME_NOT_BUNDLED');
  assert.equal(sel.gpuRuntimeBundled, false);
});

test('CUDA runtime with a GPU present is selected', async () => {
  const s = selectorWith({ cpuProbe: CPU_OK, gpuProbe: GPU_CUDA_WITH_GPU });
  const sel = await s.selectAdapter(true);
  assert.equal(sel.mode, 'gpu');
  assert.equal(sel.reason, 'GPU_AVAILABLE');
});

test('CUDA runtime without a GPU present falls back to CPU', async () => {
  const s = selectorWith({ cpuProbe: CPU_OK, gpuProbe: GPU_CUDA_NO_GPU });
  const sel = await s.selectAdapter(true);
  assert.equal(sel.mode, 'cpu');
  assert.equal(sel.reason, 'NO_GPU_DEVICE');
});

test('a non-CUDA "gpu" binary is never selected even if a device exists', async () => {
  const s = selectorWith({ cpuProbe: CPU_OK, gpuProbe: GPU_NOT_CUDA });
  const sel = await s.selectAdapter(true);
  assert.equal(sel.mode, 'cpu');
  assert.equal(sel.reason, 'GPU_BINARY_NOT_CUDA');
});

test('a failed GPU probe falls back to CPU', async () => {
  const s = selectorWith({ cpuProbe: CPU_OK, gpuProbe: { ok: false, cudaCapable: false, gpuDeviceFound: false } });
  const sel = await s.selectAdapter(true);
  assert.equal(sel.mode, 'cpu');
  assert.equal(sel.reason, 'GPU_PROBE_FAILED');
});

test('capability reports recommended mode from real GPU usability', async () => {
  const withGpu = selectorWith({ cpuProbe: CPU_OK, gpuProbe: GPU_CUDA_WITH_GPU });
  const cap = await withGpu.capability();
  assert.equal(cap.gpuRuntimeBundled, true);
  assert.equal(cap.gpuUsable, true);
  assert.equal(cap.recommendedMode, 'gpu');

  const noGpu = selectorWith({ cpuProbe: CPU_OK, gpuProbe: GPU_CUDA_NO_GPU });
  const cap2 = await noGpu.capability();
  assert.equal(cap2.gpuUsable, false);
  assert.equal(cap2.recommendedMode, 'cpu');
});
