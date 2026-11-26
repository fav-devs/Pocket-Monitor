import { createContext, useContext, type ReactNode } from 'react';
import { Platform, Pressable, Switch, Text, View } from 'react-native';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Icon } from '@/components/icon';
import { SheetScrollView } from '@/components/sheet';
import { TabRow } from '@/components/tab-row';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

/**
 * Building blocks for the assist option sheets, on the shared design system: a pinned TabRow, a scrolling body of
 * FieldSections, switch rows, colour swatches and short notes. Themed (the sheets follow light / dark).
 */

/** Rows a host puts at the top of every options body (Settings' live / playback switches). */
const MenuLeadContext = createContext<ReactNode>(null);
export const MenuLeadProvider = MenuLeadContext.Provider;
export function MenuLead() {
  return <>{useContext(MenuLeadContext)}</>;
}

/** The scrolling body of an options sheet (the sheet itself is `scroll={false}` so tabs can stay pinned). */
export function MenuScroll({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <SheetScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <MenuLead />
      {children}
    </SheetScrollView>
  );
}

/** A sheet's sections as words, pinned above the scrolling body. */
export function MenuTabs<T extends string>({ tabs, selected, onSelect }: { tabs: ReadonlyArray<{ id: T; label: string }>; selected: T; onSelect: (id: T) => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.tabs}>
      <TabRow tabs={tabs} selected={selected} onSelect={onSelect} />
    </View>
  );
}

/** The app's switch: primary track, white thumb (also on web, where the default thumb is teal). */
export function AppSwitch({ value, onChange, label, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
      thumbColor="#ffffff"
      {...WEB_THUMB}
    />
  );
}
const WEB_THUMB = (Platform.OS === 'web' ? { activeThumbColor: '#ffffff' } : {}) as object;

/** A labelled on/off row: 15pt title, optional one-line detail, a primary switch. */
export function SwitchRow({ title, detail, value, onChange, disabled }: { title: string; detail?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.switchRow, disabled && styles.disabled]}>
      <View style={styles.switchText}>
        <Text style={styles.switchTitle}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      <AppSwitch label={title} value={value} disabled={disabled} onChange={onChange} />
    </View>
  );
}

/** Colour choice as squircle swatches; the chosen one ringed in the foreground colour (ai-cut's Adjust swatches). */
export function Swatches<T extends string>({ options, value, onChange, rgb, label }: { options: readonly T[]; value: T; onChange: (v: T) => void; rgb: (o: T) => readonly [number, number, number]; label: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const [r, g, b] = rgb(o);
        const on = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="radio"
            accessibilityLabel={o}
            accessibilityState={{ checked: on }}
            onPress={() => onChange(o)}
            hitSlop={2}
            style={({ pressed }) => [styles.swatchCell, pressed && styles.pressed]}
          >
            <View style={[styles.swatchRing, on && styles.swatchRingOn]}>
              <View style={[styles.swatch, { backgroundColor: `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})` }]} />
            </View>
            <Text style={[styles.swatchLabel, on && styles.swatchLabelOn]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One short muted line where a label isn't enough. */
export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'success' | 'warning' }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const color = tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : colors.mutedForeground;
  return <Text style={[styles.note, { color }]}>{children}</Text>;
}

/** A text action in primary (Reset position and size). */
export function TextAction({ label, onPress, icon, tone = 'primary' }: { label: string; onPress: () => void; icon?: IconSvgElement; tone?: 'primary' | 'destructive' }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const color = tone === 'destructive' ? colors.destructive : colors.primary;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}>
      {icon ? <Icon icon={icon} size={17} color={color} strokeWidth={1.8} /> : null}
      <Text style={[styles.textActionLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** "Label ........ value" read-out row. */
export function ValueRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.valueRow}>
      <Text style={styles.valueLabel}>{label}</Text>
      <Text numberOfLines={1} style={[styles.value, accent && styles.valueAccent]}>
        {value}
      </Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    scroll: { flex: 1, minHeight: 0, overflow: 'hidden' as const },
    // The first FieldSection's hairline sits just above the top edge: the sheet header / tabs already draw one.
    scrollContent: { paddingHorizontal: spacing.md, marginTop: -1, paddingBottom: spacing.lg, gap: spacing.md },
    tabs: { paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
    switchRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md, minHeight: 44 },
    switchText: { flex: 1, minWidth: 0, gap: 2 },
    switchTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    detail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.65 },
    swatches: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.sm },
    swatchCell: { alignItems: 'center' as const, gap: 4, minWidth: 48 },
    swatchRing: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderWidth: 2.5,
      borderColor: 'transparent',
    },
    swatchRingOn: { borderColor: colors.foreground },
    swatch: { width: 34, height: 34, borderRadius: 10, borderWidth: 0.5, borderColor: colors.borderStrong },
    swatchLabel: { fontFamily: fonts.medium, fontSize: 11, color: colors.mutedForeground },
    swatchLabelOn: { color: colors.foreground },
    note: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
    textAction: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, minHeight: 44, alignSelf: 'flex-start' as const },
    textActionLabel: { fontFamily: fonts.semibold, fontSize: 14 },
    valueRow: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: spacing.md, minHeight: 28 },
    valueLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    value: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    valueAccent: { color: colors.primary },
  };
}
