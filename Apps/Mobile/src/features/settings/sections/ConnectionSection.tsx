import { Activity01Icon, Camera01Icon, Link04Icon, SignalFull02Icon, Video01Icon, Wifi01Icon } from '@hugeicons/core-free-icons';
import { useCamera } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import { connectionPhaseLabel, linkHealthScore, pathLabel } from '@/features/pairing/presentation';
import { useSavedCameras } from '@/state/savedCameras';
import { SettingsRow } from '@/components/settings-ui';
import { LinkHealthScale } from '../components/LinkHealthScale';
import { Group, SwitchRow, ValueRow } from '../components/ui';
import { usePref } from '../components/usePref';
import { SettingsCopy, SettingsRowCopy } from '../copy';

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
export function ConnectionSection() {
  const connection = useCamera((s) => s.connection);
  const identity = useCamera((s) => s.identity);
  const saved = useSavedCameras((s) => s.cameras);
  const [linkStats, setLinkStats] = usePref('showLinkStats');
  const live = connection.phase === 'live';
  const score = linkHealthScore(connection);
  const caption =
    score === null
      ? 'No camera connected'
      : `${connection.videoFps} fps · ${(connection.videoKbps / 1000).toFixed(1)} Mbit/s · ${Math.round(connection.lastFrameAgeMs)} ms frame age`;
  const ssid = identity?.ssid && live ? identity.ssid : null;
  const stream = live && connection.streamWidth
    ? `${connection.streamWidth}×${connection.streamHeight} ${connection.streamCodec?.toUpperCase() ?? ''}`.trim()
    : null;

  return (
    <>
      <Group label="Link health" note={SettingsCopy.linkHealthHelp}>
        <LinkHealthScale caption={caption} score={score} />
      </Group>
      <Group label="Connection" note={`${SettingsCopy.currentTransport} ${live ? SettingsCopy.networkHelp : ''}`.trim()}>
        <ValueRow icon={Link04Icon} title="Transport" value={transportLabel(connection.transport, live)} />
        <ValueRow
          icon={Activity01Icon}
          title="Phase"
          subtitle="BLE → Wi-Fi → datalink handshake"
          value={connectionPhaseLabel(connection.phase)}
          last={!live}
        />
        {ssid ? <ValueRow icon={Wifi01Icon} title="Camera Wi-Fi" subtitle="Password kept in secure storage" value={ssid} /> : null}
        {stream ? <ValueRow icon={Video01Icon} title="Live stream" value={stream} /> : null}
        {live ? <ValueRow icon={SignalFull02Icon} title="Signal" value={`${connection.signalBars} of 4`} last /> : null}
      </Group>
      <Group label="Your cameras" note={SettingsRowCopy.savedHelp}>
        {saved.length === 0 ? (
          <ValueRow icon={Camera01Icon} title="Saved" value="None" last />
        ) : (
          saved.map((camera, i) => (
            <SettingsRow
              key={camera.id}
              icon={Camera01Icon}
              title={camera.name}
              subtitle={`${modelDisplayName(camera.model)} · ${pathLabel(camera.path)}`}
              last={i === saved.length - 1}
            />
          ))
        )}
      </Group>
      <Group label="Live readouts">
        <SwitchRow
          icon={Activity01Icon}
          title="Link stats"
          subtitle={SettingsRowCopy.linkStats}
          value={linkStats}
          onChange={setLinkStats}
          last
        />
      </Group>
    </>
  );
}
