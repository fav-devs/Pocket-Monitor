import {
  Add01Icon,
  Delete02Icon,
  FilterHorizontalIcon,
  Flag02Icon,
  PencilEdit01Icon,
  StopCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { Button } from '@/components/button';
import { Chip } from '@/components/chip';
import { ChipRow, FieldSection } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { Sheet } from '@/components/sheet';
import { TextField } from '@/components/text-field';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import {
  type ClipMarker,
  type ExportClip,
  MARKER_COLORS,
  MARKER_EXPORT_FORMATS,
  MARKER_SWATCH,
  type MarkerExportFormat,
  colorForTag,
  exportFileName,
  exportMarkers,
  markerClock,
  markerTitle,
  newId,
  orderedShoots,
  shootFolder,
  tagKey,
  toastTags,
} from '@/core/markers';
import { metaKeyOf, metaOf, useClipMeta, useClipMetaFor } from '@/state/clipMeta';
import { useMediaPreferences } from '@/state/media';
import { saveExport } from './sidecarFiles';

// ───────────────────────────── Shoots ─────────────────────────────

/**
 * Shoots: start one (name + optional folder path), make one active, rename, end. In `pick`
 * mode the rows choose a shoot for clips instead (Move to shoot).
 */
export function ShootSheet({
  visible,
  onClose,
  mode = 'manage',
  pickedId,
  onPick,
  onFilter,
}: {
  visible: boolean;
  onClose: () => void;
  mode?: 'manage' | 'pick';
  pickedId?: string | null;
  onPick?: (shootId: string | null) => void;
  /** Manage mode: show only this shoot's clips (the library). */
  onFilter?: (shootId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const shoots = useClipMeta((s) => s.shoots);
  const activeId = useClipMeta((s) => s.activeShootId);
  const store = useClipMeta.getState;
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editFolder, setEditFolder] = useState('');
  useEffect(() => {
    if (!visible) {
      setEditing(null);
      setName('');
      setFolder('');
    }
  }, [visible]);
  const list = orderedShoots(shoots, activeId);
  const pick = mode === 'pick';

  const create = () => {
    const shoot = store().startShoot(name, folder, !pick);
    setName('');
    setFolder('');
    if (pick) {
      onPick?.(shoot.id);
      onClose();
    }
  };

  return (
    <Sheet visible={visible} title={pick ? 'Move to shoot' : 'Shoots'} onClose={onClose}>
      <View style={styles.list}>
        {pick ? (
          <Row title="No shoot" selected={pickedId === null} onPress={() => (onPick?.(null), onClose())} />
        ) : null}
        {list.map((s) =>
          editing === s.id ? (
            <View key={s.id} style={styles.editBox}>
              <TextField value={editName} onChangeText={setEditName} placeholder="Name" accessibilityLabel="Shoot name" maxLength={60} />
              <TextField value={editFolder} onChangeText={setEditFolder} placeholder="Folder" accessibilityLabel="Folder path" autoCorrect={false} maxLength={200} />
              <View style={styles.buttons}>
                <Button title="Cancel" variant="secondary" onPress={() => setEditing(null)} style={styles.flex} />
                <Button
                  title="Save"
                  onPress={() => {
                    store().editShoot(s.id, { name: editName, folderPath: editFolder });
                    setEditing(null);
                  }}
                  style={styles.flex}
                />
              </View>
            </View>
          ) : (
            <Row
              key={s.id}
              title={s.name}
              detail={[shootFolder(s) !== s.name ? shootFolder(s) : null, !pick && s.id === activeId ? 'Active' : s.endedAt ? 'Ended' : null].filter(Boolean).join(' · ')}
              selected={pick ? pickedId === s.id : s.id === activeId}
              onPress={() => {
                if (pick) {
                  onPick?.(s.id);
                  onClose();
                } else store().setActiveShoot(s.id === activeId ? null : s.id);
              }}
              trailing={
                pick ? null : (
                  <>
                    {onFilter ? <RowIcon icon={FilterHorizontalIcon} label={`Show ${s.name}`} onPress={() => (onFilter(s.id), onClose())} /> : null}
                    <RowIcon
                      icon={PencilEdit01Icon}
                      label={`Rename ${s.name}`}
                      onPress={() => {
                        setEditing(s.id);
                        setEditName(s.name);
                        setEditFolder(s.folderPath);
                      }}
                    />
                    {s.id === activeId ? <RowIcon icon={StopCircleIcon} label={`End ${s.name}`} color={colors.destructive} onPress={() => store().endShoot(s.id)} /> : null}
                  </>
                )
              }
            />
          ),
        )}
      </View>
      <View style={[styles.form, list.length > 0 && styles.formAfterList]}>
        <TextField value={name} onChangeText={setName} placeholder="Name" accessibilityLabel="Shoot name" returnKeyType="next" maxLength={60} />
        <TextField
          value={folder}
          onChangeText={setFolder}
          placeholder="Folder (Vlog/Tokyo/Day 2)"
          accessibilityLabel="Folder path"
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={200}
          onSubmitEditing={create}
        />
        <Button title={pick ? 'New shoot' : 'Start shoot'} icon={Add01Icon} onPress={create} />
      </View>
    </Sheet>
  );
}

function Row({ title, detail, selected, onPress, trailing, swatch }: { title: string; detail?: string; selected?: boolean; onPress: () => void; trailing?: React.ReactNode; swatch?: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected: !!selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.rowPress, pressed && { backgroundColor: colors.surface }]}
      >
        {swatch ? <View style={[styles.swatchDot, { backgroundColor: swatch }]} /> : null}
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {title}
          </Text>
          {detail ? (
            <Text numberOfLines={1} style={styles.rowDetail}>
              {detail}
            </Text>
          ) : null}
        </View>
        {selected ? <Icon icon={Tick02Icon} size={20} color={colors.primary} /> : null}
      </Pressable>
      {trailing}
    </View>
  );
}

