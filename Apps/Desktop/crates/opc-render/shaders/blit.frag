#version 450
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(set = 0, binding = 0) uniform sampler2D uTex;
layout(push_constant) uniform PC {
    float opacity;
    // 0 identity, 1 rot 90 CW, 2 rot 90 CCW. Add 10 to reconstruct with Catmull-Rom
    // instead of bilinear: the picture is being drawn larger than it was decoded.
    float uvMode;
} pc;

// Catmull-Rom through nine bilinear taps. Bilinear alone turns a 720p feed into soft
// mush at 1080p and beyond; this keeps edges crisp without the ringing of Lanczos.
vec4 catmullRom(vec2 uv) {
    vec2 size = vec2(textureSize(uTex, 0));
    vec2 position = uv * size;
    vec2 centre = floor(position - 0.5) + 0.5;
    vec2 f = position - centre;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 t0 = (centre - 1.0) / size;
    vec2 t3 = (centre + 2.0) / size;
    vec2 t12 = (centre + w2 / w12) / size;
    vec4 color =
        texture(uTex, vec2(t0.x, t0.y)) * (w0.x * w0.y) +
        texture(uTex, vec2(t12.x, t0.y)) * (w12.x * w0.y) +
        texture(uTex, vec2(t3.x, t0.y)) * (w3.x * w0.y) +
        texture(uTex, vec2(t0.x, t12.y)) * (w0.x * w12.y) +
        texture(uTex, vec2(t12.x, t12.y)) * (w12.x * w12.y) +
        texture(uTex, vec2(t3.x, t12.y)) * (w3.x * w12.y) +
        texture(uTex, vec2(t0.x, t3.y)) * (w0.x * w3.y) +
        texture(uTex, vec2(t12.x, t3.y)) * (w12.x * w3.y) +
        texture(uTex, vec2(t3.x, t3.y)) * (w3.x * w3.y);
    return clamp(color, 0.0, 1.0);
}

void main() {
    vec2 uv = vUv;
    float mode = pc.uvMode;
    bool reconstruct = mode > 9.5;
    if (reconstruct) mode -= 10.0;
    if (mode > 1.5) uv = vec2(1.0 - vUv.y, vUv.x);
    else if (mode > 0.5) uv = vec2(vUv.y, 1.0 - vUv.x);
    vec4 color = reconstruct ? catmullRom(uv) : texture(uTex, uv);
    oColor = color * pc.opacity;
}
