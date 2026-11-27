import { FACE_UNIFORM_VEC4, MAX_FACES } from '@/core/edit/face';

/**
 * The editor's face stage in WebGL2 (the web demo): the GLSL of Android's
 * `PocketFaceRetouchEffect`, reading `packFaceUniforms` (core/edit/face.ts). One pass from the
 * camera signal to a same-size target: per pixel inside a face's bounds, the warp (slim pushes,
 * eye magnifiers) picks the source position; around it the skin is smoothed (three rings of eight
 * taps weighted by colour distance, an edge-keeping bilateral) and lifted, both under the skin
 * mask (the oval less eyes and lips, with a chroma check against the cheeks). Outside every face's
 * bounds the pixel is copied unchanged. Signal space: v = 1 is the picture's top.
 */
export const FACE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_res;
uniform int u_faces;
uniform vec4 u_face[${FACE_UNIFORM_VEC4 * MAX_FACES}];

const int N = ${FACE_UNIFORM_VEC4};

vec3 src(vec2 p) { return texture(u_src, vec2(p.x / u_res.x, 1.0 - p.y / u_res.y)).rgb; }

vec2 chroma(vec3 c) { return vec2(dot(c, vec3(-0.168736, -0.331264, 0.5)), dot(c, vec3(0.5, -0.418688, -0.081312))); }

float ellipse(vec2 p, vec4 e, vec2 axis) {
  vec2 d = p - e.xy;
  return length(vec2(dot(d, axis), dot(d, vec2(-axis.y, axis.x))) / max(e.zw, vec2(0.001)));
}

vec2 magnify(vec2 p, vec4 eye, float k) {
  vec2 d = p - eye.xy;
  float r = length(d) / max(eye.z, 0.001);
  if (r >= 1.0) return vec2(0.0);
  float m = 1.0 - r * r;
  return d * (m * m * k);
}

void edge(vec2 p, vec2 a, vec2 b, inout float nearest, inout bool inside) {
  vec2 e = b - a;
  vec2 w = p - a;
  vec2 h = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
  nearest = min(nearest, dot(h, h));
  if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
}

// Signed distance to the outline (negative inside).
float outline(vec2 p, int b) {
  float nearest = 1e20;
  bool inside = false;
  vec2 prev = u_face[b + 23].zw;
  for (int i = 0; i < 9; i++) {
    vec4 pr = u_face[b + 15 + i];
    edge(p, pr.xy, prev, nearest, inside);
    edge(p, pr.zw, pr.xy, nearest, inside);
    prev = pr.zw;
  }
  return (inside ? -1.0 : 1.0) * sqrt(nearest);
}

vec3 lift(vec3 e, float amount) {
  vec3 c = min(e, vec3(1.0));
  vec3 up = max(pow(max(c, vec3(0.0)), vec3(1.0 - amount)) - c, vec3(0.0));
  return e + up * (1.0 - smoothstep(0.8, 1.0, c));
}

vec3 retouch(vec2 p, int b) {
  vec4 A = u_face[b];
  vec4 F = u_face[b + 2];
  // 1. Warp: where this pixel takes its colour from.
  vec2 q = p;
  float r2 = F.w * F.w;
  for (int i = 0; i < 6; i++) {
    vec4 pu = u_face[b + 9 + i];
    vec2 d = p - pu.xy;
    float d2 = dot(d, d);
    if (d2 < r2 && dot(pu.zw, pu.zw) > 0.0) {
      float w = 1.0 - d2 / r2;
      q -= (w * w) * pu.zw;
    }
  }
  if (A.y > 0.0) q -= magnify(p, u_face[b + 3], A.y) + magnify(p, u_face[b + 4], A.y);
  vec3 c = src(q);
  // 2. The skin mask at the source position.
  float sd = outline(q, b);
  float glow = 1.0 - smoothstep(-F.z * 2.0, F.z * 1.5, sd);
  if (glow <= 0.0) return c;
  float face = 1.0 - smoothstep(-F.z, F.z * 0.25, sd);
  float holes = smoothstep(1.0, 1.35, ellipse(q, u_face[b + 5], F.xy)) * smoothstep(1.0, 1.35, ellipse(q, u_face[b + 6], F.xy))
    * smoothstep(1.0, 1.3, ellipse(q, u_face[b + 7], F.xy));
  vec4 S = u_face[b + 8];
  vec4 K = u_face[b + 24];
  vec3 skinColour = S.w > 0.5 ? S.rgb : (src(K.xy) + src(K.zw)) * 0.5;
  float tone = 1.0 - smoothstep(0.05, 0.13, distance(chroma(c), chroma(skinColour)));
  float skin = face * holes * tone;
  vec3 rgb = c;
  // 3. Smooth: edge-keeping blur, blended in by the mask.
  if (A.x > 0.0 && skin > 0.0) {
    vec3 sum = c;
    float total = 1.0;
    vec2 start = vec2(1.0, 0.0);
    for (int ring = 1; ring <= 3; ring++) {
      float reach = A.w * float(ring) / 3.0;
      float falloff = exp(-float(ring * ring) / 6.0);
      start = vec2(start.x * 0.92388 - start.y * 0.38268, start.x * 0.38268 + start.y * 0.92388);
      vec2 dir = start;
      for (int k = 0; k < 8; k++) {
        vec3 s = src(q + dir * reach);
        vec3 d = s - c;
        float w = falloff * exp(-dot(d, d) * 30.0);
        sum += s * w;
        total += w;
        dir = vec2(dir.x * 0.70711 - dir.y * 0.70711, dir.x * 0.70711 + dir.y * 0.70711);
      }
    }
    rgb = mix(rgb, sum / total, A.x * skin);
  }
  // 4. Brighten: lift the mid-tones over the skin's wider glow; highlights kept.
  if (A.z > 0.0) rgb = lift(rgb, A.z * glow * (0.85 + 0.15 * holes) * (0.35 + 0.65 * tone));
  return rgb;
}

void main() {
  vec2 p = vec2(v_uv.x * u_res.x, (1.0 - v_uv.y) * u_res.y);
  vec3 col = src(p);
  for (int f = 0; f < ${MAX_FACES}; f++) {
    if (f >= u_faces) break;
    int b = f * N;
    vec4 bounds = u_face[b + 1];
    if (p.x < bounds.x || p.y < bounds.y || p.x > bounds.z || p.y > bounds.w) continue;
    col = retouch(p, b);
    break;
  }
  o = vec4(col, 1.0);
}
`;
