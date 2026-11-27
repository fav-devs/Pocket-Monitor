import { useCallback, useMemo } from 'react';
import { useCamera, useCameraSession, type PicturePoint, type PictureRect } from '@/camera';
import { CaptureControlBar } from '@/features/live/capture/CaptureControlBar';
import { LiveSheetHost } from '@/features/live/chrome/LiveSheetHost';
import { Slot } from '@/features/live/chrome/primitives';
import { FeedGestureWell } from '@/features/live/feed/FeedGestureWell';
import { MonitorTrackingOverlay } from '@/features/live/feed/MonitorTrackingOverlay';
import { LiveGimbalButton } from '@/features/live/gimbal/LiveGimbalControls';
import { LiveGimbalStick } from '@/features/live/gimbal/LiveGimbalStick';
import { ZoomChip } from '@/features/live/gimbal/ZoomChip';
import { computeFieldMonitorLayout, isEmptyRect, type FieldMonitorLayout } from '@/features/live/layout/fieldMonitorLayout';
import { useLiveUi } from '@/features/live/liveUiStore';
import { expoExponent, useGimbalDrivePump, type StickMapping } from '@/features/input';
import { usePreferences } from '@/state/preferences';
import type { MultiviewLayout } from './multiviewLayout';

/** The live monitor's layout with the Multiview stage's readout strip and sheet placement. */
export function liveLayoutFor(layout: MultiviewLayout): FieldMonitorLayout {
  const base = computeFieldMonitorLayout({ width: layout.viewport.width, height: layout.viewport.height, safeArea: layout.safeArea });
  return { ...base, values: layout.values, valuesPerRow: layout.valuesPerRow, sheet: layout.sheet, portrait: layout.portrait };
}

/**
 * The selected camera's controls on Center stage, from the live screen (not forked): the capture
 * readout strip and its sheets, zoom, the gimbal button and stick, tap to focus / track on its
 * picture. Rendered inside that tile's `CameraSessionScope`, so every piece drives that camera.
 */
export function FocusedControls({
  layout,
  notice,
  enabled,
}: {
  layout: MultiviewLayout;
  notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
  enabled: boolean;
}) {
  const session = useCameraSession();
  const live = useCamera((s) => s.connection.phase === 'live');
  const gimbalAvailable = useCamera((s) => s.capabilities.gimbal && s.gimbal.available);
  const programActive = useCamera((s) => ['preparing', 'running'].includes(s.gimbal.program.status));
  const set = useLiveUi((s) => s.set);
  const liveLayout = useMemo(() => liveLayoutFor(layout), [layout]);
  const main = layout.main != null ? layout.tiles[layout.main] : null;
  // The large tile is 16:9 like the stream, so the picture fills it.
  const picture: PictureRect = useMemo(() => (main ? { ...main } : { x: 0, y: 0, width: 0, height: 0 }), [main]);

  useGimbalDrivePump(session, live && enabled);

  const getMapping = useCallback((): StickMapping => {
    const p = usePreferences.getState();
    const selfie = session.getState().gimbal.face === 'selfie';
    return {
      exponent: expoExponent(p.stickExpo),
      invertPan: p.stickPictureRelative ? selfie : false,
      invertTilt: p.stickInvertTilt,
      directionLock: p.directionLock,
    };
  }, [session]);

  const handlers = useMemo(
    () => ({
      onTap: (pt: PicturePoint) => {
        const s = session.getState();
        const box = s.tracking.status !== 'idle' ? s.tracking.box : undefined;
        if (box && pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height) {
          session.control.stopTracking().catch(() => {});
          return;
        }
        const p = usePreferences.getState();
        if (p.tapToTrack && s.capabilities.tracking && s.tracking.available) {
          session.control.startTracking(pt).catch(() => {});
          return;
        }
        if (p.tapToFocus || s.focus.mode !== 'mf') session.control.focusAt(pt).catch(() => {});
      },
      onTrackBox: (box: PictureRect) => {
        const s = session.getState();
        if (!s.capabilities.tracking || !s.tracking.available) return notice('This camera cannot track', 'warning');
        session.control.startTracking(box).catch(() => {});
      },
      onDisp: () => {},
    }),
    [session, notice],
  );

  if (!main) return null;
  return (
    <>
      <FeedGestureWell picture={picture} enabled={live && enabled} handlers={handlers} />
      <MonitorTrackingOverlay picture={picture} />
      {enabled ? (
        <>
          <CaptureControlBar layout={liveLayout} />
          <Slot rect={layout.zoom}>
            <ZoomChip size={layout.zoom.width} disabled={!live} onOpenDial={() => set({ zoomDialOpen: true, captureSheet: null, gimbalPanel: 'none' })} />
          </Slot>
          {gimbalAvailable ? (
            <>
              <Slot rect={layout.gimbal}>
                <LiveGimbalButton size={layout.gimbal.width} disabled={!live} />
              </Slot>
              {!isEmptyRect(layout.stick) ? (
                <Slot rect={layout.stick}>
                  <LiveGimbalStick
                    size={layout.stick.width}
                    enabled={live && !programActive}
                    getMapping={getMapping}
                    onDoubleTap={() => session.gimbal.recenter().catch(() => {})}
                    onTripleTap={() => session.getState().capabilities.selfieFlip && session.gimbal.flip().catch(() => {})}
                  />
                </Slot>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      <LiveSheetHost layout={liveLayout} chromeShown={enabled} notice={notice} session={session} />
    </>
  );
}
