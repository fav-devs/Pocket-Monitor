// Metal Shading Language source, compiled at runtime (`makeLibrary(source:)`) so the pod needs
// no .metallib resource bundle. Semantics are mirrored 1:1 in Android `OpcVideoShaders.kt`
// and in the web GLSL; the uniform slots are documented in `OpcVideoFxUniforms`.
//
// Per-pixel order (picture): signal → display transform (sourceColor) → LUT mix (lutIntensity)
// → monochrome → false colour → peaking → zebra. Zebra, false colour and peaking measure the
// camera signal (encoded codes on the WAVE axis), never the graded picture.

let opcVideoShaderSource = """
#include <metal_stdlib>
using namespace metal;

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

struct OpcFx { float4 v[17]; };

struct OpcVOut {
  float4 position [[position]];
  float2 uv;
};

// Full-screen triangle; uv has a top-left origin like Metal textures.
vertex OpcVOut opc_fullscreen_vertex(uint vid [[vertex_id]]) {
  float2 p = float2(float((vid << 1) & 2), float(vid & 2));
  OpcVOut o;
  o.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = float2(p.x, 1.0 - p.y);
  return o;
}

constant float OPC_CRUSH = 0.05;
constant float OPC_CLIPL = 0.95;
constant float3 OPC_LUMA709 = float3(0.2126, 0.7152, 0.0722);

// ScopeDisplayScale.waveformLevel on anchors (black, mid, clip, midLevel).
static float opc_wave_level(float v, float4 a) {
  v = clamp(v, 0.0, 1.0);
  float black = a.x, mid = a.y, clip = a.z, midL = a.w;
  if (v < black) return black <= 0.0 ? OPC_CRUSH : v / black * OPC_CRUSH;
  if (v > clip) {
    float head = 1.0 - clip;
    return head <= 0.0 ? OPC_CLIPL : OPC_CLIPL + (v - clip) / head * (1.0 - OPC_CLIPL);
  }
  if (clip <= mid || mid <= black) return OPC_CRUSH + (v - black) / max(clip - black, 1e-6) * (OPC_CLIPL - OPC_CRUSH);
  if (v <= mid) return OPC_CRUSH + (v - black) / (mid - black) * (midL - OPC_CRUSH);
  return midL + (v - mid) / (clip - mid) * (OPC_CLIPL - midL);
}

static float opc_monitor_ire(float v, float4 a) {
  return clamp((opc_wave_level(v, a) - OPC_CRUSH) / (OPC_CLIPL - OPC_CRUSH) * 100.0, 0.0, 100.0);
}

// Inverse transfer (camera code → scene linear), not clamped below zero.
static float opc_decode(float e, int t) {
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

// Forward transfer (scene linear → camera code), clamped 0…1. Used by the demo scenes.
static float opc_encode(float l, int t) {
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
    o = l <= 0.0078 ? 6.025 * l + 0.0929 : log10(l * 0.9892 + 0.0108) * 0.256663 + 0.584555;
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

// MonitorSceneToneMap.displayCode: tone.x gain, tone.y contrast, tone.z whiteReinhard.
static float opc_tone(float x, float4 tone) {
  float xn = max(x, 0.0) / 0.18;
  float c = tone.x * pow(max(xn, 1e-8), tone.y);
  float w = tone.z;
  float m = c * (1.0 + c / (w * w)) / (1.0 + c);
  return pow(clamp(m, 0.0, 1.0), 1.0 / 2.4);
}

// MonitorLogDisplayTransform: decode → source gamut to Rec.709 → clamp ≥ 0 → tone map.
static float3 opc_display(float3 s, constant OpcFx& fx) {
  if (fx.v[P_TONE].w < 0.5) return s;
  int t = int(fx.v[P_LUMA].w + 0.5);
  float3 lin = float3(opc_decode(s.r, t), opc_decode(s.g, t), opc_decode(s.b, t));
  float3 m = max(float3(dot(fx.v[P_GR].xyz, lin), dot(fx.v[P_GG].xyz, lin), dot(fx.v[P_GB].xyz, lin)), 0.0);
  float4 tone = fx.v[P_TONE];
  return float3(opc_tone(m.r, tone), opc_tone(m.g, tone), opc_tone(m.b, tone));
}

static float3 opc_lut(float3 s, texture3d<float> lut, sampler smp, constant OpcFx& fx) {
  float n = fx.v[P_LUT].y;
  float3 dmin = fx.v[P_LUTMIN].xyz;
  float3 dmax = fx.v[P_LUTMAX].xyz;
  float3 c = clamp((s - dmin) / max(dmax - dmin, float3(1e-6)), 0.0, 1.0);
  float3 coord = (c * (n - 1.0) + 0.5) / n;
  return lut.sample(smp, coord).rgb;
}

// Display transform, then the LUT (fed the camera signal) mixed by lutIntensity.
static float3 opc_grade(float3 s, texture3d<float> lut, sampler smp, constant OpcFx& fx) {
  float3 c = opc_display(s, fx);
  if (fx.v[P_LUT].x > 0.5) c = mix(c, opc_lut(s, lut, smp, fx), clamp(fx.v[P_LUT].z, 0.0, 1.0));
  return clamp(c, 0.0, 1.0);
}

static float3 opc_rgb255(float r, float g, float b) { return float3(r, g, b) / 255.0; }

// CineStop (scene stops around 18% grey; clip from the camera ceiling shelf).
static float3 opc_fc_cinestop(float st, float clipStops) {
  if (st >= clipStops) return opc_rgb255(245, 39, 0);
  if (st < -6.5) return opc_rgb255(75, 8, 165);
  if (st < -2.5) return opc_rgb255(102, 102, 102);
  if (st < -1.5) return opc_rgb255(39, 76, 0);
  if (st < -0.5) return opc_rgb255(155, 196, 56);
  if (st < 0.5) return opc_rgb255(127, 127, 127);
  if (st < 1.5) return opc_rgb255(221, 174, 180);
  if (st < 2.5) return opc_rgb255(252, 232, 96);
  return opc_rgb255(179, 178, 178);
}

// Returns rgb + w = 1 when a band paints, w = 0 in a gap.
static float4 opc_fc_video(float ire) {
  if (ire < 5.0) return float4(0.44, 0.22, 0.76, 1);
  if (ire < 6.0) return float4(0.28, 0.37, 0.85, 1);
  if (ire >= 10.0 && ire < 13.0) return float4(0.18, 0.58, 0.64, 1);
  if (ire >= 41.0 && ire < 49.0) return float4(0.38, 0.63, 0.35, 1);
  if (ire >= 61.0 && ire < 71.0) return float4(0.83, 0.53, 0.71, 1);
  if (ire >= 92.0 && ire < 94.0) return float4(0.83, 0.77, 0.45, 1);
  if (ire >= 94.0 && ire < 96.0) return float4(0.89, 0.72, 0.29, 1);
  if (ire >= 96.0 && ire < 99.0) return float4(0.85, 0.55, 0.22, 1);
  if (ire >= 99.0) return float4(0.78, 0.28, 0.18, 1);
  return float4(0);
}

static float4 opc_fc_ire(float ire) {
  if (ire < 2.5) return float4(opc_rgb255(115, 33, 120), 1);
  if (ire < 10.0) return float4(opc_rgb255(29, 2, 221), 1);
  if (ire >= 38.0 && ire < 42.0) return float4(opc_rgb255(123, 207, 87), 1);
  if (ire >= 52.0 && ire < 56.0) return float4(opc_rgb255(241, 190, 198), 1);
  if (ire >= 80.0 && ire < 95.0) return float4(opc_rgb255(255, 255, 88), 1);
  if (ire >= 95.0) return float4(opc_rgb255(220, 51, 33), 1);
  return float4(0);
}

static float4 opc_fc_limits(float ire, float edge) {
  if (ire < 5.0) return float4(0.44, 0.22, 0.76, 1);
  if (ire < 10.0) return float4(0.28, 0.37, 0.85, 1);
  if (ire >= 94.0 && ire < edge) return float4(0.89, 0.72, 0.29, 1);
  if (ire >= edge) return float4(0.78, 0.28, 0.18, 1);
  return float4(0);
}

static float3 opc_false_color(float3 s, float3 graded, constant OpcFx& fx) {
  int mode = int(fx.v[P_FC].x + 0.5);
  int t = int(fx.v[P_LUMA].w + 0.5);
  float luma = dot(s, fx.v[P_LUMA].xyz);
  if (mode == 1) {
    float lin = max(opc_decode(luma, t), 0.0);
    float st = lin > 0.0 ? log2(lin / 0.18) : -100.0;
    return opc_fc_cinestop(st, fx.v[P_FC].y);
  }
  float ire = opc_monitor_ire(luma, fx.v[P_ANCH]);
  float grey = dot(graded, OPC_LUMA709);
  if (mode == 2) { float4 b = opc_fc_video(ire); return b.w > 0.5 ? b.rgb : float3(grey); }
  if (mode == 3) { float4 b = opc_fc_ire(ire); return b.w > 0.5 ? b.rgb : float3(grey); }
  if (mode == 4) { float4 b = opc_fc_limits(ire, fx.v[P_FC].z); return b.w > 0.5 ? b.rgb : graded; }
  return graded;
}

// Peaking (Apps/Desktop opc-render peaking_blur / peaking_mask / feed.frag).
constant float OPC_PW0 = 0.382992;
constant float OPC_PW1 = 0.241798;
constant float OPC_PW2 = 0.060662;
constant float OPC_PW3 = 0.006044;

static float opc_tap(float offset) {
  float d = abs(offset);
  return d < 0.5 ? OPC_PW0 : d < 1.5 ? OPC_PW1 : d < 2.5 ? OPC_PW2 : d < 3.5 ? OPC_PW3 : 0.0;
}

static float opc_grey(texture2d<float> src, sampler smp, float2 uv) {
  float3 c = src.sample(smp, uv).rgb;
  return (c.r + c.g + c.b) / 3.0;
}

static float2 opc_pack16(float value) {
  float scaled = clamp(value, 0.0, 1.0) * 255.0;
  float high = floor(scaled);
  return float2(high, (scaled - high) * 255.0) / 255.0;
}

static float opc_unpack16(float2 pair) { return pair.x + pair.y / 255.0; }

static float opc_roberts(float a, float b, float c, float d) {
  float d1 = d - a;
  float d2 = c - b;
  return d1 * d1 + d2 * d2;
}

fragment float4 opc_peak_blur_fragment(OpcVOut in [[stage_in]], constant OpcFx& fx [[buffer(0)]],
                                       texture2d<float> src [[texture(0)]], sampler near [[sampler(1)]]) {
  float2 size = max(fx.v[P_SRC].xy, float2(1.0));
  float2 texel = 1.0 / size;
  float2 centre = (floor(in.uv * size) + 0.5) * texel;
  float row0 = 0.0, row1 = 0.0;
  for (int r = 0; r < 8; r++) {
    float dy = float(r) - 3.0;
    float g = opc_grey(src, near, centre + float2(0.0, dy) * texel);
    row0 += opc_tap(dy) * g;
    row1 += opc_tap(dy - 1.0) * g;
  }
  return float4(opc_pack16(row0), opc_pack16(row1));
}

fragment float4 opc_peak_mask_fragment(OpcVOut in [[stage_in]], constant OpcFx& fx [[buffer(0)]],
                                       texture2d<float> src [[texture(0)]], texture2d<float> blur [[texture(1)]],
                                       sampler near [[sampler(1)]]) {
  float2 size = max(fx.v[P_SRC].xy, float2(1.0));
  float2 inset = float2(6.0) / size;
  if (in.uv.x < inset.x || in.uv.y < inset.y || in.uv.x >= 1.0 - inset.x || in.uv.y >= 1.0 - inset.y) {
    return float4(0, 0, 0, 1);
  }
  float2 texel = 1.0 / size;
  float2 centre = (floor(in.uv * size) + 0.5) * texel;
  float b00 = 0.0, b10 = 0.0, b01 = 0.0, b11 = 0.0;
  for (int c = 0; c < 8; c++) {
    float dx = float(c) - 3.0;
    float4 rows = blur.sample(near, centre + float2(dx, 0.0) * texel);
    float vp0 = opc_unpack16(rows.xy);
    float vp1 = opc_unpack16(rows.zw);
    float wx0 = opc_tap(dx);
    float wx1 = opc_tap(dx - 1.0);
    b00 += wx0 * vp0; b10 += wx1 * vp0; b01 += wx0 * vp1; b11 += wx1 * vp1;
  }
  float coarse = opc_roberts(b00, b10, b01, b11);
  float fine = opc_roberts(opc_grey(src, near, centre), opc_grey(src, near, centre + float2(texel.x, 0.0)),
                           opc_grey(src, near, centre + float2(0.0, texel.y)), opc_grey(src, near, centre + texel));
  float ratio = min(fine / max(coarse, 1e-9), 4.0);
  float ratioThreshold = fx.v[P_PEAK].y;
  float noiseGate = fx.v[P_PEAK].z;
  float gate = clamp((coarse - noiseGate * 0.7) / max(noiseGate * 0.3, 1e-9), 0.0, 1.0);
  float stroke = clamp((ratio - ratioThreshold) / 0.12, 0.0, 1.0) * gate;
  float under = clamp((ratio - (ratioThreshold - 0.06)) / 0.12, 0.0, 1.0) * gate;
  return float4(stroke, under, 0.0, 1.0);
}

static float opc_peak_closed(texture2d<float> m, sampler near, float2 c, float2 t) {
  float m00 = m.sample(near, c).r;
  float mR = m.sample(near, c + float2(t.x, 0)).r;
  float mL = m.sample(near, c - float2(t.x, 0)).r;
  float mD = m.sample(near, c + float2(0, t.y)).r;
  float mU = m.sample(near, c - float2(0, t.y)).r;
  float mRR = m.sample(near, c + float2(2.0 * t.x, 0)).r;
  float mLL = m.sample(near, c - float2(2.0 * t.x, 0)).r;
  float mDD = m.sample(near, c + float2(0, 2.0 * t.y)).r;
  float mUU = m.sample(near, c - float2(0, 2.0 * t.y)).r;
  float mRD = m.sample(near, c + float2(t.x, t.y)).r;
  float mRU = m.sample(near, c + float2(t.x, -t.y)).r;
  float mLD = m.sample(near, c + float2(-t.x, t.y)).r;
  float mLU = m.sample(near, c + float2(-t.x, -t.y)).r;
  float dC = max(max(max(m00, mR), max(mL, mD)), mU);
  float dR = max(max(max(mR, mRR), max(m00, mRD)), mRU);
  float dL = max(max(max(mL, m00), max(mLL, mLD)), mLU);
  float dD = max(max(max(mD, mRD), max(mLD, mDD)), m00);
  float dU = max(max(max(mU, mRU), max(mLU, m00)), mUU);
  return min(min(min(dC, dR), min(dL, dD)), dU);
}

// The monitoring picture.
fragment float4 opc_picture_fragment(OpcVOut in [[stage_in]], constant OpcFx& fx [[buffer(0)]],
                                     texture2d<float> src [[texture(0)]], texture3d<float> lut [[texture(1)]],
                                     texture2d<float> mask [[texture(2)]],
                                     sampler lin [[sampler(0)]], sampler near [[sampler(1)]]) {
  float4 map = fx.v[P_MAP];
  float2 suv = (in.uv - map.zw) * map.xy;
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) return float4(0, 0, 0, 1);
  if (fx.v[P_VIEW].w > 0.5) suv.x = 1.0 - suv.x;
  float3 s = src.sample(lin, suv).rgb;
  float3 color = opc_grade(s, lut, lin, fx);
  if (fx.v[P_LUT].w > 0.5) color = float3(dot(color, OPC_LUMA709));
  if (fx.v[P_FC].x > 0.5) color = opc_false_color(s, color, fx);
  if (fx.v[P_PEAK].x > 0.5) {
    float2 texel = fx.v[P_SRC].zw;
    float2 centre = (floor(suv * fx.v[P_SRC].xy) + 0.5) * texel;
    float stroke = opc_peak_closed(mask, near, centre, texel);
    float under = mask.sample(near, centre).g;
    color = mix(color, float3(0.04, 0.04, 0.05), under);
    color = mix(color, fx.v[P_PEAKC].rgb, stroke);
  }
  float4 z = fx.v[P_ZEB];
  if (z.x > 0.5) {
    float2 pix = in.position.xy;
    float pitch = max(fx.v[P_VIEW].z, 1.0);
    float stripe = z.w > 0.5 ? step(0.5, fract((pix.x + pix.y) / pitch)) : 1.0;
    float4 a = fx.v[P_ANCH];
    float hot = max(s.r, max(s.g, s.b));
    float m = clamp(opc_monitor_ire(hot, a) - z.y + 1.0, 0.0, 1.0);
    if (z.z >= 0.0) {
      float d = abs(opc_monitor_ire(dot(s, fx.v[P_LUMA].xyz), a) - z.z);
      m = max(m, clamp((5.0 - d) * 2.0 + 1.0, 0.0, 1.0));
    }
    color = mix(color, fx.v[P_ZEBP].rgb, m * stripe);
  }
  return float4(color, 1.0);
}

// Ingest: decoder planes → RGBA signal texture at source size.
struct OpcIngest { float4 cfg; };  // x fullRange, y unused, z unused, w unused

fragment float4 opc_ingest_yuv_fragment(OpcVOut in [[stage_in]], constant OpcIngest& p [[buffer(0)]],
                                        texture2d<float> lumaTex [[texture(0)]], texture2d<float> chromaTex [[texture(1)]],
                                        sampler lin [[sampler(0)]]) {
  float y = lumaTex.sample(lin, in.uv).r;
  float2 c = chromaTex.sample(lin, in.uv).rg - float2(128.0 / 255.0);
  if (p.cfg.x < 0.5) {
    y = (y - 16.0 / 255.0) * (255.0 / 219.0);
    c *= 255.0 / 224.0;
  }
  float3 rgb = float3(y + 1.5748 * c.y, y - 0.1873 * c.x - 0.4681 * c.y, y + 1.8556 * c.x);
  return float4(clamp(rgb, 0.0, 1.0), 1.0);
}

fragment float4 opc_ingest_rgb_fragment(OpcVOut in [[stage_in]], texture2d<float> tex [[texture(0)]],
                                        sampler lin [[sampler(0)]]) {
  return float4(tex.sample(lin, in.uv).rgb, 1.0);
}

// Procedural demo scenes (scene-linear light, encoded with the selected transfer).
struct OpcDemo { float4 cfg; };  // x scene (0 studio, 1 bars, 2 skin, 3 night), y seconds, z transfer, w aspect

static float opc_hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }

static float3 opc_demo_linear(float2 uv, float4 cfg) {
  int scene = int(cfg.x + 0.5);
  float time = cfg.y;
  float aspect = cfg.w;
  if (scene == 1) {
    // 75% bars, an 11-step grey scale and a full ramp (scene linear of Rec.709 codes).
    if (uv.y < 0.6) {
      int i = int(floor(uv.x * 7.0));
      float3 bars[7] = { float3(0.75), float3(0.75, 0.75, 0), float3(0, 0.75, 0.75), float3(0, 0.75, 0),
                         float3(0.75, 0, 0.75), float3(0.75, 0, 0), float3(0, 0, 0.75) };
      float3 code = bars[clamp(i, 0, 6)];
      return float3(opc_decode(code.r, 0), opc_decode(code.g, 0), opc_decode(code.b, 0));
    }
    if (uv.y < 0.78) {
      float step = floor(uv.x * 11.0) / 10.0;
      return float3(opc_decode(step, 0));
    }
    float ramp = uv.x;
    float marker = abs(uv.x - fract(time * 0.1)) < 0.002 ? 1.0 : 0.0;
    return float3(mix(opc_decode(ramp, 0), 1.0, marker));
  }
  if (scene == 2) {
    // Skin patches on a neutral wall with an 18% card.
    float3 wall = float3(0.16, 0.155, 0.15) * (0.85 + 0.15 * uv.y);
    float2 p = float2(uv.x * aspect, uv.y);
    float3 tones[5] = { float3(0.62, 0.42, 0.33), float3(0.47, 0.30, 0.22), float3(0.33, 0.20, 0.14),
                        float3(0.20, 0.12, 0.08), float3(0.72, 0.55, 0.47) };
    for (int k = 0; k < 5; k++) {
      float2 c = float2((0.18 + 0.16 * float(k)) * aspect, 0.42 + 0.05 * sin(time * 0.7 + float(k)));
      float r = length(p - c);
      if (r < 0.11) {
        float shade = 0.75 + 0.25 * (1.0 - r / 0.11);
        return tones[k] * shade * 0.7;
      }
    }
    if (uv.y > 0.72 && uv.y < 0.9 && uv.x > 0.4 && uv.x < 0.6) return float3(0.18);
    return wall;
  }
  if (scene == 3) {
    // Low key: dark street with practical lights and sensor noise.
    float3 base = float3(0.004, 0.005, 0.008) + float3(0.01, 0.008, 0.006) * (1.0 - uv.y);
    float2 p = float2(uv.x * aspect, uv.y);
    float3 light = float3(0);
    for (int k = 0; k < 6; k++) {
      float2 c = float2((0.1 + 0.17 * float(k)) * aspect, 0.3 + 0.12 * fract(float(k) * 0.37));
      float d = length(p - c);
      float3 tint = k % 2 == 0 ? float3(1.0, 0.75, 0.45) : float3(0.6, 0.8, 1.0);
      light += tint * (0.002 / (d * d + 0.0004)) * (0.9 + 0.1 * sin(time * 3.0 + float(k)));
    }
    float noise = (opc_hash(uv * 1000.0 + fract(time)) - 0.5) * 0.004;
    return max(base + light * 0.02 + noise, 0.0);
  }
  // Studio: graded backdrop, a zone-plate subject (focus detail), a window that clips.
  float2 p = float2(uv.x * aspect, uv.y);
  float3 backdrop = mix(float3(0.05, 0.06, 0.08), float3(0.22, 0.2, 0.18), uv.x) * (1.1 - 0.4 * uv.y);
  float2 subject = float2(0.5 * aspect + 0.08 * sin(time * 0.4), 0.55);
  float r = length(p - subject);
  if (r < 0.26) {
    float zone = 0.5 + 0.5 * cos(180.0 * r * r);
    float falloff = 1.0 - smoothstep(0.18, 0.26, r);
    return mix(backdrop, float3(0.18) * (0.3 + 1.4 * zone), falloff);
  }
  if (uv.x > 0.06 && uv.x < 0.24 && uv.y > 0.08 && uv.y < 0.42) {
    float mullion = (abs(uv.x - 0.15) < 0.004 || abs(uv.y - 0.25) < 0.004) ? 0.05 : 1.0;
    return float3(6.0, 6.2, 6.8) * mullion;
  }
  return backdrop;
}

fragment float4 opc_ingest_demo_fragment(OpcVOut in [[stage_in]], constant OpcDemo& d [[buffer(0)]]) {
  float3 l = opc_demo_linear(in.uv, d.cfg);
  int t = int(d.cfg.z + 0.5);
  return float4(opc_encode(l.r, t), opc_encode(l.g, t), opc_encode(l.b, t), 1.0);
}

// Scope measurement: the signal, or the graded picture when measuring after the LUT.
fragment float4 opc_measure_fragment(OpcVOut in [[stage_in]], constant OpcFx& fx [[buffer(0)]],
                                     texture2d<float> src [[texture(0)]], texture3d<float> lut [[texture(1)]],
                                     constant float4& mcfg [[buffer(1)]], sampler lin [[sampler(0)]]) {
  float3 s = src.sample(lin, in.uv).rgb;
  if (mcfg.x > 0.5) s = opc_grade(s, lut, lin, fx);
  return float4(s, 1.0);
}

// ─── Scopes ─────────────────────────────────────────────────────────────────────────────
// bins layout (uint): plane p at p * 65536.
//   waveform/parade: plane ch, index x * 256 + level bin (x < measure width ≤ 256)
//   histogram: index plane * 256 + bin within [0, 1024) (plane 0 luma, 1…3 r g b)
//   vectorscope: counts row * 128 + col in plane 0, channel sums in planes 1…3
//   bins[4 * 65536] = peak count (written by opc_scope_reduce)
#define OPC_MAX_SLOT 262144u

struct OpcScope {
  float4 anch;  // axis anchors (signal transfer, or Rec.709 after the LUT)
  float4 luma;  // xyz weights
  float4 cfg;   // x kind (0 waveform, 1 parade, 2 histogram, 3 vectorscope), y mode (0 luma, 1 rgb), z gain, w measure width
  float4 draw;  // x brightness, y view width px, z view height px, w unused
};

static uint opc_bin(float level) { return uint(clamp(level * 255.0 + 0.5, 0.0, 255.0)); }

kernel void opc_scope_accumulate(texture2d<float, access::read> m [[texture(0)]],
                                 device atomic_uint* bins [[buffer(0)]],
                                 constant OpcScope& p [[buffer(1)]],
                                 uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= m.get_width() || gid.y >= m.get_height()) return;
  float3 c = m.read(gid).rgb;
  int kind = int(p.cfg.x + 0.5);
  bool rgb = p.cfg.y > 0.5;
  if (kind == 0 || kind == 1) {
    uint x = min(gid.x, 255u);
    if (kind == 0 && !rgb) {
      atomic_fetch_add_explicit(&bins[x * 256u + opc_bin(opc_wave_level(dot(c, p.luma.xyz), p.anch))], 1u, memory_order_relaxed);
    } else {
      for (uint ch = 0; ch < 3; ch++) {
        uint b = opc_bin(opc_wave_level(c[ch], p.anch));
        atomic_fetch_add_explicit(&bins[ch * 65536u + x * 256u + b], 1u, memory_order_relaxed);
      }
    }
  } else if (kind == 2) {
    atomic_fetch_add_explicit(&bins[opc_bin(opc_wave_level(dot(c, p.luma.xyz), p.anch))], 1u, memory_order_relaxed);
    for (uint ch = 0; ch < 3; ch++) {
      atomic_fetch_add_explicit(&bins[(ch + 1u) * 256u + opc_bin(opc_wave_level(c[ch], p.anch))], 1u, memory_order_relaxed);
    }
  } else {
    float y = dot(c, OPC_LUMA709);
    float x = (c.b - y) / 1.8556 * p.cfg.z + 0.5;
    float v = (c.r - y) / 1.5748 * p.cfg.z + 0.5;
    if (x < 0.0 || x > 1.0 || v < 0.0 || v > 1.0) return;
    uint idx = uint(round(v * 127.0)) * 128u + uint(round(x * 127.0));
    atomic_fetch_add_explicit(&bins[idx], 1u, memory_order_relaxed);
    atomic_fetch_add_explicit(&bins[65536u + idx], uint(c.r * 255.0), memory_order_relaxed);
    atomic_fetch_add_explicit(&bins[131072u + idx], uint(c.g * 255.0), memory_order_relaxed);
    atomic_fetch_add_explicit(&bins[196608u + idx], uint(c.b * 255.0), memory_order_relaxed);
  }
}

// One threadgroup of 256 threads: peak over bins[range.x ..< range.x + range.y] with a stride
// of range.z planes (range.w = plane count).
kernel void opc_scope_reduce(device uint* bins [[buffer(0)]], constant uint4& range [[buffer(1)]],
                             uint tid [[thread_index_in_threadgroup]]) {
  threadgroup uint partial[256];
  uint best = 0;
  for (uint plane = 0; plane < range.w; plane++) {
    uint base = range.x + plane * range.z;
    for (uint i = tid; i < range.y; i += 256u) best = max(best, bins[base + i]);
  }
  partial[tid] = best;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  for (uint s = 128u; s > 0u; s >>= 1) {
    if (tid < s) partial[tid] = max(partial[tid], partial[tid + s]);
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
  if (tid == 0) bins[OPC_MAX_SLOT] = partial[0];
}

static float opc_line(float distPx) { return clamp(1.0 - abs(distPx), 0.0, 1.0); }

fragment float4 opc_scope_draw_fragment(OpcVOut in [[stage_in]], device const uint* bins [[buffer(0)]],
                                        constant OpcScope& p [[buffer(1)]]) {
  int kind = int(p.cfg.x + 0.5);
  bool rgb = p.cfg.y > 0.5;
  float bright = clamp(p.draw.x, 0.0, 1.0);
  float2 viewPx = max(p.draw.yz, float2(1.0));
  float peak = float(bins[OPC_MAX_SLOT]);
  float lp = log(1.0 + max(peak, 1.0));
  float2 uv = in.uv;
  float3 trace = float3(0);
  float alpha = 0.0;
  float grat = 0.0;

  if (kind == 0 || kind == 1) {
    uint W = uint(max(p.cfg.w, 1.0));
    float level = 1.0 - uv.y;
    uint b = opc_bin(level);
    if (kind == 0) {
      uint x = min(uint(uv.x * float(W)), W - 1u);
      if (!rgb) {
        float c = float(bins[x * 256u + b]);
        if (c > 0.0) { float d = log(1.0 + c) / lp; alpha = (0.4 + 0.6 * d) * bright; trace = float3(1.0); }
      } else {
        for (uint ch = 0; ch < 3; ch++) {
          float c = float(bins[ch * 65536u + x * 256u + b]);
          if (c > 0.0) {
            float d = (0.4 + 0.6 * log(1.0 + c) / lp) * bright;
            trace[ch] = max(trace[ch], d);
          }
        }
        alpha = max(trace.r, max(trace.g, trace.b));
        trace = alpha > 0.0 ? trace / alpha : trace;
      }
    } else {
      uint lane = min(uint(uv.x * 3.0), 2u);
      float lx = uv.x * 3.0 - float(lane);
      uint x = min(uint(lx * float(W)), W - 1u);
      float c = float(bins[lane * 65536u + x * 256u + b]);
      if (c > 0.0) {
        float d = log(1.0 + c) / lp;
        alpha = (0.4 + 0.6 * d) * bright;
        trace = lane == 0u ? float3(1.0, 0.3, 0.3) : lane == 1u ? float3(0.3, 1.0, 0.3) : float3(0.35, 0.5, 1.0);
      }
      grat = max(grat, opc_line((uv.x * 3.0 - 1.0) * viewPx.x / 3.0) * 0.25);
      grat = max(grat, opc_line((uv.x * 3.0 - 2.0) * viewPx.x / 3.0) * 0.25);
    }
    float yPx = level * viewPx.y;
    grat = max(grat, opc_line(yPx - 0.05 * viewPx.y) * 0.35);
    grat = max(grat, opc_line(yPx - 0.95 * viewPx.y) * 0.35);
    grat = max(grat, opc_line(yPx - p.anch.w * viewPx.y) * 0.25);
    grat = max(grat, opc_line(yPx - 0.5 * viewPx.y) * 0.12);
  } else if (kind == 2) {
    uint b = opc_bin(uv.x);
    float h = 1.0 - uv.y;
    if (!rgb) {
      float v = float(bins[b]) / max(peak, 1.0);
      if (h <= v) { alpha = 0.55 * bright + 0.1; trace = float3(1.0); }
    } else {
      for (uint ch = 0; ch < 3; ch++) {
        float v = float(bins[(ch + 1u) * 256u + b]) / max(peak, 1.0);
        if (h <= v) trace[ch] = 1.0;
      }
      float anyOn = max(trace.r, max(trace.g, trace.b));
      alpha = anyOn * (0.5 * bright + 0.1);
    }
    float xPx = uv.x * viewPx.x;
    grat = max(grat, opc_line(xPx - 0.05 * viewPx.x) * 0.3);
    grat = max(grat, opc_line(xPx - 0.95 * viewPx.x) * 0.3);
    grat = max(grat, opc_line(xPx - p.anch.w * viewPx.x) * 0.2);
  } else {
    float side = min(viewPx.x, viewPx.y);
    float2 local = (in.position.xy - viewPx * 0.5) / side + 0.5;
    if (local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0) {
      uint col = uint(clamp(round(local.x * 127.0), 0.0, 127.0));
      uint row = uint(clamp(round((1.0 - local.y) * 127.0), 0.0, 127.0));
      uint idx = row * 128u + col;
      float c = float(bins[idx]);
      if (c > 0.0) {
        float d = log(1.0 + c) / lp;
        alpha = clamp((0.4 + 0.6 * d) * bright, 0.0, 1.0);
        float3 avg = float3(float(bins[65536u + idx]), float(bins[131072u + idx]), float(bins[196608u + idx])) / (c * 255.0);
        float lo = min(avg.r, min(avg.g, avg.b));
        float hi = max(avg.r, max(avg.g, avg.b));
        float span = hi - lo;
        if (hi > 1e-6 && span > 1e-6) {
          float sat = clamp(span / hi, 0.0, 1.0);
          trace = (1.0 - sat) + (avg - lo) / span * sat;
        } else {
          trace = float3(1.0);
        }
      }
      float2 q = (local - 0.5) * side;
      float r = length(q);
      grat = max(grat, opc_line(r - 0.5 * side) * 0.3);
      grat = max(grat, opc_line(r - 0.375 * side) * 0.15);
      grat = max(grat, opc_line(q.x) * 0.15 * step(r, 0.5 * side));
      grat = max(grat, opc_line(q.y) * 0.15 * step(r, 0.5 * side));
      // Skin line, 123° from +Cb.
      float2 dir = float2(-0.544639, -0.838671);  // y flipped: +Cr is up on screen
      float along = dot(q, dir);
      float across = q.x * dir.y - q.y * dir.x;
      if (along > 0.0 && along < 0.5 * side) grat = max(grat, opc_line(across) * 0.35);
    }
  }
  float3 g = float3(0.85, 0.85, 0.8) * grat;
  float a = clamp(alpha, 0.0, 1.0);
  // Premultiplied: trace over graticule over a transparent plate.
  float3 color = trace * a + g * (1.0 - a);
  float outA = a + grat * (1.0 - a);
  return float4(color, outA);
}
"""
