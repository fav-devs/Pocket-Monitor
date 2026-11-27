#version 450
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 oColor;

layout(set = 0, binding = 0) uniform sampler2D uFeed;
layout(set = 0, binding = 1) uniform sampler3D uLut;
layout(set = 0, binding = 2) uniform sampler3D uLimitsPaint;
layout(set = 0, binding = 3) uniform sampler3D uLimitsWeight;
layout(set = 0, binding = 4) uniform sampler2D uPeakingMask;

// The mobile `PictureEffects` fields the push constants predate (`opc_render::Look`).
// The defaults (zeros, intensity 1, stripes on) paint exactly what the shader always did.
layout(std140, set = 0, binding = 5) uniform LookBlock {
    // Source gamut -> linear Rec.709, one row per vec4 (xyz).
    vec4 gamut0;
    vec4 gamut1;
    vec4 gamut2;
    // Scene tone map: gain, Reinhard white, contrast, display transform on (> 0.5).
    vec4 tone;
    // Signal curve ordinal, display curve ordinal, input exposure in stops, cube intensity.
    vec4 curve;
    // Monochrome, vertical mirror, zebra stripes, _.
    vec4 flags;
} look;

layout(push_constant) uniform PC {
    vec2 sourceSize;
    vec2 displaySize;
    float lutSize;
    float limitsPaintSize;
    float limitsWeightSize;
    float limitsOn;
    float splitOn;
    float splitVertical;
    float zebraHighlightOn;
    float zebraHighlight;
    float zebraMidtoneOn;
    float zebraMidtone;
    float zebraMidtoneHalf;
    float feedUpscale;
    float mirror;
    float peakingOn;
    float _pad0;
    float _pad1;
    vec4 zebraHighlightColor;
    vec4 zebraMidtoneColor;
    vec4 peakingColor;
} pc;

const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
const float ZEBRA_GAIN = 40.0;
const float STRIPE_PITCH = 14.14;
const vec3 PEAKING_UNDER_COLOR = vec3(0.04, 0.04, 0.05);

float peakingClosedStroke(vec2 centre, vec2 texel) {
    float m00 = texture(uPeakingMask, centre).r;
    float mR = texture(uPeakingMask, centre + vec2(texel.x, 0.0)).r;
    float mL = texture(uPeakingMask, centre - vec2(texel.x, 0.0)).r;
    float mD = texture(uPeakingMask, centre + vec2(0.0, texel.y)).r;
    float mU = texture(uPeakingMask, centre - vec2(0.0, texel.y)).r;
    float mRR = texture(uPeakingMask, centre + vec2(2.0 * texel.x, 0.0)).r;
    float mLL = texture(uPeakingMask, centre - vec2(2.0 * texel.x, 0.0)).r;
    float mDD = texture(uPeakingMask, centre + vec2(0.0, 2.0 * texel.y)).r;
    float mUU = texture(uPeakingMask, centre - vec2(0.0, 2.0 * texel.y)).r;
    float mRD = texture(uPeakingMask, centre + vec2(texel.x, texel.y)).r;
    float mRU = texture(uPeakingMask, centre + vec2(texel.x, -texel.y)).r;
    float mLD = texture(uPeakingMask, centre + vec2(-texel.x, texel.y)).r;
    float mLU = texture(uPeakingMask, centre + vec2(-texel.x, -texel.y)).r;
    float dC = max(max(max(m00, mR), max(mL, mD)), mU);
    float dR = max(max(max(mR, mRR), max(m00, mRD)), mRU);
    float dL = max(max(max(mL, m00), max(mLL, mLD)), mLU);
    float dD = max(max(max(mD, mRD), max(mLD, mDD)), m00);
    float dU = max(max(max(mU, mRU), max(mLU, m00)), mUU);
    return min(min(min(dC, dR), min(dL, dD)), dU);
}

vec3 sampleLut(sampler3D cube, float cubeSize, vec3 color) {
    if (cubeSize < 2.0) return color;
    // Match CIColorCube: R fastest in x, then G, then B. Half-texel so
    // linear filter stays inside the lattice (2D atlases bled across tiles).
    vec3 coord = (clamp(color, 0.0, 1.0) * (cubeSize - 1.0) + 0.5) / cubeSize;
    return texture(cube, coord).rgb;
}


// Transfer curves, transcribed from Apps/Mobile/src/core/media/transfer.ts (the web
// renderer's CURVES_GLSL and opc_render::color). Ordinals: 0 Rec.709, 1 HLG, 2 D-Log,
// 3 D-Log2, 4 D-Log M.
const float HLG_A = 0.17883277;
const float HLG_B = 0.28466892;
const float HLG_C = 0.55991073;
const float HLG_DW = 0.26496256; // inverseOETF(0.75)

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

// MonitorSceneToneMap.displayCode.
float toneCode(float x) {
    float c = look.tone.x * pow(max(x, 0.0) / 0.18, look.tone.z);
    float w = look.tone.y;
    float m = clamp(c * (1.0 + c / (w * w)) / (1.0 + c), 0.0, 1.0);
    return pow(m, 1.0 / 2.4);
}

// MonitorLogDisplayTransform: raw decode, source gamut -> Rec.709, the scene tone map.
vec3 displayTransform(vec3 c) {
    int t = int(look.curve.y + 0.5);
    vec3 lin = vec3(decodeRaw(c.r, t), decodeRaw(c.g, t), decodeRaw(c.b, t));
    lin = max(vec3(dot(look.gamut0.xyz, lin), dot(look.gamut1.xyz, lin), dot(look.gamut2.xyz, lin)), 0.0);
    return vec3(toneCode(lin.r), toneCode(lin.g), toneCode(lin.b));
}

