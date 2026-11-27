import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { useRef, type ReactNode } from 'react';
import { CameraSessionScope, type CameraSession } from '@/camera';
import { Pressable } from 'react-native';
import AssistBar from '@/features/assists/AssistBar';
import { Icon } from '@/components/icon';
import { Sheet, SheetDockProvider } from '@/components/sheet';
import { useTheme } from '@/constants/theme';
import { CameraSettingsSheet } from '../capture/CameraSettingsSheet';
import { CAPTURE_PANEL_TITLES, CaptureSheetBody, capturePanelFor, useCaptureSheetAdmission, type CapturePanel } from '../capture/CaptureSheetHost';
import { ExposurePanel } from '../capture/ExposurePanel';
import { MonitorZoomDial } from '../gimbal/MonitorZoomDial';
import { MotionControlEditor } from '../gimbal/MotionControl';
import type { FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CameraTab } from '../liveUiStore';
import { MonitorPanel } from '../panel/MonitorPanel';

type Sheeted = { kind: 'motion' } | { kind: 'zoom' };

function MinimizeAction() {
  const { colors } = useTheme();
  const set = useLiveUi((s) => s.set);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Minimize motion control" hitSlop={8} onPress={() => set({ gimbalPanel: 'runPill' })}>
      <Icon icon={ArrowDown01Icon} size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}

/** Narrow panels (Mimo's exposure and format panels are about a third of the screen). */
const NARROW: Partial<Record<CapturePanel['kind'], number>> = { exposure: 270, format: 310, mode: 280 };

/**
 * Every panel the monitor opens. Exposure, format, shooting mode, camera settings (with its
 * Gimbal tab: the gimbal controls) and assists are compact dark panels docked against the
 * leading strip (Mimo), or under the picture in portrait, so the picture stays in view and live.
 * Motion Control and the zoom dial keep the shared preview Sheet.
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
  /** Optional (additive). The camera settings panel's "All settings" row; default pushes /settings. */
  onOpenSettings?: () => void;
}) {
  useCaptureSheetAdmission();
  const captureSheet = useLiveUi((s) => s.captureSheet);
  const gimbalPanel = useLiveUi((s) => s.gimbalPanel);
  const zoomDialOpen = useLiveUi((s) => s.zoomDialOpen);
  const cameraTab = useLiveUi((s) => s.cameraTab);
  const set = useLiveUi((s) => s.set);

  // The docked panel: the gimbal button opens camera settings at its Gimbal tab.
  let panel: CapturePanel | null = null;
  if (chromeShown && gimbalPanel === 'sheet') panel = { kind: 'camera', tab: 'gimbal' };
  else if (chromeShown && captureSheet && !zoomDialOpen) panel = capturePanelFor(captureSheet, cameraTab);

  let sheeted: Sheeted | null = null;
  if (gimbalPanel === 'editor') sheeted = { kind: 'motion' };
  else if (chromeShown && zoomDialOpen) sheeted = { kind: 'zoom' };
  const last = useRef<Sheeted>({ kind: 'zoom' });
  if (sheeted) last.current = sheeted;
  const shownSheet = sheeted ?? last.current;

  const close = () => {
    const s = useLiveUi.getState();
    set({ captureSheet: null, zoomDialOpen: false, gimbalPanel: s.gimbalPanel === 'runPill' ? 'runPill' : 'none' });
  };
  const onTab = (tab: CameraTab) =>
    tab === 'gimbal'
      ? set({ gimbalPanel: 'sheet', captureSheet: null, cameraTab: 'gimbal', zoomDialOpen: false })
      : set({ gimbalPanel: 'none', captureSheet: 'camera', cameraTab: tab, zoomDialOpen: false });

  const scoped = (node: ReactNode) => (session ? <CameraSessionScope session={session}>{node}</CameraSessionScope> : node);

  const body =
    panel == null ? null : panel.kind === 'exposure' ? (
      <ExposurePanel />
    ) : panel.kind === 'camera' ? (
      <CameraSettingsSheet tab={panel.tab} onTab={onTab} onOpenSettings={onOpenSettings} notice={notice} />
    ) : panel.kind === 'assists' ? (
      <AssistBar orientation={layout.portrait ? 'portrait' : 'landscape'} variant="panel" inspector={false} />
    ) : (
      <CaptureSheetBody id={panel.kind} />
    );

  const sheet = (
    <Sheet
      visible={sheeted != null}
      title={shownSheet.kind === 'motion' ? 'Motion Control' : 'Zoom'}
      onClose={close}
      variant={layout.sheet.dock ? 'standard' : 'preview'}
      passthrough
      contentDraggable={false}
      topInset={layout.sheet.dock ? undefined : layout.sheet.topInset}
      action={shownSheet.kind === 'motion' ? <MinimizeAction /> : undefined}
    >
      {scoped(shownSheet.kind === 'motion' ? <MotionControlEditor /> : <MonitorZoomDial />)}
    </Sheet>
  );

  return (
    <>
      <MonitorPanel
        placement={layout.sheet}
        visible={panel != null}
        full={panel?.kind === 'camera'}
        scroll={panel?.kind !== 'camera'}
        width={panel ? NARROW[panel.kind] : undefined}
        label={panel ? (panel.kind === 'camera' && panel.tab === 'gimbal' ? 'Gimbal' : CAPTURE_PANEL_TITLES[panel.kind]) : ''}
        onClose={close}
      >
        {body}
      </MonitorPanel>
      <SheetDockProvider dock={layout.sheet.dock}>{sheet}</SheetDockProvider>
    </>
  );
}
