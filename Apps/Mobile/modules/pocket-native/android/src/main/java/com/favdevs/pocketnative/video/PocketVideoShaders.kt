package com.favdevs.pocketnative.video

/**
 * GLSL ES 3.00 sources; a line-for-line port of iOS `PocketVideoShaders.swift` (MSL).
 *
 * Texture convention: every intermediate texture (signal, peaking, measure) is stored upright in
 * GL convention (t = 0 is the bottom row). Picture-space math uses a top-left `uv` derived from
 * `gl_FragCoord`, exactly like Metal's `in.uv`, and converts with `tex(uv) = (uv.x, 1 - uv.y)`.
 */
object PocketVideoShaders {
  const val VERTEX = """#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
"""

  private const val HEADER = """#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
"""

  private const val COMMON = """
#define P_ANCH 0
#define P_LUMA 1
#define P_TONE 2
#define P_GR 3
#define P_GG 4
#define P_GB 5
#define P_LUT 6
#define P_LUTMIN 7
#define P_LUTMAX 8
#define P_FC 9
#define P_ZEB 10
#define P_ZEBP 11
#define P_PEAK 12
#define P_PEAKC 13
#define P_SRC 14
#define P_VIEW 15
#define P_MAP 16

uniform vec4 uFx[17];

const float POCKET_CRUSH = 0.05;
const float POCKET_CLIPL = 0.95;
const vec3 POCKET_LUMA709 = vec3(0.2126, 0.7152, 0.0722);

float pocket_wave_level(float v, vec4 a) {
  v = clamp(v, 0.0, 1.0);
  float black = a.x; float mid = a.y; float clip = a.z; float midL = a.w;
  if (v < black) return black <= 0.0 ? POCKET_CRUSH : v / black * POCKET_CRUSH;
  if (v > clip) {
    float head = 1.0 - clip;
    return head <= 0.0 ? POCKET_CLIPL : POCKET_CLIPL + (v - clip) / head * (1.0 - POCKET_CLIPL);
  }
  if (clip <= mid || mid <= black) return POCKET_CRUSH + (v - black) / max(clip - black, 1e-6) * (POCKET_CLIPL - POCKET_CRUSH);
  if (v <= mid) return POCKET_CRUSH + (v - black) / (mid - black) * (midL - POCKET_CRUSH);
  return midL + (v - mid) / (clip - mid) * (POCKET_CLIPL - midL);
}

float pocket_monitor_ire(float v, vec4 a) {
  return clamp((pocket_wave_level(v, a) - POCKET_CRUSH) / (POCKET_CLIPL - POCKET_CRUSH) * 100.0, 0.0, 100.0);
}

float pocket_log10(float x) { return log2(x) * 0.30102999566; }

float pocket_decode(float e, int t) {
  e = clamp(e, 0.0, 1.0);
  if (t == 1) {
    float s = e <= 0.5 ? e * e / 3.0 : (exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
    return s / 0.26496256;
  }
  if (t == 2) {
    float k = exp2(e * 5.612990379333496 + 0.9327186346054077) - 2.428226947784424;
    float v = k < 0.6034245491027832 ? k * 1.0151796340942383 + 0.5178895592689514 : k * 1.8734303712844849;
    return v * (0.18 / 12.4054);
  }
  if (t == 3) {
    return e <= 0.14 ? (e - 0.0929) / 6.025 : (pow(10.0, 3.89616 * e - 2.27752) - 0.0108) / 0.9892;
  }
  if (t == 4) {
    if (e >= 0.304985337243402) return (475.0 / (exp2(16.285770761945304) - 1.0)) * (exp2(16.285770761945304 * e) - 1.0);
    if (e >= 0.148314799066323) return exp2((e - 0.304985337243402) / 0.059439938321493 + log2(0.18));
    return (e - 0.148314799066323) / 2.960935245492250 + 0.028961695254132;
  }
  return e < 0.081 ? e / 4.5 : pow((e + 0.099) / 1.099, 1.0 / 0.45);
}

float pocket_encode(float l, int t) {
  l = max(l, 0.0);
  float o;
  if (t == 1) {
    float s = clamp(l * 0.26496256, 0.0, 1.0);
    o = s <= 1.0 / 12.0 ? sqrt(3.0 * s) : 0.17883277 * log(12.0 * s - 0.28466892) + 0.55991073;
  } else if (t == 2) {
    float v = l / (0.18 / 12.4054);
    float k = v < 0.6034245491027832 * 1.8734303712844849 ? (v - 0.5178895592689514) / 1.0151796340942383 : v / 1.8734303712844849;
    o = (log2(max(k + 2.428226947784424, 1e-6)) - 0.9327186346054077) / 5.612990379333496;
  } else if (t == 3) {
    o = l <= 0.0078 ? 6.025 * l + 0.0929 : pocket_log10(l * 0.9892 + 0.0108) * 0.256663 + 0.584555;
  } else if (t == 4) {
    if (l >= 0.18) o = (1.0 / 16.285770761945304) * log2(l * (exp2(16.285770761945304) - 1.0) / 475.0 + 1.0);
    else if (l >= 0.028961695254132) o = 0.059439938321493 * (log2(max(l, 1e-15)) - log2(0.18)) + 0.304985337243402;
    else o = 2.960935245492250 * (l - 0.028961695254132) + 0.148314799066323;
  } else {
    float c = min(l, 1.0);
    o = c < 0.018 ? 4.5 * c : 1.099 * pow(c, 0.45) - 0.099;
  }
  return clamp(o, 0.0, 1.0);
}

float pocket_tone(float x, vec4 tone) {
  float xn = max(x, 0.0) / 0.18;
  float c = tone.x * pow(max(xn, 1e-8), tone.y);
  float w = tone.z;
  float m = c * (1.0 + c / (w * w)) / (1.0 + c);
  return pow(clamp(m, 0.0, 1.0), 1.0 / 2.4);
}

vec3 pocket_display(vec3 s) {
  if (uFx[P_TONE].w < 0.5) return s;
  int t = int(uFx[P_LUMA].w + 0.5);
  vec3 lin = vec3(pocket_decode(s.r, t), pocket_decode(s.g, t), pocket_decode(s.b, t));
  vec3 m = max(vec3(dot(uFx[P_GR].xyz, lin), dot(uFx[P_GG].xyz, lin), dot(uFx[P_GB].xyz, lin)), 0.0);
  vec4 tone = uFx[P_TONE];
  return vec3(pocket_tone(m.r, tone), pocket_tone(m.g, tone), pocket_tone(m.b, tone));
}

uniform sampler3D uLut;

vec3 pocket_lut(vec3 s) {
  float n = uFx[P_LUT].y;
  vec3 dmin = uFx[P_LUTMIN].xyz;
  vec3 dmax = uFx[P_LUTMAX].xyz;
  vec3 c = clamp((s - dmin) / max(dmax - dmin, vec3(1e-6)), 0.0, 1.0);
  return texture(uLut, (c * (n - 1.0) + 0.5) / n).rgb;
}

vec3 pocket_grade(vec3 s) {
  vec3 c = pocket_display(s);
  if (uFx[P_LUT].x > 0.5) c = mix(c, pocket_lut(s), clamp(uFx[P_LUT].z, 0.0, 1.0));
  return clamp(c, 0.0, 1.0);
}
"""

