import type { CameraCapabilities, CameraModelId, CameraState } from './types';

export const ISO_STEPS = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400];
export const SHUTTER_DENOMS = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 240, 200, 160, 120, 100, 60, 50, 48, 30, 25, 24];
export const EV_STEPS = [-3, -2.7, -2.3, -2, -1.7, -1.3, -1, -0.7, -0.3, 0, 0.3, 0.7, 1, 1.3, 1.7, 2, 2.3, 2.7, 3];

export function capabilitiesFor(model: CameraModelId): CameraCapabilities {
  const hasGimbal = model.startsWith('osmo-pocket');
  return {
    zoom: model !== 'osmo-nano',
    gimbal: hasGimbal,
    tracking: hasGimbal,
    selfieFlip: hasGimbal,
    aperture: model === 'osmo-action-6',
    manualFocus: model !== 'osmo-nano',
    audioControls: true,
    media: true,
    timecode: model !== 'osmo-nano',
  };
}

export function zoomStopsFor(model: CameraModelId): { stops: number[]; max: number; opticalMax: number } {
  switch (model) {
    case 'osmo-pocket-4-pro':
      return { stops: [1, 3, 6, 12, 18], max: 18, opticalMax: 3 };
    case 'osmo-pocket-4':
      return { stops: [1, 2, 4], max: 4, opticalMax: 1 };
    case 'osmo-pocket-3':
      return { stops: [1, 2, 4], max: 4, opticalMax: 1 };
    case 'osmo-nano':
      return { stops: [1], max: 1, opticalMax: 1 };
    default:
      return { stops: [1, 2], max: 2, opticalMax: 1 };
  }
}

export function modelDisplayName(model: CameraModelId): string {
  switch (model) {
    case 'osmo-pocket-3':
      return 'Osmo Pocket 3';
    case 'osmo-pocket-4':
      return 'Osmo Pocket 4';
    case 'osmo-pocket-4-pro':
      return 'Osmo Pocket 4 Pro';
    case 'osmo-nano':
      return 'Osmo Nano';
    case 'osmo-action-6':
      return 'Osmo Action 6';
    default:
      return 'Osmo camera';
  }
}

/** An empty, disconnected camera state. */
export function initialCameraState(model: CameraModelId = 'unknown'): CameraState {
  const zoom = zoomStopsFor(model);
  return {
    identity: null,
    connection: {
      phase: 'idle',
      transport: 'none',
      linkBand: 'stable',
      signalBars: 0,
      videoFps: 0,
      videoKbps: 0,
      lastFrameAgeMs: 0,
    },
    recording: { recording: false, elapsedSec: 0, remainingSec: -1, countdown: null, capturingStill: false },
    exposure: {
      mode: 'auto',
      iso: null,
      isoAuto: true,
      isoOptions: ISO_STEPS,
      shutterDenom: null,
      shutterAuto: true,
      shutterOptions: SHUTTER_DENOMS,
      ev: 0,
      evOptions: EV_STEPS,
      meteredEv: null,
    },
    whiteBalance: {
      preset: 'auto',
      kelvin: null,
      tint: 0,
      kelvinMin: 2000,
      kelvinMax: 10000,
      kelvinStep: 100,
      tintMin: -10,
      tintMax: 10,
    },
    format: {
      shootingMode: 'video',
      shootingModeOptions: ['video', 'photo', 'slow-motion', 'timelapse', 'hyperlapse', 'panorama'],
      resolution: '4K',
      fps: 30,
      aspect: '16:9',
      options: [
        { resolution: '4K', width: 3840, height: 2160, fps: [24, 25, 30, 48, 50, 60, 100, 120], aspect: '16:9' },
        { resolution: '2.7K', width: 2688, height: 1512, fps: [24, 25, 30, 48, 50, 60], aspect: '16:9' },
        { resolution: '1080p', width: 1920, height: 1080, fps: [24, 25, 30, 48, 50, 60, 100, 120, 240], aspect: '16:9' },
      ],
      colorMode: 'normal',
      colorModeOptions: ['normal', 'hlg', 'dlog-m'],
      codec: 'h265',
      bitrate: 'high',
    },
    focus: { mode: 'afc', x: 0.5, y: 0.5, hasPoint: false, faceDetection: true },
    zoom: { factor: 1, stops: zoom.stops, min: 1, max: zoom.max, opticalMax: zoom.opticalMax },
    gimbal: {
      available: model.startsWith('osmo-pocket'),
      mode: 'follow',
      modeOptions: ['follow', 'tilt-locked', 'fpv'],
      speed: 'normal',
      face: 'front',
      yaw: 0,
      pitch: 0,
      roll: 0,
      lockedAllAxes: false,
      recentering: false,
      program: { status: 'idle', legSeconds: [4, 4], smoothness: 0, progress: 0 },
    },
    tracking: { available: model.startsWith('osmo-pocket'), status: 'idle' },
    power: {
      batteryPercent: -1,
      charging: false,
      docked: false,
      storageFreeMb: 0,
      storageTotalMb: 0,
      sdPresent: false,
      thermal: 'normal',
    },
    audio: {
      left: { rmsDb: -120, peakDb: -120 },
      right: { rmsDb: -120, peakDb: -120 },
      channel: 'stereo',
      source: 'internal',
      windReduction: false,
      directional: 'off',
      vocalBoost: false,
    },
    level: { roll: 0, pitch: 0 },
    capabilities: capabilitiesFor(model),
  };
}
