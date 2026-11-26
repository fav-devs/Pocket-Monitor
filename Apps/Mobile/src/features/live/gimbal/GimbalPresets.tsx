import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { Pressable, Text, View } from 'react-native';
import { presetClear, presetGo, presetSave, presetSeconds, desktopInput, useDesktopInput } from '@/camera/desktop/input';
import { Icon } from '@/components/icon';
import { Squircle } from '@/components/squircle';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { FieldLabel, ModeBar } from '../capture/controls';
import { angleLabel } from '../format';
import { haptics } from '../haptics';

const SECONDS = [0.5, 1, 2, 4, 8, 15];

function secondsLabel(s: number) {
  return `${s} s`;
}

function PresetRow({ slot, pose, disabled }: { slot: number; pose: { yaw: number; pitch: number } | null; disabled: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const set = !!pose;
  const name = `${slot + 1}`;
  return (
    <View style={[styles.row, disabled && styles.dim]}>
      <Squircle width={36} height={36} radius={12} color={set ? colors.ink : colors.surface}>
        <Text style={[styles.slot, set && { color: colors.inkForeground }]}>{name}</Text>
      </Squircle>
      <Text numberOfLines={1} style={[styles.pose, !set && styles.unset]}>
        {pose ? `Pan ${angleLabel(pose.yaw)} · Tilt ${angleLabel(pose.pitch)}` : 'Empty'}
      </Text>
      {set ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear preset ${name}`}
          disabled={disabled}
          hitSlop={6}
          onPress={() => presetClear(slot)}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
        >
          <Icon icon={Cancel01Icon} size={16} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Save preset ${name} here`}
        disabled={disabled}
        hitSlop={4}
        onPress={() => {
          haptics.medium();
          presetSave(slot).catch(() => {});
        }}
        style={({ pressed }) => [styles.key, pressed && styles.pressed]}
      >
        <Text style={styles.keyLabel}>Save</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Go to preset ${name} (key ${name})`}
        disabled={disabled || !set}
        hitSlop={4}
        onPress={() => {
          haptics.selection();
          presetGo(slot);
        }}
        style={({ pressed }) => [styles.key, set && styles.keyPrimary, !set && styles.faint, pressed && styles.pressed]}
      >
        <Text style={[styles.keyLabel, set && styles.keyLabelPrimary]}>Go</Text>
      </Pressable>
    </View>
  );
}

/**
 * Gimbal presets (desktop §1.Q Q2): six poses saved from the live attitude, recalled with keys
 * 1–6 or Go, each as one timed move of the recall time. Desktop app only.
 */
export function GimbalPresets({ disabled }: { disabled?: boolean }) {
  const styles = useThemedStyles(createStyles);
  const presets = useDesktopInput((s) => s.input?.presets);
  if (!desktopInput()) return null;
  const slots = presets?.slots ?? [null, null, null, null, null, null];
  const seconds = presets?.seconds ?? 2;
  const choices = presets?.choices?.length ? presets.choices : SECONDS;
  const selected = choices.reduce((b, v, i) => (Math.abs(v - seconds) < Math.abs(choices[b] - seconds) ? i : b), 0);
  return (
    <View style={styles.stack}>
      <FieldLabel>Presets</FieldLabel>
      <View style={styles.rows}>
        {slots.map((pose, slot) => (
          <PresetRow key={slot} slot={slot} pose={pose} disabled={!!disabled} />
        ))}
      </View>
      <View style={styles.group}>
        <FieldLabel>Recall · {secondsLabel(seconds)}</FieldLabel>
        <ModeBar
          accessibilityLabel="Preset recall time"
          tabs={choices.map(secondsLabel)}
          selected={selected}
          disabled={disabled}
          onSelect={(i) => presetSeconds(choices[i])}
        />
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    stack: { gap: spacing.sm },
    group: { gap: spacing.sm },
    rows: { gap: spacing.xs },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm + 2, minHeight: 44 },
    slot: { fontFamily: fonts.bold, fontSize: 14, color: colors.foreground },
    pose: { flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    unset: { color: colors.mutedForeground },
    clear: { width: 32, height: 36, alignItems: 'center' as const, justifyContent: 'center' as const },
    key: {
      minWidth: 52,
      height: 36,
      paddingHorizontal: 12,
      borderRadius: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: colors.surface,
    },
    keyPrimary: { backgroundColor: colors.ink },
    keyLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    keyLabelPrimary: { color: colors.inkForeground },
    dim: { opacity: 0.4 },
    faint: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
  };
}
