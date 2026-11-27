import { Text, View } from 'react-native';
import Svg, { Defs, Line, Mask, Rect, Text as SvgText } from 'react-native-svg';
import {
  CROSSHAIR,
  GRID_STROKE_OPACITY,
  LEVEL_GAUGE,
  gridSegments,
  guideFrames,
  levelFrames,
  levelGaugeFraction,
  levelLabel,
  safeRect,
  type GuideAspect,
  type GuideSafeAreas,
  type Rect as R,
} from '@/core/media';
import { fonts } from '@/constants/theme';
import { LevelBubble } from './Meters';

/** Composition grid (`MonitorFeedGrid`). Coordinates are the overlay's own. */
export function GridOverlay({ feed, size, thirds, phi, diagonal }: { feed: R; size: { width: number; height: number }; thirds: boolean; phi: boolean; diagonal: boolean }) {
  return (
    <Svg width={size.width} height={size.height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {gridSegments(feed, { thirds, phi, diagonal }).map((s, i) => (
        <Line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={`rgba(255,255,255,${GRID_STROKE_OPACITY})`} strokeWidth={1} />
      ))}
    </Svg>
  );
}

/** Frame lines: white, stronger than the 35% grid so the frame reads first. */
const GUIDE_LINE = 'rgba(255,255,255,0.7)';

/** Aspect frame lines, optional mask outside them, action / title safe (`MonitorAspectGuideFrames`). */
export function GuidesOverlay({ feed, size, selected, mask, safe }: { feed: R; size: { width: number; height: number }; selected: GuideAspect[]; mask: boolean; safe: GuideSafeAreas }) {
  const frames = guideFrames(feed, selected.length ? selected : ['2.39:1']);
  const areas = [
    ...(safe.actionSafe ? [{ percent: safe.actionPercent, dash: '6 4', opacity: 0.7 }] : []),
    ...(safe.titleSafe ? [{ percent: safe.titlePercent, dash: '2 3', opacity: 0.55 }] : []),
  ];
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: size.width, height: size.height }}>
      <Svg width={size.width} height={size.height}>
        {mask ? (
          <>
            <Defs>
              <Mask id="guideMask" x={0} y={0} width={size.width} height={size.height} maskUnits="userSpaceOnUse">
                <Rect x={feed.x} y={feed.y} width={feed.width} height={feed.height} fill="white" />
                {frames.map((f) => (
                  <Rect key={f.aspect} x={f.rect.x} y={f.rect.y} width={f.rect.width} height={f.rect.height} fill="black" />
                ))}
              </Mask>
            </Defs>
            <Rect x={feed.x} y={feed.y} width={feed.width} height={feed.height} fill="rgba(0,0,0,0.6)" mask="url(#guideMask)" />
          </>
        ) : null}
        {areas.map((a) =>
          frames.map((f) => {
            const r = safeRect(f.rect, a.percent);
            return (
              <Rect key={`${a.percent}${f.aspect}`} x={r.x} y={r.y} width={r.width} height={r.height} fill="none" stroke={`rgba(255,255,255,${a.opacity * 0.75})`} strokeWidth={1} strokeDasharray={a.dash} />
            );
          }),
        )}
        {frames.map((f) => (
          <Rect key={f.aspect} x={f.rect.x + 0.5} y={f.rect.y + 0.5} width={f.rect.width - 1} height={f.rect.height - 1} fill="none" stroke={GUIDE_LINE} strokeWidth={1} />
        ))}
      </Svg>
      {frames.map((f) => (
        <View
          key={f.aspect}
          style={{ position: 'absolute', left: f.rect.x + 8, top: f.rect.y + 6, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}
        >
          <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: '#ffffff' }}>{f.aspect}</Text>
        </View>
      ))}
    </View>
  );
}

