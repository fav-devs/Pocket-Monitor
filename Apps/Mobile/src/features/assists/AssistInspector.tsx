import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { Sheet, SheetDockProvider } from '@/components/sheet';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { ASSIST_TITLES, useAssists, type AssistContext, type AssistTool } from '@/state/assists';
import { AssistMenu } from './AssistMenus';
import { AppSwitch, MenuLeadProvider } from './menuKit';
import { WindowLayer } from './WebPortal';

/** Where the options sheet sits over the picture: docked in a panel (landscape) or a tray `topInset` down. */
export interface AssistSheetPlacement {
  dock: { left: number; width: number; top: number; bottom: number } | null;
  topInset?: number;
}

type Host = { id: string; priority: number; placement?: AssistSheetPlacement };

/** Only one mounted host draws the inspector (overlays and bar can both be on screen): the overlays' wins. */
const useHosts = create<{ hosts: Host[]; put: (h: Host) => void; remove: (id: string) => void }>((set) => ({
  hosts: [],
  put: (h) => set((s) => (s.hosts.some((x) => x.id === h.id) ? { hosts: s.hosts.map((x) => (x.id === h.id ? h : x)) } : { hosts: [...s.hosts, h] })),
  remove: (id) => set((s) => ({ hosts: s.hosts.filter((x) => x.id !== id) })),
}));

const winner = (hosts: Host[]) => hosts.reduce<Host | null>((best, h) => (!best || h.priority > best.priority ? h : best), null);

export function AssistInspectorHost({ priority = 0, placement }: { priority?: number; placement?: AssistSheetPlacement }) {
  const id = useId();
  const put = useHosts((s) => s.put);
  const remove = useHosts((s) => s.remove);
  const mine = useHosts((s) => winner(s.hosts)?.id === id);
  const key = JSON.stringify(placement ?? null);
  useEffect(() => {
    put({ id, priority, placement });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placement compared by value
  }, [id, priority, key, put]);
  useEffect(() => () => remove(id), [id, remove]);
  if (!mine) return null;
  return <ToolInspector placement={placement} />;
}

/** The long-press options of the open tool (`MonitorToolInspector`), kept mounted while its sheet slides away. */
export function ToolInspector({ placement }: { placement?: AssistSheetPlacement }) {
  const tool = useAssists((s) => s.configureTool);
  const context = useAssists((s) => s.configureContext);
  const close = useAssists((s) => s.openInspector);
  const last = useRef<AssistTool | null>(tool);
  if (tool) last.current = tool;
  const shown = tool ?? last.current;
  if (!shown) return null;
  return <AssistOptionsSheet tool={shown} context={context} visible={tool != null} onClose={() => close(null)} placement={placement} />;
}

/**
 * A tool's options as a sheet. Over the picture it is a preview tray that lets touches through, docked down the right
 * side in landscape (the old side card) and along the bottom in portrait; `settings` opens it from Settings with the
 * live / playback switches on top.
 */
export function AssistOptionsSheet({
  tool,
  context = 'live',
  visible,
  onClose,
  lead,
  placement,
}: {
  tool: AssistTool;
  context?: AssistContext;
  visible: boolean;
  onClose: () => void;
  /** Settings: rows above the options instead of the header switch; the sheet then dims what is behind it. */
  lead?: ReactNode;
  /** Over the picture: where the screen wants its sheets. Defaults to a left dock in landscape, a half-height tray. */
  placement?: AssistSheetPlacement;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const overVideo = lead === undefined;
  const landscape = width > height;
  const title = context === 'playback' && overVideo ? `${ASSIST_TITLES[tool]} · Playback` : ASSIST_TITLES[tool];
  const fallbackDock = {
    left: Math.max(insets.left, 8),
    width: Math.min(400, Math.max(300, Math.round(width * 0.42))),
    top: Math.max(insets.top, 8),
    bottom: height - Math.max(insets.bottom, 8),
  };
  const dock = overVideo && landscape ? (placement ? placement.dock : fallbackDock) : null;
  const topInset = overVideo && !dock ? (placement?.topInset ?? Math.round(height * 0.5)) : undefined;
  const sheet = (
    <SheetDockProvider dock={dock}>
      <Sheet
        visible={visible}
        title={title}
        onClose={onClose}
        variant={dock ? 'standard' : 'preview'}
        passthrough={overVideo}
        scroll={false}
        topInset={topInset}
        bodyStyle={BODY}
        action={overVideo ? <ToolSwitch tool={tool} context={context} /> : undefined}
      >
        <MenuLeadProvider value={lead ?? null}>
          <AssistMenu tool={tool} />
        </MenuLeadProvider>
      </Sheet>
    </SheetDockProvider>
  );
  return overVideo ? <WindowLayer>{sheet}</WindowLayer> : sheet;
}

const BODY: ViewStyle = { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 };

function ToolSwitch({ tool, context }: { tool: AssistTool; context: AssistContext }) {
  const styles = useThemedStyles(createStyles);
  const on = useAssists((s) => s.isOn(tool, context));
  const setOn = useAssists((s) => s.setOn);
  return (
    <View style={styles.switch}>
      <Text style={styles.switchLabel}>{on ? 'On' : 'Off'}</Text>
      <AppSwitch label={`${ASSIST_TITLES[tool]} on`} value={on} onChange={(v) => setOn(tool, v, context)} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    switch: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    switchLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
  };
}
