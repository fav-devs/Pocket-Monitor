import { ChevronsDownUp, Maximize2, Minus, Play, Plus, Square, X } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { useCamera, useCameraSession, type MotionWaypoint } from '@/camera';
import { MText, colors, fonts, radius, withAlpha } from '@/theme';
import { ModeBar } from '../capture/controls';
import { angleLabel } from '../format';
import { haptics } from '../haptics';
import type { Rect } from '../layout/fieldMonitorLayout';
import { useLiveUi } from '../liveUiStore';
import { PanelSurface } from '../chrome/primitives';

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
  const { gimbal } = useCameraSession();
  const set = !!point;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: set ? colors.accent : withAlpha('#FFFFFF', 0.08),
        }}
      >
        <MText size={13} weight="bold" color={set ? '#FFFFFF' : colors.muted}>
          {slot.toUpperCase()}
        </MText>
      </View>
      <MText size={12} mono color={set ? colors.text : colors.muted} style={{ flex: 1 }} numberOfLines={1}>
        {pointLabel(point)}
      </MText>
      {set ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${slot.toUpperCase()}`}
          disabled={disabled}
          onPress={() => gimbal.clearWaypoint(slot)}
          style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
        >
          <X size={15} color={colors.muted} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${set ? 'Update' : 'Set'} ${slot.toUpperCase()} to the current pose`}
        disabled={disabled}
        onPress={() => {
          haptics.medium();
          gimbal.captureWaypoint(slot).catch(() => {});
        }}
        style={({ pressed }) => ({
          minWidth: 64,
          minHeight: 40,
          paddingHorizontal: 10,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: set ? withAlpha('#FFFFFF', 0.08) : withAlpha(colors.accent, 0.2),
          borderWidth: 1,
          borderColor: set ? colors.border : withAlpha(colors.accent, 0.5),
          opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
        })}
      >
        <MText size={11} weight="semibold" tracking={0.6} color={set ? colors.secondary : colors.accent}>
          {set ? 'RESET' : 'SET'}
        </MText>
      </Pressable>
    </View>
  );
}

function DurationRow({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, opacity: disabled ? 0.4 : 1 }}>
      <MText size={12} weight="medium" color={colors.secondary} style={{ flex: 1 }}>
        {label}
      </MText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} shorter`}
        disabled={disabled || value <= LEG_MIN}
        onPress={() => onChange(Math.max(LEG_MIN, value - LEG_STEP))}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Minus size={16} color={colors.secondary} />
      </Pressable>
      <MText size={15} weight="semibold" mono style={{ minWidth: 52, textAlign: 'center' }} accessibilityLabel={`${label} ${value} seconds`}>
        {`${value.toFixed(1)} s`}
      </MText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} longer`}
        disabled={disabled || value >= LEG_MAX}
        onPress={() => onChange(Math.min(LEG_MAX, value + LEG_STEP))}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Plus size={16} color={colors.secondary} />
      </Pressable>
    </View>
  );
}

function RunButton({ compact }: { compact?: boolean }) {
  const { gimbal } = useCameraSession();
  const p = useProgram();
  const busy = running(p.status);
  const ready = !!p.a && !!p.b;
  return (
    <Pressable
      testID="monitor.motion.run"
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Stop' : 'Start'}
      disabled={!busy && !ready}
      onPress={() => {
        haptics.heavy();
        if (busy) gimbal.stopProgram();
        else gimbal.runProgram().catch(() => {});
      }}
      style={({ pressed }) => ({
        minHeight: compact ? 36 : 46,
        minWidth: compact ? 64 : undefined,
        flex: compact ? undefined : 1,
        paddingHorizontal: 12,
        borderRadius: compact ? 18 : radius.md,
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: busy ? colors.recording : colors.accent,
        opacity: !busy && !ready ? 0.35 : pressed ? 0.72 : 1,
      })}
    >
      {busy ? <Square size={13} color="#FFFFFF" fill="#FFFFFF" /> : <Play size={13} color="#FFFFFF" fill="#FFFFFF" />}
      <MText size={13} weight="semibold">
        {busy ? 'Stop' : 'Start'}
      </MText>
    </Pressable>
  );
}

function Progress() {
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
    <View style={{ gap: 4 }}>
      <MText size={11} weight="medium" color={p.status === 'failed' ? colors.recording : colors.muted}>
        {label}
      </MText>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: withAlpha('#FFFFFF', 0.1), overflow: 'hidden' }}>
        <View style={{ width: `${Math.round(p.progress * 100)}%`, height: 4, backgroundColor: colors.accent }} />
      </View>
    </View>
  );
}

