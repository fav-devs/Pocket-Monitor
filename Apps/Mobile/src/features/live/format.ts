import type {
  CameraState,
  ColorMode,
  FocusMode,
  GimbalMode,
  GimbalSpeed,
  ShootingMode,
  WhiteBalancePreset,
} from '@/camera';

/** Operator copy for camera values (MonitorCapturePresentation equivalents). */

export const DASH = '—';

export function isoLabel(iso: number | null, auto: boolean): string {
  if (auto) return iso != null ? `A ${iso}` : 'AUTO';
  return iso != null ? String(iso) : '--';
}

export function shutterLabel(denom: number | null): string {
  if (denom == null) return '--';
  return denom >= 1 ? `1/${denom}` : `${Math.round(1 / denom)}"`;
}

/** 360 × fps / denominator, the cinema shutter angle. */
export function shutterAngle(denom: number | null, fps: number): number | null {
  if (denom == null || !(fps > 0)) return null;
  return Math.round((360 * fps) / denom);
}

export function shutterAngleLabel(denom: number | null, fps: number): string {
  const a = shutterAngle(denom, fps);
  return a == null ? '--' : `${a}°`;
}

export function evLabel(ev: number): string {
  if (Math.abs(ev) < 0.05) return '0.0';
  return `${ev > 0 ? '+' : '−'}${Math.abs(ev).toFixed(1)}`;
}

export function exposureModeLabel(mode: 'auto' | 'manual'): string {
  return mode === 'manual' ? 'M' : 'A';
}

export const WB_PRESET_LABEL: Record<WhiteBalancePreset, string> = {
  auto: 'Auto',
  daylight: 'Daylight',
  cloudy: 'Cloudy',
  incandescent: 'Tungsten',
  fluorescent: 'Fluorescent',
  custom: 'Custom',
};

export function wbLabel(preset: WhiteBalancePreset, kelvin: number | null): string {
  if (preset === 'auto') return 'AWB';
  if (preset === 'custom') return kelvin != null ? `${kelvin}K` : 'Custom';
  return kelvin != null ? `${kelvin}K` : WB_PRESET_LABEL[preset];
}

export const FOCUS_LABEL: Record<FocusMode, string> = { afc: 'AF-C', afs: 'AF-S', mf: 'MF' };

export const COLOR_LABEL: Record<ColorMode, string> = {
  normal: 'Normal',
  hlg: 'HLG',
  'dlog-m': 'D-Log M',
  dlog: 'D-Log',
  dlog2: 'D-Log2',
  '10bit': '10-bit',
};

export const MODE_LABEL: Record<ShootingMode, string> = {
  video: 'Video',
  photo: 'Photo',
  'slow-motion': 'Slow Motion',
  timelapse: 'Timelapse',
  hyperlapse: 'Hyperlapse',
  panorama: 'Panorama',
  night: 'Night',
  unknown: DASH,
};

export const GIMBAL_MODE_LABEL: Record<GimbalMode, string> = {
  follow: 'Follow',
  'tilt-locked': 'Tilt Locked',
  fpv: 'FPV',
  spin: 'Spin',
  locked: 'Locked',
};

export const GIMBAL_SPEED_LABEL: Record<GimbalSpeed, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

export function formatChip(resolution: string, fps: number): string {
  return `${resolution} · ${fps}p`;
}

export function apertureLabel(f: number | null | undefined): string {
  return f != null ? `f/${f.toFixed(1).replace(/\.0$/, '')}` : '--';
}

export function audioLabel(channel: 'stereo' | 'mono'): string {
  return channel === 'stereo' ? 'Stereo' : 'Mono';
}

export function isPhotoMode(mode: ShootingMode) {
  return mode === 'photo' || mode === 'panorama' || mode === 'night';
}

/** STBY/REC elapsed "MM:SS". */
export function elapsedLabel(sec: number | null): string {
  if (sec == null || sec < 0) return '--:--';
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** `MonitorTimecodeFormat.accentComponents`: the last colon field is the accent. */
export function timecodeComponents(tc: string): { base: string; accent: string } {
  const i = tc.lastIndexOf(':');
  if (i < 0) return { base: tc, accent: '' };
  return { base: tc.slice(0, i + 1), accent: tc.slice(i + 1) };
}

export const TIMECODE_PLACEHOLDER = '--:--:--';

/** Storage readout cycle (A5-11): free space, record time remaining, percent free. */
export function storageForms(s: CameraState): string[] {
  const p = s.power;
  if (!p.sdPresent) return ['No card'];
  const gb = p.storageFreeMb / 1000;
  const forms = [gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`];
  const rem = s.recording.remainingSec;
  if (rem >= 0) {
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    forms.push(h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`);
  }
  if (p.storageTotalMb > 0) forms.push(`${Math.round((p.storageFreeMb / p.storageTotalMb) * 100)}% free`);
  return forms;
}

export function zoomLabel(factor: number): string {
  const r = Math.round(factor * 10) / 10;
  return Number.isInteger(r) ? `${r}x` : `${r.toFixed(1)}x`;
}

/** `MonitorZoomCaption.label`. */
export function zoomCaption(factor: number, opticalMax: number, stops: number[]): string {
  if (Math.abs(factor - 1) < 0.05) return 'WIDE';
  if (stops.some((s) => Math.abs(s - 3) < 0.01) && opticalMax >= 3) {
    if (Math.abs(factor - 3) < 0.05) return 'TELE';
    return factor > 3 ? 'DIGITAL · SOFT' : 'WIDE CROP';
  }
  return 'DIGITAL CROP';
}

export function isDigitalZoom(factor: number, opticalMax: number) {
  return factor > opticalMax + 0.02;
}

export function angleLabel(deg: number) {
  const r = Math.round(deg);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}°`;
}
