import { ChevronLeft, MonitorPlay, RefreshCw, Unplug } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useCamera } from '@/camera';
import { MText, colors, radius } from '@/theme';
import { PanelSurface } from './primitives';

/** The first retry stays quiet this long so a quick reconnect never flashes the card. */
const GRACE_MS = 1200;

function Action({
  title,
  icon: Icon,
  accent,
  onPress,
}: {
  title: string;
  icon: typeof RefreshCw;
  accent?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 44,
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderRadius: radius.pill,
        backgroundColor: accent ? colors.accent : 'rgba(255,255,255,0.1)',
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <Icon size={13} color={accent ? '#000' : colors.text} />
      <MText size={13} weight="semibold" color={accent ? '#000' : colors.text} numberOfLines={1}>
        {title}
      </MText>
    </Pressable>
  );
}

/**
 * `SessionRecoveryOverlay`: a card over the held frame when an established session drops
 * (phase `recovering` / `failed` / `disconnected`), or when the live view opens with no camera.
 * A camera power cycle must not throw the operator back to the camera list.
 */
export function SessionRecoveryOverlay({
  onRetry,
  onExit,
  onDemo,
}: {
  onRetry: () => void;
  onExit: () => void;
  /** Offered when nothing is connected and the demo camera can stand in. */
  onDemo?: () => void;
}) {
  const conn = useCamera((s) => s.connection);
  const name = useCamera((s) => s.identity?.name ?? 'The camera');
  const [graceElapsed, setGraceElapsed] = useState(false);
  const recovering = conn.phase === 'recovering';

  useEffect(() => {
    if (!recovering) {
      setGraceElapsed(false);
      return;
    }
    const t = setTimeout(() => setGraceElapsed(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [recovering]);

  const idle = conn.phase === 'idle';
  const connecting = ['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start'].includes(conn.phase);
  const show = (recovering && graceElapsed) || conn.phase === 'failed' || conn.phase === 'disconnected' || idle || connecting;
  if (!show) return null;

  let title: string;
  let detail: string;
  if (recovering) {
    title = 'Reconnecting';
    detail = `${name} dropped. The picture holds the last frame while the link comes back.`;
  } else if (connecting) {
    title = 'Connecting';
    detail = conn.detail ?? 'Starting live view';
  } else if (conn.phase === 'failed') {
    title = 'Connection paused';
    detail = conn.error ?? `${name} stopped answering. Check that it is on and nearby.`;
  } else if (idle) {
    title = 'No camera connected';
    detail = 'Choose a camera to start live view.';
  } else {
    title = 'Camera disconnected';
    detail = `${name} is no longer connected.`;
  }
  const spinning = recovering || connecting;

  return (
    <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.34)' }} />
      <PanelSurface radius={radius.lg} style={{ width: '90%', maxWidth: 460, paddingHorizontal: 18, paddingVertical: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 26, alignItems: 'center' }}>
            {spinning ? <ActivityIndicator size="small" color={colors.accent} /> : <Unplug size={20} color={colors.accent} />}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <MText size={16} weight="semibold" accessibilityRole="header">
              {title}
            </MText>
            <MText size={12} weight="medium" color={colors.muted}>
              {detail}
            </MText>
            {recovering && conn.detail ? (
              <MText size={12} weight="medium">
                {conn.detail}
              </MText>
            ) : null}
          </View>
        </View>
        {!connecting ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {idle ? (
              onDemo ? <Action title="Demo camera" icon={MonitorPlay} accent onPress={onDemo} /> : null
            ) : (
              <Action title="Retry connection" icon={RefreshCw} accent onPress={onRetry} />
            )}
            <Action title="Cameras" icon={ChevronLeft} onPress={onExit} />
          </View>
        ) : null}
      </PanelSurface>
    </View>
  );
}
