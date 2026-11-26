import { Cancel01Icon, Maximize01Icon, PlayIcon, StopIcon } from '@hugeicons/core-free-icons';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { useCamera, useCameraSession, type MotionWaypoint } from '@/camera';
import { Icon } from '@/components/icon';
import { Squircle } from '@/components/squircle';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { FieldLabel, Hint, ModeBar, StepperRow } from '../capture/controls';
import { angleLabel } from '../format';
import { haptics } from '../haptics';
import type { Rect } from '../layout/fieldMonitorLayout';
import { useLiveUi } from '../liveUiStore';
import { onVideo, textShadow } from '../chrome/primitives';

type Slot = 'a' | 'b' | 'c';
const SMOOTHNESS = [0, 0.25, 0.5, 0.75, 1];
/** Duration editor: 0.5 s floor, half-second steps. */
const LEG_MIN = 0.5;
const LEG_STEP = 0.5;
const LEG_MAX = 60;

function pointLabel(p?: MotionWaypoint) {
  return p ? `Pan ${angleLabel(p.yaw)} · Tilt ${angleLabel(p.pitch)}` : 'Not set';
}

function useProgram() {
  return useCamera((s) => s.gimbal.program);
}

function running(status: string) {
  return status === 'running' || status === 'preparing';
}

