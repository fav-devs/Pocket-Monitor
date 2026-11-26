import { useCamera } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import { connectionPhaseLabel, linkHealthScore, pathLabel } from '@/features/pairing/presentation';
import { useSavedCameras } from '@/state/savedCameras';
import { CardColumns, FullWidth } from '../components/CardColumns';
import { LinkHealthScale } from '../components/LinkHealthScale';
import { SettingsCard, SettingsRow, SwitchRow, ValueRow, ValueText } from '../components/SettingsControls';
import { usePref } from '../components/usePref';
import { SettingsCopy } from '../copy';

function transportLabel(transport: string, live: boolean): string {
  if (!live) return 'Not connected';
  switch (transport) {
    case 'softap':
      return 'BLE + camera Wi-Fi';
    case 'station':
      return 'BLE + shared Wi-Fi';
    case 'hotspot':
      return 'BLE + phone hotspot';
    case 'watcher':
      return 'Watcher relay';
    case 'demo':
      return 'Demo camera';
    default:
      return 'Connected';
  }
}

/** Link: health, connection facts, saved camera network paths (`MonitorConnectionSettings`). */
export function ConnectionSection({ width }: { width: number }) {
  const connection = useCamera((s) => s.connection);
  const identity = useCamera((s) => s.identity);
  const saved = useSavedCameras((s) => s.cameras);
  const [linkStats, setLinkStats] = usePref('showLinkStats');
  const live = connection.phase === 'live';
  const score = linkHealthScore(connection);
  const caption =
    score === null
      ? 'No camera connected'
      : `${connection.videoFps} fps · ${(connection.videoKbps / 1000).toFixed(1)} Mbit/s · ${Math.round(connection.lastFrameAgeMs)} ms frame age · score ${score}`;

  return (
    <CardColumns width={width}>
      <FullWidth key="health">
        <LinkHealthScale caption={caption} score={score} />
      </FullWidth>
      <SettingsCard key="connection" title="Connection">
        <ValueRow divider={false} title="Current Transport" help={SettingsCopy.currentTransport} value={transportLabel(connection.transport, live)} />
        <ValueRow title="Phase" help={SettingsCopy.phaseHelp} value={connectionPhaseLabel(connection.phase)} />
        {identity?.ssid && live ? <ValueRow title="Camera Wi-Fi" help={SettingsCopy.networkHelp} value={identity.ssid} /> : null}
        {live && connection.streamWidth ? (
          <ValueRow
            title="Live stream"
            value={`${connection.streamWidth}×${connection.streamHeight} ${connection.streamCodec?.toUpperCase() ?? ''}`.trim()}
          />
        ) : null}
        {live ? <ValueRow title="Signal" value={`${connection.signalBars} of 4`} /> : null}
      </SettingsCard>
      <SettingsCard key="saved" title="Your cameras">
        {saved.length === 0 ? (
          <ValueRow divider={false} title="Saved" help={SettingsCopy.savedHelp} value="None" />
        ) : (
          saved.map((camera, i) => (
            <SettingsRow
              key={camera.id}
              divider={i > 0}
              title={camera.name}
              help={`${modelDisplayName(camera.model)} · ${pathLabel(camera.path)}. ${SettingsCopy.savedHelp}`}
            >
              <ValueText value={pathLabel(camera.path)} />
            </SettingsRow>
          ))
        )}
      </SettingsCard>
      <SettingsCard key="diagnostics" title="Live readouts">
        <SwitchRow divider={false} title="Link stats" help={SettingsCopy.linkStats} value={linkStats} onChange={setLinkStats} />
      </SettingsCard>
    </CardColumns>
  );
}