  private const val FALSE_COLOR = """
vec3 pocket_rgb255(float r, float g, float b) { return vec3(r, g, b) / 255.0; }

vec3 pocket_fc_cinestop(float st, float clipStops) {
  if (st >= clipStops) return pocket_rgb255(245.0, 39.0, 0.0);
  if (st < -6.5) return pocket_rgb255(75.0, 8.0, 165.0);
  if (st < -2.5) return pocket_rgb255(102.0, 102.0, 102.0);
  if (st < -1.5) return pocket_rgb255(39.0, 76.0, 0.0);
  if (st < -0.5) return pocket_rgb255(155.0, 196.0, 56.0);
  if (st < 0.5) return pocket_rgb255(127.0, 127.0, 127.0);
  if (st < 1.5) return pocket_rgb255(221.0, 174.0, 180.0);
  if (st < 2.5) return pocket_rgb255(252.0, 232.0, 96.0);
  return pocket_rgb255(179.0, 178.0, 178.0);
}

vec4 pocket_fc_video(float ire) {
  if (ire < 5.0) return vec4(0.44, 0.22, 0.76, 1.0);
  if (ire < 6.0) return vec4(0.28, 0.37, 0.85, 1.0);
  if (ire >= 10.0 && ire < 13.0) return vec4(0.18, 0.58, 0.64, 1.0);
  if (ire >= 41.0 && ire < 49.0) return vec4(0.38, 0.63, 0.35, 1.0);
  if (ire >= 61.0 && ire < 71.0) return vec4(0.83, 0.53, 0.71, 1.0);
  if (ire >= 92.0 && ire < 94.0) return vec4(0.83, 0.77, 0.45, 1.0);
  if (ire >= 94.0 && ire < 96.0) return vec4(0.89, 0.72, 0.29, 1.0);
  if (ire >= 96.0 && ire < 99.0) return vec4(0.85, 0.55, 0.22, 1.0);
  if (ire >= 99.0) return vec4(0.78, 0.28, 0.18, 1.0);
  return vec4(0.0);
}

vec4 pocket_fc_ire(float ire) {
  if (ire < 2.5) return vec4(pocket_rgb255(115.0, 33.0, 120.0), 1.0);
  if (ire < 10.0) return vec4(pocket_rgb255(29.0, 2.0, 221.0), 1.0);
  if (ire >= 38.0 && ire < 42.0) return vec4(pocket_rgb255(123.0, 207.0, 87.0), 1.0);
  if (ire >= 52.0 && ire < 56.0) return vec4(pocket_rgb255(241.0, 190.0, 198.0), 1.0);
  if (ire >= 80.0 && ire < 95.0) return vec4(pocket_rgb255(255.0, 255.0, 88.0), 1.0);
  if (ire >= 95.0) return vec4(pocket_rgb255(220.0, 51.0, 33.0), 1.0);
  return vec4(0.0);
}

vec4 pocket_fc_limits(float ire, float edge) {
  if (ire < 5.0) return vec4(0.44, 0.22, 0.76, 1.0);
  if (ire < 10.0) return vec4(0.28, 0.37, 0.85, 1.0);
  if (ire >= 94.0 && ire < edge) return vec4(0.89, 0.72, 0.29, 1.0);
  if (ire >= edge) return vec4(0.78, 0.28, 0.18, 1.0);
  return vec4(0.0);
}

vec3 pocket_false_color(vec3 s, vec3 graded) {
  int mode = int(uFx[P_FC].x + 0.5);
  int t = int(uFx[P_LUMA].w + 0.5);
  float luma = dot(s, uFx[P_LUMA].xyz);
  if (mode == 1) {
    float lin = max(pocket_decode(luma, t), 0.0);
    float st = lin > 0.0 ? log2(lin / 0.18) : -100.0;
    return pocket_fc_cinestop(st, uFx[P_FC].y);
  }
  float ire = pocket_monitor_ire(luma, uFx[P_ANCH]);
  float grey = dot(graded, POCKET_LUMA709);
  if (mode == 2) { vec4 b = pocket_fc_video(ire); return b.w > 0.5 ? b.rgb : vec3(grey); }
  if (mode == 3) { vec4 b = pocket_fc_ire(ire); return b.w > 0.5 ? b.rgb : vec3(grey); }
  if (mode == 4) { vec4 b = pocket_fc_limits(ire, uFx[P_FC].z); return b.w > 0.5 ? b.rgb : graded; }
  return graded;
}
"""

