import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { OpcGamepad } from '@modules/opc-native/src';
import type { GamepadState } from '@modules/opc-native/src';
import type { LiveInputActions } from './actions';
import { postDrive, releaseDrive } from './gimbalDrive';
import { applyStickMapping, type StickMapping } from './stickMath';

type ButtonName = keyof GamepadState['buttons'];

const REST: GamepadState = {
  connected: false,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  l2: 0,
  r2: 0,
  buttons: { a: false, b: false, x: false, y: false, l1: false, r1: false, up: false, down: false, left: false, right: false, menu: false },
};

/** Trigger travel below this is rest. */
const TRIGGER_REST = 0.06;

/** Browser "standard" mapping → the native module's shape. */
function readWebPad(): GamepadState {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return REST;
  const pads = navigator.getGamepads();
  const pad = Array.from(pads).find((p): p is Gamepad => !!p && p.connected && p.axes.length >= 2);
  if (!pad) return REST;
  const b = (i: number) => !!pad.buttons[i]?.pressed;
  const v = (i: number) => pad.buttons[i]?.value ?? 0;
  return {
    connected: true,
    name: pad.id,
    leftX: pad.axes[0] ?? 0,
    // Browser Y axis is down-positive; the native contract is up-positive.
    leftY: -(pad.axes[1] ?? 0),
    rightX: pad.axes[2] ?? 0,
    rightY: -(pad.axes[3] ?? 0),
    l2: v(6),
    r2: v(7),
    buttons: {
      a: b(0),
      b: b(1),
      x: b(2),
      y: b(3),
      l1: b(4),
      r1: b(5),
      menu: b(9),
      up: b(12),
      down: b(13),
      left: b(14),
      right: b(15),
    },
  };
}

/**
 * "Gimbal pad" (CONTEXT.md): left stick drives the gimbal with the on-screen stick's expo and
 * picture-relative invert. Cross/A records (skips confirmation), Circle/B recenters, Square/X
 * rotates 180, Triangle/Y tracks a face or cancels. L1/R1 jump zoom stops; L2/R2 hold-to-zoom
 * (deeper is faster). D-pad up/down ISO, left/right shutter (left opens, right closes).
 * Toasts connect/disconnect; unplug rests stick and zoom. Returns connection for Settings.
 */
export function useGamepadInput(
  actions: LiveInputActions,
  getMapping: () => StickMapping,
  enabled: boolean,
): { connected: boolean; name?: string } {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const mappingRef = useRef(getMapping);
  mappingRef.current = getMapping;
  const [status, setStatus] = useState<{ connected: boolean; name?: string }>({ connected: false });

  useEffect(() => {
    if (!enabled) return;
    let prev: GamepadState = REST;
    let zoom = 0;

    const handle = (next: GamepadState) => {
      const a = actionsRef.current;
      if (next.connected !== prev.connected) {
        setStatus({ connected: next.connected, name: next.name });
        a.notice(next.connected ? 'Gamepad connected' : 'Gamepad disconnected', next.connected ? 'success' : 'info');
        if (!next.connected) {
          releaseDrive('gamepad');
          if (zoom !== 0) a.zoomRate(0);
          zoom = 0;
          prev = REST;
          return;
        }
      }
      if (!next.connected) return;

      const v = applyStickMapping(next.leftX, next.leftY, mappingRef.current());
      if (v.x === 0 && v.y === 0) releaseDrive('gamepad');
      else postDrive('gamepad', v.x, v.y);

      const r2 = next.r2 > TRIGGER_REST ? next.r2 : 0;
      const l2 = next.l2 > TRIGGER_REST ? next.l2 : 0;
      const rate = Math.round((r2 - l2) * 20) / 20;
      if (rate !== zoom) {
        zoom = rate;
        a.zoomRate(rate);
      }

      const pressed = (k: ButtonName) => next.buttons[k] && !prev.buttons[k];
      if (pressed('a')) a.toggleRecord({ skipConfirm: true });
      if (pressed('b')) a.recenter();
      if (pressed('x')) a.flip();
      if (pressed('y')) a.toggleFaceTrack();
      if (pressed('l1')) a.zoomStep(-1);
      if (pressed('r1')) a.zoomStep(1);
      if (pressed('up')) a.stepIso(1);
      if (pressed('down')) a.stepIso(-1);
      if (pressed('left')) a.stepShutter(-1);
      if (pressed('right')) a.stepShutter(1);
      prev = next;
    };

    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.getGamepads) return;
      const id = setInterval(() => handle(readWebPad()), 16);
      return () => {
        clearInterval(id);
        releaseDrive('gamepad');
        if (zoom !== 0) actionsRef.current.zoomRate(0);
      };
    }

    if (!OpcGamepad) return;
    let sub: { remove(): void } | null = null;
    try {
      OpcGamepad.start();
      sub = OpcGamepad.addListener('onGamepad', handle);
    } catch {
      return;
    }
    return () => {
      sub?.remove();
      try {
        OpcGamepad?.stop();
      } catch {
        // ignore
      }
      releaseDrive('gamepad');
      if (zoom !== 0) actionsRef.current.zoomRate(0);
    };
  }, [enabled]);

  return status;
}