/** 40pt centre cross, 1.4pt, white 65% (`MonitorFeedCrosshair`). */
export function CrosshairOverlay({ feed }: { feed: R }) {
  const cx = feed.x + feed.width / 2;
  const cy = feed.y + feed.height / 2;
  const c = `rgba(255,255,255,${CROSSHAIR.opacity})`;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: cx - CROSSHAIR.arm / 2, top: cy - CROSSHAIR.arm / 2, width: CROSSHAIR.arm, height: CROSSHAIR.arm }}>
      <View style={{ position: 'absolute', left: (CROSSHAIR.arm - CROSSHAIR.stroke) / 2, top: 0, width: CROSSHAIR.stroke, height: CROSSHAIR.arm, backgroundColor: c }} />
      <View style={{ position: 'absolute', top: (CROSSHAIR.arm - CROSSHAIR.stroke) / 2, left: 0, height: CROSSHAIR.stroke, width: CROSSHAIR.arm, backgroundColor: c }} />
    </View>
  );
}

const GOOD = '#22c55e';

function Gauge({ rect, axis, value }: { rect: R; axis: 'horizontal' | 'vertical'; value: number | null }) {
  const vertical = axis === 'vertical';
  const level = value != null && Math.abs(value) < LEVEL_GAUGE.levelDeg;
  const tint = level ? GOOD : '#fff';
  const length = vertical ? rect.height : rect.width;
  const start = vertical ? 18 : 4;
  const end = Math.max(start, length - 4);
  const across = vertical ? rect.width / 2 : rect.height - 8;
  const h = LEVEL_GAUGE.band / 2;
  const pos = (deg: number) => {
    const f = levelGaugeFraction(deg);
    return vertical ? end - h - (end - start - 2 * h) * f : start + h + (end - start - 2 * h) * f;
  };
  const pt = (t: number, off = 0) => (vertical ? { x: across + off, y: t } : { x: t, y: across + off });
  const a = pt(start + h);
  const b = pt(end - h);
  const z = pos(0);
  const m = value != null ? pos(value) : null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <Svg width={rect.width} height={rect.height}>
        {vertical ? (
          <Rect x={across - h} y={start} width={LEVEL_GAUGE.band} height={end - start} rx={h} fill="rgba(0,0,0,0.32)" />
        ) : (
          <Rect x={start} y={across - h} width={end - start} height={LEVEL_GAUGE.band} rx={h} fill="rgba(0,0,0,0.32)" />
        )}
        <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tint} strokeOpacity={level ? 1 : 0.8} strokeWidth={1} />
        {[-1, 1].map((s) => {
          const p1 = pt(z, s * (h + 1));
          const p2 = pt(z, s * (h + 4));
          return <Line key={s} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="rgba(255,255,255,0.8)" strokeWidth={1} />;
        })}
        {m != null
          ? (() => {
              const p1 = pt(m, -(h + 2));
              const p2 = pt(m, h + 2);
              return <Line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={tint} strokeWidth={2} strokeLinecap="round" />;
            })()
          : null}
        <SvgText x={rect.width / 2} y={10} fill={tint} fontSize={10} fontFamily={fonts.semibold} textAnchor="middle">
          {levelLabel(value)}
        </SvgText>
      </Svg>
    </View>
  );
}

/**
 * LEVEL: camera roll (horizontal strip) and pitch (vertical strip); near plumb a bubble shows
 * the lens offset from straight down / up. Missing attitude reads "No level data".
 */
export function LevelOverlay({ feed, roll, pitch, portrait }: { feed: R; roll: number | null; pitch: number | null; portrait: boolean }) {
  if (roll != null && pitch != null && Math.abs(pitch) > 75) {
    const y = pitch > 0 ? pitch - 90 : pitch + 90;
    return (
      <View pointerEvents="none" style={{ position: 'absolute', left: feed.x + feed.width / 2 - 66, top: feed.y + feed.height / 2 - 66 }}>
        <LevelBubble x={roll} y={y} />
      </View>
    );
  }
  const frames = levelFrames(feed, portrait);
  return (
    <>
      <Gauge rect={frames.roll} axis="horizontal" value={roll} />
      {roll == null ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: frames.roll.x, width: frames.roll.width, top: frames.roll.y + frames.roll.height + 1, alignItems: 'center' }}>
          <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: 'rgba(255,255,255,0.8)', textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 }}>No level data</Text>
        </View>
      ) : null}
      {frames.tilt.height > 0 ? <Gauge rect={frames.tilt} axis="vertical" value={pitch} /> : null}
    </>
  );
}
