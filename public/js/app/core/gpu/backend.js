/**
 * Compute backend abstraction — WebGPU primary, Canvas2D/JS fallback.
 *
 * A single interface for image/compositing kernels. `createBackend()` picks the
 * fastest path the runtime supports (from core/capabilities.js): WebGPU when
 * available, otherwise a portable CPU path. WASM-SIMD kernels slot in behind the
 * same interface in a later phase. Every backend is interchangeable, so callers
 * never branch on hardware — they just call `backend.grayscale(img)`.
 *
 * Image shape used throughout: `{ data: Uint8ClampedArray (RGBA), width, height }`
 * (structurally an ImageData; works with OffscreenCanvas and in workers).
 */
import { detectCapabilities } from '../capabilities.js';

/** Pure selection helper (unit-testable): capability snapshot → backend name. */
export function pickBackendName(caps) {
  if (caps && caps.webgpu) return 'webgpu';
  return 'cpu';
}

/* ------------------------------- CPU fallback ---------------------------- */

class CpuBackend {
  get name() { return 'cpu'; }
  async init() { return this; }

  async grayscale(img) {
    const { data, width, height } = img;
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
      // Rec. 601 luma.
      const y = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      out[i] = out[i + 1] = out[i + 2] = y;
      out[i + 3] = data[i + 3];
    }
    return { data: out, width, height };
  }

  destroy() {}
}

/* --------------------------------- WebGPU -------------------------------- */

const GRAYSCALE_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read>       src : array<u32>;
@group(0) @binding(1) var<storage, read_write> dst : array<u32>;
@group(0) @binding(2) var<uniform>             n   : u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= n) { return; }
  let px = src[i];
  let r = f32(px & 0xffu);
  let g = f32((px >> 8u) & 0xffu);
  let b = f32((px >> 16u) & 0xffu);
  let a = (px >> 24u) & 0xffu;
  let y = u32(clamp(r * 0.299 + g * 0.587 + b * 0.114, 0.0, 255.0));
  dst[i] = y | (y << 8u) | (y << 16u) | (a << 24u);
}`;

class WebGPUBackend {
  constructor() { this.device = null; this._pipelines = new Map(); }
  get name() { return 'webgpu'; }

  async init() {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.device = await adapter.requestDevice();
    return this;
  }

  _pipeline(key, code) {
    let p = this._pipelines.get(key);
    if (!p) {
      const module = this.device.createShaderModule({ code });
      p = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      this._pipelines.set(key, p);
    }
    return p;
  }

  async grayscale(img) {
    const { data, width, height } = img;
    const n = width * height;
    const bytes = n * 4;
    const dev = this.device;

    const src = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const dst = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const uni = dev.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const readback = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    dev.queue.writeBuffer(src, 0, data.buffer, data.byteOffset, bytes);
    dev.queue.writeBuffer(uni, 0, new Uint32Array([n]));

    const pipeline = this._pipeline('grayscale', GRAYSCALE_WGSL);
    const bind = dev.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: src } },
        { binding: 1, resource: { buffer: dst } },
        { binding: 2, resource: { buffer: uni } },
      ],
    });

    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(dst, 0, readback, 0, bytes);
    dev.queue.submit([enc.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const out = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    src.destroy(); dst.destroy(); uni.destroy(); readback.destroy();
    return { data: out, width, height };
  }

  destroy() { if (this.device) this.device.destroy(); }
}

/* --------------------------------- factory ------------------------------- */

let singleton = null;

/**
 * Create (and cache) the best available backend. Falls back to CPU if WebGPU
 * init fails at runtime (e.g. device lost), so callers always get a usable one.
 * @returns {Promise<{name:string, grayscale:Function, destroy:Function}>}
 */
export async function createBackend() {
  if (singleton) return singleton;
  const caps = await detectCapabilities();
  if (pickBackendName(caps) === 'webgpu') {
    try {
      singleton = await new WebGPUBackend().init();
      return singleton;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[DocMaster] WebGPU backend init failed, falling back to CPU:', e && e.message);
    }
  }
  singleton = await new CpuBackend().init();
  return singleton;
}

// Exposed for tests / explicit selection.
export { CpuBackend, WebGPUBackend };
