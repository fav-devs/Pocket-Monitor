/**
 * GLSL ES 3.00 for the web picture: the procedural demo camera (scene-linear light encoded in
 * the camera's curve) and the monitor effects pass implementing every `PictureEffects` field.
 * The curve and tone-map math transcribes `src/core/media/transfer.ts`.
 */

const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;
const HLG_DIFFUSE_WHITE = (Math.exp((0.75 - HLG_C) / HLG_A) + HLG_B) / 12;
const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** Transfer ids: 0 Rec.709, 1 HLG, 2 D-Log, 3 D-Log2, 4 D-Log M. */
export const CURVES_GLSL = /* glsl */ `
const float HLG_A = ${f(HLG_A)};
const float HLG_B = ${f(HLG_B)};
const float HLG_C = ${f(HLG_C)};
const float HLG_DW = ${f(HLG_DIFFUSE_WHITE)};

float hlgInv(float e) { return e <= 0.5 ? e * e / 3.0 : (exp((e - HLG_C) / HLG_A) + HLG_B) / 12.0; }
float hlgOetf(float s) { return s <= 1.0 / 12.0 ? sqrt(3.0 * s) : HLG_A * log(12.0 * s - HLG_B) + HLG_C; }

float decodeRaw(float e, int t) {
  if (t == 0) return e < 0.081 ? e / 4.5 : pow((e + 0.099) / 1.099, 1.0 / 0.45);
  if (t == 1) return hlgInv(clamp(e, 0.0, 1.0)) / HLG_DW;
  if (t == 2) return e <= 0.14 ? (e - 0.0929) / 6.025 : (pow(10.0, 3.89616 * e - 2.27752) - 0.0108) / 0.9892;
  if (t == 3) {
    const float A = 16.285770761945304;
    const float K1 = 0.059439938321493;
    const float B1 = 0.304985337243402;
    const float K2 = 2.96093524549225;
    const float B2 = 0.148314799066323;
    if (e >= B1) return (475.0 / (exp2(A) - 1.0)) * (exp2(A * e) - 1.0);
    if (e >= B2) return exp2((e - B1) / K1 + log2(0.18));
    return (e - B2) / K2 + 0.028961695254132;
  }
  float tt = exp2(e * 5.612990379333496 + 0.9327186346054077) - 2.428226947784424;
  float v = tt < 0.6034245491027832 ? tt * 1.0151796340942383 + 0.5178895592689514 : tt * 1.8734303712844849;
  return v * (0.18 / 12.4054);
}

float encodeCurve(float l, int t) {
  l = max(l, 0.0);
  float e;
  if (t == 0) { float c = min(l, 1.0); e = c < 0.018 ? 4.5 * c : 1.099 * pow(c, 0.45) - 0.099; }
  else if (t == 1) e = hlgOetf(clamp(l * HLG_DW, 0.0, 1.0));
  else if (t == 2) e = l <= 0.0078 ? 6.025 * l + 0.0929 : log(l * 0.9892 + 0.0108) / log(10.0) * 0.256663 + 0.584555;
  else if (t == 3) {
    const float A = 16.285770761945304;
    if (l >= 0.18) e = (1.0 / A) * log2(l * (exp2(A) - 1.0) / 475.0 + 1.0);
    else if (l >= 0.028961695254132) e = 0.059439938321493 * (log2(max(l, 1e-15)) - log2(0.18)) + 0.304985337243402;
    else e = 2.96093524549225 * (l - 0.028961695254132) + 0.148314799066323;
  } else {
    float v = l / (0.18 / 12.4054);
    float tt = v < 0.6034245491027832 * 1.8734303712844849 ? (v - 0.5178895592689514) / 1.0151796340942383 : v / 1.8734303712844849;
    e = (log2(max(tt + 2.428226947784424, 1e-6)) - 0.9327186346054077) / 5.612990379333496;
  }
  return clamp(e, 0.0, 1.0);
}

vec3 encode3(vec3 l, int t) { return vec3(encodeCurve(l.r, t), encodeCurve(l.g, t), encodeCurve(l.b, t)); }
vec3 linearize3(vec3 e, int t) {
  return max(vec3(decodeRaw(clamp(e.r, 0.0, 1.0), t), decodeRaw(clamp(e.g, 0.0, 1.0), t), decodeRaw(clamp(e.b, 0.0, 1.0), t)), 0.0);
}
vec3 lumaW(int t) { return (t == 1 || t == 3) ? vec3(0.2627, 0.6780, 0.0593) : vec3(0.2126, 0.7152, 0.0722); }
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** Procedural demo camera. Output: the camera signal, encoded in `u_signal`. v_uv.y = 0 is the top. */
export const SCENE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform float u_time;
uniform int u_scene;
uniform int u_signal;
uniform float u_gain;
uniform vec2 u_res;
${CURVES_GLSL}

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float box(vec2 p, vec2 c, vec2 h, float soft) {
  vec2 d = abs(p - c) - h;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, dist);
}
// smoothstep with either edge order (GLSL leaves edge0 >= edge1 undefined).
float rs(float a, float b, float x) { return a < b ? smoothstep(a, b, x) : 1.0 - smoothstep(b, a, x); }
float disc(vec2 p, vec2 c, float r, float soft) { return 1.0 - smoothstep(r - soft, r + soft, length(p - c)); }
vec3 srgbToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }

// X-Rite ColorChecker Classic, sRGB.
vec3 checker(int i) {
  vec3 c[24] = vec3[24](
    vec3(115, 82, 68), vec3(194, 150, 130), vec3(98, 122, 157), vec3(87, 108, 67), vec3(133, 128, 177), vec3(103, 189, 170),
    vec3(214, 126, 44), vec3(80, 91, 166), vec3(193, 90, 99), vec3(94, 60, 108), vec3(157, 188, 64), vec3(224, 163, 46),
    vec3(56, 61, 150), vec3(70, 148, 73), vec3(175, 54, 60), vec3(231, 199, 31), vec3(187, 86, 149), vec3(8, 133, 161),
    vec3(243, 243, 242), vec3(200, 200, 200), vec3(160, 160, 160), vec3(122, 122, 121), vec3(85, 85, 85), vec3(52, 52, 52));
  return srgbToLin(c[i] / 255.0);
}

vec3 skinTone(int i) {
  vec3 c[5] = vec3[5](vec3(0.62, 0.44, 0.36), vec3(0.50, 0.33, 0.25), vec3(0.38, 0.24, 0.17), vec3(0.24, 0.14, 0.10), vec3(0.13, 0.075, 0.055));
  return c[i];
}

// A face: skin with a sphere-lit key from upper left, hair, eyes and lips. Returns rgb + coverage.
vec4 face(vec2 q, vec2 c, float r, vec3 skin, float t) {
  vec2 d = (q - c) / vec2(r * 0.78, r);
  float cover = 1.0 - smoothstep(0.96, 1.02, length(d));
  vec3 n = normalize(vec3(d.x, -d.y, sqrt(max(0.0, 1.0 - dot(d, d)))));
  float key = max(0.0, dot(n, normalize(vec3(-0.55, 0.6, 0.7))));
  float fill = 0.18 + 0.12 * max(0.0, n.z);
  vec3 col = skin * (key * 1.5 + fill);
  col += vec3(1.0, 0.92, 0.85) * pow(key, 28.0) * 0.9; // sheen
  float hair = rs(-0.35, -0.55, d.y) * cover;
  col = mix(col, vec3(0.025, 0.018, 0.014) * (0.6 + key), hair);
  for (int s = -1; s <= 1; s += 2) {
    float eye = disc(d, vec2(0.34 * float(s), -0.08), 0.1, 0.02);
    col = mix(col, vec3(0.9), eye * 0.85);
    col = mix(col, vec3(0.02), disc(d, vec2(0.34 * float(s) + 0.02 * sin(t * 0.7), -0.08), 0.045, 0.01));
  }
  col = mix(col, skin * vec3(1.1, 0.55, 0.5) * (key + 0.3), box(d, vec2(0.0, 0.45), vec2(0.2, 0.045), 0.03));
  return vec4(col, cover);
}

vec3 studio(vec2 p, float t) {
  float a = 16.0 / 9.0;
  vec2 q = vec2((p.x - 0.5) * a, p.y - 0.5);
  // Wall: warm key on the left, cool fill on the right, defocused texture.
  float wallLight = 0.55 + 0.6 * exp(-pow(length(q - vec2(-0.6, -0.3)), 2.0) * 1.6);
  vec3 wall = mix(vec3(0.20, 0.16, 0.13), vec3(0.10, 0.13, 0.17), smoothstep(-0.6, 0.8, q.x)) * wallLight;
  wall *= 0.85 + 0.15 * noise(q * 6.0);
  vec3 col = wall;
  // Moving light sweep across the wall.
  col += vec3(0.35, 0.28, 0.2) * exp(-pow((q.x - 0.9 * sin(t * 0.21)) * 5.0, 2.0)) * rs(0.1, -0.3, q.y);
  // Defocused practical bokeh (soft, out of focus).
  for (int i = 0; i < 5; i++) {
    vec2 c = vec2(-0.85 + 0.12 * float(i), -0.38 + 0.03 * sin(float(i) * 2.1));
    col += vec3(3.5, 2.4, 1.2) * disc(q, c, 0.035, 0.02);
  }
  // Window / softbox: blown in Rec.709, held in log.
  float win = box(q, vec2(0.62, -0.3), vec2(0.18, 0.14), 0.01);
  vec3 sky = vec3(9.0, 10.0, 12.0) * (0.75 + 0.25 * rs(0.2, -0.45, q.y));
  sky += vec3(40.0, 36.0, 30.0) * disc(q, vec2(0.68, -0.38), 0.03, 0.01);
  col = mix(col, sky, win);
  col = mix(col, vec3(0.03), box(q, vec2(0.62, -0.3), vec2(0.19, 0.15), 0.004) * (1.0 - win)); // frame
  col = mix(col, vec3(0.03), box(q, vec2(0.62, -0.3), vec2(0.006, 0.14), 0.002));
  // Table and deep shadow.
  float table = smoothstep(0.24, 0.26, q.y);
  col = mix(col, vec3(0.09, 0.06, 0.04) * (0.8 + 0.2 * noise(q * vec2(40.0, 3.0))), table);
  col *= mix(1.0, 0.04, rs(-0.2, -0.95, q.x) * smoothstep(0.0, 0.5, q.y));
  // Colour checker on an easel.
  vec2 cc = (q - vec2(0.2, 0.02)) / vec2(0.42, 0.28);
  if (cc.x > 0.0 && cc.x < 1.0 && cc.y > 0.0 && cc.y < 1.0) {
    vec2 cell = cc * vec2(6.0, 4.0);
    vec2 f = fract(cell);
    int idx = int(floor(cell.y)) * 6 + int(floor(cell.x));
    float inPatch = box(f, vec2(0.5), vec2(0.4), 0.015);
    col = mix(vec3(0.012), checker(idx) * 1.05, inPatch);
  }
  // Subject: sways gently, shirt with fine weave (in focus, for peaking).
  vec2 sway = vec2(0.02 * sin(t * 0.6), 0.008 * sin(t * 1.1));
  vec2 fq = q - sway;
  float shirt = box(fq, vec2(-0.35, 0.36), vec2(0.21, 0.2), 0.03);
  float weave = 0.75 + 0.25 * step(0.5, fract((fq.x + fq.y) * 90.0));
  col = mix(col, vec3(0.05, 0.09, 0.16) * weave * (1.2 - fq.y), shirt);
  vec4 fc = face(fq, vec2(-0.35, -0.04), 0.18, vec3(0.55, 0.38, 0.29), t);
  col = mix(col, fc.rgb, fc.a);
  // Moving orange ball on the table.
  vec2 ball = vec2(0.45 * sin(t * 0.45), 0.31);
  float bd = length(q - ball);
  vec3 bn = normalize(vec3(q - ball, sqrt(max(0.0, 0.045 * 0.045 - bd * bd))));
  vec3 bcol = vec3(0.85, 0.28, 0.05) * (0.25 + max(0.0, dot(bn, normalize(vec3(-0.5, -0.6, 0.6))))) + vec3(6.0) * pow(max(0.0, dot(bn, normalize(vec3(-0.4, -0.5, 0.75)))), 60.0);
  col = mix(col, bcol, disc(q, ball, 0.045, 0.002));
  // Exposure ramp along the bottom: −8 … +8 stops around 18% grey.
  if (p.y > 0.965) {
    float stops = floor(p.x * 17.0) - 8.0;
    col = vec3(0.18 * exp2(stops));
  }
  return col;
}

vec3 bars(vec2 p, float t) {
  vec3 c;
  if (p.y < 0.66) {
    int i = int(floor(p.x * 7.0));
    vec3 b[7] = vec3[7](vec3(1, 1, 1), vec3(1, 1, 0), vec3(0, 1, 1), vec3(0, 1, 0), vec3(1, 0, 1), vec3(1, 0, 0), vec3(0, 0, 1));
    c = b[i] * 0.75;
    c = vec3(c.r < 0.08 ? c.r / 4.5 : pow((c.r + 0.099) / 1.099, 1.0 / 0.45), c.g < 0.08 ? c.g / 4.5 : pow((c.g + 0.099) / 1.099, 1.0 / 0.45), c.b < 0.08 ? c.b / 4.5 : pow((c.b + 0.099) / 1.099, 1.0 / 0.45));
  } else if (p.y < 0.74) {
    int i = int(floor(p.x * 7.0));
    vec3 b[7] = vec3[7](vec3(0, 0, 1), vec3(0), vec3(1, 0, 1), vec3(0), vec3(0, 1, 1), vec3(0), vec3(1, 1, 1));
    c = b[i] * 0.53;
  } else if (p.y < 0.88) {
    // Grey steps in stops from −6 to +6 around 18%.
    float s = floor(p.x * 13.0) - 6.0;
    c = vec3(0.18 * exp2(s));
  } else {
    // Smooth log ramp −10 … +10 stops.
    c = vec3(0.18 * exp2(mix(-10.0, 10.0, p.x)));
  }
  float sweep = exp(-pow((p.x - fract(t * 0.08)) * 120.0, 2.0));
  return c + vec3(1.2) * sweep * step(0.88, p.y);
}

vec3 skin(vec2 p, float t) {
  float a = 16.0 / 9.0;
  vec2 q = vec2((p.x - 0.5) * a, p.y - 0.5);
  vec3 col = vec3(0.18) * (0.75 + 0.35 * rs(0.9, -0.6, q.x));
  col *= 0.9 + 0.1 * noise(q * 3.0);
  for (int i = 0; i < 5; i++) {
    vec2 c = vec2(-0.66 + 0.33 * float(i), 0.02 + 0.015 * sin(t * 0.8 + float(i)));
    col = mix(col, vec3(0.04, 0.05, 0.07), box(q, c + vec2(0.0, 0.36), vec2(0.13, 0.17), 0.03));
    vec4 fc = face(q, c, 0.14, skinTone(i), t + float(i));
    col = mix(col, fc.rgb, fc.a);
  }
  return col;
}

vec3 night(vec2 p, float t) {
  float a = 16.0 / 9.0;
  vec2 q = vec2((p.x - 0.5) * a, p.y - 0.5);
  vec3 col = vec3(0.003, 0.004, 0.009) * (1.0 + 2.0 * rs(0.5, -0.5, q.y));
  // Buildings with lit windows.
  float bx = floor(q.x * 8.0);
  float top = -0.1 - 0.25 * hash(vec2(bx, 3.0));
  if (q.y > top) {
    col = vec3(0.002);
    vec2 w = fract(q * vec2(40.0, 30.0));
    float lit = step(0.6, hash(floor(q * vec2(40.0, 30.0))));
    col += vec3(0.6, 0.45, 0.25) * lit * box(w, vec2(0.5), vec2(0.3, 0.32), 0.05) * step(q.y, 0.2);
  }
  // Neon signs.
  col += vec3(4.0, 0.2, 2.8) * box(q, vec2(-0.45, -0.05), vec2(0.16, 0.012), 0.004);
  col += vec3(0.2, 3.0, 3.5) * box(q, vec2(0.38, 0.02), vec2(0.012, 0.1), 0.004);
  // Sodium street lamps with glow.
  for (int i = 0; i < 4; i++) {
    vec2 c = vec2(-0.8 + 0.53 * float(i), -0.22);
    float d = length(q - c);
    col += vec3(30.0, 14.0, 3.0) * disc(q, c, 0.012, 0.003) + vec3(0.25, 0.12, 0.03) * exp(-d * 18.0);
  }
  // Wet road and moving headlights.
  float road = smoothstep(0.2, 0.22, q.y);
  col = mix(col, vec3(0.006, 0.006, 0.008), road);
  float car = -1.0 + mod(t * 0.25, 2.3);
  for (int s = 0; s < 2; s++) {
    vec2 c = vec2(car + 0.09 * float(s), 0.3);
    col += vec3(20.0, 19.0, 16.0) * disc(q, c, 0.014, 0.004) + vec3(0.4, 0.38, 0.3) * exp(-length((q - c) * vec2(1.0, 4.0)) * 14.0);
    col += vec3(0.5, 0.48, 0.42) * road * exp(-abs(q.x - c.x) * 30.0) * rs(0.5, 0.3, q.y) * 0.4;
  }
  return col;
}

void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
  float t = u_time;
  vec3 lin;
  if (u_scene == 1) lin = bars(p, t);
  else if (u_scene == 2) lin = skin(p, t);
  else if (u_scene == 3) lin = night(p, t);
  else lin = studio(p, t);
  lin *= u_gain;
  // Sensor noise (more visible in the shadows), then the camera curve.
  float n = hash(p * u_res + fract(t * 13.0)) - 0.5;
  lin = max(lin + n * (0.0015 + 0.01 * sqrt(max(lin, 0.0))) , 0.0);
  o = vec4(encode3(lin, u_signal), 1.0);
}
`;

