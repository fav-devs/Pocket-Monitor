import {
  Add01Icon,
  CheckmarkCircle02Icon,
  CubeIcon,
  Delete02Icon,
  Edit02Icon,
  SlidersHorizontalIcon,
  Tick02Icon,
  Upload04Icon,
} from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { FieldSection } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { Sheet } from '@/components/sheet';
import { Squircle } from '@/components/squircle';
import { TextField } from '@/components/text-field';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import {
  ASPECTS,
  exportLabel,
  exportOverall,
  exportRunning,
  hasAudio,
  isIdentity,
  lookById,
  outputSize,
  LOW_RES_LONG_SIDE,
  type ClipEdit,
  type EditPreset,
  type ExportQuality,
  type Size,
} from '@/core/edit';
import { deleteCustomLut, pickAndImportCube } from '@/features/picture/lutLibrary';
import { useAssists } from '@/state/assists';
import { useClipEdits } from '@/state/clipEdits';
import { useEditExport } from './exporter';

/** A row in an edit sheet: icon well, title + meta, trailing actions; the row body is one press. */
function ListRow({
  icon,
  title,
  meta,
  selected,
  onPress,
  accessibilityLabel,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['icon'];
  title: string;
  meta?: string;
  selected?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ selected: !!selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}
      >
        <Squircle width={36} height={36} radius={11} color={selected ? colors.ink : colors.surfaceStrong}>
          <Icon icon={selected ? CheckmarkCircle02Icon : icon} size={18} color={selected ? colors.inkForeground : colors.foreground} strokeWidth={1.7} />
        </Squircle>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {title}
          </Text>
          {meta ? (
            <Text numberOfLines={1} style={styles.rowMeta}>
              {meta}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {children}
    </View>
  );
}

function IconAction({ icon, label, onPress, destructive }: { icon: Parameters<typeof Icon>[0]['icon']; label: string; onPress: () => void; destructive?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      <Icon icon={icon} size={20} color={destructive ? colors.destructive : colors.mutedForeground} strokeWidth={1.7} />
    </Pressable>
  );
}

/** Rename in place: a field with a tick. */
function RenameRow({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const styles = useThemedStyles(createStyles);
  const [name, setName] = useState(initial);
  return (
    <View style={[styles.row, { gap: spacing.xs }]}>
      <TextField
        value={name}
        onChangeText={setName}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => onDone(name)}
        accessibilityLabel="Name"
        style={{ flex: 1, minHeight: 44 }}
      />
      <IconAction icon={Tick02Icon} label="Save name" onPress={() => onDone(name)} />
    </View>
  );
}

// ───────────────────────────── LUT Hub ─────────────────────────────

/** LUT Hub: imported `.cube` LUTs to apply to this clip; import, rename, delete. */
export function LutHubSheet({ visible, onClose, applied, onApply }: { visible: boolean; onClose: () => void; applied: string | null; onApply: (id: string | null) => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const luts = useAssists((s) => s.options.lut.custom);
  const rename = useAssists((s) => s.renameCustomLut);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) {
      setRenaming(null);
      setError(null);
    }
  }, [visible]);

  const importOne = async () => {
    setBusy(true);
    setError(null);
    const r = await pickAndImportCube({ select: false });
    setBusy(false);
    if (r.ok) onApply(r.entry.id);
    else if (!r.canceled) setError(r.error ?? 'That file is not a 3D .cube LUT.');
  };

  return (
    <Sheet
      visible={visible}
      title="LUT Hub"
      onClose={onClose}
      action={<Button title="Import" icon={Add01Icon} variant="ghost" loading={busy} onPress={() => void importOne()} />}
    >
      {error ? <Text style={[styles.muted, { color: colors.destructive }]}>{error}</Text> : null}
      {luts.length === 0 ? (
        <View style={styles.empty}>
          <Squircle width={56} height={56} radius={18} color={colors.surface}>
            <Icon icon={CubeIcon} size={26} color={colors.foreground} strokeWidth={1.5} />
          </Squircle>
          <Text style={styles.emptyTitle}>No LUTs yet</Text>
          <Text style={styles.muted}>Import a .cube file.</Text>
          <Button title="Import .cube" icon={Add01Icon} loading={busy} onPress={() => void importOne()} />
        </View>
      ) : (
        <View style={styles.card}>
          {luts.map((l, i) =>
            renaming === l.id ? (
              <RenameRow
                key={l.id}
                initial={l.name}
                onDone={(name) => {
                  if (name) rename(l.id, name);
                  setRenaming(null);
                }}
              />
            ) : (
              <View key={l.id} style={i < luts.length - 1 ? styles.divider : undefined}>
                <ListRow icon={CubeIcon} title={l.name} meta={`${l.size}³`} selected={applied === l.id} onPress={() => onApply(applied === l.id ? null : l.id)}>
                  <IconAction icon={Edit02Icon} label={`Rename ${l.name}`} onPress={() => setRenaming(l.id)} />
                  <IconAction
                    icon={Delete02Icon}
                    label={`Delete ${l.name}`}
                    destructive
                    onPress={() => {
                      if (applied === l.id) onApply(null);
                      void deleteCustomLut(l.id);
                    }}
                  />
                </ListRow>
              </View>
            ),
          )}
        </View>
      )}
    </Sheet>
  );
}

