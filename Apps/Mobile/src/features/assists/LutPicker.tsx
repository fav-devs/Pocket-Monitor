import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Add01Icon, CheckmarkCircle02Icon, CubeIcon, Delete02Icon, MagicWand01Icon } from '@hugeicons/core-free-icons';
import { Icon } from '@/components/icon';
import { SheetScrollView } from '@/components/sheet';
import { Slider } from '@/components/slider';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { BUILT_IN_LOOKS, LUT_EXPOSURE, evLabel, isLogTransfer, snapLutExposure, type BuiltInLook, type MonitorTransfer } from '@/core/media';
import { deleteCustomLut, pickAndImportCube, useLutVersion } from '@/features/picture/lutLibrary';
import { resolveLut, useAssists, useSourceTransfer, type LutSelection } from '@/state/assists';
import { useDesktopLuts } from '@/features/picture/desktop/luts';
import { MenuLead, MenuTabs, Note, ValueRow } from './menuKit';

const TRANSFORMS: { sel: LutSelection; title: string; short: string; curve: MonitorTransfer }[] = [
  { sel: 'transform:dlogm', title: 'D-Log M → Rec.709', short: 'D-Log M → 709', curve: 'dlogm' },
  { sel: 'transform:dlog', title: 'D-Log → Rec.709', short: 'D-Log → 709', curve: 'dlog' },
  { sel: 'transform:dlog2', title: 'D-Log2 → Rec.709', short: 'D-Log2 → 709', curve: 'dlog2' },
  { sel: 'transform:hdr', title: 'HLG → Rec.709', short: 'HLG → 709', curve: 'hdr' },
];

type Swatch = readonly [string, string, ...string[]];

/** A look's colour, drawn as the tile's picture (the looks are generated, there is no still to show). */
const LOOK_SWATCH: Record<BuiltInLook, Swatch> = {
  Mono: ['#151515', '#6b6b6b', '#e4e4e4'],
  Contrast: ['#030303', '#2a2a2a', '#d8d8d8', '#ffffff'],
  Warm: ['#4a210a', '#d9823b', '#ffe0b0'],
  Cool: ['#081f3a', '#3f86c6', '#d4ecff'],
};
const LOG_SWATCH: Swatch = ['#7f8682', '#a3a8a4'];
const REC709_SWATCH: Swatch = ['#1f4f86', '#6fa7d6', '#efb07a'];
const AUTO_SWATCH: Swatch = ['#203a5a', '#3b4ee8', '#17a9f3'];
const CUSTOM_SWATCH: Swatch = ['#2a1a3a', '#6a2d73', '#d6155f'];

type Tab = 'display' | 'creative' | 'custom';

type Tile = {
  key: string;
  name: string;
  selected: boolean;
  onPress: () => void;
  swatch?: Swatch;
  /** Two halves: log on the left, the display transform on the right. */
  split?: boolean;
  icon?: IconSvgElement;
  onDelete?: () => void;
};

/**
 * LUT catalog as a filter-browser grid: Auto and the locked display transforms, the generated looks, imported
 * `.cube`s and Import. Intensity (and input exposure for log) stay pinned under the grid.
 */
