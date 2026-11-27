import { ArrowReloadHorizontalIcon, DashboardSquareEditIcon, Undo02Icon } from '@hugeicons/core-free-icons';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { onVideo, textShadow } from '../chrome/primitives';
import { haptics } from '../haptics';
import { useLiveUi } from '../liveUiStore';
import { ITEM_SIZES, MOVABLE_LABEL, activeLayout, slotOf, type ItemSize, type LayoutSlot } from './layoutModel';
import { useActiveLayoutName, useLayoutEditor, useLiveLayouts } from './layoutStore';

/** Opens Edit layout: closes panels and the lock so every movable item shows. */
export function beginLayoutEdit() {
  useLiveUi.getState().set({ captureSheet: null, gimbalPanel: useLiveUi.getState().gimbalPanel === 'runPill' ? 'runPill' : 'none', zoomDialOpen: false, disp: 'live', locked: false });
  useLayoutEditor.getState().begin();
}

/**
 * Edit layout's bar over the top of the picture: the layout's name (or the selected item with
 * its sizes), Undo, Reset (the selected item, else this orientation's layout) and Done.
 */
export function LayoutEditBar({ slot, top }: { slot: LayoutSlot; top: number }) {
  const styles = useThemedStyles(createStyles);
  const name = useActiveLayoutName();
  const selected = useLayoutEditor((s) => s.selected);
  const canUndo = useLayoutEditor((s) => s.undo.length > 0);
  const size = useLiveLayouts((s) => (selected ? slotOf(activeLayout(s), slot).items[selected]?.size : undefined)) ?? 'M';
  const sizes = selected ? ITEM_SIZES[selected] : [];
  const edit = useLayoutEditor.getState;

  const setSize = (v: ItemSize) => {
    if (!selected) return;
    haptics.selection();
    edit().checkpoint(slot);
    useLiveLayouts.getState().setItem(slot, selected, { size: v });
  };
  const reset = () => {
    haptics.medium();
    edit().checkpoint(slot);
    if (selected) useLiveLayouts.getState().resetItem(slot, selected);
    else useLiveLayouts.getState().resetSlot(slot);
  };

  return (
    <View pointerEvents="box-none" style={[styles.host, { top }]}>
      <View testID="monitor.layout.bar" style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selected ? `${MOVABLE_LABEL[selected]} selected. Tap to clear.` : `Layout ${name}`}
          onPress={() => edit().select(null)}
          style={styles.title}
        >
          <Text numberOfLines={1} style={styles.titleText}>
            {selected ? MOVABLE_LABEL[selected] : name}
          </Text>
        </Pressable>
        {sizes.length > 1 ? (
          <View accessibilityRole="radiogroup" style={styles.track}>
            {sizes.map((v) => (
              <Pressable
                key={v}
                accessibilityRole="radio"
                accessibilityLabel={`Size ${v === 'S' ? 'small' : v === 'M' ? 'medium' : 'large'}`}
                accessibilityState={{ selected: size === v }}
                hitSlop={{ top: 8, bottom: 8 }}
                onPress={() => setSize(v)}
                style={[styles.option, size === v && styles.optionOn]}
              >
                <Text style={[styles.optionText, size === v && styles.optionTextOn]}>{v}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Pressable
          testID="monitor.layout.undo"
          accessibilityRole="button"
          accessibilityLabel="Undo"
          disabled={!canUndo}
          onPress={() => {
            haptics.light();
            edit().undoLast();
          }}
          style={({ pressed }) => [styles.icon, !canUndo && styles.dim, pressed && styles.pressed]}
        >
          <Icon icon={Undo02Icon} size={20} color={onVideo.ink} strokeWidth={1.8} />
        </Pressable>
        <Pressable
          testID="monitor.layout.reset"
          accessibilityRole="button"
          accessibilityLabel={selected ? `Reset ${MOVABLE_LABEL[selected]}` : 'Reset layout'}
          onPress={reset}
          style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
        >
          <Icon icon={ArrowReloadHorizontalIcon} size={20} color={onVideo.ink} strokeWidth={1.8} />
        </Pressable>
        <Pressable
          testID="monitor.layout.done"
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={() => {
            haptics.light();
            edit().end();
          }}
          style={({ pressed }) => [styles.done, pressed && styles.pressed]}
        >
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Long-press on an empty part of the picture: a small "Edit layout" key at the finger, gone
 * after a few seconds or on any other touch.
 */
export function EditLayoutPrompt({ point, bounds, onClose }: { point: { x: number; y: number }; bounds: { width: number; height: number }; onClose: () => void }) {
  const styles = useThemedStyles(createStyles);
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [point, onClose]);
  const W = 148;
  const left = Math.min(Math.max(8, point.x - W / 2), bounds.width - W - 8);
  const top = Math.min(Math.max(8, point.y - 64), bounds.height - 52);
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      <Pressable accessibilityLabel="Dismiss" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} onPress={onClose} />
      <Pressable
        testID="monitor.layout.prompt"
        accessibilityRole="button"
        accessibilityLabel="Edit layout"
        onPress={() => {
          onClose();
          haptics.medium();
          beginLayoutEdit();
        }}
        style={({ pressed }) => [styles.prompt, { left, top, width: W }, pressed && styles.pressed]}
      >
        <Icon icon={DashboardSquareEditIcon} size={18} color={onVideo.ink} strokeWidth={1.8} />
        <Text style={styles.promptText}>Edit layout</Text>
      </Pressable>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    host: { position: 'absolute' as const, left: 0, right: 0, alignItems: 'center' as const },
    bar: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 2,
      height: 44,
      paddingLeft: 6,
      paddingRight: 4,
      borderRadius: 999,
      backgroundColor: onVideo.notice,
    },
    title: { maxWidth: 150, minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: 10 },
    titleText: { fontFamily: fonts.semibold, fontSize: 14, color: onVideo.ink, ...textShadow },
    track: { flexDirection: 'row' as const, padding: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.45)', marginHorizontal: 4 },
    option: { minWidth: 30, height: 28, borderRadius: 8, alignItems: 'center' as const, justifyContent: 'center' as const },
    optionOn: { backgroundColor: onVideo.chosen },
    optionText: { fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink },
    optionTextOn: { color: onVideo.dark },
    icon: { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    done: {
      height: 36,
      minWidth: 64,
      paddingHorizontal: 14,
      marginLeft: 4,
      borderRadius: 999,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: onVideo.chosen,
    },
    doneText: { fontFamily: fonts.semibold, fontSize: 14, color: onVideo.dark },
    prompt: {
      position: 'absolute' as const,
      height: 44,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      borderRadius: 999,
      backgroundColor: onVideo.notice,
    },
    promptText: { fontFamily: fonts.semibold, fontSize: 14, color: onVideo.ink },
    dim: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
    accent: { color: colors.accent },
  };
}
