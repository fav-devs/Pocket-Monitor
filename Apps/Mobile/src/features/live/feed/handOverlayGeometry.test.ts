import { describe, expect, it } from 'vitest';
import type { DesktopHandOverlay } from '@/camera/desktop/gestures';
import { HAND_BONES, cornersToView, overlayShapes, overlayStatus, toView } from './handOverlayGeometry';

const size = { width: 1600, height: 900 };
const plain = { horizontal: false, vertical: false };
const mirrored = { horizontal: true, vertical: false };

const overlay: DesktopHandOverlay = {
  source: 'cameraFeed',
  status: 'GPU 9 ms',
  hands: [
    {
      points: Array.from({ length: 21 }, (_, i) => [0.5 + i * 0.001, 0.5] as [number, number]),
      bounds: [0.4, 0.3, 0.6, 0.7],
      right: true,
      role: 'stick',
      pose: 'palm',
      score: 0.968,
      reach: [1.71, 1.8, 1.66, 1.5],
      pinch: 0.83,
    },
  ],
  grabs: [{ role: 'zoom', anchor: [0.25, 0.5], point: [0.25, 0.4] }],
  hold: 0.5,
  faces: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.2, score: 0.9 }],
};

describe('the hand view on the picture', () => {
  it('maps picture fractions onto the drawn picture, mirrored with it', () => {
    expect(toView([0.25, 0.5], size, plain)).toEqual({ x: 400, y: 450 });
    expect(toView([0.25, 0.5], size, mirrored)).toEqual({ x: 1200, y: 450 });
    expect(toView([0.25, 0.25], size, { horizontal: false, vertical: true })).toEqual({ x: 400, y: 675 });
  });

  it('keeps a mirrored box the right way round', () => {
    expect(cornersToView([0.1, 0.2, 0.3, 0.4], size, mirrored)).toEqual({ x: 1120, y: 180, width: 320, height: 180 });
  });

  it('draws every bone, the tips, the role and pose, the grab and the face', () => {
    const shapes = overlayShapes(overlay, size, mirrored);
    expect(HAND_BONES).toHaveLength(21);
    const [hand] = shapes.hands;
    expect(hand.bones).toHaveLength(21);
    expect(hand.joints.filter((j) => j.tip)).toHaveLength(5);
    expect(hand.label).toBe('Stick · Palm 97%');
    expect(hand.detail).toBe('I1.7 M1.8 R1.7 P1.5 · pinch 0.83');
    expect(hand.holding).toBe(true);
    expect(hand.box.x).toBeCloseTo(640);
    expect(shapes.grabs[0].anchor).toEqual({ x: 1200, y: 450 });
    expect(shapes.faces[0].x).toBeCloseTo(1280);
    expect(shapes.faces[0].width).toBeCloseTo(160);
    expect(shapes.hold).toBe(0.5);
  });

  it('draws nothing without a reading or a picture', () => {
    expect(overlayShapes(null, size, plain).hands).toEqual([]);
    expect(overlayShapes(overlay, { width: 0, height: 0 }, plain).hands).toEqual([]);
  });

  it('says what is reading', () => {
    expect(overlayStatus(overlay, true)).toBe('Hand view · GPU 9 ms');
    expect(overlayStatus({ ...overlay, hands: [] }, true)).toBe('Hand view · GPU 9 ms · no hand');
    expect(overlayStatus({ ...overlay, source: 'webcam', status: 'Integrated Camera' }, true)).toBe('Hand view · webcam · Integrated Camera');
    expect(overlayStatus(overlay, false)).toBe('Hand view · gestures off (J)');
  });
});
