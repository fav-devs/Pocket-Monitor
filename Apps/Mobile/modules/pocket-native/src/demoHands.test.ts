import { describe, expect, it } from 'vitest';
import { FeedReader, defaultGestureMap, pinchRatio, poseOf, PINCH_ON } from '@/core/gestures';
import { handsOf } from '@/features/gestures/runtime';
import { createDemoHands } from './demoHands';
import type { HandsSeenEvent } from './types';

describe('the web demo hands', () => {
  it('read as an open palm and a pinch, with a face, through the phone reader', async () => {
    const hands = createDemoHands();
    const seen: HandsSeenEvent[] = [];
    const sub = hands.addListener('onHands', (e) => seen.push(e));
    await hands.start({ source: 'cameraFeed', sessionId: 'demo' });
    await new Promise((r) => setTimeout(r, 400));
    hands.stop();
    sub.remove();
    expect(seen.length).toBeGreaterThan(3);
    const [palm, pinch] = handsOf(seen[0]);
    expect(poseOf(palm)).toBe('palm');
    expect(palm.right).toBe(true);
    expect(pinchRatio(pinch)).toBeLessThan(PINCH_ON);
    expect(seen.some((e) => e.faces?.length)).toBe(true);
    // The pinch holds still inside the dead zone: a zoom grip that never zooms.
    const reader = new FeedReader();
    const tuning = { map: defaultGestureMap(), stickIsRight: true, handControl: true, faceRequested: false, autoFace: false, tracking: false };
    const rates: number[] = [];
    seen.forEach((e, i) => {
      for (const c of reader.read([{ kind: 'seen', hands: handsOf(e), faces: null, ms: e.ms }], null, i / 15, tuning).controls) if (c.kind === 'zoom') rates.push(c.rate);
    });
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((r) => r === 0)).toBe(true);
  });
});