  private const val PEAK_COMMON = """
const float POCKET_PW0 = 0.382992;
const float POCKET_PW1 = 0.241798;
const float POCKET_PW2 = 0.060662;
const float POCKET_PW3 = 0.006044;

float pocket_tap(float offset) {
  float d = abs(offset);
  return d < 0.5 ? POCKET_PW0 : d < 1.5 ? POCKET_PW1 : d < 2.5 ? POCKET_PW2 : d < 3.5 ? POCKET_PW3 : 0.0;
}

uniform sampler2D uSrc;

vec4 pocket_fetch(sampler2D t, ivec2 p) {
  ivec2 size = textureSize(t, 0);
  return texelFetch(t, clamp(p, ivec2(0), size - 1), 0);
}

float pocket_grey(ivec2 p) {
  vec3 c = pocket_fetch(uSrc, p).rgb;
  return (c.r + c.g + c.b) / 3.0;
}

vec2 pocket_pack16(float value) {
  float scaled = clamp(value, 0.0, 1.0) * 255.0;
  float high = floor(scaled);
  return vec2(high, (scaled - high) * 255.0) / 255.0;
}

float pocket_unpack16(vec2 pair) { return pair.x + pair.y / 255.0; }

float pocket_roberts(float a, float b, float c, float d) {
  float d1 = d - a;
  float d2 = c - b;
  return d1 * d1 + d2 * d2;
}
"""

