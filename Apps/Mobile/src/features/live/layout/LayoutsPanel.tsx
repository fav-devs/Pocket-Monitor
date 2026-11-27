import { Add01Icon, Copy01Icon, DashboardSquareEditIcon, Delete02Icon, PencilEdit02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/icon';
import { monitorPanel as P } from '@/constants/monitor';
import { fonts, useThemedStyles } from '@/constants/theme';
import { haptics } from '../haptics';
import { PanelRow, RowValue } from '../panel/kit';
import { beginLayoutEdit } from './LayoutEditor';
import { useActiveLayoutName, useLiveLayouts } from './layoutStore';

/** General tab rows: the active layout (opens the list) and Edit layout. */
export function LayoutRows({ onOpenLayouts }: { onOpenLayouts: () => void }) {
  const name = useActiveLayoutName();
  return (
    <>
      <PanelRow testID="monitor.general.layouts" title="Layout" onPress={onOpenLayouts}>
        <RowValue value={name} />
      </PanelRow>
      <PanelRow
        testID="monitor.general.editLayout"
        title="Edit layout"
        icon={DashboardSquareEditIcon}
        onPress={beginLayoutEdit}
      />
    </>
  );
}

/**
 * The layouts page (General › Layout): tap one to switch; save the current one as new, rename,
 * duplicate or delete the active one. One layout is always active and the last never goes.
 */
export function LayoutsPanel({ onEdit }: { onEdit: () => void }) {
  const styles = useThemedStyles(createStyles);
  const layouts = useLiveLayouts((s) => s.layouts);
  const activeId = useLiveLayouts((s) => s.activeId);
  const store = useLiveLayouts.getState;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const active = layouts.find((l) => l.id === activeId) ?? layouts[0];

  const commitRename = () => {
    if (renaming) store().rename(renaming, draft);
    setRenaming(null);
  };

  return (
    <>
      <View accessibilityRole="radiogroup">
        {layouts.map((l) => {
          const on = l.id === active.id;
          if (renaming === l.id) {
            return (
              <View key={l.id} style={[styles.row, styles.rowLine]}>
                <TextInput
                  testID="monitor.layouts.name"
                  accessibilityLabel="Layout name"
                  autoFocus
                  value={draft}
                  onChangeText={setDraft}
                  onSubmitEditing={commitRename}
                  onBlur={commitRename}
                  returnKeyType="done"
                  maxLength={32}
                  selectTextOnFocus
                  style={styles.input}
                  placeholderTextColor={P.faint}
                />
                <Pressable accessibilityRole="button" accessibilityLabel="Save name" onPress={commitRename} style={styles.key}>
                  <Icon icon={Tick02Icon} size={20} color={P.chosen} strokeWidth={2} />
                </Pressable>
              </View>
            );
          }
          return (
            <Pressable
              key={l.id}
              testID={`monitor.layouts.${l.id}`}
              accessibilityRole="radio"
              accessibilityLabel={l.name}
              accessibilityState={{ selected: on }}
              onPress={() => {
                haptics.selection();
                store().switchTo(l.id);
              }}
              onLongPress={() => {
                setDraft(l.name);
                setRenaming(l.id);
              }}
              style={({ pressed }) => [styles.row, styles.rowLine, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={[styles.name, on && styles.nameOn]}>
                {l.name}
              </Text>
              {on ? <Icon icon={Tick02Icon} size={20} color={P.chosen} strokeWidth={2} /> : null}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.gap} />
      <PanelRow testID="monitor.layouts.edit" icon={DashboardSquareEditIcon} title="Edit layout" onPress={() => {
        onEdit();
        beginLayoutEdit();
      }} />
      <PanelRow testID="monitor.layouts.save" icon={Add01Icon} title="Save as new" onPress={() => store().saveAsNew()} />
      <PanelRow
        testID="monitor.layouts.rename"
        icon={PencilEdit02Icon}
        title="Rename"
        onPress={() => {
          setDraft(active.name);
          setRenaming(active.id);
        }}
      />
      <PanelRow testID="monitor.layouts.duplicate" icon={Copy01Icon} title="Duplicate" onPress={() => store().duplicate(active.id)} />
      <PanelRow
        testID="monitor.layouts.delete"
        icon={Delete02Icon}
        title="Delete"
        disabled={layouts.length < 2}
        last
        onPress={() => store().remove(active.id)}
      />
    </>
  );
}

/** A compact switcher: the saved layouts as chips (the settings panel's quick switch). */
export function LayoutChips() {
  const styles = useThemedStyles(createStyles);
  const layouts = useLiveLayouts((s) => s.layouts);
  const activeId = useLiveLayouts((s) => s.activeId);
  if (layouts.length < 2) return null;
  return (
    <View accessibilityRole="radiogroup" style={styles.chips}>
      {layouts.map((l) => {
        const on = l.id === activeId;
        return (
          <Pressable
            key={l.id}
            accessibilityRole="radio"
            accessibilityLabel={`Layout ${l.name}`}
            accessibilityState={{ selected: on }}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => {
              haptics.selection();
              useLiveLayouts.getState().switchTo(l.id);
            }}
            style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
          >
            <Text numberOfLines={1} style={[styles.chipText, on && styles.chipTextOn]}>
              {l.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles() {
  return {
    row: { minHeight: 48, flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 16, gap: 10 },
    rowLine: { borderBottomWidth: 1, borderBottomColor: P.hairline },
    name: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: P.text },
    nameOn: { fontFamily: fonts.semibold, color: P.chosen },
    input: {
      flex: 1,
      height: 36,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: P.wellStrong,
      color: P.text,
      fontFamily: fonts.medium,
      fontSize: 15,
    },
    key: { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
    chip: { height: 32, paddingHorizontal: 12, borderRadius: 999, justifyContent: 'center' as const, backgroundColor: P.well },
    chipOn: { backgroundColor: '#ffffff' },
    chipText: { fontFamily: fonts.semibold, fontSize: 13, color: P.text, maxWidth: 140 },
    chipTextOn: { color: P.dark },
    gap: { height: 12 },
    pressed: { opacity: 0.65 },
  };
}
