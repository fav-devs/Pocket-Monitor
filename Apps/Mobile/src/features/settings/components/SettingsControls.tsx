import * as Haptics from 'expo-haptics';
import { Info, Minus, Plus, RefreshCw } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Platform, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { MText, colors, fonts, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { usePreferences } from '@/state/preferences';

/** Card metrics (`MonitorSettingsCardMetrics`). */
export const cardMetrics = {
  titleTopPadding: 11,
  titleMinHeight: 24,
  titleContentGap: 8,
  titleSize: 13,
  rowTitleSize: 12.5,
} as const;

/** Selection pulse for settings controls (`OperatorSettingsHaptics.selection`), when Haptics is on. */
export function settingsFeedback() {
  if (Platform.OS === 'web') return;
  if (!usePreferences.getState().recordHaptics) return;
  Haptics.selectionAsync().catch(() => {});
}

/** One settings card (`MonitorSettingsRowCard`) on the card surface. */
export function SettingsCard({
  title,
  onReset,
  children,
  style,
  testID,
}: {
  title?: string;
  onReset?: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[
        {
          paddingHorizontal: 13,
          paddingBottom: 4,
          borderRadius: 12,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          gap: title ? cardMetrics.titleContentGap : 0,
        },
        style,
      ]}
    >
      {title ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: cardMetrics.titleMinHeight,
            paddingTop: cardMetrics.titleTopPadding,
          }}
        >
          <MText size={cardMetrics.titleSize} weight="semibold" style={{ flex: 1 }} accessibilityRole="header">
            {title}
          </MText>
          {onReset ? <ResetButton onPress={onReset} /> : null}
        </View>
      ) : null}
      <View>{children}</View>
    </View>
  );
}

function ResetButton({ onPress }: { onPress: () => void }) {
  return (
    <PressableScale
      accessibilityLabel="Reset to defaults"
      onPress={() => {
        settingsFeedback();
        onPress();
      }}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -10, marginRight: -8 }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: withAlpha(colors.background, 0.42),
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <RefreshCw size={12} color={colors.muted} />
      </View>
    </PressableScale>
  );
}

/** The info dot beside a row title; tapping reveals the row's help under it. */
function HelpBadge({ open, onPress }: { open: boolean; onPress: () => void }) {
  return (
    <PressableScale
      accessibilityLabel={open ? 'Hide help' : 'Help'}
      onPress={onPress}
      hitSlop={14}
      style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: open ? withAlpha(colors.accent, 0.18) : withAlpha(colors.background, 0.5),
          borderWidth: 1,
          borderColor: open ? withAlpha(colors.accent, 0.4) : colors.border,
        }}
      >
        <Info size={9} color={open ? colors.accent : colors.faint} strokeWidth={2.4} />
      </View>
    </PressableScale>
  );
}

/** Label + trailing control (`MonitorSettingsInlineRow`). `stacked` puts the control below. */
export function SettingsRow({
  title,
  help,
  divider = true,
  stacked,
  children,
  testID,
}: {
  title: string;
  help?: string;
  divider?: boolean;
  stacked?: boolean;
  children?: ReactNode;
  testID?: string;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const label = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
      <MText size={cardMetrics.rowTitleSize} weight="semibold" numberOfLines={stacked ? 2 : 2} style={{ flexShrink: 1 }}>
        {title}
      </MText>
      {help ? <HelpBadge open={showHelp} onPress={() => setShowHelp((s) => !s)} /> : null}
    </View>
  );
  return (
    <View testID={testID}>
      {divider ? <View style={{ height: 1, backgroundColor: colors.border }} /> : null}
      {stacked ? (
        <View style={{ paddingVertical: 8, gap: 6, minHeight: 44 }}>
          {label}
          {children}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 50, gap: 12 }}>
          <View style={{ flex: 1 }}>{label}</View>
          {children}
        </View>
      )}
      {showHelp && help ? (
        <MText size={10.5} color={colors.muted} style={{ lineHeight: 15, paddingBottom: 10 }}>
          {help}
        </MText>
      ) : null}
    </View>
  );
}

/** Muted tabular value (`MonitorSettingsValueText`). */
export function ValueText({ value, color = colors.muted }: { value: string; color?: string }) {
  return (
    <MText size={12.5} weight="medium" mono color={color} numberOfLines={1} style={{ maxWidth: 200, textAlign: 'right' }}>
      {value}
    </MText>
  );
}

