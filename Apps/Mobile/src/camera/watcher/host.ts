/**
 * Host-side helpers shared by the real feed-sharing hook and the simulated hosts.
 */
import type { CameraSession } from '../session';
import type { HostAction } from './mapping';

/** A host carrying out an admitted watcher command on its own camera session. */
export function applyHostAction(camera: CameraSession, action: HostAction): Promise<void> {
  const c = camera.control;
  switch (action.kind) {
    case 'record':
      return action.start ? c.startRecording() : c.stopRecording();
    case 'focus':
      return c.focusAt({ x: action.x, y: action.y });
    case 'iso':
      return c.setIso(action.value);
    case 'shutter':
      return c.setShutter(action.denom);
    case 'white-balance':
      return c.setWhiteBalance(action.preset === 'auto' ? { preset: 'auto', tint: action.tint } : { preset: 'custom', kelvin: action.kelvin, tint: action.tint });
    case 'color':
      return c.setFormat({ colorMode: action.mode });
    case 'zoom':
      return c.setZoom(action.factor);
  }
}