vec2 flipped(vec2 uv) {
    return vec2(mix(uv.x, 1.0 - uv.x, pc.mirror), mix(uv.y, 1.0 - uv.y, look.flags.y));
}

vec3 sampleSource(vec2 uv) {
    return texture(uFeed, flipped(uv)).rgb;
}

vec3 sampleSourceAt(vec2 pixel, vec2 sourceSize) {
    return sampleSource(pixel / sourceSize);
}

vec3 sampleSourceReconstructed(vec2 coordinate, vec2 sourceSize) {
    vec2 samplePosition = coordinate * sourceSize;
    vec2 centre = floor(samplePosition - 0.5) + 0.5;
    vec2 f = samplePosition - centre;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 centre12 = centre + w2 / w12;
    vec2 centre0 = centre - 1.0;
    vec2 centre3 = centre + 2.0;
    vec3 row0 = sampleSourceAt(vec2(centre0.x, centre0.y), sourceSize) * w0.x
        + sampleSourceAt(vec2(centre12.x, centre0.y), sourceSize) * w12.x
        + sampleSourceAt(vec2(centre3.x, centre0.y), sourceSize) * w3.x;
    vec3 row12 = sampleSourceAt(vec2(centre0.x, centre12.y), sourceSize) * w0.x
        + sampleSourceAt(vec2(centre12.x, centre12.y), sourceSize) * w12.x
        + sampleSourceAt(vec2(centre3.x, centre12.y), sourceSize) * w3.x;
    vec3 row3 = sampleSourceAt(vec2(centre0.x, centre3.y), sourceSize) * w0.x
        + sampleSourceAt(vec2(centre12.x, centre3.y), sourceSize) * w12.x
        + sampleSourceAt(vec2(centre3.x, centre3.y), sourceSize) * w3.x;
    return clamp(row0 * w0.y + row12 * w12.y + row3 * w3.y, 0.0, 1.0);
}

void main() {
    vec2 uv = vUv;
    // The camera signal: every measurement (false colour, peaking, zebra) reads this,
    // never the graded picture.
    vec3 source = sampleSource(uv);
    vec3 displaySource = pc.feedUpscale > 0.5
        ? sampleSourceReconstructed(uv, max(pc.sourceSize, vec2(1.0)))
        : source;
    // The phones' order: input exposure on the signal -> display transform -> cube mixed
    // by intensity -> monochrome -> false colour -> peaking -> zebra.
    vec3 signal = displaySource;
    if (look.curve.z != 0.0) {
        int curve = int(look.curve.x + 0.5);
        signal = encode3(linearize3(signal, curve) * exp2(look.curve.z), curve);
    }
    bool graded = pc.splitOn < 0.5
        || (pc.splitVertical > 0.5 ? uv.x >= 0.5 : uv.y < 0.5);
    vec3 color = displaySource;
    if (graded) {
        color = look.tone.w > 0.5 ? displayTransform(signal) : signal;
        if (pc.lutSize >= 2.0) {
            // The cube is fed the camera signal; intensity mixes it over the display
            // transform.
            color = mix(color, sampleLut(uLut, pc.lutSize, signal), clamp(look.curve.w, 0.0, 1.0));
        }
    }
    if (look.flags.x > 0.5) color = vec3(dot(color, LUMA_709));
    if (pc.limitsOn > 0.5) {
        vec3 paint = sampleLut(uLimitsPaint, pc.limitsPaintSize, source);
        float weight = sampleLut(uLimitsWeight, pc.limitsWeightSize, source).r;
        color = mix(color, paint, clamp(weight, 0.0, 1.0));
    }
    if (pc.peakingOn > 0.5) {
        vec2 sourceSize = max(pc.sourceSize, vec2(1.0));
        vec2 texel = 1.0 / sourceSize;
        vec2 centre = (floor(flipped(uv) * sourceSize) + 0.5) * texel;
        float stroke = peakingClosedStroke(centre, texel);
        float under = texture(uPeakingMask, centre).g;
        color = mix(color, PEAKING_UNDER_COLOR, under);
        color = mix(color, pc.peakingColor.rgb, stroke);
    }
    if (pc.zebraHighlightOn > 0.5 || pc.zebraMidtoneOn > 0.5) {
        float luma = dot(source, LUMA_709);
        vec2 displayCoordinate = vec2(uv.x * pc.displaySize.x, (1.0 - uv.y) * pc.displaySize.y);
        float stripe = look.flags.z > 0.5
            ? step(0.5, fract((displayCoordinate.x + displayCoordinate.y) / STRIPE_PITCH))
            : 1.0;
        if (pc.zebraHighlightOn > 0.5) {
            // Highlight reads the max channel — the byte WAVE draws at 100 (#136).
            float hot = max(source.r, max(source.g, source.b));
            float highlightMask = clamp((hot - pc.zebraHighlight) * ZEBRA_GAIN + 1.0, 0.0, 1.0);
            color = mix(color, pc.zebraHighlightColor.rgb, highlightMask * stripe);
        }
        if (pc.zebraMidtoneOn > 0.5) {
            float halfWidth = max(pc.zebraMidtoneHalf, 1e-6);
            float midtoneMask =
                clamp((luma - (pc.zebraMidtone - halfWidth)) * ZEBRA_GAIN + 1.0, 0.0, 1.0)
                * clamp(((pc.zebraMidtone + halfWidth) - luma) * ZEBRA_GAIN + 1.0, 0.0, 1.0);
            color = mix(color, pc.zebraMidtoneColor.rgb, midtoneMask * stripe);
        }
    }
    oColor = vec4(color, 1.0);
}
