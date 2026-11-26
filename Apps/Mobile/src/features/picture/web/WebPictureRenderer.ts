import {
  LogDisplayTransform,
  cubeVolumeRGBA,
  falseColorTable,
  peakingGateScale,
  scaleForMode,
  transferForSourceColor,
  type CubeLUT,
  type MonitorTransfer,
} from '@/core/media';
import type { DemoScene, PictureEffects } from '@modules/opc-native/src/types';
import { BLUR_FS, COPY_FS, EFFECTS_FS, FULLSCREEN_VS, SCENE_FS } from './shaders';

const TRANSFER_ID: Record<MonitorTransfer, number> = { rec709: 0, hdr: 1, dlog: 2, dlog2: 3, dlogm: 4 };
const SCENE_ID: Record<DemoScene, number> = { studio: 0, bars: 1, skin: 2, night: 3 };

export const SIGNAL_WIDTH = 1280;
export const SIGNAL_HEIGHT = 720;

export interface RenderInputs {
  scene: DemoScene | null;
  effects: PictureEffects;
  /** Scene exposure gain (camera ISO / shutter / EV). */
  gain: number;
  dpr: number;
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

/**
 * WebGL2 monitor for web: renders the procedural demo camera into a 1280×720 signal texture,
 * re-blurs its luma for peaking, then draws the effects pass to the canvas. A small copy of the
 * signal is read back on demand for the scopes.
 */
export class WebPictureRenderer {
  readonly gl: WebGL2RenderingContext;
  private progScene: WebGLProgram;
  private progBlur: WebGLProgram;
  private progCopy: WebGLProgram;
  private progFx: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private signal: Target;
  private blurH: Target;
  private blurV: Target;
  private sample: Target;
  private lutTex: WebGLTexture;
  private lutKey: CubeLUT | null = null;
  private lutSize = 2;
  private fcTex: WebGLTexture;
  private fcKey = '';
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private displayCache = new Map<MonitorTransfer, LogDisplayTransform>();
  readonly errors: string[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.progScene = this.program(SCENE_FS, 'scene');
    this.progBlur = this.program(BLUR_FS, 'blur');
    this.progCopy = this.program(COPY_FS, 'copy');
    this.progFx = this.program(EFFECTS_FS, 'effects');
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.progScene, this.progBlur, this.progCopy, this.progFx]) {
      const loc = gl.getAttribLocation(p, 'a_pos');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    }
    this.signal = this.target(SIGNAL_WIDTH, SIGNAL_HEIGHT, gl.LINEAR);
    this.blurH = this.target(SIGNAL_WIDTH, SIGNAL_HEIGHT, gl.NEAREST);
    this.blurV = this.target(SIGNAL_WIDTH, SIGNAL_HEIGHT, gl.NEAREST);
    this.sample = this.target(192, 108, gl.NEAREST);
    this.lutTex = gl.createTexture()!;
    this.uploadLut(null);
    this.fcTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.fcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 4));
    this.texParams(gl.TEXTURE_2D, gl.LINEAR);
  }

  private program(fs: string, name: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? 'unknown';
        this.errors.push(`${name}: ${log}`);
        throw new Error(`Shader ${name} failed: ${log}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, FULLSCREEN_VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p) ?? 'unknown';
      this.errors.push(`${name}: ${log}`);
      throw new Error(`Program ${name} failed: ${log}`);
    }
    return p;
  }

  private u(p: WebGLProgram, name: string) {
    let m = this.uniforms.get(p);
    if (!m) this.uniforms.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private texParams(target: number, filter: number) {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  private target(w: number, h: number, filter: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(gl.TEXTURE_2D, filter);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  private uploadLut(lut: CubeLUT | null) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (lut) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, cubeVolumeRGBA(lut));
      this.lutSize = lut.size;
    } else {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(2 * 2 * 2 * 4));
      this.lutSize = 2;
    }
    this.texParams(gl.TEXTURE_3D, gl.LINEAR);
    this.lutKey = lut;
  }

  private draw(target: Target | null, width: number, height: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindTex(unit: number, target: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
  }

  /** Render one frame to the canvas. `lut` is the cube for `effects.lutId` (null if none / loading). */
  render(time: number, inputs: RenderInputs, lut: CubeLUT | null, canvasW: number, canvasH: number) {
    const gl = this.gl;
    const fx = inputs.effects;
    const signal = transferForSourceColor(fx.signal ?? fx.sourceColor);
    const display = transferForSourceColor(fx.sourceColor);
    const clipByte = fx.clipByte ?? 255;

    // 1. Camera signal.
    gl.useProgram(this.progScene);
    gl.uniform1f(this.u(this.progScene, 'u_time'), time);
    gl.uniform1i(this.u(this.progScene, 'u_scene'), inputs.scene ? SCENE_ID[inputs.scene] : 0);
    gl.uniform1i(this.u(this.progScene, 'u_signal'), TRANSFER_ID[signal]);
    gl.uniform1f(this.u(this.progScene, 'u_gain'), inputs.scene ? inputs.gain : 0);
    gl.uniform2f(this.u(this.progScene, 'u_res'), SIGNAL_WIDTH, SIGNAL_HEIGHT);
    this.draw(this.signal, SIGNAL_WIDTH, SIGNAL_HEIGHT);

    // 2. Peaking coarse scale.
    const peak = fx.peaking;
    if (peak) {
      const lw = signal === 'hdr' || signal === 'dlog2' ? [0.2627, 0.678, 0.0593] : [0.2126, 0.7152, 0.0722];
      gl.useProgram(this.progBlur);
      gl.uniform1i(this.u(this.progBlur, 'u_src'), 0);
      gl.uniform3f(this.u(this.progBlur, 'u_lumaW'), lw[0], lw[1], lw[2]);
      this.bindTex(0, gl.TEXTURE_2D, this.signal.tex);
      gl.uniform2f(this.u(this.progBlur, 'u_dir'), 1, 0);
      gl.uniform1i(this.u(this.progBlur, 'u_fromSignal'), 1);
      this.draw(this.blurH, SIGNAL_WIDTH, SIGNAL_HEIGHT);
      this.bindTex(0, gl.TEXTURE_2D, this.blurH.tex);
      gl.uniform2f(this.u(this.progBlur, 'u_dir'), 0, 1);
      gl.uniform1i(this.u(this.progBlur, 'u_fromSignal'), 0);
      this.draw(this.blurV, SIGNAL_WIDTH, SIGNAL_HEIGHT);
    }

    // 3. Tables.
    if (lut !== this.lutKey) this.uploadLut(lut);
    const fcKey = fx.falseColor ? `${fx.falseColor}:${signal}:${clipByte}` : '';
    if (fcKey && fcKey !== this.fcKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.fcTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, falseColorTable(scaleForMode(fx.falseColor!), signal, clipByte));
      this.fcKey = fcKey;
    }

    // 4. Effects to the canvas.
    const p = this.progFx;
    gl.useProgram(p);
    this.bindTex(0, gl.TEXTURE_2D, this.signal.tex);
    this.bindTex(1, gl.TEXTURE_2D, this.blurV.tex);
    this.bindTex(2, gl.TEXTURE_3D, this.lutTex);
    this.bindTex(3, gl.TEXTURE_2D, this.fcTex);
    gl.uniform1i(this.u(p, 'u_signalTex'), 0);
    gl.uniform1i(this.u(p, 'u_coarse'), 1);
    gl.uniform1i(this.u(p, 'u_lut'), 2);
    gl.uniform1i(this.u(p, 'u_fcTable'), 3);
    gl.uniform1i(this.u(p, 'u_signal'), TRANSFER_ID[signal]);
    gl.uniform1i(this.u(p, 'u_display'), TRANSFER_ID[display]);
    let dt = this.displayCache.get(display);
    if (!dt) this.displayCache.set(display, (dt = new LogDisplayTransform(display)));
    gl.uniformMatrix3fv(this.u(p, 'u_gamut'), true, dt.matrix);
    gl.uniform3f(this.u(p, 'u_tone'), dt.tone.gain, dt.tone.whiteReinhard, dt.tone.contrast);
    gl.uniform1f(this.u(p, 'u_exposureStops'), fx.lutExposureStops ?? 0);
    gl.uniform1f(this.u(p, 'u_lutOn'), lut ? 1 : 0);
    gl.uniform1f(this.u(p, 'u_lutSize'), this.lutSize);
    gl.uniform1f(this.u(p, 'u_lutIntensity'), fx.lutIntensity);
    gl.uniform1i(this.u(p, 'u_mono'), fx.monochrome ? 1 : 0);
    gl.uniform1i(this.u(p, 'u_fcMode'), fx.falseColor ? (fx.falseColor === 'limits' ? 2 : 1) : 0);
    const z = fx.zebra;
    gl.uniform1f(this.u(p, 'u_zebraHi'), z ? z.upper : 9);
    gl.uniform3f(this.u(p, 'u_zebraHiColor'), ...(z ? z.paint : ([1, 1, 1] as [number, number, number])));
    const mid = z?.midtone;
    gl.uniform2f(this.u(p, 'u_zebraMid'), mid ? mid.lower : 1, mid ? mid.upper : 0);
    gl.uniform3f(this.u(p, 'u_zebraMidColor'), ...(mid ? mid.paint : ([1, 1, 1] as [number, number, number])));
    gl.uniform1i(this.u(p, 'u_peak'), peak ? 1 : 0);
    if (peak) {
      gl.uniform3f(this.u(p, 'u_peakColor'), ...peak.color);
      gl.uniform1f(this.u(p, 'u_peakThreshold'), peak.ratioThreshold);
      gl.uniform1f(this.u(p, 'u_peakGate'), peak.noiseGate * peakingGateScale(signal));
    }
    gl.uniform2f(this.u(p, 'u_flip'), fx.mirror ? 1 : 0, fx.mirrorVertical ? 1 : 0);
    gl.uniform1f(this.u(p, 'u_dpr'), inputs.dpr);
    this.draw(null, canvasW, canvasH);
  }

  private pbo: WebGLBuffer | null = null;
  private fence: WebGLSync | null = null;

  /**
   * Start an asynchronous 192×108 readback of the camera signal into a pixel-pack buffer
   * (no pipeline stall). Collect it with `pollSample` on a later frame.
   */
  requestSample() {
    const gl = this.gl;
    if (this.fence) return;
    const { w, h } = this.sample;
    gl.useProgram(this.progCopy);
    this.bindTex(0, gl.TEXTURE_2D, this.signal.tex);
    gl.uniform1i(this.u(this.progCopy, 'u_src'), 0);
    this.draw(this.sample, w, h);
    if (!this.pbo) {
      this.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
    } else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  /** The finished readback (top-down RGBA rows), or null while the GPU is still busy. */
  pollSample(): { width: number; height: number; rgba: Uint8Array } | null {
    const gl = this.gl;
    if (!this.fence || !this.pbo) return null;
    const status = gl.clientWaitSync(this.fence, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return null;
    gl.deleteSync(this.fence);
    this.fence = null;
    const { w, h } = this.sample;
    const rgba = new Uint8Array(w * h * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, rgba);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    // COPY_FS already flipped v, so rows from readPixels (bottom-up) arrive top-down.
    return { width: w, height: h, rgba };
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.signal, this.blurH, this.blurV, this.sample]) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    if (this.fence) gl.deleteSync(this.fence);
    if (this.pbo) gl.deleteBuffer(this.pbo);
    gl.deleteTexture(this.lutTex);
    gl.deleteTexture(this.fcTex);
    for (const p of [this.progScene, this.progBlur, this.progCopy, this.progFx]) gl.deleteProgram(p);
  }
}
