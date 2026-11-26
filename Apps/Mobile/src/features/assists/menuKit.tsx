import { useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { MText, colors, minTouch, radius, spacing, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';

/** Settings rows for the assist inspectors (`MonitorSettingsInlineRow` & co). */

export function MenuSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, marginBottom: spacing.md }}>
      {title ? (
        <MText size={10} weight="bold" tracking={1.4} color={colors.faint} uppercase style={{ paddingTop: spacing.md }}>
          {title}
        </MText>
      ) : null}
      {children}
    </View>
  );
}

export function MenuRow({
  title,
  help,
  stacked,
  divider = true,
  children,
}: {
  title: string;
  help?: string;
  stacked?: boolean;
  divider?: boolean;
  children?: ReactNode;
}) {
  return (
    <View style={{ paddingVertical: spacing.md, borderTopWidth: divider ? 1 : 0, borderTopColor: colors.border, gap: spacing.sm }}>
      <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: spacing.sm }}>
        <MText size={13} weight="medium" style={{ flex: stacked ? undefined : 1 }}>
          {title}
        </MText>
        {children}
      </View>
      {help ? (
        <MText size={11} color={colors.muted}>
          {help}
        </MText>
      ) : null}
    </View>
  );
}

export function MenuHelp({ children }: { children: string }) {
  return (
    <MText size={12} color={colors.muted} style={{ paddingVertical: spacing.sm }}>
      {children}
    </MText>
  );
}

export function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
  title = (o) => String(o),
  accessibilityLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  title?: (o: T) => string;
  accessibilityLabel?: string;
}) {
  return (
    <View accessibilityLabel={accessibilityLabel} style={{ flexDirection: 'row', backgroundColor: colors.raised, borderRadius: radius.sm, padding: 2, gap: 2, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={String(o)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o)}
            style={{
              flexGrow: 1,
              minHeight: 36,
              minWidth: 44,
              paddingHorizontal: 10,
              borderRadius: radius.sm - 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? withAlpha(colors.accent, 0.22) : 'transparent',
              borderWidth: 1,
              borderColor: on ? colors.accent : 'transparent',
            }}
          >
            <MText size={12} weight={on ? 'semibold' : 'regular'} color={on ? colors.accent : colors.secondary}>
              {title(o)}
            </MText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      hitSlop={8}
      style={{ width: minTouch, height: 30, justifyContent: 'center' }}
    >
      <View style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: value ? colors.accent : colors.raised, borderWidth: 1, borderColor: colors.borderStrong, padding: 2 }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', transform: [{ translateX: value ? 18 : 0 }] }} />
      </View>
    </Pressable>
  );
}

export function SwitchRow({ title, help, value, onChange, divider }: { title: string; help?: string; value: boolean; onChange: (v: boolean) => void; divider?: boolean }) {
  return (
    <MenuRow title={title} help={help} divider={divider}>
      <Toggle value={value} onChange={onChange} label={title} />
    </MenuRow>
  );
}

/** Horizontal slider with a 44pt hit area. Steps to `step`. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format = (v) => String(Math.round(v)),
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  format?: (v: number) => string;
}) {
  const [width, setWidth] = useState(1);
  const startX = useRef(0);
  const live = useRef({ width, min, max, step, onChange });
  live.current = { width, min, max, step, onChange };
  const setFromX = (x: number) => {
    const { width: w, min: lo, max: hi, step: st, onChange: cb } = live.current;
    const t = Math.min(1, Math.max(0, x / Math.max(1, w)));
    const raw = lo + t * (hi - lo);
    cb(Math.round(raw / st) * st);
  };
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        startX.current = e.nativeEvent.locationX;
        setFromX(startX.current);
      },
      onPanResponderMove: (_e, g) => setFromX(startX.current + g.dx),
    }),
  ).current;
  const t = (value - min) / Math.max(1e-9, max - min);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 160, flexShrink: 1 }}>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: value, text: format(value) }}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={{ flex: 1, height: minTouch, justifyContent: 'center' }}
        {...responder.panHandlers}
      >
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: colors.raised }}>
          <View style={{ width: `${Math.min(100, Math.max(0, t * 100))}%`, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
        </View>
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: Math.min(Math.max(0, t), 1) * width - 9, width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff' }}
        />
      </View>
      <MText size={12} mono color={colors.secondary} style={{ width: 44, textAlign: 'right' }}>
        {format(value)}
      </MText>
    </View>
  );
}

export function ColorDots<T extends string>({ options, value, onChange, rgb }: { options: readonly T[]; value: T; onChange: (v: T) => void; rgb: (o: T) => [number, number, number] }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {options.map((o) => {
        const [r, g, b] = rgb(o);
        const on = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="button"
            accessibilityLabel={o}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o)}
            style={{ width: minTouch, height: minTouch, alignItems: 'center', justifyContent: 'center' }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`,
                borderWidth: on ? 2 : 1,
                borderColor: on ? colors.accent : colors.borderStrong,
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

export function TextButton({ label, onPress, tone = 'default', icon }: { label: string; onPress: () => void; tone?: 'default' | 'accent' | 'danger'; icon?: ReactNode }) {
  const fg = tone === 'accent' ? colors.accent : tone === 'danger' ? colors.recording : colors.secondary;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      style={{
        minHeight: minTouch,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.md,
        backgroundColor: tone === 'accent' ? withAlpha(colors.accent, 0.14) : colors.raised,
        borderWidth: 1,
        borderColor: tone === 'accent' ? withAlpha(colors.accent, 0.5) : colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
      }}
    >
      {icon}
      <MText size={13} weight="semibold" color={fg}>
        {label}
      </MText>
    </PressableScale>
  );
}