  val PEAK_BLUR = HEADER + COMMON + PEAK_COMMON + """
in vec2 vUv;
out vec4 oColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float row0 = 0.0;
  float row1 = 0.0;
  for (int r = 0; r < 8; r++) {
    float dy = float(r) - 3.0;
    float g = pocket_grey(p + ivec2(0, r - 3));
    row0 += pocket_tap(dy) * g;
    row1 += pocket_tap(dy - 1.0) * g;
  }
  oColor = vec4(pocket_pack16(row0), pocket_pack16(row1));
}
"""

  val PEAK_MASK = HEADER + COMMON + PEAK_COMMON + """
uniform sampler2D uBlur;
in vec2 vUv;
out vec4 oColor;
void main() {
  vec2 size = max(uFx[P_SRC].xy, vec2(1.0));
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (float(p.x) < 6.0 || float(p.y) < 6.0 || float(p.x) >= size.x - 6.0 || float(p.y) >= size.y - 6.0) {
    oColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float b00 = 0.0; float b10 = 0.0; float b01 = 0.0; float b11 = 0.0;
  for (int c = 0; c < 8; c++) {
    float dx = float(c) - 3.0;
    vec4 rows = pocket_fetch(uBlur, p + ivec2(c - 3, 0));
    float vp0 = pocket_unpack16(rows.xy);
    float vp1 = pocket_unpack16(rows.zw);
    float wx0 = pocket_tap(dx);
    float wx1 = pocket_tap(dx - 1.0);
    b00 += wx0 * vp0; b10 += wx1 * vp0; b01 += wx0 * vp1; b11 += wx1 * vp1;
  }
  float coarse = pocket_roberts(b00, b10, b01, b11);
  float fine = pocket_roberts(pocket_grey(p), pocket_grey(p + ivec2(1, 0)), pocket_grey(p + ivec2(0, 1)), pocket_grey(p + ivec2(1, 1)));
  float ratio = min(fine / max(coarse, 1e-9), 4.0);
  float ratioThreshold = uFx[P_PEAK].y;
  float noiseGate = uFx[P_PEAK].z;
  float gate = clamp((coarse - noiseGate * 0.7) / max(noiseGate * 0.3, 1e-9), 0.0, 1.0);
  float stroke = clamp((ratio - ratioThreshold) / 0.12, 0.0, 1.0) * gate;
  float under = clamp((ratio - (ratioThreshold - 0.06)) / 0.12, 0.0, 1.0) * gate;
  oColor = vec4(stroke, under, 0.0, 1.0);
}
"""

