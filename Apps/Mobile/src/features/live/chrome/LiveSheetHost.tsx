import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { useRef } from 'react';
import { Pressable } from 'react-native';
import { Icon } from '@/components/icon';
import { Sheet, SheetDockProvider } from '@/components/sheet';
import { useTheme } from '@/constants/theme';
import { CAPTURE_TITLES, CaptureSheetBody, useCaptureSheetAdmission } from '../capture/CaptureSheetHost';
import { LiveGimbalPanel } from '../gimbal/LiveGimbalControls';
import { MonitorZoomDial } from '../gimbal/MonitorZoomDial';
import { MotionControlEditor } from '../gimbal/MotionControl';
import type { FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';

type Panel = { kind: 'capture'; id: CaptureSheetId } | { kind: 'gimbal' } | { kind: 'motion' } | { kind: 'zoom' };

function MinimizeAction() {
  const { colors } = useTheme();
  const set = useLiveUi((s) => s.set);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Minimize motion control" hitSlop={8} onPress={() => set({ gimbalPanel: 'runPill' })}>
      <Icon icon={ArrowDown01Icon} size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}

/**
 * Every panel the monitor opens — capture values, gimbal controls, Motion Control, zoom — in
 * one shared preview Sheet with passthrough, so the picture stays in view and live. Landscape
 * docks it beside the picture on the leading side (the stick and record stay reachable);
 * portrait keeps it under the picture.
 */
export function LiveSheetHost({
  layout,
  chromeShown,
  notice,
}: {
  layout: FieldMonitorLayout;
  chromeShown: boolean;
  notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
}) {
  useCaptureSheetAdmission();
  const captureSheet = useLiveUi((s) => s.captureSheet);
  const gimbalPanel = useLiveUi((s) => s.gimbalPanel);
  const zoomDialOpen = useLiveUi((s) => s.zoomDialOpen);
  const set = useLiveUi((s) => s.set);

  let open: Panel | null = null;
  if (gimbalPanel === 'editor') open = { kind: 'motion' };
  else if (chromeShown && gimbalPanel === 'sheet') open = { kind: 'gimbal' };
  else if (chromeShown && zoomDialOpen) open = { kind: 'zoom' };
  else if (chromeShown && captureSheet) open = { kind: 'capture', id: captureSheet };

  // What the sheet showed last stays while it slides away.
  const last = useRef<Panel>({ kind: 'gimbal' });
  if (open) last.current = open;
  const panel = open ?? last.current;

  const close = () => {
    const s = useLiveUi.getState();
    set({
      captureSheet: null,
      zoomDialOpen: false,
      gimbalPanel: s.gimbalPanel === 'runPill' ? 'runPill' : 'none',
    });
  };

  const title =
    panel.kind === 'capture'
      ? CAPTURE_TITLES[panel.id]
      : panel.kind === 'gimbal'
        ? 'Gimbal'
        : panel.kind === 'motion'
          ? 'Motion Control'
          : 'Zoom';

  const body =
    panel.kind === 'capture' ? (
      <CaptureSheetBody id={panel.id} />
    ) : panel.kind === 'gimbal' ? (
      <LiveGimbalPanel notice={notice} />
    ) : panel.kind === 'motion' ? (
      <MotionControlEditor />
    ) : (
      <MonitorZoomDial />
    );

  const sheet = (
    <Sheet
      visible={open != null}
      title={title}
      onClose={close}
      // Docked, the tray fills its column; under the picture it keeps the preview's fixed height.
      variant={layout.sheet.dock ? 'standard' : 'preview'}
      passthrough
      contentDraggable={false}
      topInset={layout.sheet.dock ? undefined : layout.sheet.topInset}
      action={panel.kind === 'motion' ? <MinimizeAction /> : undefined}
    >
      {body}
    </Sheet>
  );
  return <SheetDockProvider dock={layout.sheet.dock}>{sheet}</SheetDockProvider>;
}