function RowIcon({ icon, label, onPress, color }: { icon: typeof Tick02Icon; label: string; onPress: () => void; color?: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.rowIcon, pressed && { opacity: 0.6 }]}>
      <Icon icon={icon} size={19} color={color ?? colors.mutedForeground} />
    </Pressable>
  );
}

// ───────────────────────────── Tags ─────────────────────────────

/** Tags to choose from: the built-ins, the operator's own, and any in `extra`; plus a field for a new one. */
export function TagChooser({ selected, onToggle, extra = [] }: { selected: string[]; onToggle: (tag: string) => void; extra?: string[] }) {
  const styles = useThemedStyles(createStyles);
  const userTags = useClipMeta((s) => s.userTags);
  const [draft, setDraft] = useState('');
  const tags = useMemo(() => {
    const out = toastTags(userTags);
    for (const t of [...extra, ...selected]) if (!out.some((x) => tagKey(x) === tagKey(t))) out.push(t);
    return out;
  }, [userTags, extra, selected]);
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    useClipMeta.getState().addUserTag(t);
    if (!selected.some((x) => tagKey(x) === tagKey(t))) onToggle(t);
    setDraft('');
  };
  return (
    <View style={styles.tagBox}>
      <ChipRow>
        {tags.map((t) => (
          <Chip key={t} label={t} selected={selected.some((x) => tagKey(x) === tagKey(t))} onPress={() => onToggle(t)} />
        ))}
      </ChipRow>
      <View style={styles.addRow}>
        <TextField value={draft} onChangeText={setDraft} placeholder="New tag" accessibilityLabel="New tag" maxLength={32} onSubmitEditing={add} returnKeyType="done" style={styles.flex} />
        <Button title="Add" variant="secondary" onPress={add} disabled={!draft.trim()} />
      </View>
    </View>
  );
}

