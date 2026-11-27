import { useRef, type ReactNode } from 'react';
import { type GestureResponderEvent, PanResponder, View } from 'react-native';
import { panBy, previewLayout, zoomTo, type ClipEdit, type CropState, type Size } from '@/core/edit';

/**
 * The edit's geometry stage for the preview: the picture (`children`, any view that fills its
 * box) is rotated, offset so the crop fills `frame`, and flipped — the same mapping the exporter
 * renders (`previewLayout` in core/edit/geometry). `before` (optional) is the unedited colour
 * of the same picture for a split compare: it shows on the frame's left half.
 */
export function EditedPicture({
  edit,
  source,
  frame,
  children,
  before,
}: {
  edit: ClipEdit;
  source: Size;
  frame: Size;
  children: ReactNode;
  before?: ReactNode;
}) {
  const l = previewLayout(source, edit.rotation, edit.crop, { h: edit.flipH, v: edit.flipV }, frame);
  const content = (node: ReactNode) => (
    <View style={{ position: 'absolute', left: 0, top: 0, width: frame.width, height: frame.height, transform: [{ scaleX: l.scaleX }, { scaleY: l.scaleY }] }}>
      <View style={{ position: 'absolute', left: l.box.left, top: l.box.top, width: l.box.width, height: l.box.height }}>
        <View
          style={{
            position: 'absolute',
            left: l.inner.left,
            top: l.inner.top,
            width: l.inner.width,
            height: l.inner.height,
            transform: l.inner.rotate ? [{ rotate: `${l.inner.rotate}deg` }] : undefined,
          }}
        >
          {node}
        </View>
      </View>
    </View>
  );
  return (
    <View pointerEvents="none" style={{ width: frame.width, height: frame.height, overflow: 'hidden' }}>
      {content(children)}
      {before ? (
        <>
          <View style={{ position: 'absolute', left: 0, top: 0, width: frame.width / 2, height: frame.height, overflow: 'hidden' }}>{content(before)}</View>
          <View style={{ position: 'absolute', left: frame.width / 2 - 1, top: 0, width: 2, height: frame.height, backgroundColor: 'rgba(255,255,255,0.85)' }} />
        </>
      ) : null}
    </View>
  );
}

/** The compare line for a native split (the native stage draws both halves). */
export function CompareLine({ frame }: { frame: Size }) {
  return <View pointerEvents="none" style={{ position: 'absolute', left: frame.width / 2 - 1, top: 0, width: 2, height: frame.height, backgroundColor: 'rgba(255,255,255,0.85)' }} />;
}

const spread = (e: GestureResponderEvent) => {
  const t = e.nativeEvent.touches;
  return t && t.length >= 2 ? Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY) : null;
};

/**
 * Aspect Ratio framing on the picture: one finger drags the picture inside the crop, two fingers
 * pinch to zoom. Draws the frame edge and thirds while the tool is open.
 */
export function CropGestureLayer({ edit, source, frame, onChange }: { edit: ClipEdit; source: Size; frame: Size; onChange: (crop: CropState) => void }) {
  const cur = useRef({ edit, source, frame, onChange });
  cur.current = { edit, source, frame, onChange };
  const start = useRef<{ crop: CropState; d0: number | null; dx: number; dy: number } | null>(null);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        start.current = { crop: cur.current.edit.crop, d0: spread(e), dx: 0, dy: 0 };
      },
      onPanResponderMove: (e, g) => {
        const s = start.current;
        if (!s) return;
        const { edit: ed, source: src, frame: f } = cur.current;
        const flip = { h: ed.flipH, v: ed.flipV };
        const d = spread(e);
        if (d != null) {
          if (s.d0 == null) {
            // Second finger arrived: restart from here as a pinch.
            start.current = { crop: ed.crop, d0: d, dx: g.dx, dy: g.dy };
            return;
          }
          cur.current.onChange(zoomTo(src, ed.rotation, s.crop, s.crop.zoom * (d / Math.max(1, s.d0))));
          return;
        }
        if (s.d0 != null) {
          // Back to one finger after a pinch: drag from the current framing.
          start.current = { crop: ed.crop, d0: null, dx: g.dx, dy: g.dy };
          return;
        }
        if (f.width <= 0 || f.height <= 0) return;
        cur.current.onChange(panBy(src, ed.rotation, s.crop, flip, (g.dx - s.dx) / f.width, (g.dy - s.dy) / f.height));
      },
      onPanResponderRelease: () => void (start.current = null),
      onPanResponderTerminate: () => void (start.current = null),
    }),
  ).current;
  const line = 'rgba(255,255,255,0.35)';
  return (
    <View
      {...responder.panHandlers}
      accessibilityLabel="Drag to frame, pinch to zoom"
      style={{ position: 'absolute', left: 0, top: 0, width: frame.width, height: frame.height, borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)' }}
    >
      {[1, 2].map((i) => (
        <View key={`v${i}`} pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: (frame.width * i) / 3, width: 1, backgroundColor: line }} />
      ))}
      {[1, 2].map((i) => (
        <View key={`h${i}`} pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: (frame.height * i) / 3, height: 1, backgroundColor: line }} />
      ))}
    </View>
  );
}