  val PICTURE = HEADER + COMMON + FALSE_COLOR + PEAK_COMMON + """
uniform sampler2D uMask;
in vec2 vUv;
out vec4 oColor;

float pocket_peak_closed(ivec2 c) {
  float m00 = pocket_fetch(uMask, c).r;
  float mR = pocket_fetch(uMask, c + ivec2(1, 0)).r;
  float mL = pocket_fetch(uMask, c - ivec2(1, 0)).r;
  float mD = pocket_fetch(uMask, c + ivec2(0, 1)).r;
  float mU = pocket_fetch(uMask, c - ivec2(0, 1)).r;
  float mRR = pocket_fetch(uMask, c + ivec2(2, 0)).r;
  float mLL = pocket_fetch(uMask, c - ivec2(2, 0)).r;
  float mDD = pocket_fetch(uMask, c + ivec2(0, 2)).r;
  float mUU = pocket_fetch(uMask, c - ivec2(0, 2)).r;
  float mRD = pocket_fetch(uMask, c + ivec2(1, 1)).r;
  float mRU = pocket_fetch(uMask, c + ivec2(1, -1)).r;
  float mLD = pocket_fetch(uMask, c + ivec2(-1, 1)).r;
  float mLU = pocket_fetch(uMask, c + ivec2(-1, -1)).r;
  float dC = max(max(max(m00, mR), max(mL, mD)), mU);
  float dR = max(max(max(mR, mRR), max(m00, mRD)), mRU);
  float dL = max(max(max(mL, m00), max(mLL, mLD)), mLU);
  float dD = max(max(max(mD, mRD), max(mLD, mDD)), m00);
  float dU = max(max(max(mU, mRU), max(mLU, m00)), mUU);
  return min(min(min(dC, dR), min(dL, dD)), dU);
}

void main() {
  vec2 viewPx = max(uFx[P_VIEW].xy, vec2(1.0));
  vec2 pix = vec2(gl_FragCoord.x, viewPx.y - gl_FragCoord.y);  // top-left pixel coords
  vec2 uv = pix / viewPx;
  vec4 map = uFx[P_MAP];
  vec2 suv = (uv - map.zw) * map.xy;
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) { oColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (uFx[P_VIEW].w > 0.5) suv.x = 1.0 - suv.x;
  vec2 tc = vec2(suv.x, 1.0 - suv.y);
  vec3 s = texture(uSrc, tc).rgb;
  vec3 color = pocket_grade(s);
  if (uFx[P_LUT].w > 0.5) color = vec3(dot(color, POCKET_LUMA709));
  if (uFx[P_FC].x > 0.5) color = pocket_false_color(s, color);
  if (uFx[P_PEAK].x > 0.5) {
    ivec2 c = ivec2(floor(tc * uFx[P_SRC].xy));
    float stroke = pocket_peak_closed(c);
    float under = pocket_fetch(uMask, c).g;
    color = mix(color, vec3(0.04, 0.04, 0.05), under);
    color = mix(color, uFx[P_PEAKC].rgb, stroke);
  }
  vec4 z = uFx[P_ZEB];
  if (z.x > 0.5) {
    float pitch = max(uFx[P_VIEW].z, 1.0);
    float stripe = z.w > 0.5 ? step(0.5, fract((pix.x + pix.y) / pitch)) : 1.0;
    vec4 a = uFx[P_ANCH];
    float hot = max(s.r, max(s.g, s.b));
    float m = clamp(pocket_monitor_ire(hot, a) - z.y + 1.0, 0.0, 1.0);
    if (z.z >= 0.0) {
      float d = abs(pocket_monitor_ire(dot(s, uFx[P_LUMA].xyz), a) - z.z);
      m = max(m, clamp((5.0 - d) * 2.0 + 1.0, 0.0, 1.0));
    }
    color = mix(color, uFx[P_ZEBP].rgb, m * stripe);
  }
  oColor = vec4(color, 1.0);
}
"""

  /** Measure: signal, or graded picture (`uMeasure.x` = 1), whole frame. */
  val MEASURE = HEADER + COMMON + """
uniform sampler2D uSrc;
uniform vec4 uMeasure;
in vec2 vUv;
out vec4 oColor;
void main() {
  vec3 s = texture(uSrc, vUv).rgb;
  if (uMeasure.x > 0.5) s = pocket_grade(s);
  oColor = vec4(s, 1.0);
}
"""