/** Separable re-blur of the signal's luma (the peaking coarse scale). */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform int u_fromSignal;
uniform vec3 u_lumaW;
const float W[7] = float[7](0.006044, 0.060662, 0.241798, 0.382992, 0.241798, 0.060662, 0.006044);
void main() {
  ivec2 size = textureSize(u_src, 0);
  ivec2 p = ivec2(v_uv * vec2(size));
  float acc = 0.0;
  for (int i = 0; i < 7; i++) {
    ivec2 q = clamp(p + ivec2(u_dir) * (i - 3), ivec2(0), size - 1);
    vec4 s = texelFetch(u_src, q, 0);
    acc += W[i] * (u_fromSignal == 1 ? dot(s.rgb, u_lumaW) : s.r);
  }
  o = vec4(acc, acc, acc, 1.0);
}
`;

/** Plain copy (readback for the scopes: the camera signal, never the LUT). */
export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
void main() { o = vec4(texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0); }
`;

/** The monitor, in the native order: display transform → LUT → mono → false colour → peaking → zebra. */
export const EFFECTS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_signalTex;
uniform sampler2D u_coarse;
uniform sampler3D u_lut;
uniform sampler2D u_fcTable;
uniform int u_signal;
uniform int u_display;
uniform mat3 u_gamut;
uniform vec3 u_tone; // gain, whiteReinhard, contrast
uniform float u_exposureStops;
uniform float u_lutOn;
uniform float u_lutSize;
uniform float u_lutIntensity;
uniform int u_mono;
uniform int u_fcMode; // 0 off, 1 full repaint, 2 limits (composite)
uniform float u_zebraHi;
uniform float u_zebraHiSoft;
uniform int u_zebraStripes;
uniform vec3 u_zebraHiColor;
uniform vec2 u_zebraMid; // lower, upper (lower > upper = off)
uniform vec3 u_zebraMidColor;
uniform int u_peak;
uniform vec3 u_peakColor;
uniform float u_peakThreshold;
uniform float u_peakGate;
uniform vec2 u_flip; // mirror x, mirror y (1 = flip)
uniform float u_dpr;
${CURVES_GLSL}

