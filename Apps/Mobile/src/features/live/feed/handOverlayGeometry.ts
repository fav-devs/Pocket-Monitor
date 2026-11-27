/**
 * The hand view's geometry (`Y`, desktop): `vision://hands` is in fractions of the decoded
 * picture before mirroring; this maps it onto the picture as drawn (its size in view points,
 * mirrored with the picture) for `HandViewOverlay`. Pure, so it is tested without React.
 */
import type { DesktopHandOverlay } from '@/camera/desktop/gestures';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Mirror {
  horizontal: boolean;
  vertical: boolean;
}

/** `pm_controller::handnet::BONES`: which of the 21 landmarks are joined. */
export const HAND_BONES: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** `pm_controller::handnet::TIPS`: the fingertips, drawn larger. */
export const HAND_TIPS: readonly number[] = [4, 8, 12, 16, 20];

const POSE_LABEL: Record<NonNullable<DesktopHandOverlay['hands'][number]['pose']>, string> = {
  fist: 'Fist',
  point: 'Point',
  two: 'Two',
  horns: 'Rock',
  palm: 'Palm',
};

/** A picture fraction onto the drawn picture. */
export function toView([u, v]: readonly [number, number], size: Size, mirror: Mirror): Point {
  return {
    x: (mirror.horizontal ? 1 - u : u) * size.width,
    y: (mirror.vertical ? 1 - v : v) * size.height,
  };
}

/** A box given as two corners (left, top, right, bottom) onto the drawn picture. */
export function cornersToView([l, t, r, b]: readonly [number, number, number, number], size: Size, mirror: Mirror): Box {
  const a = toView([l, t], size, mirror);
  const c = toView([r, b], size, mirror);
  return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
}

export interface HandShape {
  role: 'stick' | 'zoom';
  box: Box;
  bones: [Point, Point][];
  joints: (Point & { tip: boolean })[];
  /** "Stick · Palm 97%". */
  label: string;
  /** Finger reach and pinch, as the old hand view printed them. */
  detail: string;
  /** Whether this hand's pose is the one filling the hold bar. */
  holding: boolean;
}

export interface OverlayShapes {
  hands: HandShape[];
  grabs: { role: 'stick' | 'zoom'; anchor: Point; point: Point }[];
  faces: Box[];
  /** 0…1: how far the held pose is. */
  hold: number;
}

/** Everything the hand view draws, in the drawn picture's points. */
export function overlayShapes(overlay: DesktopHandOverlay | null, size: Size, mirror: Mirror): OverlayShapes {
  if (!overlay || size.width <= 0 || size.height <= 0) return { hands: [], grabs: [], faces: [], hold: 0 };
  const hold = Math.min(1, Math.max(0, overlay.hold || 0));
  return {
    hands: overlay.hands.map((hand) => {
      const joints = hand.points.map((p, i) => ({ ...toView(p, size, mirror), tip: HAND_TIPS.includes(i) }));
      const bones = HAND_BONES.filter(([a, b]) => joints[a] && joints[b]).map(([a, b]) => [joints[a], joints[b]] as [Point, Point]);
      const who = hand.role === 'stick' ? 'Stick' : 'Zoom';
      const pose = hand.pose ? POSE_LABEL[hand.pose] : 'No pose';
      const [i, m, r, p] = hand.reach;
      return {
        role: hand.role,
        box: cornersToView(hand.bounds, size, mirror),
        bones,
        joints,
        label: `${who} · ${pose} ${Math.round(hand.score * 100)}%`,
        detail: `I${i.toFixed(1)} M${m.toFixed(1)} R${r.toFixed(1)} P${p.toFixed(1)} · pinch ${hand.pinch.toFixed(2)}`,
        holding: hold > 0 && hand.pose != null,
      };
    }),
    grabs: overlay.grabs.map((grab) => ({ role: grab.role, anchor: toView(grab.anchor, size, mirror), point: toView(grab.point, size, mirror) })),
    faces: overlay.faces.map((f) => cornersToView([f.x, f.y, f.x + f.width, f.y + f.height], size, mirror)),
    hold,
  };
}

/** The hand view's status line. */
export function overlayStatus(overlay: DesktopHandOverlay | null, gesturesOn: boolean): string {
  if (!gesturesOn || !overlay || overlay.source === 'off') return 'Hand view · gestures off (J)';
  if (overlay.source === 'webcam') return `Hand view · webcam${overlay.status ? ` · ${overlay.status}` : ''}`;
  const seen = overlay.hands.length ? '' : ' · no hand';
  return `Hand view${overlay.status ? ` · ${overlay.status}` : ''}${seen}`;
}