  /** Decoder output (external OES, already RGB) → signal texture. */
  const val INGEST_OES = """#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision highp float;
uniform samplerExternalOES uTex;
uniform mat4 uSt;
in vec2 vUv;
out vec4 oColor;
void main() {
  vec2 tc = (uSt * vec4(vUv, 0.0, 1.0)).xy;
  oColor = vec4(texture(uTex, tc).rgb, 1.0);
}
"""

  val INGEST_DEMO = HEADER + COMMON + """
uniform vec4 uDemo;  // x scene (0 studio, 1 bars, 2 skin, 3 night), y seconds, z transfer, w aspect
in vec2 vUv;
out vec4 oColor;

float pocket_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 pocket_demo_linear(vec2 uv, vec4 cfg) {
  int scene = int(cfg.x + 0.5);
  float time = cfg.y;
  float aspect = cfg.w;
  if (scene == 1) {
    if (uv.y < 0.6) {
      int i = clamp(int(floor(uv.x * 7.0)), 0, 6);
      vec3 bars[7] = vec3[7](vec3(0.75), vec3(0.75, 0.75, 0.0), vec3(0.0, 0.75, 0.75), vec3(0.0, 0.75, 0.0),
                             vec3(0.75, 0.0, 0.75), vec3(0.75, 0.0, 0.0), vec3(0.0, 0.0, 0.75));
      vec3 code = bars[i];
      return vec3(pocket_decode(code.r, 0), pocket_decode(code.g, 0), pocket_decode(code.b, 0));
    }
    if (uv.y < 0.78) {
      float stepv = floor(uv.x * 11.0) / 10.0;
      return vec3(pocket_decode(stepv, 0));
    }
    float marker = abs(uv.x - fract(time * 0.1)) < 0.002 ? 1.0 : 0.0;
    return vec3(mix(pocket_decode(uv.x, 0), 1.0, marker));
  }
  if (scene == 2) {
    vec3 wall = vec3(0.16, 0.155, 0.15) * (0.85 + 0.15 * uv.y);
    vec2 p = vec2(uv.x * aspect, uv.y);
    vec3 tones[5] = vec3[5](vec3(0.62, 0.42, 0.33), vec3(0.47, 0.30, 0.22), vec3(0.33, 0.20, 0.14),
                            vec3(0.20, 0.12, 0.08), vec3(0.72, 0.55, 0.47));
    for (int k = 0; k < 5; k++) {
      vec2 c = vec2((0.18 + 0.16 * float(k)) * aspect, 0.42 + 0.05 * sin(time * 0.7 + float(k)));
      float r = length(p - c);
      if (r < 0.11) {
        float shade = 0.75 + 0.25 * (1.0 - r / 0.11);
        return tones[k] * shade * 0.7;
      }
    }
    if (uv.y > 0.72 && uv.y < 0.9 && uv.x > 0.4 && uv.x < 0.6) return vec3(0.18);
    return wall;
  }
  if (scene == 3) {
    vec3 base = vec3(0.004, 0.005, 0.008) + vec3(0.01, 0.008, 0.006) * (1.0 - uv.y);
    vec2 p = vec2(uv.x * aspect, uv.y);
    vec3 light = vec3(0.0);
    for (int k = 0; k < 6; k++) {
      vec2 c = vec2((0.1 + 0.17 * float(k)) * aspect, 0.3 + 0.12 * fract(float(k) * 0.37));
      float d = length(p - c);
      vec3 tint = (k % 2 == 0) ? vec3(1.0, 0.75, 0.45) : vec3(0.6, 0.8, 1.0);
      light += tint * (0.002 / (d * d + 0.0004)) * (0.9 + 0.1 * sin(time * 3.0 + float(k)));
    }
    float noise = (pocket_hash(uv * 1000.0 + fract(time)) - 0.5) * 0.004;
    return max(base + light * 0.02 + noise, 0.0);
  }
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec3 backdrop = mix(vec3(0.05, 0.06, 0.08), vec3(0.22, 0.2, 0.18), uv.x) * (1.1 - 0.4 * uv.y);
  vec2 subject = vec2(0.5 * aspect + 0.08 * sin(time * 0.4), 0.55);
  float r = length(p - subject);
  if (r < 0.26) {
    float zone = 0.5 + 0.5 * cos(180.0 * r * r);
    float falloff = 1.0 - smoothstep(0.18, 0.26, r);
    return mix(backdrop, vec3(0.18) * (0.3 + 1.4 * zone), falloff);
  }
  if (uv.x > 0.06 && uv.x < 0.24 && uv.y > 0.08 && uv.y < 0.42) {
    float mullion = (abs(uv.x - 0.15) < 0.004 || abs(uv.y - 0.25) < 0.004) ? 0.05 : 1.0;
    return vec3(6.0, 6.2, 6.8) * mullion;
  }
  return backdrop;
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);  // top-left, like Metal
  vec3 l = pocket_demo_linear(uv, uDemo);
  int t = int(uDemo.z + 0.5);
  oColor = vec4(pocket_encode(l.r, t), pocket_encode(l.g, t), pocket_encode(l.b, t), 1.0);
}
"""

