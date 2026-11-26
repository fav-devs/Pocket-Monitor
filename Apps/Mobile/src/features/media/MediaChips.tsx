import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Switch, View, type StyleProp, type ViewStyle } from 'react-native';
import { MText, colors, minTouch, radius, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';

export const favoriteGold = '#E9C35A';
export const onPhoneTint = '#3FD3A3';

/** `MonitorMediaCatalogChip`: icon (+ text) on a faint plate, 44pt target. */
export function MediaChip({
  icon: Icon,
  text,
  label,
  onPress,
  active,
  danger,
  disabled,
  filled,
  trailing,
}: {
  icon: LucideIcon;
  text?: string;
  label: string;
  onPress?: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  filled?: boolean;
  trailing?: ReactNode;
}) {
  const fg = danger ? colors.recording : active ? colors.text : colors.secondary;
  return (
    <PressableScale
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={{
        minWidth: minTouch,
        minHeight: minTouch,
        paddingHorizontal: text ? 11 : 9,
        borderRadius: 9,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        backgroundColor: active ? withAlpha(colors.accent, 0.18) : 'rgba(255,255,255,0.04)',
      }}
    >
      <Icon size={13} color={fg} strokeWidth={2} fill={filled ? fg : 'transparent'} />
      {text ? (
        <MText size={10.5} weight="semibold" color={fg} numberOfLines={1}>
          {text}
        </MText>
      ) : null}
      {trailing}
    </PressableScale>
  );
}

/** `MonitorPlaybackChip`: a 44pt glass square on the player's chrome. */
export function PlaybackChip({
  icon: Icon,
  label,
  onPress,
  active,
  destructive,
  text,
  accent,
  tint,
  filled,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onPress?: () => void;
  active?: boolean;
  destructive?: boolean;
  text?: string;
  accent?: boolean;
  tint?: string;
  filled?: boolean;
  disabled?: boolean;
}) {
  const fg = tint ?? (destructive ? colors.recording : accent || active ? colors.accent : colors.secondary);
  const bg = destructive
    ? withAlpha(colors.recording, 0.2)
    : accent
      ? withAlpha(colors.accent, 0.2)
      : active
        ? withAlpha(colors.accent, 0.16)
        : 'rgba(40,42,44,0.72)';
  const border = destructive ? withAlpha(colors.recording, 0.5) : accent ? withAlpha(colors.accent, 0.55) : colors.border;
  return (
    <PressableScale
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={{
        height: minTouch,
        minWidth: minTouch,
        paddingHorizontal: text ? 14 : 0,
        borderRadius: radius.md,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: border,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <Icon size={18} color={fg} strokeWidth={1.9} fill={filled ? fg : 'transparent'} />
      {text ? (
        <MText size={13} weight="bold" tracking={1} color={fg} uppercase>
          {text}
        </MText>
      ) : null}
    </PressableScale>
  );
}

/** Black rounded tag over artwork ("ON CAMERA", "0:21", "3 frames"). */
export function ArtTag({ text, color = colors.text, tracking }: { text: string; color?: string; tracking?: number }) {
  return (
    <View style={{ backgroundColor: 'rgba(0,0,0,0.66)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 3 }}>
      <MText size={8.5} weight="bold" color={color} tracking={tracking} mono>
        {text}
      </MText>
    </View>
  );
}

/** A thin accent progress bar on a faint track. */
export function ProgressTrack({ fraction, height = 4, style }: { fraction: number; height?: number; style?: StyleProp<ViewStyle> }) {
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <View style={[{ height, borderRadius: height, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' }, style]}>
      <View style={{ width: `${f * 100}%`, minWidth: f > 0 ? height : 0, height, borderRadius: height, backgroundColor: colors.accent }} />
    </View>
  );
}

/** Settings-style toggle row: title, help, switch. */
export function ToggleRow({
  title,
  help,
  value,
  onChange,
  disabled,
  badge,
}: {
  title: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <PressableScale
      noScale
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      onPress={() => !disabled && onChange(!value)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: minTouch, paddingVertical: 6 }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <MText size={12.5} weight="semibold" color={disabled ? colors.faint : colors.text}>
            {title}
          </MText>
          {badge ? <Badge text={badge} /> : null}
        </View>
        {help ? (
          <MText size={10.5} color={colors.muted}>
            {help}
          </MText>
        ) : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: colors.raised, true: colors.accent }}
        thumbColor="#fff"
        {...(Platform.OS === 'web' ? ({ activeThumbColor: '#fff' } as object) : {})}
        accessibilityLabel={title}
      />
    </PressableScale>
  );
}

export function Badge({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'accent' | 'muted' }) {
  const c = tone === 'warn' ? colors.digitalCrop : tone === 'accent' ? colors.accent : colors.muted;
  return (
    <View style={{ borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: withAlpha(c, 0.16) }}>
      <MText size={8.5} weight="bold" tracking={0.6} color={c} uppercase>
        {text}
      </MText>
    </View>
  );
}

/** Segmented choice (pill group). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <View accessibilityLabel={label} style={{ flexDirection: 'row', padding: 3, gap: 2, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.35)', alignSelf: 'flex-start', flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <PressableScale
            key={o.value}
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={{ minHeight: 38, minWidth: 44, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? 'rgba(255,255,255,0.14)' : 'transparent' }}
          >
            <MText size={11.5} weight="semibold" color={on ? colors.text : colors.muted}>
              {o.label}
            </MText>
          </PressableScale>
        );
      })}
    </View>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <ActivityIndicator size="small" color={colors.accent} />
      <MText size={12} color={colors.muted}>
        {label}
      </MText>
    </View>
  );
}