/** `LiveGimbalMoveEditor`: A/B/C capture, leg durations, smoothness, start/stop. */
export function MotionControlEditor({ width, maxHeight }: { width: number; maxHeight: number }) {
  const { gimbal } = useCameraSession();
  const p = useProgram();
  const set = useLiveUi((s) => s.set);
  const busy = running(p.status);
  const smoothIndex = SMOOTHNESS.reduce((b, v, i) => (Math.abs(v - p.smoothness) < Math.abs(SMOOTHNESS[b] - p.smoothness) ? i : b), 0);
  return (
    <PanelSurface radius={radius.lg} style={{ width, maxHeight }}>
      <ScrollView bounces={false} contentContainerStyle={{ padding: 14, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <MText size={13} weight="semibold" tracking={0.6} uppercase accessibilityRole="header">
              Motion Control
            </MText>
            <MText size={11} color={colors.muted}>
              Experimental · A → B → C pan and tilt
            </MText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Minimize motion control"
            onPress={() => set({ gimbalPanel: 'runPill' })}
            style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <ChevronsDownUp size={17} color={colors.secondary} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => set({ gimbalPanel: 'none' })}
            style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -8 }}
          >
            <X size={18} color={colors.secondary} />
          </Pressable>
        </View>
        <WaypointRow slot="a" point={p.a} disabled={busy} />
        <WaypointRow slot="b" point={p.b} disabled={busy} />
        <WaypointRow slot="c" point={p.c} disabled={busy} />
        <DurationRow
          label="A → B"
          value={p.legSeconds[0]}
          disabled={busy}
          onChange={(v) => gimbal.configureProgram({ legSeconds: [v, p.legSeconds[1]] })}
        />
        <DurationRow
          label="B → C"
          value={p.legSeconds[1]}
          disabled={busy || !p.c}
          onChange={(v) => gimbal.configureProgram({ legSeconds: [p.legSeconds[0], v] })}
        />
        <View style={{ gap: 6, opacity: p.c ? 1 : 0.4 }}>
          <View style={{ flexDirection: 'row' }}>
            <MText size={12} weight="medium" color={colors.secondary} style={{ flex: 1 }}>
              Smoothness
            </MText>
            <MText size={12} mono color={colors.secondary}>
              {Math.round(p.smoothness * 100)}%
            </MText>
          </View>
          <ModeBar
            tabs={SMOOTHNESS.map((v) => `${Math.round(v * 100)}`)}
            uppercase={false}
            disabled={busy || !p.c}
            selected={smoothIndex}
            onSelect={(i) => gimbal.configureProgram({ smoothness: SMOOTHNESS[i] })}
          />
        </View>
        <View style={{ height: 4 }} />
        <Progress />
        <View style={{ flexDirection: 'row', marginTop: 6 }}>
          <RunButton />
        </View>
      </ScrollView>
    </PanelSurface>
  );
}

/** `LiveGimbalRunPill`: the minimized editor, start/stop and progress. */
export function MotionRunPill() {
  const p = useProgram();
  const set = useLiveUi((s) => s.set);
  return (
    <PanelSurface radius={22} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 4, height: 44 }}>
      <MText size={12} weight="semibold" mono>
        {['a', 'b', 'c'].filter((k) => p[k as Slot]).map((k) => k.toUpperCase()).join('→') || 'Motion'}
      </MText>
      {running(p.status) ? (
        <MText size={11} mono color={colors.accent}>
          {Math.round(p.progress * 100)}%
        </MText>
      ) : null}
      <RunButton compact />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Expand motion control"
        onPress={() => set({ gimbalPanel: 'editor' })}
        style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Maximize2 size={15} color={colors.secondary} />
      </Pressable>
    </PanelSurface>
  );
}

/** Horizontal field of view at 1× for the waypoint preview (presentation only). */
const HFOV_DEG = 80;

/**
 * `LiveGimbalWaypointMarks`: A/B/C and the dashed path preview projected from the current
 * pose into the picture. A preview, not a tracking box. Smoothness rounds near B.
 */
export function MotionPathOverlay({ picture }: { picture: Rect }) {
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
        {d ? <Path d={d} stroke={colors.accent} strokeWidth={2} strokeDasharray="6 5" fill="none" strokeOpacity={0.9} /> : null}
        {pts.map((pt) => (
          <Circle key={`c${pt.k}`} cx={pt.x} cy={pt.y} r={11} fill={withAlpha(colors.accent, 0.85)} stroke="#FFFFFF" strokeWidth={1.5} />
        ))}
        {pts.map((pt) => (
          <SvgText key={`t${pt.k}`} x={pt.x} y={pt.y + 4} fill="#FFFFFF" fontSize={11} fontFamily={fonts.bold} textAnchor="middle">
            {pt.k.toUpperCase()}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}
