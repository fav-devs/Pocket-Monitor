import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { modelDisplayName } from '@/camera/defaults';
import type { CameraSession } from '@/camera/session';
import type { ConnectionPhase, SavedCamera } from '@/camera/types';
import { appBrand } from '@/features/startup/brand';
import type { OperatorPreferences } from '@/state/preferences';

/** Recent connection events, newest last. Kept in memory only, never persisted or uploaded. */
const journal: { at: number; phase: ConnectionPhase; detail?: string; error?: string }[] = [];

export function recordConnectionEvent(phase: ConnectionPhase, detail?: string, error?: string) {
  const last = journal[journal.length - 1];
  if (last && last.phase === phase && last.detail === detail && last.error === error) return;
  journal.push({ at: Date.now(), phase, detail, error });
  if (journal.length > 60) journal.splice(0, journal.length - 60);
}

export function appVersion(): string {
  const version = Constants.expoConfig?.version ?? '0.0.0';
  const build = Platform.OS === 'ios' ? Constants.expoConfig?.ios?.buildNumber : undefined;
  return build ? `${version} (${build})` : version;
}

function platformLine(): string {
  const os = Platform.OS === 'web' ? 'Web' : Platform.OS === 'ios' ? 'iOS' : 'Android';
  return `${os} ${String(Platform.Version ?? '')}`.trim();
}

const time = (at: number) => new Date(at).toISOString().slice(11, 23);

/**
 * A plain-text diagnostics report: app and device versions, the connection state and recent
 * connection events. No camera names, Wi-Fi names or passwords, footage or location.
 */
export function buildDiagnosticsReport(input: {
  session: CameraSession;
  saved: SavedCamera[];
  preferences?: Partial<OperatorPreferences>;
  includeConnection?: boolean;
}): string {
  const state = input.session.getState();
  const c = state.connection;
  const lines: string[] = [];
  lines.push(`${appBrand.name} diagnostics`);
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`App: ${appBrand.name} ${appVersion()}`);
  lines.push(`Device: ${platformLine()}`);
  lines.push(`Session: ${input.session.kind}`);
  if (state.identity) {
    lines.push(
      `Camera: ${modelDisplayName(state.identity.model)}${state.identity.firmware ? ` · firmware ${state.identity.firmware}` : ''}`,
    );
  } else {
    lines.push('Camera: none');
  }
  if (input.includeConnection !== false) {
    lines.push('');
    lines.push('Connection');
    lines.push(`  phase: ${c.phase}${c.detail ? ` (${c.detail})` : ''}`);
    lines.push(`  transport: ${c.transport}`);
    lines.push(`  link: ${c.linkBand}, ${c.signalBars}/4 bars`);
    lines.push(`  video: ${c.videoFps} fps, ${Math.round(c.videoKbps)} kbit/s, last frame ${Math.round(c.lastFrameAgeMs)} ms`);
    if (c.streamWidth && c.streamHeight) {
      lines.push(`  stream: ${c.streamWidth}x${c.streamHeight} ${c.streamCodec ?? ''}`.trimEnd());
    }
    if (c.error) lines.push(`  error: ${c.error}`);
    lines.push(
      `  power: battery ${state.power.batteryPercent}%, thermal ${state.power.thermal}, card ${state.power.sdPresent ? 'present' : 'absent'}`,
    );
    lines.push('');
    lines.push(`Saved cameras: ${input.saved.length}`);
    input.saved.forEach((cam, i) => {
      lines.push(`  ${i + 1}. ${modelDisplayName(cam.model)} over ${cam.path.kind}`);
    });
    lines.push('');
    lines.push('Recent connection events');
    if (journal.length === 0) lines.push('  (none)');
    journal.slice(-30).forEach((e) => {
      lines.push(`  ${time(e.at)} ${e.phase}${e.detail ? ` · ${e.detail}` : ''}${e.error ? ` · ERROR ${e.error}` : ''}`);
    });
  }
  if (input.preferences) {
    lines.push('');
    lines.push('Preferences');
    Object.entries(input.preferences)
      .filter(([, v]) => typeof v !== 'function')
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([k, v]) => lines.push(`  ${k}: ${String(v)}`));
  }
  return lines.join('\n');
}

export function diagnosticsFileName(prefix = 'diagnostics'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `PocketMonitor-${prefix}-${stamp}.txt`;
}