  /**
   * Scope draw. Bins are computed on the CPU (PocketScopeView) and uploaded as an R32F texture of
   * 256 × 1024 texels: element `idx` lives at (idx & 255, idx >> 8), planes at idx = p * 65536.
   * Same layout and drawing as the MSL `pocket_scope_draw_fragment`.
   */
  val SCOPE_DRAW = HEADER + """
uniform sampler2D uBins;
uniform vec4 uScope[4];  // anch, luma, cfg (kind, mode, gain, width), draw (brightness, viewW, viewH, peak)
in vec2 vUv;
out vec4 oColor;

float pocket_bins(int idx) { return texelFetch(uBins, ivec2(idx & 255, idx >> 8), 0).r; }
int pocket_bin(float level) { return int(clamp(level * 255.0 + 0.5, 0.0, 255.0)); }
float pocket_line(float distPx) { return clamp(1.0 - abs(distPx), 0.0, 1.0); }

void main() {
  vec4 anch = uScope[0];
  vec4 cfg = uScope[2];
  vec4 dr = uScope[3];
  int kind = int(cfg.x + 0.5);
  bool rgb = cfg.y > 0.5;
  float bright = clamp(dr.x, 0.0, 1.0);
  vec2 viewPx = max(dr.yz, vec2(1.0));
  float peak = dr.w;
  float lp = log(1.0 + max(peak, 1.0));
  vec2 pixTL = vec2(gl_FragCoord.x, viewPx.y - gl_FragCoord.y);
  vec2 uv = pixTL / viewPx;
  vec3 trace = vec3(0.0);
  float alpha = 0.0;
  float grat = 0.0;

  if (kind == 0 || kind == 1) {
    int W = int(max(cfg.w, 1.0));
    float level = 1.0 - uv.y;
    int b = pocket_bin(level);
    if (kind == 0) {
      int x = min(int(uv.x * float(W)), W - 1);
      if (!rgb) {
        float c = pocket_bins(x * 256 + b);
        if (c > 0.0) { float d = log(1.0 + c) / lp; alpha = (0.4 + 0.6 * d) * bright; trace = vec3(1.0); }
      } else {
        for (int ch = 0; ch < 3; ch++) {
          float c = pocket_bins(ch * 65536 + x * 256 + b);
          if (c > 0.0) trace[ch] = max(trace[ch], (0.4 + 0.6 * log(1.0 + c) / lp) * bright);
        }
        alpha = max(trace.r, max(trace.g, trace.b));
        if (alpha > 0.0) trace /= alpha;
      }
    } else {
      int lane = min(int(uv.x * 3.0), 2);
      float lx = uv.x * 3.0 - float(lane);
      int x = min(int(lx * float(W)), W - 1);
      float c = pocket_bins(lane * 65536 + x * 256 + b);
      if (c > 0.0) {
        float d = log(1.0 + c) / lp;
        alpha = (0.4 + 0.6 * d) * bright;
        trace = lane == 0 ? vec3(1.0, 0.3, 0.3) : (lane == 1 ? vec3(0.3, 1.0, 0.3) : vec3(0.35, 0.5, 1.0));
      }
      grat = max(grat, pocket_line((uv.x * 3.0 - 1.0) * viewPx.x / 3.0) * 0.25);
      grat = max(grat, pocket_line((uv.x * 3.0 - 2.0) * viewPx.x / 3.0) * 0.25);
    }
    float yPx = level * viewPx.y;
    grat = max(grat, pocket_line(yPx - 0.05 * viewPx.y) * 0.35);
    grat = max(grat, pocket_line(yPx - 0.95 * viewPx.y) * 0.35);
    grat = max(grat, pocket_line(yPx - anch.w * viewPx.y) * 0.25);
    grat = max(grat, pocket_line(yPx - 0.5 * viewPx.y) * 0.12);
  } else if (kind == 2) {
    int b = pocket_bin(uv.x);
    float h = 1.0 - uv.y;
    if (!rgb) {
      float v = pocket_bins(b) / max(peak, 1.0);
      if (h <= v) { alpha = 0.55 * bright + 0.1; trace = vec3(1.0); }
    } else {
      for (int ch = 0; ch < 3; ch++) {
        float v = pocket_bins((ch + 1) * 256 + b) / max(peak, 1.0);
        if (h <= v) trace[ch] = 1.0;
      }
      float anyOn = max(trace.r, max(trace.g, trace.b));
      alpha = anyOn * (0.5 * bright + 0.1);
    }
    float xPx = uv.x * viewPx.x;
    grat = max(grat, pocket_line(xPx - 0.05 * viewPx.x) * 0.3);
    grat = max(grat, pocket_line(xPx - 0.95 * viewPx.x) * 0.3);
    grat = max(grat, pocket_line(xPx - anch.w * viewPx.x) * 0.2);
  } else {
    float side = min(viewPx.x, viewPx.y);
    vec2 local = (pixTL - viewPx * 0.5) / side + 0.5;
    if (local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0) {
      int col = int(clamp(floor(local.x * 127.0 + 0.5), 0.0, 127.0));
      int row = int(clamp(floor((1.0 - local.y) * 127.0 + 0.5), 0.0, 127.0));
      int idx = row * 128 + col;
      float c = pocket_bins(idx);
      if (c > 0.0) {
        float d = log(1.0 + c) / lp;
        alpha = clamp((0.4 + 0.6 * d) * bright, 0.0, 1.0);
        vec3 avg = vec3(pocket_bins(65536 + idx), pocket_bins(131072 + idx), pocket_bins(196608 + idx)) / (c * 255.0);
        float lo = min(avg.r, min(avg.g, avg.b));
        float hi = max(avg.r, max(avg.g, avg.b));
        float span = hi - lo;
        if (hi > 1e-6 && span > 1e-6) {
          float sat = clamp(span / hi, 0.0, 1.0);
          trace = (1.0 - sat) + (avg - lo) / span * sat;
        } else {
          trace = vec3(1.0);
        }
      }
      vec2 q = (local - 0.5) * side;
      float r = length(q);
      grat = max(grat, pocket_line(r - 0.5 * side) * 0.3);
      grat = max(grat, pocket_line(r - 0.375 * side) * 0.15);
      grat = max(grat, pocket_line(q.x) * 0.15 * step(r, 0.5 * side));
      grat = max(grat, pocket_line(q.y) * 0.15 * step(r, 0.5 * side));
      vec2 dir = vec2(-0.544639, -0.838671);
      float along = dot(q, dir);
      float across = q.x * dir.y - q.y * dir.x;
      if (along > 0.0 && along < 0.5 * side) grat = max(grat, pocket_line(across) * 0.35);
    }
  }
  vec3 g = vec3(0.85, 0.85, 0.8) * grat;
  float a = clamp(alpha, 0.0, 1.0);
  oColor = vec4(trace * a + g * (1.0 - a), a + grat * (1.0 - a));
}
"""

  /** Plain textured blit (signal → RGBA readback at another size). */
  val BLIT = HEADER + """
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 oColor;
void main() { oColor = vec4(texture(uSrc, vUv).rgb, 1.0); }
"""
}
