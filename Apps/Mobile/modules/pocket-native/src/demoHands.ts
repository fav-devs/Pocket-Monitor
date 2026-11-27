/**
 * A made-up `PocketHands` for the web demo: two hands and a face, 15 readings a second, so the
 * hand view, the status pill and the Gestures page can be seen in a browser. The right hand holds
 * up an open palm, swaying a little; the left pinches and holds still (a zoom grip inside its dead
 * zone, so it never zooms); a face sits above them. No microphone.
 */
import type { HandsFace, HandsLandmarks, HandsSeenEvent, HandsSource, HandsStartOptions, HandsStatusEvent, PocketHandsNativeModule } from './types';

const ASPECT = 16 / 9;
const RATE_HZ = 15;

/** A hand at (cx, cy), fingers `out` straight up, the thumb `pinched` onto the index tip or off to the side. */
function demoHand(cx: number, cy: number, out: readonly boolean[], pinched: boolean, right: boolean, score: number): HandsLandmarks {
  const s = 0.06;
  const p: [number, number][] = Array.from({ length: 21 }, () => [cx, cy]);
  // The picture is not mirrored: a right hand facing the lens has its thumb on the picture's left.
  const side = right ? -1 : 1;
  p[0] = [cx, cy + 2 * s];
  const bases: [number, number][] = [
    [5, -0.6],
    [9, -0.2],
    [13, 0.2],
    [17, 0.6],
  ];
  bases.forEach(([base, dx], finger) => {
    const bx = cx + (-side * dx * s) / ASPECT;
    p[base] = [bx, cy];
    const reach = out[finger] ? 2 : 0.2;
    const lean = out[finger] ? (-side * (finger - 1.5) * 0.12 * s) / ASPECT : 0;
    p[base + 1] = [bx + lean * 0.4, cy - reach * s * 0.4];
    p[base + 2] = [bx + lean * 0.7, cy - reach * s * 0.7];
    p[base + 3] = [bx + lean, cy - reach * s];
  });
  p[1] = [cx + (side * s) / ASPECT, cy + s];
  p[2] = [cx + (side * 1.6 * s) / ASPECT, cy + 0.5 * s];
  p[3] = [cx + (side * 2.1 * s) / ASPECT, cy - 0.1 * s];
  p[4] = pinched ? [p[8][0] + 0.002, p[8][1] + 0.002] : [cx + (side * 2.8 * s) / ASPECT, cy - 0.6 * s];
  return { points: p.flat(), score, right };
}

type Listener = (event: never) => void;

export function createDemoHands(): PocketHandsNativeModule {
  const listeners: Record<string, Set<Listener>> = { onHands: new Set(), onStatus: new Set(), onAudio: new Set() };
  let timer: ReturnType<typeof setInterval> | null = null;
  let source: HandsSource = 'cameraFeed';
  let frame = 0;
  const emit = (event: string, payload: unknown) => {
    for (const cb of listeners[event] ?? []) (cb as (e: unknown) => void)(payload);
  };
  const reading = (): HandsSeenEvent => {
    const t = frame / RATE_HZ;
    frame += 1;
    const sway = Math.sin(t * 1.3) * 0.012;
    // On the demo scene's presenter.
    const face: HandsFace = { x: 0.226, y: 0.29, width: 0.14, height: 0.31, score: 0.93 };
    return {
      source,
      hands: [demoHand(0.54 + sway, 0.5, [true, true, true, true], false, true, 0.97), demoHand(0.11, 0.62, [false, true, true, true], true, false, 0.94)],
      // Faces a few times a second, as the native modules look for them.
      faces: frame % 4 === 0 ? [face] : null,
      aspect: ASPECT,
      ms: 9 + Math.round(Math.abs(Math.sin(t * 0.7)) * 4),
    };
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    isAvailable: () => true,
    start: async (options: HandsStartOptions) => {
      stop();
      source = options.source;
      frame = 0;
      emit('onStatus', { state: 'starting' } satisfies HandsStatusEvent);
      setTimeout(() => emit('onStatus', { state: 'ready', provider: 'Demo' } satisfies HandsStatusEvent), 50);
      timer = setInterval(() => emit('onHands', reading()), 1000 / RATE_HZ);
    },
    stop: () => {
      if (!timer) return;
      stop();
      emit('onStatus', { state: 'stopped' } satisfies HandsStatusEvent);
    },
    setWantsFaces: () => {},
    startMicrophone: async () => {},
    stopMicrophone: () => {},
    addListener: ((event: string, cb: Listener) => {
      listeners[event]?.add(cb);
      return { remove: () => listeners[event]?.delete(cb) };
    }) as PocketHandsNativeModule['addListener'],
  };
}