export function LutPicker() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const lut = useAssists((s) => s.options.lut);
  const lutOn = useAssists((s) => s.on.LUT);
  const set = useAssists((s) => s.setOption);
  const setOn = useAssists((s) => s.setOn);
  const { transfer } = useSourceTransfer();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(340);
  const [tab, setTab] = useState<Tab>(() => (lut.selection.startsWith('look:') ? 'creative' : lut.selection.startsWith('custom:') ? 'custom' : 'display'));
  useLutVersion();
  // Desktop backend: the drop folder, imports into it, the native pick (null elsewhere).
  const desktop = useDesktopLuts();
  const resolved = resolveLut(lut, lutOn, transfer);
  const choose = (selection: LutSelection) => {
    set('lut', { selection });
    setOn('LUT', true);
    setMessage(null);
    desktop?.select(selection);
  };
  const importCube = async () => {
    if (busy) return;
    setBusy(true);
    const r = desktop ? await desktop.importCube() : await pickAndImportCube();
    setBusy(false);
    if (r.ok) {
      setOn('LUT', true);
      setMessage(`Imported ${r.entry.name} (${r.entry.size}³).`);
    } else if (!r.canceled) setMessage(r.error ?? 'Import failed.');
  };

  const tiles: Tile[] =
    tab === 'display'
      ? [
          { key: 'auto', name: 'Auto', selected: lut.selection === 'auto', onPress: () => choose('auto'), swatch: AUTO_SWATCH, icon: MagicWand01Icon },
          ...TRANSFORMS.map((t) => ({ key: t.sel, name: t.short, selected: lut.selection === t.sel, onPress: () => choose(t.sel), split: true })),
        ]
      : tab === 'creative'
        ? BUILT_IN_LOOKS.map((l) => ({ key: l, name: l, selected: lut.selection === `look:${l}`, onPress: () => choose(`look:${l}`), swatch: LOOK_SWATCH[l] }))
        : [
            { key: 'import', name: busy ? 'Importing…' : 'Import .cube', selected: false, onPress: () => void importCube(), icon: Add01Icon },
            ...lut.custom.map((c) => ({
              key: c.id,
              name: c.name,
              selected: lut.selection === `custom:${c.id}`,
              onPress: () => choose(`custom:${c.id}`),
              swatch: CUSTOM_SWATCH,
              icon: CubeIcon,
              // A drop-folder cube is the operator's file: removed in the folder, not here.
              onDelete: desktop?.isFile(c.id) ? undefined : () => void deleteCustomLut(c.id),
            })),
          ];

  const columns = width >= 520 ? 4 : 3;
  const gap = 8;
  const tileWidth = Math.floor((width - spacing.md * 2 - (columns - 1) * gap) / columns);
  const previewHeight = Math.round(tileWidth * 0.62);
  const intensity = (v: number) => set('lut', { intensity: v / 100 });
  const exposure = (v: number) => set('lut', { exposureStops: snapLutExposure(v) });

  return (
    <View style={styles.root} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <MenuTabs
        tabs={[
          { id: 'display', label: 'Display' },
          { id: 'creative', label: 'Creative' },
          { id: 'custom', label: 'Custom' },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      <SheetScrollView key={tab} style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        <MenuLead />
        <ValueRow label="Showing" value={resolved.label} accent={lutOn} />
        <View style={[styles.grid, { gap }]}>
          {tiles.map((t) => (
            <LutTile key={t.key} tile={t} width={tileWidth} previewHeight={previewHeight} styles={styles} colors={colors} />
          ))}
        </View>
        {tab === 'custom' ? (
          <>
            {message ? <Note tone={message.startsWith('Imported') ? 'success' : 'warning'}>{message}</Note> : null}
            <Note>{desktop?.folder ? `3D .cube, up to 65³. Also read from ${desktop.folder}` : '3D .cube, up to 65³.'}</Note>
          </>
        ) : null}
      </SheetScrollView>
      <View style={styles.footer}>
        {desktop ? (
          <MenuTabs
            tabs={[
              { id: 'off', label: 'Full' },
              { id: 'across', label: 'Top half' },
              { id: 'down', label: 'Right half' },
            ]}
            selected={desktop.split}
            onSelect={desktop.setSplit}
          />
        ) : null}
        <Slider label="Intensity" value={Math.round(lut.intensity * 100)} min={0} max={100} step={5} tone="primary" resetValue={100} format={(v) => `${Math.round(v)}%`} onChange={intensity} onEnd={intensity} />
        {isLogTransfer(transfer) ? (
          <Slider
            label="Input exposure"
            value={lut.exposureStops}
            min={LUT_EXPOSURE.min}
            max={LUT_EXPOSURE.max}
            step={LUT_EXPOSURE.step}
            tone="primary"
            resetValue={0}
            origin={0}
            format={(v) => evLabel(snapLutExposure(v))}
            onChange={exposure}
            onEnd={exposure}
          />
        ) : null}
      </View>
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

function LutTile({ tile, width, previewHeight, styles, colors }: { tile: Tile; width: number; previewHeight: number; styles: Styles; colors: ThemeColors }) {
  const plain = !tile.swatch && !tile.split;
  return (
    <View style={{ width }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tile.name}
        accessibilityState={{ selected: tile.selected }}
        onPress={tile.onPress}
        style={({ pressed }) => [styles.tile, tile.selected && styles.tileSelected, pressed && styles.pressed]}
      >
        <View style={[styles.preview, { height: previewHeight }, plain && styles.previewPlain]}>
          {tile.split ? (
            <View style={styles.split}>
              <LinearGradient colors={LOG_SWATCH} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.half} />
              <LinearGradient colors={REC709_SWATCH} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.half} />
            </View>
          ) : tile.swatch ? (
            <LinearGradient colors={tile.swatch} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} />
          ) : null}
          {tile.icon ? (
            <View style={styles.tileIcon} pointerEvents="none">
              <Icon icon={tile.icon} size={22} color={plain ? colors.foreground : '#ffffff'} strokeWidth={1.7} />
            </View>
          ) : null}
          {tile.selected ? (
            <View style={styles.check}>
              <Icon icon={CheckmarkCircle02Icon} size={20} color={colors.primary} strokeWidth={2} />
            </View>
          ) : null}
        </View>
        <View style={[styles.caption, tile.selected && styles.captionSelected]}>
          <Text numberOfLines={1} style={[styles.name, tile.selected && styles.nameSelected]}>
            {tile.name}
          </Text>
        </View>
      </Pressable>
      {tile.onDelete ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${tile.name}`} onPress={tile.onDelete} hitSlop={11} style={({ pressed }) => [styles.delete, pressed && styles.pressed]}>
          <Icon icon={Delete02Icon} size={13} color="#ffffff" strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, minHeight: 0 },
    list: { flex: 1, minHeight: 0, overflow: 'hidden' as const },
    listContent: { paddingHorizontal: spacing.md, marginTop: -1, paddingTop: spacing.xs, paddingBottom: spacing.md, gap: spacing.md },
    grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const },
    tile: { borderWidth: 2, borderColor: 'transparent', borderRadius: 14, overflow: 'hidden' as const, backgroundColor: colors.surface },
    tileSelected: { borderColor: colors.primary },
    preview: { overflow: 'hidden' as const, backgroundColor: colors.surfaceStrong, alignItems: 'center' as const, justifyContent: 'center' as const },
    previewPlain: { backgroundColor: colors.surfaceStrong },
    fill: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0 },
    split: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0, flexDirection: 'row' as const },
    half: { flex: 1 },
    tileIcon: { alignItems: 'center' as const, justifyContent: 'center' as const },
    check: { position: 'absolute' as const, right: 3, top: 3, borderRadius: 20, backgroundColor: colors.background, padding: 1 },
    caption: { minHeight: 28, paddingHorizontal: 4, justifyContent: 'center' as const, alignItems: 'center' as const },
    captionSelected: { backgroundColor: colors.primarySoft },
    name: { fontFamily: fonts.medium, fontSize: 11, color: colors.foreground },
    nameSelected: { fontFamily: fonts.semibold, color: colors.primary },
    delete: {
      position: 'absolute' as const,
      left: 6,
      top: 6,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pressed: { opacity: 0.72 },
    footer: {
      paddingHorizontal: spacing.md + 2,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
      gap: spacing.sm,
      borderTopWidth: 0.5,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
    },
  };
}
