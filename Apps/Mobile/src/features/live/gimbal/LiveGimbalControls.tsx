import {
  FlipHorizontalIcon,
  LockIcon,
  Refresh01Icon,
  Route01Icon,
  RulerIcon,
  Target02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { MinusSignCircleIcon, PlusSignCircleIcon } from '@hugeicons/core-free-icons';
import { Pressable, Text, View } from 'react-native';
import { useCamera, useCameraSession, type GimbalSpeed } from '@/camera';
import { Icon } from '@/components/icon';
import { monitorPanel } from '@/constants/monitor';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import { PanelGrid, PanelHeading, PanelKey, PanelRow, PanelSegments, PanelSwitch, RowValue } from '../panel/kit';
import { GIMBAL_MODE_LABEL, GIMBAL_SPEED_LABEL, angleLabel } from '../format';
import { haptics } from '../haptics';
import { ZOOM_RAMP_CHOICES, rampLabel, useLiveUi, useZoomPresets } from '../liveUiStore';
import { onVideo } from '../chrome/primitives';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import { gesturesAvailable } from '@/camera/desktop/gestures';
import { DesktopGestureRows } from './DesktopGestureRows';

/** `LiveGimbalButton`: a zoom-sized translucent circle leading of the zoom chip; toggles the sheet. */
export function LiveGimbalButton({ size, disabled }: { size: number; disabled?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const panel = useLiveUi((s) => s.gimbalPanel);
  const set = useLiveUi((s) => s.set);
  const running = useCamera((s) => s.gimbal.program.status === 'running' || s.gimbal.program.status === 'preparing');
  const active = panel === 'sheet' || panel === 'editor' || running;
  return (
    <Pressable
      testID="monitor.gimbal.controls"
      accessibilityRole="button"
      accessibilityLabel="Gimbal controls"
      accessibilityState={{ expanded: panel === 'sheet' || panel === 'editor', disabled }}
      disabled={disabled}
      onPress={() => set({ gimbalPanel: panel === 'sheet' || panel === 'editor' ? 'none' : 'sheet', captureSheet: null, zoomDialOpen: false })}
      style={({ pressed }) => [
        styles.circle,
        { width: size, height: size, borderRadius: size / 2 },
        active && { backgroundColor: colors.accent },
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Icon icon={Target02Icon} size={20} color={active ? onVideo.dark : onVideo.ink} strokeWidth={1.8} />
    </Pressable>
  );
}

const SPEEDS: GimbalSpeed[] = ['slow', 'normal', 'fast'];

/** A labelled icon key in the gimbal panel's tool row (Recenter, Level, Flip, Lock axes). */
function GimbalTool({ icon, label, onPress, on = false }: { icon: IconSvgElement; label: string; onPress: () => void; on?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={() => {
        haptics.light();
        onPress();
      }}
      style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
    >
      <View style={[styles.toolWell, on && styles.toolWellOn]}>
        <Icon icon={icon} size={22} color={on ? monitorPanel.dark : monitorPanel.text} strokeWidth={on ? 2 : 1.7} />
      </View>
      <Text numberOfLines={1} style={styles.toolLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The gimbal panel (camera settings' Gimbal tab): pose, recenter / level / flip / lock axes,
 * mode, speed, Direction Lock, zoom preset ramp, and the Motion Control entry. Follow / speed /
 * ramp / A·B·C live here, not leading of the stick (CONTEXT.md Gimbal cluster).
 */
export function LiveGimbalPanel({ notice }: { notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void }) {
  const styles = useThemedStyles(createStyles);
  const { gimbal } = useCameraSession();
  const g = useCamera((s) => s.gimbal);
  const selfieFlip = useCamera((s) => s.capabilities.selfieFlip);
  const set = useLiveUi((s) => s.set);
  const directionLock = usePreferences((p) => p.directionLock);
  const setPref = usePreferences((p) => p.set);
  const { rampSeconds, setRamp } = useZoomPresets();
  const rampIndex = ZOOM_RAMP_CHOICES.indexOf(rampSeconds);
  const program = g.program;
  const setCount = [program.a, program.b, program.c].filter(Boolean).length;

  return (
    <View testID="monitor.panel.gimbal">
      <Text style={styles.pose}>
        Pan {angleLabel(g.yaw)} · Tilt {angleLabel(g.pitch)}
      </Text>
      <View style={styles.tools}>
        <GimbalTool icon={Refresh01Icon} label={g.recentering ? 'Centring…' : 'Recenter'} onPress={() => gimbal.recenter().catch(() => {})} />
        <GimbalTool icon={RulerIcon} label="Level" onPress={() => gimbal.level().catch(() => {})} />
        {selfieFlip ? (
          <GimbalTool
            icon={FlipHorizontalIcon}
            label={g.face === 'selfie' ? 'Selfie' : 'Flip'}
            on={g.face === 'selfie'}
            onPress={() => gimbal.flip().catch(() => {})}
          />
        ) : null}
        <GimbalTool
          icon={LockIcon}
          label="Lock axes"
          on={g.lockedAllAxes}
          onPress={() => {
            const next = !g.lockedAllAxes;
            gimbal.setLockedAllAxes(next);
            notice(next ? 'Gimbal locked on all axes' : 'Gimbal unlocked');
          }}
        />
      </View>
      <PanelHeading>Mode</PanelHeading>
      <PanelGrid
        accessibilityLabel="Gimbal mode"
        columns={g.modeOptions.length > 4 ? 3 : 2}
        cells={g.modeOptions.map((m) => ({
          key: m,
          label: GIMBAL_MODE_LABEL[m],
          chosen: m === g.mode,
          onPress: () => gimbal.setMode(m).catch(() => notice('Gimbal mode not changed', 'error')),
        }))}
      />
      <PanelHeading>Speed</PanelHeading>
      <View style={styles.pad}>
        <PanelSegments
          accessibilityLabel="Gimbal speed"
          options={SPEEDS.map((s) => GIMBAL_SPEED_LABEL[s])}
          selected={SPEEDS.indexOf(g.speed)}
          onSelect={(i) => gimbal.setSpeed(SPEEDS[i]).catch(() => {})}
        />
      </View>
      <PanelRow title="Direction Lock">
        <PanelSwitch label="Direction Lock" value={directionLock} onChange={(v) => setPref('directionLock', v)} />
      </PanelRow>
      <PanelRow title="Zoom ramp">
        <PanelKey
          icon={MinusSignCircleIcon}
          label="Shorter ramp"
          disabled={rampIndex <= 0}
          onPress={() => setRamp(ZOOM_RAMP_CHOICES[Math.max(0, rampIndex - 1)])}
        />
        <Text style={styles.stepValue}>{rampLabel(rampSeconds)}</Text>
        <PanelKey
          icon={PlusSignCircleIcon}
          label="Longer ramp"
          disabled={rampIndex >= ZOOM_RAMP_CHOICES.length - 1}
          onPress={() => setRamp(ZOOM_RAMP_CHOICES[Math.min(ZOOM_RAMP_CHOICES.length - 1, rampIndex + 1)])}
        />
      </PanelRow>
      {desktopCameraEnabled || gesturesAvailable() ? <DesktopGestureRows /> : null}
      <PanelRow testID="monitor.gimbal.motion" icon={Route01Icon} title="Motion Control" onPress={() => set({ gimbalPanel: 'editor', captureSheet: null })}>
        <RowValue value={setCount === 0 ? '' : `${setCount} point${setCount === 1 ? '' : 's'}`} />
      </PanelRow>
    </View>
  );
}

/** All-axes lock chip beside the stick: latched hold, toasts, never a camera SET. */
export function GimbalLockChip({ onUnlock }: { onUnlock: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Gimbal locked. Tap to unlock."
      onPress={onUnlock}
      hitSlop={10}
      style={({ pressed }) => [styles.lockChip, pressed && styles.pressed]}
    >
      <Icon icon={LockIcon} size={13} color={onVideo.dark} strokeWidth={2} />
      <Text style={styles.lockChipText}>Locked</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    circle: { alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: onVideo.pill },
    dim: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    pose: {
      fontFamily: fonts.medium,
      fontSize: 13,
      color: monitorPanel.muted,
      fontVariant: ['tabular-nums' as const],
      paddingHorizontal: 16,
      paddingTop: 10,
    },
    tools: { flexDirection: 'row' as const, paddingHorizontal: 8, paddingVertical: 10 },
    tool: { flex: 1, alignItems: 'center' as const, gap: 6, minWidth: 56 },
    toolWell: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: monitorPanel.wellStrong,
    },
    toolWellOn: { backgroundColor: '#ffffff' },
    toolLabel: { fontFamily: fonts.medium, fontSize: 11, color: monitorPanel.muted },
    pad: { paddingHorizontal: 16, paddingVertical: 6 },
    stepValue: {
      minWidth: 44,
      textAlign: 'center' as const,
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: monitorPanel.text,
      fontVariant: ['tabular-nums' as const],
    },
    lockChip: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 5,
      height: 28,
      paddingHorizontal: 10,
      borderRadius: 14,
      backgroundColor: colors.accent,
    },
    lockChipText: { fontFamily: fonts.semibold, fontSize: 12, color: onVideo.dark },
  };
}
