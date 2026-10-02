'use strict';


const { resolveBinary, resolveGpuBinary } = require('./paths');

/**
 * Chooses between the bundled CPU and optional CUDA ASR runtimes.
 *
 * Design:
 *  - The CPU runtime is always present and is the universal fallback.
 *  - A CUDA runtime is optional and lives in `bin/gpu/`. It is only used when
 *    it actually loads a GPU backend (verified by the engine's own report),
 *    never merely because the machine has an NVIDIA device.
 *  - When the operator does not want the GPU, or no GPU runtime is bundled, or
 *    the GPU runtime cannot select a GPU, the CPU runtime is used.
 *
 * The probe is the source of truth. A binary compiled without CUDA reports a
 * single backend and a CPU device, even though the `-ng`/`-dev` options always
 * appear in `--help`.
 */
class RuntimeSelector {
  constructor({ WhisperAdapter, modelPath } = {}) {
    this.WhisperAdapter = WhisperAdapter;
    this.modelPath = modelPath || null;
    this.cpuPath = resolveBinary('whisper-cli');
    this.gpuPath = resolveGpuBinary('whisper-cli');
    this._cpuProbe = null;
    this._gpuProbe = null;
  }

  setModelPath(modelPath) {
    this.modelPath = modelPath;
    this._cpuProbe = null;
    this._gpuProbe = null;
  }

  get gpuRuntimeBundled() {
    // resolveGpuBinary() already returns null when no GPU runtime is present.
    return Boolean(this.gpuPath);
  }

  _adapter(binaryPath) {
    return new this.WhisperAdapter({
      binaryPath,
      modelPath: this.modelPath,
      vadModelPath: this._vadModelPath || null,
    });
  }

  setVadModelPath(vadModelPath) {
    this._vadModelPath = vadModelPath || null;
  }

  async probeCpu({ force = false } = {}) {
    if (this._cpuProbe && !force) return this._cpuProbe;
    const adapter = this._adapter(this.cpuPath);
    this._cpuProbe = { role: 'cpu', binaryPath: this.cpuPath, ...(await adapter.probeRuntime({ modelPath: this.modelPath })) };
    return this._cpuProbe;
  }

  async probeGpu({ force = false } = {}) {
    if (this._gpuProbe && !force) return this._gpuProbe;
    if (!this.gpuRuntimeBundled) {
      this._gpuProbe = { role: 'gpu', binaryPath: null, ok: false, reason: 'GPU_RUNTIME_NOT_BUNDLED', cudaCapable: false, gpuSelected: false };
      return this._gpuProbe;
    }
    const adapter = this._adapter(this.gpuPath);
    this._gpuProbe = { role: 'gpu', binaryPath: this.gpuPath, ...(await adapter.probeRuntime({ modelPath: this.modelPath })) };
    return this._gpuProbe;
  }

  /** Full capability picture for the UI. */
  async capability({ force = false } = {}) {
    const [cpu, gpu] = await Promise.all([this.probeCpu({ force }), this.probeGpu({ force })]);
    const gpuUsable = Boolean(gpu && gpu.ok && gpu.cudaCapable && gpu.gpuDeviceFound);
    return {
      cpuBinary: { path: cpu.binaryPath, ok: cpu.ok, cudaCapable: cpu.cudaCapable, gpuDeviceFound: cpu.gpuDeviceFound },
      gpuBinary: this.gpuRuntimeBundled
        ? { path: gpu.binaryPath, ok: gpu.ok, cudaCapable: gpu.cudaCapable, gpuDeviceFound: gpu.gpuDeviceFound, gpuName: gpu.gpuName, usingBackend: gpu.usingBackend }
        : null,
      gpuRuntimeBundled: this.gpuRuntimeBundled,
      gpuUsable,
      recommendedMode: gpuUsable ? 'gpu' : 'cpu',
    };
  }

  /**
   * Select the adapter to use for a run.
   *
   * @param {boolean} wantGpu operator preference
   * @returns {Promise<{adapter:object, mode:'gpu'|'cpu', reason:string, gpuRuntimeBundled:boolean}>}
   */
  async selectAdapter(wantGpu) {
    if (!wantGpu) {
      return { adapter: this._adapter(this.cpuPath), mode: 'cpu', reason: 'OPERATOR_SELECTED_CPU', gpuRuntimeBundled: this.gpuRuntimeBundled };
    }
    if (!this.gpuRuntimeBundled) {
      return { adapter: this._adapter(this.cpuPath), mode: 'cpu', reason: 'GPU_RUNTIME_NOT_BUNDLED', gpuRuntimeBundled: false };
    }
    const gpu = await this.probeGpu();
    if (gpu.ok && gpu.cudaCapable && gpu.gpuDeviceFound) {
      return { adapter: this._adapter(this.gpuPath), mode: 'gpu', reason: 'GPU_AVAILABLE', gpuRuntimeBundled: true };
    }
    const reason = !gpu.ok ? 'GPU_PROBE_FAILED' : !gpu.cudaCapable ? 'GPU_BINARY_NOT_CUDA' : 'NO_GPU_DEVICE';
    return { adapter: this._adapter(this.cpuPath), mode: 'cpu', reason, gpuRuntimeBundled: true };
  }
}

module.exports = { RuntimeSelector };
