import { useEffect, useId } from 'react';
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { create } from 'zustand';
import { MText, colors, radius, spacing } from '@/theme';
import { IconButton } from '@/ui';
import { ASSIST_TITLES, useAssists, type AssistTool } from '@/state/assists';
import { AssistIcon } from './AssistIcon';
import { AssistMenu } from './AssistMenus';
import { Toggle } from './menuKit';

/** Only one mounted host draws the inspector (overlays and bar can both be on screen). */
const useHosts = create<{ ids: string[]; add: (id: string) => void; remove: (id: string) => void }>((set) => ({
  ids: [],
  add: (id) => set((s) => ({ ids: [...s.ids, id] })),
  remove: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
}));

export function AssistInspectorHost() {
  const id = useId();
  const add = useHosts((s) => s.add);
  const remove = useHosts((s) => s.remove);
  const first = useHosts((s) => s.ids[0] === id);
  useEffect(() => {
    add(id);
    return () => remove(id);
  }, [id, add, remove]);
  const tool = useAssists((s) => s.configureTool);
  if (!first || !tool) return null;
  return <ToolInspector tool={tool} />;
}

/** `MonitorToolInspector`: tool title, on/off and its options; side card in landscape, sheet in portrait. */
export function ToolInspector({ tool }: { tool: AssistTool }) {
  const context = useAssists((s) => s.configureContext);
  const on = useAssists((s) => s.isOn(tool, context));
  const setOn = useAssists((s) => s.setOn);
  const close = useAssists((s) => s.openInspector);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const landscape = width > height;
  const cardStyle = landscape
    ? { position: 'absolute' as const, right: Math.max(insets.right, spacing.md), top: Math.max(insets.top, spacing.md), bottom: Math.max(insets.bottom, spacing.md), width: Math.min(380, width * 0.5) }
    : { position: 'absolute' as const, left: 0, right: 0, bottom: 0, maxHeight: height * 0.72, paddingBottom: insets.bottom };
  return (
    <Modal transparent visible animationType="fade" onRequestClose={() => close(null)} supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}>
      <Pressable accessibilityLabel="Close options" style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={() => close(null)} />
      <View
        style={[
          cardStyle,
          {
            backgroundColor: colors.background,
            borderRadius: landscape ? radius.lg : 0,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.borderStrong,
            overflow: 'hidden',
          },
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <AssistIcon tool={tool} size={20} color={on ? colors.accent : colors.secondary} />
          <View style={{ flex: 1 }}>
            <MText size={16} weight="semibold">
              {ASSIST_TITLES[tool]}
            </MText>
            <MText size={10} color={colors.faint} tracking={1} uppercase>
              {context === 'live' ? 'Live' : 'Playback'} · {tool}
            </MText>
          </View>
          <Toggle value={on} onChange={(v) => setOn(tool, v, context)} label={`${ASSIST_TITLES[tool]} on`} />
          <IconButton icon={X} label="Close" variant="bare" onPress={() => close(null)} />
        </View>
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ padding: spacing.lg }}>
          <AssistMenu tool={tool} />
        </ScrollView>
      </View>
    </Modal>
  );
}
