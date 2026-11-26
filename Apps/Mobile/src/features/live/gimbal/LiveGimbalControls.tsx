import {
  FlipHorizontalIcon,
  LockIcon,
  Refresh01Icon,
  Route01Icon,
  RulerIcon,
  Target02Icon,
} from '@hugeicons/core-free-icons';
import { Pressable, Text, View } from 'react-native';
import { useCamera, useCameraSession, type GimbalSpeed } from '@/camera';
import { ChipRow } from '@/components/field-section';
import { Chip } from '@/components/chip';
import { Icon } from '@/components/icon';
import { SettingsRow } from '@/components/settings-ui';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import { FieldLabel, ModeBar, StepperRow, ToggleRow, ToolWell } from '../capture/controls';
import { GIMBAL_MODE_LABEL, GIMBAL_SPEED_LABEL, angleLabel } from '../format';
import { haptics } from '../haptics';
import { ZOOM_RAMP_CHOICES, rampLabel, useLiveUi, useZoomPresets } from '../liveUiStore';
import { onVideo } from '../chrome/primitives';

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

/**
 * `LiveGimbalControls` body: mode, speed, recenter/level/flip, all-axes lock, Direction Lock,
 * zoom preset ramp, and the Motion Control entry. Follow / speed / ramp / A·B·C live here, not
 * leading of the stick (CONTEXT.md Gimbal cluster).
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
    <View style={styles.stack}>
      <Text style={styles.pose}>
        Pan {angleLabel(g.yaw)} · Tilt {angleLabel(g.pitch)}
      </Text>
      <View style={styles.tools}>
        <ToolWell icon={Refresh01Icon} label={g.recentering ? 'Centring…' : 'Recenter'} onPress={() => gimbal.recenter().catch(() => {})} />
        <ToolWell icon={RulerIcon} label="Level" onPress={() => gimbal.level().catch(() => {})} />
        {selfieFlip ? (
          <ToolWell
            icon={FlipHorizontalIcon}
            label={g.face === 'selfie' ? 'Selfie' : 'Flip'}
            selected={g.face === 'selfie'}
            onPress={() => gimbal.flip().catch(() => {})}
          />
        ) : null}
        <ToolWell
          icon={LockIcon}
          label="Lock axes"
          selected={g.lockedAllAxes}
          onPress={() => {
            const next = !g.lockedAllAxes;
            gimbal.setLockedAllAxes(next);
            notice(next ? 'Gimbal locked on all axes' : 'Gimbal unlocked');
          }}
        />
      </View>

      <View style={styles.group}>
        <FieldLabel>Mode</FieldLabel>
        <ChipRow>
          {g.modeOptions.map((m) => (
            <Chip
              key={m}
              label={GIMBAL_MODE_LABEL[m]}
              selected={m === g.mode}
              onPress={() => {
                haptics.selection();
                gimbal.setMode(m).catch(() => notice('Gimbal mode not changed', 'error'));
              }}
            />
          ))}
        </ChipRow>
      </View>
      <View style={styles.group}>
        <FieldLabel>Speed</FieldLabel>
        <ModeBar
          accessibilityLabel="Gimbal speed"
          tabs={SPEEDS.map((s) => GIMBAL_SPEED_LABEL[s])}
          selected={SPEEDS.indexOf(g.speed)}
          onSelect={(i) => gimbal.setSpeed(SPEEDS[i]).catch(() => {})}
        />
      </View>

      <View>
        <ToggleRow title="Direction Lock" value={directionLock} onChange={(v) => setPref('directionLock', v)} />
        <StepperRow
          title="Zoom ramp"
          value={rampLabel(rampSeconds)}
          minusLabel="Shorter ramp"
          plusLabel="Longer ramp"
          minusDisabled={rampIndex <= 0}
          plusDisabled={rampIndex >= ZOOM_RAMP_CHOICES.length - 1}
          onMinus={() => setRamp(ZOOM_RAMP_CHOICES[Math.max(0, rampIndex - 1)])}
          onPlus={() => setRamp(ZOOM_RAMP_CHOICES[Math.min(ZOOM_RAMP_CHOICES.length - 1, rampIndex + 1)])}
        />
      </View>

      <View testID="monitor.gimbal.motion" style={styles.motionRow}>
        <SettingsRow
          icon={Route01Icon}
          title="Motion Control"
          subtitle={setCount === 0 ? undefined : `${setCount} point${setCount === 1 ? '' : 's'} set`}
          chevron
          last
          onPress={() => set({ gimbalPanel: 'editor' })}
        />
      </View>
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
    circle: { alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: onVideo.rail },
    dim: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    stack: { gap: spacing.md },
    group: { gap: spacing.sm },
    pose: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    tools: { flexDirection: 'row' as const, gap: spacing.xs },
    motionRow: { borderRadius: 16, backgroundColor: colors.surface, paddingHorizontal: spacing.sm + 4, overflow: 'hidden' as const },
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