float toneCode(float x) {
  float c = u_tone.x * pow(max(x, 0.0) / 0.18, u_tone.z);
  float w = u_tone.y;
  float m = clamp(c * (1.0 + c / (w * w)) / (1.0 + c), 0.0, 1.0);
  return pow(m, 1.0 / 2.4);
}

float greyAt(ivec2 p, ivec2 size) {
  return dot(texelFetch(u_signalTex, clamp(p, ivec2(0), size - 1), 0).rgb, lumaW(u_signal));
}
float coarseAt(ivec2 p, ivec2 size) { return texelFetch(u_coarse, clamp(p, ivec2(0), size - 1), 0).r; }

void main() {
  // Texture space: the scene pass stores the image top at v = 1, like the canvas.
  vec2 uv = mix(v_uv, 1.0 - v_uv, u_flip);
  vec3 sig = texture(u_signalTex, uv).rgb;
  vec3 c = sig;
  if (u_exposureStops != 0.0) c = encode3(linearize3(c, u_signal) * exp2(u_exposureStops), u_signal);
  vec3 shown = c;
  if (u_display != 0) {
    vec3 lin = vec3(decodeRaw(c.r, u_display), decodeRaw(c.g, u_display), decodeRaw(c.b, u_display));
    lin = max(u_gamut * lin, 0.0);
    shown = vec3(toneCode(lin.r), toneCode(lin.g), toneCode(lin.b));
  }
  if (u_lutOn > 0.5) {
    // The cube is fed the camera signal; intensity mixes it with the display transform.
    vec3 coord = clamp(c, 0.0, 1.0) * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
    shown = mix(shown, texture(u_lut, coord).rgb, u_lutIntensity);
  }
  c = shown;
  if (u_mono == 1) c = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));

  float luma = dot(sig, lumaW(u_signal));
  if (u_fcMode != 0) {
    vec4 fc = texture(u_fcTable, vec2((luma * 255.0 + 0.5) / 256.0, 0.5));
    c = u_fcMode == 1 ? fc.rgb : mix(c, fc.rgb, fc.a);
  }

  if (u_peak == 1) {
    ivec2 size = textureSize(u_signalTex, 0);
    ivec2 p = ivec2(uv * vec2(size));
    if (p.x >= 6 && p.y >= 6 && p.x < size.x - 6 && p.y < size.y - 6) {
      float a = greyAt(p, size), b = greyAt(p + ivec2(1, 0), size), cc = greyAt(p + ivec2(0, 1), size), d = greyAt(p + ivec2(1, 1), size);
      float fine = (d - a) * (d - a) + (cc - b) * (cc - b);
      float ca = coarseAt(p, size), cb = coarseAt(p + ivec2(1, 0), size), ccc = coarseAt(p + ivec2(0, 1), size), cd = coarseAt(p + ivec2(1, 1), size);
      float coarse = (cd - ca) * (cd - ca) + (ccc - cb) * (ccc - cb);
      float ratio = min(fine / max(coarse, 1e-9), 4.0);
      float gate = clamp((coarse - u_peakGate * 0.7) / max(u_peakGate * 0.3, 1e-12), 0.0, 1.0);
      float stroke = clamp((ratio - u_peakThreshold) / 0.12, 0.0, 1.0) * gate;
      float under = clamp((ratio - (u_peakThreshold - 0.06)) / 0.12, 0.0, 1.0) * gate;
      c = mix(c, vec3(0.04, 0.04, 0.05), under);
      c = mix(c, u_peakColor, stroke);
    }
  }
  vec2 css = gl_FragCoord.xy / u_dpr;
  float stripe = u_zebraStripes == 1 ? step(mod(floor(css.x + css.y), 10.0), 4.0) : 1.0;
  float hiMeasure = max(sig.r, max(sig.g, sig.b));
  float hi = u_zebraHiSoft < u_zebraHi ? smoothstep(u_zebraHiSoft, u_zebraHi, hiMeasure) : step(u_zebraHi, hiMeasure);
  if (hi > 0.0) c = mix(c, u_zebraHiColor, 0.75 * stripe * hi);
  else if (u_zebraMid.x <= u_zebraMid.y && luma >= u_zebraMid.x && luma <= u_zebraMid.y) c = mix(c, u_zebraMidColor, 0.55 * stripe);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
