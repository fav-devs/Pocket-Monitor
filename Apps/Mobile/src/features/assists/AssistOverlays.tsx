import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import type { ColorMode, PictureRect } from '@/camera/types';
import { evMeterFrame, evMeterValue, type Insets, type Rect } from '@/core/media';
import { useScopeBundle } from '@/features/picture/frameSample';
import { useAssists, usePictureEffects, useSourceTransfer, type AssistContext } from '@/state/assists';
import { AssistInspectorHost, type AssistSheetPlacement } from './AssistInspector';
import { CrosshairOverlay, GridOverlay, GuidesOverlay, LevelOverlay } from './overlays/Framing';
import { EVMeter } from './overlays/Meters';
import { FloatingPanels } from './scopes/FloatingPanels';

export interface AssistOverlaysProps {
  /** Where the picture is drawn, in this overlay's coordinates (LivePicture `onPictureRect`). */
  pictureRect: PictureRect;
  context: AssistContext;
  /** Chrome rects (overlay coordinates) floating panels keep clear of. */
  obstacles?: Rect[];
  /** Edges reserved for chrome; panels move inside the rest. */
  clearance?: Partial<Insets>;
  /** Playback: the clip's own colour mode (scopes, false colour key). */
  colorMode?: ColorMode | null;
  /** Disable panel gestures (e.g. interface lock). */
  locked?: boolean;
  /**
   * Where a tool's options sheet goes (the screen's sheet dock / tray inset). Default: docked on the left in
   * landscape, a tray just under the picture in portrait.
   */
  sheetPlacement?: AssistSheetPlacement;
}

/**
 * Every non-per-pixel assist inside the picture: guides, grid, crosshair, level, EV meter, the
 * movable scope / meter panels and the false colour key, plus the long-press inspector host.
 * Fill the same container as `<LivePicture>` so `pictureRect` shares its coordinates.
 */
export default function AssistOverlays({ pictureRect, context, obstacles, clearance, colorMode, locked, sheetPlacement }: AssistOverlaysProps) {
  const [canvas, setCanvas] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const on = useAssists((s) => (context === 'live' ? s.on : s.playbackOn));
  const grid = useAssists((s) => s.options.grid);
  const guides = useAssists((s) => s.options.guides);
  const effects = usePictureEffects(context, colorMode);
  const session = useCameraSession();
  const video = session.video;
  const sessionId = video.kind === 'native' || video.kind === 'relay' ? video.sessionId : null;
  const demoScene = video.kind === 'demo' ? video.scene : null;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== canvas.width || height !== canvas.height) setCanvas({ x: 0, y: 0, width, height });
  };

  // The visible part of the picture (fill mode can run past the canvas).
  const feed: Rect = intersect(pictureRect, canvas);
  const size = { width: canvas.width, height: canvas.height };
  const ready = canvas.width > 0 && feed.width > 0 && feed.height > 0;
  const portrait = canvas.height > canvas.width;
  const placement =
    sheetPlacement ??
    (portrait && canvas.height > 0
      ? { dock: null, topInset: Math.round(Math.min(canvas.height * 0.68, Math.max(canvas.height * 0.36, pictureRect.y + pictureRect.height + 10))) }
      : undefined);

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} onLayout={onLayout}>
      {ready ? (
        <>
          {on.GUIDES ? <GuidesOverlay feed={pictureRect} size={size} selected={guides.selected} mask={guides.mask} safe={guides.safe} /> : null}
          {on.GRID ? <GridOverlay feed={pictureRect} size={size} thirds={grid.thirds} phi={grid.phi} diagonal={grid.diagonal} /> : null}
          {on.CROSS ? <CrosshairOverlay feed={pictureRect} /> : null}
          {on.LEVEL && context === 'live' ? <LiveLevel feed={feed} portrait={canvas.height > canvas.width} /> : null}
          {on.EV ? <EVOverlay feed={feed} context={context} colorMode={colorMode} /> : null}
          <FloatingPanels
            context={context}
            canvas={canvas}
            clearance={clearance}
            obstacles={obstacles}
            effects={effects}
            sessionId={sessionId}
            demoScene={demoScene}
            colorModeOverride={colorMode}
            enabled={!locked}
          />
        </>
      ) : null}
      <AssistInspectorHost priority={1} placement={placement} />
    </View>
  );
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bt = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, bt - y) };
}

function LiveLevel({ feed, portrait }: { feed: Rect; portrait: boolean }) {
  const roll = useCamera((s) => s.level.roll);
  const pitch = useCamera((s) => s.level.pitch);
  const live = useCamera((s) => s.connection.phase === 'live');
  return <LevelOverlay feed={feed} roll={live ? roll : null} pitch={live ? pitch : null} portrait={portrait} />;
}

function EVOverlay({ feed, context, colorMode }: { feed: Rect; context: AssistContext; colorMode?: ColorMode | null }) {
  const metered = useCamera((s) => (context === 'live' ? s.exposure.meteredEv : null));
  const crushClip = useAssists((s) => s.options.crushClip);
  const { transfer, clipByte } = useSourceTransfer(colorMode);
  const bundle = useScopeBundle(context, transfer, clipByte, crushClip, metered == null);
  const frame = evMeterFrame(feed);
  if (!frame) return null;
  const value = evMeterValue(metered, bundle ? bundle.samples.histLuma : null, transfer);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: frame.x, top: frame.y }}>
      <EVMeter value={value} width={frame.width} height={frame.height} />
    </View>
  );
}