// ───────────────────────────── Editing Preset ─────────────────────────────

export function presetSummary(p: EditPreset, lutName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (p.look) parts.push(lookById(p.look)?.name ?? 'Look');
  if (p.lut) parts.push(lutName?.(p.lut) ?? 'LUT');
  if (p.aspect !== 'original') parts.push(ASPECTS.find((a) => a.id === p.aspect)?.label ?? p.aspect);
  if (p.rotation) parts.push(`${p.rotation}°`);
  if (p.flipH) parts.push('Mirror');
  if (p.flipV) parts.push('Flip');
  if (Math.abs(p.volume - 1) > 0.001) parts.push(p.volume === 0 ? 'Muted' : `${Math.round(p.volume * 100)}%`);
  return parts.join(' · ') || 'No changes';
}

/** Editing Preset: save this clip's look as a preset; apply, rename or delete presets. */
export function PresetSheet({ visible, onClose, edit, onApply }: { visible: boolean; onClose: () => void; edit: ClipEdit; onApply: (preset: EditPreset) => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const presets = useClipEdits((s) => s.presets);
  const save = useClipEdits((s) => s.savePreset);
  const rename = useClipEdits((s) => s.renamePreset);
  const remove = useClipEdits((s) => s.deletePreset);
  const luts = useAssists((s) => s.options.lut.custom);
  const lutName = (id: string) => luts.find((l) => l.id === id)?.name;
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) {
      setName('');
      setRenaming(null);
    }
  }, [visible]);
  const nothing = isIdentity({ ...edit, trim: null });

  return (
    <Sheet visible={visible} title="Editing Preset" onClose={onClose}>
      <FieldSection title="Save this edit">
        <View style={{ flexDirection: 'row', gap: spacing.xs, alignItems: 'center' }}>
          <TextField value={name} onChangeText={setName} placeholder="Name" accessibilityLabel="Preset name" style={{ flex: 1 }} returnKeyType="done" />
          <Button
            title="Save"
            disabled={nothing}
            onPress={() => {
              save(name, edit);
              setName('');
            }}
          />
        </View>
      </FieldSection>
      {presets.length ? (
        <FieldSection title="Presets">
          <View style={styles.card}>
            {presets.map((p, i) =>
              renaming === p.id ? (
                <RenameRow
                  key={p.id}
                  initial={p.name}
                  onDone={(n) => {
                    if (n) rename(p.id, n);
                    setRenaming(null);
                  }}
                />
              ) : (
                <View key={p.id} style={i < presets.length - 1 ? styles.divider : undefined}>
                  <ListRow icon={SlidersHorizontalIcon} title={p.name} meta={presetSummary(p, lutName)} accessibilityLabel={`Apply ${p.name}`} onPress={() => onApply(p)}>
                    <IconAction icon={Edit02Icon} label={`Rename ${p.name}`} onPress={() => setRenaming(p.id)} />
                    <IconAction icon={Delete02Icon} label={`Delete ${p.name}`} destructive onPress={() => remove(p.id)} />
                  </ListRow>
                </View>
              ),
            )}
          </View>
        </FieldSection>
      ) : (
        <Text style={[styles.muted, { color: colors.mutedForeground, paddingBottom: spacing.md }]}>No presets yet.</Text>
      )}
    </Sheet>
  );
}

