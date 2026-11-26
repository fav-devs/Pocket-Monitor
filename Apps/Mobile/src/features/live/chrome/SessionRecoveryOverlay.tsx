import type { IconSvgElement } from '@hugeicons/react-native';
import { ArrowLeft01Icon, Refresh01Icon, Unlink04Icon, Video01Icon } from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCamera } from '@/camera';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { onVideo } from './primitives';

/** The first retry stays quiet this long so a quick reconnect never flashes the card. */
const GRACE_MS = 1200;

function Action({ title, icon, primary, onPress }: { title: string; icon: IconSvgElement; primary?: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  const fg = primary ? onVideo.dark : onVideo.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.action, primary && styles.actionPrimary, pressed && { opacity: 0.75 }]}
    >
      <Icon icon={icon} size={18} color={fg} strokeWidth={2} />
      <Text numberOfLines={1} style={[styles.actionLabel, { color: fg }]}>
        {title}
      </Text>
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
  const styles = useThemedStyles(createStyles);
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
    <View style={styles.root}>
      <View pointerEvents="none" style={styles.scrim} />
      <View style={styles.card}>
        <Squircle width={52} height={52} radius={17} color={onVideo.well}>
          {spinning ? <Spinner size={22} opacity={1} color={onVideo.ink} /> : <Icon icon={Unlink04Icon} size={24} color={onVideo.ink} />}
        </Squircle>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.detail}>{detail}</Text>
        {recovering && conn.detail ? <Text style={styles.status}>{conn.detail}</Text> : null}
        {!connecting ? (
          <View style={styles.actions}>
            {idle ? (
              onDemo ? <Action title="Demo camera" icon={Video01Icon} primary onPress={onDemo} /> : null
            ) : (
              <Action title="Retry connection" icon={Refresh01Icon} primary onPress={onRetry} />
            )}
            <Action title="Cameras" icon={ArrowLeft01Icon} onPress={onExit} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    root: {
      position: 'absolute' as const,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      padding: spacing.md,
    },
    scrim: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
    card: {
      width: '100%' as const,
      maxWidth: 400,
      alignItems: 'center' as const,
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      borderRadius: 28,
      backgroundColor: 'rgba(16,16,16,0.82)',
    },
    title: { marginTop: spacing.xs, fontFamily: fonts.semibold, fontSize: 20, color: onVideo.ink, textAlign: 'center' as const },
    detail: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: onVideo.inkMuted, textAlign: 'center' as const },
    status: { fontFamily: fonts.medium, fontSize: 13, color: onVideo.ink, textAlign: 'center' as const },
    actions: { alignSelf: 'stretch' as const, flexDirection: 'row' as const, gap: spacing.sm, marginTop: spacing.sm },
    action: {
      flex: 1,
      minHeight: 46,
      flexDirection: 'row' as const,
      gap: 6,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingHorizontal: 14,
      borderRadius: 16,
      backgroundColor: onVideo.well,
    },
    actionPrimary: { backgroundColor: onVideo.chosen },
    actionLabel: { fontFamily: fonts.semibold, fontSize: 15 },
  };
}
