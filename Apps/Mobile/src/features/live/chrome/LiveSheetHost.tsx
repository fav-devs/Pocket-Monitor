import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { useRef } from 'react';
import { CameraSessionScope, type CameraSession } from '@/camera';
import { Pressable } from 'react-native';
import { Icon } from '@/components/icon';
import { Sheet, SheetDockProvider } from '@/components/sheet';
import { useTheme } from '@/constants/theme';
import { CameraSettingsSheet } from '../capture/CameraSettingsSheet';
import { CAPTURE_PANEL_TITLES, CaptureSheetBody, capturePanelFor, useCaptureSheetAdmission, type CapturePanel } from '../capture/CaptureSheetHost';
import { ExposurePanel } from '../capture/ExposurePanel';
import { LiveGimbalPanel } from '../gimbal/LiveGimbalControls';
import { MonitorZoomDial } from '../gimbal/MonitorZoomDial';
import { MotionControlEditor } from '../gimbal/MotionControl';
import type { FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi } from '../liveUiStore';

type Panel = { kind: 'capture'; panel: CapturePanel } | { kind: 'gimbal' } | { kind: 'motion' } | { kind: 'zoom' };

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
 * Every panel the monitor opens — exposure, camera settings, format, mode, gimbal controls,
 * Motion Control, zoom — in
 * one shared preview Sheet with passthrough, so the picture stays in view and live. Landscape
 * docks it beside the picture on the leading side (the stick and record stay reachable);
 * portrait keeps it under the picture.
 */
export function LiveSheetHost({
  layout,
  chromeShown,
  notice,
  session,
  onOpenSettings,
}: {
  layout: FieldMonitorLayout;
  chromeShown: boolean;
  notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
  /**
   * Optional (additive). The camera the panels drive. The native sheet renders in a portal
   * outside this screen's React tree, so a scoped session (a Multiview tile) is passed in and
   * re-scoped inside the sheet. Absent: the panels use the app's session, as before.
   */
  session?: CameraSession;
  /** Optional (additive). The camera settings sheet's "All settings" row; default pushes /settings. */
  onOpenSettings?: () => void;
}) {
  useCaptureSheetAdmission();
  const captureSheet = useLiveUi((s) => s.captureSheet);
  const gimbalPanel = useLiveUi((s) => s.gimbalPanel);
  const zoomDialOpen = useLiveUi((s) => s.zoomDialOpen);
  const cameraTab = useLiveUi((s) => s.cameraTab);
  const set = useLiveUi((s) => s.set);

  let open: Panel | null = null;
  if (gimbalPanel === 'editor') open = { kind: 'motion' };
  else if (chromeShown && gimbalPanel === 'sheet') open = { kind: 'gimbal' };
  else if (chromeShown && zoomDialOpen) open = { kind: 'zoom' };
  else if (chromeShown && captureSheet) open = { kind: 'capture', panel: capturePanelFor(captureSheet, cameraTab) };

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
      ? CAPTURE_PANEL_TITLES[panel.panel.kind]
      : panel.kind === 'gimbal'
        ? 'Gimbal'
        : panel.kind === 'motion'
          ? 'Motion Control'
          : 'Zoom';

  const body =
    panel.kind === 'capture' ? (
      panel.panel.kind === 'exposure' ? (
        <ExposurePanel />
      ) : panel.panel.kind === 'camera' ? (
        <CameraSettingsSheet onOpenSettings={onOpenSettings} />
      ) : (
        <CaptureSheetBody id={panel.panel.kind} />
      )
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
      {session ? <CameraSessionScope session={session}>{body}</CameraSessionScope> : body}
    </Sheet>
  );
  return <SheetDockProvider dock={layout.sheet.dock}>{sheet}</SheetDockProvider>;
}