// ───────────────────────────── Export ─────────────────────────────

export function ExportSheet({
  visible,
  onClose,
  edit,
  sourceSize,
  hdrSource,
  lowResAvailable,
  originalOnPhone,
  onExport,
}: {
  visible: boolean;
  onClose: () => void;
  edit: ClipEdit;
  sourceSize: Size;
  hdrSource: boolean;
  lowResAvailable: boolean;
  originalOnPhone: boolean;
  onExport: (quality: ExportQuality) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const job = useEditExport();
  const [quality, setQuality] = useState<ExportQuality>('original');
  useEffect(() => {
    if (!lowResAvailable && quality === 'low-res') setQuality('original');
  }, [lowResAvailable, quality]);
  const running = exportRunning(job);
  const finished = job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled';
  const size = outputSize(sourceSize, edit.rotation, edit.crop, quality === 'low-res' ? LOW_RES_LONG_SIDE : undefined);
  const rows: [string, string][] = [
    ['Size', `${size.width} × ${size.height}`],
    ['Source', quality === 'low-res' ? 'Low-Res copy' : originalOnPhone ? 'Original on this phone' : 'Original (downloads first)'],
  ];
  if (hdrSource) rows.push(['HDR', edit.hdr === 'keep' ? 'Kept' : 'SDR']);
  if (hasAudio(edit)) rows.push(['Audio', edit.volume === 0 ? 'Muted' : `${Math.round(edit.volume * 100)}%`]);
  if (edit.trim) rows.push(['Length', `${(edit.trim.end - edit.trim.start).toFixed(1)} s`]);

  const close = () => {
    if (!running) job.dismiss();
    onClose();
  };

  return (
    <Sheet visible={visible} title="Export" onClose={close} expandable={false}>
      {running || finished ? (
        <View style={{ gap: spacing.sm, paddingBottom: spacing.md }}>
          <Text style={[styles.rowTitle, job.phase === 'failed' && { color: colors.destructive }]}>{exportLabel(job)}</Text>
          <View style={styles.track}>
            <View style={[styles.bar, { width: `${Math.round(exportOverall(job) * 100)}%` }]} />
          </View>
          {running ? (
            <Button title="Cancel" variant="secondary" onPress={job.cancel} />
          ) : (
            <View style={{ gap: spacing.xs }}>
              {job.phase !== 'done' ? <Button title="Try again" onPress={() => (job.dismiss(), onExport(quality))} /> : null}
              <Button title="Done" variant={job.phase === 'done' ? 'primary' : 'ghost'} onPress={close} />
            </View>
          )}
        </View>
      ) : (
        <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
          {lowResAvailable ? (
            <SegmentedControl
              options={[
                { value: 'original', label: 'Original' },
                { value: 'low-res', label: 'Low-Res' },
              ]}
              value={quality}
              onChange={setQuality}
            />
          ) : null}
          <View style={styles.card}>
            {rows.map(([k, v], i) => (
              <View key={k} style={[styles.infoRow, i < rows.length - 1 && styles.divider]}>
                <Text style={styles.infoKey}>{k}</Text>
                <Text style={styles.infoValue}>{v}</Text>
              </View>
            ))}
          </View>
          <Button title="Export" icon={Upload04Icon} size="lg" onPress={() => onExport(quality)} />
        </View>
      )}
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const, marginBottom: spacing.sm },
    divider: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 56, paddingLeft: spacing.md, paddingRight: spacing.xs },
    rowMain: { flex: 1, minWidth: 0, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingVertical: 10 },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
    muted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground },
    empty: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.lg },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 20, color: colors.foreground },
    infoRow: { flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 46, paddingHorizontal: spacing.md },
    infoKey: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, width: 96 },
    infoValue: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.foreground, textAlign: 'right' as const },
    track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceStrong, overflow: 'hidden' as const },
    bar: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  };
}
