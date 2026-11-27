import { FACE_OVAL_INDICES, FACE_POINT_COUNT } from '@/core/edit/face';

/**
 * The web demo's face landmarks: the studio scene's subject (`face()` / `studio()` in
 * shaders.ts) is a drawn ellipse with known eyes and mouth, so its FACE_LANDMARK_INDICES points
 * are computed here instead of detected. Pixels of a `width` × `height` (16:9) signal at scene
 * time `t`, top-left origin — what a phone's detector would hand the face stage.
 */
export function demoStudioFace(t: number, width: number, height: number): Float32Array {
  const aspect = 16 / 9;
  const sway = [0.02 * Math.sin(t * 0.6), 0.008 * Math.sin(t * 1.1)];
  const c = [-0.35 + sway[0], -0.04 + sway[1]];
  const r = 0.18;
  // Face-local d (unit circle = the face's edge) → scene q → signal pixels.
  const px = (dx: number, dy: number): [number, number] => {
    const qx = c[0] + dx * r * 0.78;
    const qy = c[1] + dy * r;
    return [(qx / aspect + 0.5) * width, (qy + 0.5) * height];
  };
  const out = new Float32Array(FACE_POINT_COUNT * 2);
  let k = 0;
  const put = (p: [number, number]) => {
    out[k++] = p[0];
    out[k++] = p[1];
  };
  // Oval clockwise from the top of the forehead (the hairline's ellipse edge).
  for (let i = 0; i < FACE_OVAL_INDICES.length; i++) {
    const a = (i / FACE_OVAL_INDICES.length) * Math.PI * 2;
    put(px(Math.sin(a) * 0.98, -Math.cos(a) * 0.98));
  }
  const look = 0.02 * Math.sin(t * 0.7);
  // The person's right eye is on the picture's left: outer, inner, top, bottom, iris.
  for (const s of [-1, 1]) {
    const ex = 0.34 * s;
    put(px(ex + 0.1 * s, -0.08));
    put(px(ex - 0.1 * s, -0.08));
    put(px(ex, -0.18));
    put(px(ex, 0.02));
    put(px(ex + look, -0.08));
  }
  // Mouth: right corner (picture left), left corner, top, bottom.
  put(px(-0.2, 0.45));
  put(px(0.2, 0.45));
  put(px(0, 0.405));
  put(px(0, 0.495));
  put(px(0, 0.18));
  put(px(-0.42, 0.18));
  put(px(0.42, 0.18));
  return out;
}

