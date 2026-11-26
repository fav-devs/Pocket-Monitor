import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { MText, colors, radius, withAlpha } from '@/theme';
import { haptics } from '../haptics';

/** `ModeBar`: joined capture tabs (11pt semibold caps, accent when selected). */
export function ModeBar({
  tabs,
  selected,
  onSelect,
  details,
  disabled,
  uppercase = true,
}: {
  tabs: string[];
  selected: number;
  onSelect: (index: number) => void;
  details?: (string | undefined)[];
  disabled?: boolean;
  uppercase?: boolean;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderRadius: radius.md,
        backgroundColor: withAlpha('#FFFFFF', 0.05),
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
      }}
    >
      {tabs.map((title, i) => {
        const active = i === selected;
        return (
          <Pressable
            key={`${title}-${i}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled }}
            accessibilityLabel={title}
            disabled={disabled}
            onPress={() => {
              haptics.selection();
              onSelect(i);
            }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 4,
              backgroundColor: active ? withAlpha(colors.accent, 0.16) : 'transparent',
              borderLeftWidth: i > 0 ? 1 : 0,
              borderLeftColor: colors.border,
              opacity: pressed ? 0.72 : disabled ? 0.4 : 1,
            })}
          >
            <MText size={11} weight="semibold" tracking={0.44} uppercase={uppercase} numberOfLines={1} color={active ? colors.accent : colors.muted}>
              {title}
            </MText>
            {details?.[i] ? (
              <MText size={9.5} mono numberOfLines={1} color={active ? colors.accent : colors.faint}>
                {details[i]}
              </MText>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** `StepButton`: 52×44 rounded step key. */
export function StepButton({
  label,
  onPress,
  disabled,
  active,
  accessibilityLabel,
  flex,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  accessibilityLabel?: string;
  flex?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => ({
        minWidth: 52,
        minHeight: 44,
        flex: flex ? 1 : undefined,
        paddingHorizontal: 10,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? withAlpha(colors.accent, 0.16) : withAlpha('#FFFFFF', 0.06),
        borderWidth: 1,
        borderColor: active ? withAlpha(colors.accent, 0.5) : colors.border,
        opacity: pressed ? 0.72 : disabled ? 0.4 : 1,
      })}
    >
      <MText size={11} weight="semibold" tracking={0.3} numberOfLines={1} color={active ? colors.accent : colors.secondary}>
        {label}
      </MText>
    </Pressable>
  );
}

/** A labelled on/off row inside a capture drawer. */
export function ToggleRow({
  title,
  detail,
  value,
  onChange,
  disabled,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={title}
      disabled={disabled}
      onPress={() => {
        haptics.selection();
        onChange(!value);
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 44,
        gap: 12,
        opacity: pressed ? 0.72 : disabled ? 0.4 : 1,
      })}
    >
      <View style={{ flex: 1 }}>
        <MText size={13} weight="medium">
          {title}
        </MText>
        {detail ? (
          <MText size={11} color={colors.muted}>
            {detail}
          </MText>
        ) : null}
      </View>
      <View
        style={{
          width: 40,
          height: 24,
          borderRadius: 12,
          padding: 2,
          backgroundColor: value ? colors.accent : withAlpha('#FFFFFF', 0.16),
          alignItems: value ? 'flex-end' : 'flex-start',
        }}
      >
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF' }} />
      </View>
    </Pressable>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <MText size={10} weight="bold" tracking={1.4} uppercase color={colors.faint}>
      {children}
    </MText>
  );
}

/** Wrapping row of choice chips (WB presets, colour modes, shooting modes). */
export function ChoiceChips<T extends string | number>({
  options,
  value,
  label,
  onSelect,
  disabled,
}: {
  options: T[];
  value: T | null;
  label: (v: T) => string;
  onSelect: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => (
        <StepButton key={String(o)} label={label(o)} active={o === value} disabled={disabled} onPress={() => onSelect(o)} />
      ))}
    </View>
  );
}