/** Tags for several clips at once (the library's selection): a tag on all of them, or off all. */
export function TagSheet({ visible, items, onClose }: { visible: boolean; items: CameraMediaItem[]; onClose: () => void }) {
  const clips = useClipMeta((s) => s.clips);
  const onAll = useMemo(() => {
    if (!items.length) return [];
    const first = metaOf(clips, items[0])?.tags ?? [];
    return first.filter((t) => items.every((i) => (metaOf(clips, i)?.tags ?? []).some((x) => tagKey(x) === tagKey(t))));
  }, [clips, items]);
  const toggle = (tag: string) => {
    const on = onAll.some((x) => tagKey(x) === tagKey(tag));
    const store = useClipMeta.getState();
    for (const item of items) {
      const tags = metaOf(store.clips, item)?.tags ?? [];
      const has = tags.some((x) => tagKey(x) === tagKey(tag));
      if (on ? has : !has) useClipMeta.getState().toggleClipTag(item, tag);
    }
  };
  return (
    <Sheet visible={visible} title={items.length === 1 ? 'Tags' : `Tags · ${items.length} clips`} onClose={onClose}>
      <TagChooser selected={onAll} onToggle={toggle} />
    </Sheet>
  );
}

// ───────────────────────────── Markers ─────────────────────────────