/** Capsule switch graphic (`MonitorSettingsSwitchGraphic`). */
export function SwitchGraphic({ isOn }: { isOn: boolean }) {
  return (
    <View
      style={{
        width: 39,
        height: 22,
        borderRadius: 11,
        backgroundColor: isOn ? withAlpha(colors.accent, 0.16) : colors.surface,
        borderWidth: 1,
        borderColor: isOn ? withAlpha(colors.accent, 0.16) : colors.border,
        justifyContent: 'center',
        alignItems: isOn ? 'flex-end' : 'flex-start',
        paddingHorizontal: 2.5,
      }}
    >
      <View style={{ width: 15, height: 15, borderRadius: 8, backgroundColor: isOn ? colors.accent : colors.muted }} />
    </View>
  );
}

/** A 44pt switch with the monitor graphic. */
export function SettingsSwitch({
  value,
  onChange,
  label,
  disabled,
  testID,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => {
        settingsFeedback();
        onChange(!value);
      }}
      style={{ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <SwitchGraphic isOn={value} />
    </PressableScale>
  );
}

/** Title + switch row (`MonitorSettingsSwitchInlineRow`). */
export function SwitchRow({
  title,
  help,
  value,
  onChange,
  divider,
  disabled,
  testID,
}: {
  title: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  divider?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <SettingsRow title={title} help={help} divider={divider}>
      <SettingsSwitch value={value} onChange={onChange} label={title} disabled={disabled} testID={testID} />
    </SettingsRow>
  );
}

/** Title + value row. */
export function ValueRow({ title, help, value, divider, color }: { title: string; help?: string; value: string; divider?: boolean; color?: string }) {
  return (
    <SettingsRow title={title} help={help} divider={divider}>
      <ValueText value={value} color={color} />
    </SettingsRow>
  );
}

/** Caps capsule action (`MonitorSettingsActionPill`). */
export function ActionPill({
  title,
  onPress,
  tint = colors.accent,
  disabled,
  accessibilityLabel,
  testID,
}: {
  title: string;
  onPress: () => void;
  tint?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  return (
    <PressableScale
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? title}
      disabled={disabled}
      onPress={() => {
        settingsFeedback();
        onPress();
      }}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 999,
          backgroundColor: withAlpha(tint, 0.16),
          borderWidth: 1,
          borderColor: withAlpha(tint, 0.5),
        }}
      >
        <MText size={10.5} weight="bold" tracking={0.6} color={tint} uppercase numberOfLines={1}>
          {title}
        </MText>
      </View>
    </PressableScale>
  );
}

/** Title + action pill row. */
export function ActionRow({
  title,
  help,
  action,
  onPress,
  divider,
  tint,
  disabled,
  testID,
}: {
  title: string;
  help?: string;
  action: string;
  onPress: () => void;
  divider?: boolean;
  tint?: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <SettingsRow title={title} help={help} divider={divider}>
      <ActionPill title={action} onPress={onPress} tint={tint} disabled={disabled} accessibilityLabel={`${action} ${title}`} testID={testID} />
    </SettingsRow>
  );
}

/** Equal choices in a recessed track (`MonitorSegmentedControl`, compact). */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  title = (v) => String(v),
  disabled,
  stretch = true,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  title?: (v: T) => string;
  disabled?: boolean;
  stretch?: boolean;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: 'row',
        gap: 3,
        padding: 3,
        borderRadius: 12,
        backgroundColor: withAlpha(colors.canvas, 0.5),
        borderWidth: 1,
        borderColor: colors.border,
        alignSelf: stretch ? 'stretch' : 'flex-start',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <PressableScale
            key={String(option)}
            noScale
            hitSlop={0}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={title(option)}
            accessibilityState={{ selected: active, checked: active }}
            onPress={() => {
              if (active) return;
              settingsFeedback();
              onChange(option);
            }}
            style={{
              flex: stretch ? 1 : undefined,
              minHeight: 38,
              paddingHorizontal: 8,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? colors.surface : 'transparent',
            }}
          >
            <MText size={11} weight={active ? 'semibold' : 'medium'} color={active ? colors.text : colors.muted} numberOfLines={1}>
              {title(option)}
            </MText>
          </PressableScale>
        );
      })}
    </View>
  );
}