function WaypointRow({ slot, point, disabled }: { slot: Slot; point?: MotionWaypoint; disabled: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { gimbal } = useCameraSession();
  const set = !!point;
  const name = slot.toUpperCase();
  return (
    <View style={[styles.waypoint, disabled && styles.dim]}>
      <Squircle width={36} height={36} radius={12} color={set ? colors.ink : colors.surface}>
        <Text style={[styles.slot, set && { color: colors.inkForeground }]}>{name}</Text>
      </Squircle>
      <Text numberOfLines={1} style={[styles.point, !set && styles.pointUnset]}>
        {pointLabel(point)}
      </Text>
      {set ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${name}`}
          disabled={disabled}
          hitSlop={6}
          onPress={() => gimbal.clearWaypoint(slot)}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
        >
          <Icon icon={Cancel01Icon} size={16} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${set ? 'Update' : 'Set'} ${name} to the current pose`}
        disabled={disabled}
        hitSlop={4}
        onPress={() => {
          haptics.medium();
          gimbal.captureWaypoint(slot).catch(() => {});
        }}
        style={({ pressed }) => [styles.setKey, !set && styles.setKeyPrimary, pressed && styles.pressed]}
      >
        <Text style={[styles.setLabel, !set && styles.setLabelPrimary]}>{set ? 'Reset' : 'Set'}</Text>
      </Pressable>
    </View>
  );
}

/** Start (accent) / Stop (dotPink). `compact` is the run pill's over-video version. */
function RunButton({ compact }: { compact?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { gimbal } = useCameraSession();
  const p = useProgram();
  const busy = running(p.status);
  const ready = !!p.a && !!p.b;
  const fg = busy ? '#ffffff' : onVideo.dark;
  return (
    <Pressable
      testID="monitor.motion.run"
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Stop' : 'Start'}
      accessibilityState={{ disabled: !busy && !ready }}
      disabled={!busy && !ready}
      onPress={() => {
        haptics.heavy();
        if (busy) gimbal.stopProgram();
        else gimbal.runProgram().catch(() => {});
      }}
      style={({ pressed }) => [
        compact ? styles.runCompact : styles.run,
        { backgroundColor: busy ? colors.dotPink : colors.accent },
        !busy && !ready && styles.faint,
        pressed && styles.pressed,
      ]}
    >
      <Icon icon={busy ? StopIcon : PlayIcon} size={compact ? 14 : 18} color={fg} strokeWidth={2} />
      <Text style={[compact ? styles.runLabelCompact : styles.runLabel, { color: fg }]}>{busy ? 'Stop' : 'Start'}</Text>
    </Pressable>
  );
}

function Progress() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const p = useProgram();
  const label =
    p.status === 'preparing'
      ? 'Moving to A…'
      : p.status === 'running'
        ? `Running ${Math.round(p.progress * 100)}%`
        : p.status === 'done'
          ? 'Take complete'
          : p.status === 'failed'
            ? (p.error ?? 'Take invalid')
            : !p.a || !p.b
              ? 'Set A and B'
              : 'Ready';
  return (
    <View style={styles.progress}>
      <Text style={[styles.progressLabel, p.status === 'failed' && { color: colors.destructive }]}>{label}</Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round(p.progress * 100)}%` }]} />
      </View>
    </View>
  );
}

/** `LiveGimbalMoveEditor` body: A/B/C capture, leg durations, smoothness, start/stop. */
export function MotionControlEditor() {
  const styles = useThemedStyles(createStyles);
  const { gimbal } = useCameraSession();
  const p = useProgram();
  const busy = running(p.status);
  const smoothIndex = SMOOTHNESS.reduce((b, v, i) => (Math.abs(v - p.smoothness) < Math.abs(SMOOTHNESS[b] - p.smoothness) ? i : b), 0);
  return (
    <View style={styles.stack}>
      <Hint>Experimental · a repeatable A → B → C pan and tilt.</Hint>
      <View style={styles.waypoints}>
        <WaypointRow slot="a" point={p.a} disabled={busy} />
        <WaypointRow slot="b" point={p.b} disabled={busy} />
        <WaypointRow slot="c" point={p.c} disabled={busy} />
      </View>
      <View>
        <StepperRow
          title="A → B"
          value={`${p.legSeconds[0].toFixed(1)} s`}
          valueLabel={`A → B ${p.legSeconds[0]} seconds`}
          minusLabel="A → B shorter"
          plusLabel="A → B longer"
          disabled={busy}
          minusDisabled={p.legSeconds[0] <= LEG_MIN}
          plusDisabled={p.legSeconds[0] >= LEG_MAX}
          onMinus={() => gimbal.configureProgram({ legSeconds: [Math.max(LEG_MIN, p.legSeconds[0] - LEG_STEP), p.legSeconds[1]] })}
          onPlus={() => gimbal.configureProgram({ legSeconds: [Math.min(LEG_MAX, p.legSeconds[0] + LEG_STEP), p.legSeconds[1]] })}
        />
        <StepperRow
          title="B → C"
          value={`${p.legSeconds[1].toFixed(1)} s`}
          valueLabel={`B → C ${p.legSeconds[1]} seconds`}
          minusLabel="B → C shorter"
          plusLabel="B → C longer"
          disabled={busy || !p.c}
          minusDisabled={p.legSeconds[1] <= LEG_MIN}
          plusDisabled={p.legSeconds[1] >= LEG_MAX}
          onMinus={() => gimbal.configureProgram({ legSeconds: [p.legSeconds[0], Math.max(LEG_MIN, p.legSeconds[1] - LEG_STEP)] })}
          onPlus={() => gimbal.configureProgram({ legSeconds: [p.legSeconds[0], Math.min(LEG_MAX, p.legSeconds[1] + LEG_STEP)] })}
        />
      </View>
      <View style={[styles.group, !p.c && styles.dim]}>
        <FieldLabel>Smoothness · {Math.round(p.smoothness * 100)}%</FieldLabel>
        <ModeBar
          accessibilityLabel="Smoothness"
          tabs={SMOOTHNESS.map((v) => `${Math.round(v * 100)}`)}
          disabled={busy || !p.c}
          selected={smoothIndex}
          onSelect={(i) => gimbal.configureProgram({ smoothness: SMOOTHNESS[i] })}
        />
      </View>
      <Progress />
      <RunButton />
    </View>
  );
}

/** `LiveGimbalRunPill`: the minimized editor over video — points, progress, start/stop. */
export function MotionRunPill() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const p = useProgram();
  const set = useLiveUi((s) => s.set);
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{['a', 'b', 'c'].filter((k) => p[k as Slot]).map((k) => k.toUpperCase()).join(' → ') || 'Motion'}</Text>
      {running(p.status) ? <Text style={[styles.pillText, { color: colors.accent }]}>{Math.round(p.progress * 100)}%</Text> : null}
      <RunButton compact />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Expand motion control"
        hitSlop={6}
        onPress={() => set({ gimbalPanel: 'editor' })}
        style={({ pressed }) => [styles.pillExpand, pressed && styles.pressed]}
      >
        <Icon icon={Maximize01Icon} size={16} color={onVideo.ink} />
      </Pressable>
    </View>
  );
}

/** Horizontal field of view at 1× for the waypoint preview (presentation only). */
const HFOV_DEG = 80;

/**
 * `LiveGimbalWaypointMarks`: A/B/C and the dashed path preview projected from the current
 * pose into the picture. A preview, not a tracking box. Smoothness rounds near B.
 */
export function MotionPathOverlay({ picture }: { picture: Rect }) {
  const { colors } = useTheme();
  const p = useProgram();
  const yaw = useCamera((s) => Math.round(s.gimbal.yaw * 10) / 10);
  const pitch = useCamera((s) => Math.round(s.gimbal.pitch * 10) / 10);
  const zoom = useCamera((s) => Math.round(s.zoom.factor * 10) / 10);
  const points = (['a', 'b', 'c'] as Slot[]).map((k) => [k, p[k]] as const).filter((e): e is readonly [Slot, MotionWaypoint] => !!e[1]);
  if (points.length === 0 || picture.width < 2) return null;
  const hfov = HFOV_DEG / Math.max(1, zoom);
  const vfov = hfov * (picture.height / picture.width);
  const project = (w: MotionWaypoint) => ({
    x: (0.5 + (w.yaw - yaw) / hfov) * picture.width,
    y: (0.5 - (w.pitch - pitch) / vfov) * picture.height,
  });
  const pts = points.map(([k, w]) => ({ k, ...project(w) }));
  let d = '';
  if (pts.length >= 2) {
    const [A, B, C] = pts;
    d = `M ${A.x} ${A.y}`;
    if (C && p.smoothness > 0) {
      const s = p.smoothness * 0.5;
      const p1 = { x: B.x + (A.x - B.x) * s, y: B.y + (A.y - B.y) * s };
      const p2 = { x: B.x + (C.x - B.x) * s, y: B.y + (C.y - B.y) * s };
      d += ` L ${p1.x} ${p1.y} Q ${B.x} ${B.y} ${p2.x} ${p2.y} L ${C.x} ${C.y}`;
    } else {
      d += ` L ${B.x} ${B.y}`;
      if (C) d += ` L ${C.x} ${C.y}`;
    }
  }
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: picture.x, top: picture.y, width: picture.width, height: picture.height, overflow: 'hidden' }}
    >
      <Svg width={picture.width} height={picture.height}>
        {d ? <Path d={d} stroke={colors.accent} strokeWidth={2} strokeDasharray="6 5" fill="none" strokeOpacity={0.95} /> : null}
        {pts.map((pt) => (
          <Circle key={`c${pt.k}`} cx={pt.x} cy={pt.y} r={11} fill={colors.accent} stroke={onVideo.ink} strokeWidth={1.5} />
        ))}
        {pts.map((pt) => (
          <SvgText key={`t${pt.k}`} x={pt.x} y={pt.y + 4} fill={onVideo.dark} fontSize={11} fontFamily={fonts.bold} textAnchor="middle">
            {pt.k.toUpperCase()}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    stack: { gap: spacing.md },
    group: { gap: spacing.sm },
    waypoints: { gap: spacing.xs },
    waypoint: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm + 2, minHeight: 44 },
    slot: { fontFamily: fonts.bold, fontSize: 14, color: colors.foreground },
    point: { flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    pointUnset: { color: colors.mutedForeground },
    clear: { width: 32, height: 36, alignItems: 'center' as const, justifyContent: 'center' as const },
    setKey: {
      minWidth: 64,
      height: 36,
      paddingHorizontal: 12,
      borderRadius: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: colors.surface,
    },
    setKeyPrimary: { backgroundColor: colors.ink },
    setLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    setLabelPrimary: { color: colors.inkForeground },
    run: {
      minHeight: 50,
      borderRadius: radius.md,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    runLabel: { fontFamily: fonts.semibold, fontSize: 15 },
    runCompact: {
      height: 32,
      paddingHorizontal: 12,
      borderRadius: 16,
      flexDirection: 'row' as const,
      gap: 5,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    runLabelCompact: { fontFamily: fonts.semibold, fontSize: 13 },
    progress: { gap: 6 },
    progressLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceStrong, overflow: 'hidden' as const },
    progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
    pill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      height: 44,
      paddingLeft: 14,
      paddingRight: 6,
      borderRadius: 22,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    pillText: { fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink, fontVariant: ['tabular-nums' as const], ...textShadow },
    pillExpand: { width: 32, height: 32, alignItems: 'center' as const, justifyContent: 'center' as const },
    dim: { opacity: 0.4 },
    faint: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
  };
}