/** A marker's label, tag and colour, or delete it. */
export function MarkerEditSheet({
  visible,
  marker,
  index,
  onClose,
  onChange,
  onDelete,
}: {
  visible: boolean;
  marker: ClipMarker | null;
  index: number;
  onClose: () => void;
  onChange: (patch: Partial<Omit<ClipMarker, 'id'>>) => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [label, setLabel] = useState(marker?.label ?? '');
  useEffect(() => setLabel(marker?.label ?? ''), [marker?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    if (marker && label !== marker.label) onChange({ label: label.trim() });
    onClose();
  };
  return (
    <Sheet
      visible={visible && !!marker}
      title={marker ? `${markerTitle(marker, index)} · ${markerClock(marker.time)}` : 'Marker'}
      onClose={close}
      footer={
        <View style={styles.footer}>
          <Button title="Delete" icon={Delete02Icon} variant="secondary" destructive onPress={() => (onDelete(), onClose())} style={styles.flex} />
          <Button title="Done" onPress={close} style={styles.flex} />
        </View>
      }
    >
      {marker ? (
        <View style={styles.sections}>
          <FieldSection title="Label">
            <TextField value={label} onChangeText={setLabel} placeholder="Label" accessibilityLabel="Marker label" maxLength={200} onSubmitEditing={close} returnKeyType="done" />
          </FieldSection>
          <FieldSection title="Tag">
            <TagChooser
              selected={marker.tag ? [marker.tag] : []}
              onToggle={(t) => {
                const next = marker.tag && tagKey(marker.tag) === tagKey(t) ? null : t;
                onChange({ tag: next, color: colorForTag(next) });
              }}
            />
          </FieldSection>
          <FieldSection title="Colour">
            <View style={styles.swatches}>
              {MARKER_COLORS.map((c) => (
                <Pressable
                  key={c}
                  accessibilityRole="radio"
                  accessibilityLabel={c}
                  accessibilityState={{ checked: marker.color === c }}
                  onPress={() => onChange({ color: c })}
                  style={[styles.swatch, { backgroundColor: MARKER_SWATCH[c] }, marker.color === c && { borderColor: colors.foreground }]}
                />
              ))}
            </View>
          </FieldSection>
        </View>
      ) : null}
    </Sheet>
  );
}

/**
 * A clip's metadata in playback (the Markers sheet) and the desktop inspector: markers (tap to
 * seek, hold to edit, add at the playhead), tags, notes and the shoot.
 */
export function ClipMetaBody({
  item,
  position,
  onSeek,
  compact,
}: {
  item: CameraMediaItem;
  /** The playhead (seconds), for "Add marker". */
  position: number;
  onSeek: (seconds: number) => void;
  /** The inspector: no add button title line breaks, tighter spacing. */
  compact?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const meta = useClipMetaFor(item);
  const shoots = useClipMeta((s) => s.shoots);
  const markers = meta?.markers ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [shootOpen, setShootOpen] = useState(false);
  const [notes, setNotes] = useState(meta?.notes ?? '');
  useEffect(() => setNotes(meta?.notes ?? ''), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = () => metaKeyOf(useClipMeta.getState().clips, item);
  const ref = () => ({ kind: 'clip' as const, itemId: key() });
  const saveNotes = () => {
    if ((meta?.notes ?? '') !== notes) useClipMeta.getState().setNotes(item, notes);
  };
  // Notes are saved when the field loses focus, and when the clip changes or the body closes.
  const pending = useRef({ item, notes });
  pending.current = { item, notes };
  useEffect(
    () => () => {
      const { item: it, notes: n } = pending.current;
      if ((metaOf(useClipMeta.getState().clips, it)?.notes ?? '') !== n) useClipMeta.getState().setNotes(it, n);
    },
    [item.id],
  );
  const shoot = shoots.find((s) => s.id === meta?.shootId) ?? null;
  const editingMarker = markers.find((m) => m.id === editing) ?? null;
  const add = () => {
    const now = Date.now();
    const marker: ClipMarker = { id: newId('m', now), time: Math.max(0, position), label: '', tag: null, color: colorForTag(null), createdAt: now, source: 'playback' };
    useClipMeta.getState().addMarker(ref(), marker, item);
  };

  return (
    <View style={[styles.sections, compact && styles.compact]}>
      <FieldSection title={markers.length ? `Markers · ${markers.length}` : 'Markers'}>
        <View>
          {markers.map((m, i) => (
            <View key={m.id} style={styles.row}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${markerTitle(m, i)} at ${markerClock(m.time)}`}
                accessibilityHint="Hold to edit"
                onPress={() => onSeek(m.time)}
                onLongPress={() => setEditing(m.id)}
                delayLongPress={350}
                style={({ pressed }) => [styles.markerRow, pressed && { backgroundColor: colors.surface }]}
              >
                <View style={[styles.swatchDot, { backgroundColor: MARKER_SWATCH[m.color] }]} />
                <Text numberOfLines={1} style={styles.markerTitle}>
                  {markerTitle(m, i)}
                </Text>
                {m.tag && m.label ? (
                  <Text numberOfLines={1} style={styles.markerTag}>
                    {m.tag}
                  </Text>
                ) : null}
                <Text style={styles.markerTime}>{markerClock(m.time)}</Text>
              </Pressable>
              <RowIcon icon={PencilEdit01Icon} label={`Edit ${markerTitle(m, i)}`} onPress={() => setEditing(m.id)} />
            </View>
          ))}
          <Button title={`Add marker at ${markerClock(position)}`} icon={Flag02Icon} variant="secondary" onPress={add} style={styles.addButton} />
        </View>
      </FieldSection>
      <FieldSection title="Tags">
        <TagChooser selected={meta?.tags ?? []} onToggle={(t) => useClipMeta.getState().toggleClipTag(item, t)} />
      </FieldSection>
      <FieldSection title="Notes">
        <TextField value={notes} onChangeText={setNotes} onBlur={saveNotes} placeholder="Notes" accessibilityLabel="Notes" multiline maxLength={4000} style={styles.notes} />
      </FieldSection>
      <FieldSection title="Shoot">
        <Row title={shoot ? shoot.name : 'No shoot'} detail={shoot ? shootFolder(shoot) : undefined} onPress={() => setShootOpen(true)} swatch={undefined} />
      </FieldSection>
      <MarkerEditSheet
        visible={editing != null}
        marker={editingMarker}
        index={Math.max(0, markers.findIndex((m) => m.id === editing))}
        onClose={() => setEditing(null)}
        onChange={(patch) => editing && useClipMeta.getState().updateMarker(ref(), editing, patch)}
        onDelete={() => editing && useClipMeta.getState().removeMarker(ref(), editing)}
      />
      <ShootSheet visible={shootOpen} mode="pick" pickedId={meta?.shootId ?? null} onClose={() => setShootOpen(false)} onPick={(id) => useClipMeta.getState().setShoot([item], id)} />
    </View>
  );
}

// ───────────────────────────── Export markers ─────────────────────────────

/** "Export markers" for a selection: FCPXML, Resolve EDL / CSV, Premiere CSV. */
export function ExportMarkersSheet({ visible, items, onClose, onDone }: { visible: boolean; items: CameraMediaItem[]; onClose: () => void; onDone: (message: string) => void }) {
  const styles = useThemedStyles(createStyles);
  const clips = useClipMeta((s) => s.clips);
  const shoots = useClipMeta((s) => s.shoots);
  const ratings = useMediaPreferences((s) => s.ratings);
  const exportClips: ExportClip[] = useMemo(
    () =>
      items
        .filter((i) => i.kind === 'video')
        .map((i) => {
          const m = metaOf(clips, i);
          return {
            identity: { ...(m?.identity ?? {}), fileName: i.fileName, createdAt: i.createdAt, durationSec: i.durationSec, fps: i.fps, width: i.width, height: i.height },
            markers: m?.markers ?? [],
            tags: m?.tags ?? [],
            rating: ratings[i.id] ?? 0,
            favorite: i.favorite,
            notes: m?.notes ?? '',
            shootName: shoots.find((s) => s.id === m?.shootId)?.name,
          };
        }),
    [items, clips, shoots, ratings],
  );
  const count = exportClips.reduce((n, c) => n + c.markers.length, 0);
  const run = (format: MarkerExportFormat) => {
    const f = MARKER_EXPORT_FORMATS.find((x) => x.id === format)!;
    const text = exportMarkers(format, exportClips);
    onClose();
    saveExport(exportFileName(format, exportClips), text, f.mimeType)
      .then(onDone)
      .catch((e: unknown) => onDone(e instanceof Error ? e.message : 'Could not export the markers.'));
  };
  return (
    <Sheet visible={visible} title={`Export markers · ${count}`} onClose={onClose} expandable={false}>
      {count === 0 ? <Text style={styles.muted}>No markers on these clips.</Text> : null}
      <View>
        {MARKER_EXPORT_FORMATS.map((f) => (
          <Row key={f.id} title={f.label} detail={`.${f.extension}`} onPress={() => run(f.id)} />
        ))}
      </View>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    flex: { flex: 1 },
    form: { gap: spacing.sm, paddingBottom: spacing.md },
    formAfterList: { paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
    list: { paddingBottom: spacing.sm },
    sections: { gap: spacing.md, paddingBottom: spacing.sm },
    compact: { gap: spacing.sm },
    footer: { flexDirection: 'row' as const, gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
    buttons: { flexDirection: 'row' as const, gap: spacing.sm },
    editBox: { gap: spacing.sm, paddingVertical: spacing.sm },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const },
    rowPress: {
      flex: 1,
      minHeight: 48,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowDetail: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    rowIcon: { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    tagBox: { gap: spacing.sm },
    addRow: { flexDirection: 'row' as const, gap: spacing.sm, alignItems: 'center' as const },
    swatches: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 10 },
    swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 3, borderColor: 'transparent' },
    swatchDot: { width: 10, height: 10, borderRadius: 5 },
    markerRow: { flex: 1, minHeight: 44, flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
    markerTitle: { flex: 1, minWidth: 0, fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    markerTag: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    markerTime: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    addButton: { marginTop: spacing.xs },
    notes: { minHeight: 84, paddingTop: 12, textAlignVertical: 'top' as const },
    muted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, paddingBottom: spacing.sm },
  };
}