/** − value + stepper for bounded numbers. */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
  label,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label: string;
  disabled?: boolean;
}) {
  const round = (v: number) => Math.round(v / step) * step;
  const set = (v: number) => {
    const next = Math.min(max, Math.max(min, round(v)));
    if (next === value) return;
    settingsFeedback();
    onChange(Number(next.toFixed(4)));
  };
  const btn = (dir: -1 | 1) => {
    const Icon = dir < 0 ? Minus : Plus;
    const off = disabled || (dir < 0 ? value <= min : value >= max);
    return (
      <PressableScale
        accessibilityLabel={`${dir < 0 ? 'Decrease' : 'Increase'} ${label}`}
        disabled={off}
        onPress={() => set(value + dir * step)}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.raised,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Icon size={14} color={colors.secondary} strokeWidth={2.2} />
        </View>
      </PressableScale>
    );
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: format(value) }}
      onAccessibilityAction={(e) => set(value + (e.nativeEvent.actionName === 'increment' ? step : -step))}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      {btn(-1)}
      <MText size={12.5} weight="semibold" mono align="center" style={{ minWidth: 46 }}>
        {format(value)}
      </MText>
      {btn(1)}
    </View>
  );
}

/** A tappable notch track for small integer ranges (the slider for 1…5 style settings). */
export function NotchSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label: string;
}) {
  const stops: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) stops.push(Number(v.toFixed(4)));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: format(value) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const i = stops.indexOf(value);
          const next = stops[Math.min(stops.length - 1, Math.max(0, i + (e.nativeEvent.actionName === 'increment' ? 1 : -1)))];
          if (next !== undefined && next !== value) onChange(next);
        }}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', height: 44 }}
      >
        <View style={{ position: 'absolute', left: 10, right: 10, height: 3, borderRadius: 2, backgroundColor: colors.raised }} />
        {stops.map((s) => {
          const on = s <= value;
          const current = s === value;
          return (
            <PressableScale
              key={s}
              noScale
              hitSlop={0}
              accessibilityLabel={`${label} ${format(s)}`}
              onPress={() => {
                if (s === value) return;
                settingsFeedback();
                onChange(s);
              }}
              style={{ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <View
                style={{
                  width: current ? 18 : 9,
                  height: current ? 18 : 9,
                  borderRadius: 9,
                  backgroundColor: on ? colors.accent : colors.raised,
                  borderWidth: current ? 3 : 1,
                  borderColor: current ? withAlpha(colors.accent, 0.35) : colors.border,
                }}
              />
            </PressableScale>
          );
        })}
      </View>
      <MText size={12} weight="medium" mono style={{ minWidth: 40, textAlign: 'right' }}>
        {format(value)}
      </MText>
    </View>
  );
}

/** A compact right-aligned text input for a row. */
export function InlineTextInput(props: TextInputProps & { width?: number }) {
  const { width = 150, style, ...rest } = props;
  return (
    <TextInput
      placeholderTextColor={colors.faint}
      autoCapitalize="none"
      autoCorrect={false}
      {...rest}
      style={[
        {
          width,
          minHeight: 40,
          borderRadius: 10,
          paddingHorizontal: 10,
          backgroundColor: withAlpha(colors.background, 0.6),
          borderWidth: 1,
          borderColor: colors.border,
          color: colors.text,
          fontFamily: fonts.medium,
          fontSize: 13,
          textAlign: 'right',
        },
        style,
      ]}
    />
  );
}

/** A muted caption inside a card. */
export function CardCaption({ children }: { children: ReactNode }) {
  return (
    <MText size={10.5} color={colors.muted} style={{ lineHeight: 15, paddingVertical: 6 }}>
      {children}
    </MText>
  );
}

/** Tile toggle used for grids of pins (`MonitorSettingsDisplayToggle`). */
export function ToggleTile({ title, value, onChange }: { title: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <PressableScale
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value }}
      onPress={() => {
        settingsFeedback();
        onChange(!value);
      }}
      style={{
        flexGrow: 1,
        flexBasis: 116,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 9,
        height: 46,
        borderRadius: 12,
        backgroundColor: withAlpha(colors.background, 0.38),
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <MText size={11.5} weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
        {title}
      </MText>
      <View style={{ transform: [{ scale: 0.86 }] }}>
        <SwitchGraphic isOn={value} />
      </View>
    </PressableScale>
  );
}
