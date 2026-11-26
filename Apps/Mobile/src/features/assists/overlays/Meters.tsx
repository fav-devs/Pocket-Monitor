import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Sun03Icon } from '@hugeicons/core-free-icons';
import { Icon } from '@/components/icon';
import { fonts, useTheme } from '@/constants/theme';
import {
  AUDIO_GUIDE_MARKS,
  AUDIO_RED_FROM_DB,
  AUDIO_YELLOW_FROM_DB,
  EV_METER_SPAN,
  audioFraction,
  audioLabel,
  audioZone,
  evLabel,
  evMeterFraction,
  linearFromDecibels,
  ndChipLabel,
  silentChannel,
  stepChannel,
  trafficChannelDisplay,
  type AudioMeterChannel,
  type AudioOrientation,
  type FalseColorReference,
  type NDNotation,
  type NDSuggestion,
  type TrafficLightsReading,
} from '@/core/media';
import type { AudioState } from '@/camera/types';
import { SCOPE_PANEL_FILL, plateStyles } from '../scopes/ScopePlate';

const plate = plateStyles.plate;
/** On-video text: white with the camera screen's soft shadow. */
const videoText = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 } as const;
const GOOD = '#22c55e';
const WARM = '#fedb2e';
const METER_RGB = { red: 'rgb(255,92,82)', green: 'rgb(86,235,132)', blue: 'rgb(96,158,255)' };

// ───────────────────────────── Traffic lights (goal posts) ─────────────────────────────

/** `MonitorTrafficLightsMeter`: clip lamp, balance bar around grey, crush lamp, per channel. */
export function TrafficLightsMeter({ reading, width, height }: { reading: TrafficLightsReading | null; width: number; height: number }) {
  const ui = Math.min(width / 74, height / 168);
  const colW = 11 * ui;
  const colH = 108 * ui;
  const dot = 8 * ui;
  const channels = (['red', 'green', 'blue'] as const).map((k) => ({ k, ch: reading?.[k] ?? { clip: false, crush: false, level: 0.5 } }));
  return (
    <View pointerEvents="none" style={[plate, { width, height, alignItems: 'center', paddingTop: 8 * ui }]}>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 10 * ui, color: 'rgba(255,255,255,0.88)' }}>Lights</Text>
      <View style={{ flexDirection: 'row', gap: 6 * ui, marginTop: 6 * ui }}>
        {channels.map(({ k, ch }) => {
          const shown = trafficChannelDisplay(ch.level);
          const half = (colH - 1) / 2;
          const bar = Math.max(1.5 * ui, half * shown.fill);
          const c = METER_RGB[k];
          return (
            <View key={k} style={{ alignItems: 'center', gap: 4 * ui }}>
              <View style={{ width: dot, height: dot, borderRadius: dot / 2, borderWidth: 1.5, borderColor: c, backgroundColor: ch.clip ? c : 'transparent' }} />
              <View style={{ width: colW, height: colH, borderRadius: 2 * ui, overflow: 'hidden' }}>
                <View style={{ height: half, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'flex-end' }}>
                  {shown.side === 'over' ? <View style={{ height: bar, backgroundColor: c, opacity: 0.85 }} /> : null}
                </View>
                <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.14)' }} />
                <View style={{ height: half, backgroundColor: 'rgba(255,255,255,0.08)' }}>
                  {shown.side === 'under' ? <View style={{ height: bar, backgroundColor: c, opacity: 0.85 }} /> : null}
                </View>
              </View>
              <View style={{ width: dot, height: dot, borderRadius: dot / 2, borderWidth: 1.5, borderColor: c, backgroundColor: ch.crush ? c : 'transparent' }} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ───────────────────────────── ND chip ─────────────────────────────

export function NDChip({ reading, notation, width, height }: { reading: NDSuggestion | null; notation: NDNotation; width: number; height: number }) {
  return (
    <View
      pointerEvents="none"
      accessibilityLabel="ND Suggestion"
      accessibilityValue={{ text: reading ? `${ndChipLabel(reading, notation)}${reading.needsGlass ? '' : ', no ND'}` : 'waiting for picture' }}
      style={{ width, height, borderRadius: height / 2, backgroundColor: SCOPE_PANEL_FILL, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }}
    >
      <Text numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: Math.min(13, height * 0.46), color: reading?.needsGlass ? WARM : '#ffffff' }}>
        {ndChipLabel(reading, notation)}
      </Text>
    </View>
  );
}

// ───────────────────────────── EV meter ─────────────────────────────

/** Exposure strip: readout, +3 / −3 marks, grey centre and a sun marker at the reading. */
export function EVMeter({ value, width, height }: { value: number | null; width: number; height: number }) {
  const top = 30;
  const bottom = height - 14;
  const span = bottom - top;
  const y = value == null ? null : top + evMeterFraction(value) * span;
  return (
    <View pointerEvents="none" accessibilityLabel="EV Meter" accessibilityValue={{ text: value == null ? 'no reading' : evLabel(value) }} style={{ width, height }}>
      <Text numberOfLines={1} style={{ width: Math.max(width, 52), fontFamily: fonts.semibold, fontSize: 13, color: '#ffffff', ...videoText }}>
        {value == null ? '—' : evLabel(value)}
      </Text>
      <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>
        <SvgText x={width / 2} y={top - 4} fill="rgba(255,255,255,0.85)" fontSize={9} fontFamily={fonts.medium} textAnchor="middle">
          +{EV_METER_SPAN}
        </SvgText>
        <SvgText x={width / 2} y={bottom + 11} fill="rgba(255,255,255,0.85)" fontSize={9} fontFamily={fonts.medium} textAnchor="middle">
          {`−${EV_METER_SPAN}`}
        </SvgText>
        <Line x1={width / 2} x2={width / 2} y1={top} y2={bottom} stroke="rgba(0,0,0,0.35)" strokeWidth={3} strokeLinecap="round" />
        <Line x1={width / 2} x2={width / 2} y1={top} y2={bottom} stroke="rgba(255,255,255,0.6)" strokeWidth={1} />
        <Line x1={width / 2 - 6} x2={width / 2 + 6} y1={top + span / 2} y2={top + span / 2} stroke="rgba(255,255,255,0.9)" strokeWidth={1.5} strokeLinecap="round" />
      </Svg>
      {y != null ? (
        <View style={{ position: 'absolute', left: width / 2 - 9, top: y - 9, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={Sun03Icon} size={14} color={Math.abs(value!) < 0.34 ? GOOD : '#ffffff'} strokeWidth={2} />
        </View>
      ) : null}
    </View>
  );
}

// ───────────────────────────── Audio ─────────────────────────────

/** Ballistics over the camera's reported peaks (instant attack, decay, peak hold). */
export function useAudioBallistics(audio: AudioState | null): { left: AudioMeterChannel; right: AudioMeterChannel } {
  const [levels, setLevels] = useState({ left: silentChannel(), right: silentChannel() });
  const latest = useRef(audio);
  latest.current = audio;
  useEffect(() => {
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      const a = latest.current;
      setLevels((l) => ({
        left: stepChannel(l.left, a ? linearFromDecibels(a.left.peakDb) : 0, dt),
        right: stepChannel(l.right, a ? linearFromDecibels(a.right.peakDb) : 0, dt),
      }));
    }, 50);
    return () => clearInterval(t);
  }, []);
  return levels;
}

const ZONE = { green: 'rgba(86,235,132,0.9)', yellow: 'rgba(245,208,82,0.95)', red: 'rgba(255,92,82,0.95)' };

/** `MonitorAudioMeter`: stereo dBFS bars with −18 / −6 zones and held peak ticks. */
export function AudioMeter({ left, right, orientation, showDB, width, height }: { left: AudioMeterChannel; right: AudioMeterChannel; orientation: AudioOrientation; showDB: boolean; width: number; height: number }) {
  const vertical = orientation === 'Vertical';
  const bar = 10;
  const gap = 2;
  const pairs: [string, AudioMeterChannel][] = [
    ['L', left],
    ['R', right],
  ];
  const label = vertical ? 10 : 0;
  const along0 = vertical ? 2 : 9;
  const alongLen = vertical ? height - label - 2 : width - 9 - (showDB ? 22 : 1);
  const pos = (db: number) => (vertical ? along0 + alongLen - audioFraction(db) * alongLen : along0 + audioFraction(db) * alongLen);
  const cross = vertical ? width : height;
  const pairSpan = bar * 2 + gap;
  return (
    <View pointerEvents="none" accessibilityLabel="Audio Levels" accessibilityValue={{ text: `Left ${audioLabel(left.levelDB)} dBFS, right ${audioLabel(right.levelDB)} dBFS` }} style={[plate, { width, height }]}>
      <Svg width={width} height={height}>
        {vertical
          ? AUDIO_GUIDE_MARKS.map((m) => <Line key={m} x1={0} x2={width} y1={pos(m)} y2={pos(m)} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />)
          : null}
        {pairs.map(([name, ch], i) => {
          const c0 = cross / 2 - pairSpan / 2 + i * (bar + gap);
          const track = vertical ? { x: c0, y: along0, w: bar, h: alongLen } : { x: along0, y: c0, w: alongLen, h: bar };
          const zones: [number, number, string][] = [
            [-60, AUDIO_YELLOW_FROM_DB, ZONE.green],
            [AUDIO_YELLOW_FROM_DB, AUDIO_RED_FROM_DB, ZONE.yellow],
            [AUDIO_RED_FROM_DB, 0, ZONE.red],
          ];
          const level = ch.levelDB;
          return [
            <Rect key={`${name}t`} x={track.x} y={track.y} width={track.w} height={track.h} rx={2} fill="rgba(255,255,255,0.08)" />,
            ...zones.map(([lo, hi, color], zi) => {
              const top = Math.min(hi, level);
              if (top <= lo) return null;
              const a = pos(lo);
              const b = pos(top);
              return vertical ? (
                <Rect key={`${name}z${zi}`} x={track.x} y={Math.min(a, b)} width={bar} height={Math.abs(a - b)} fill={color} />
              ) : (
                <Rect key={`${name}z${zi}`} x={Math.min(a, b)} y={track.y} width={Math.abs(a - b)} height={bar} fill={color} />
              );
            }),
            ch.peakDB > -59.5 ? (
              vertical ? (
                <Line key={`${name}p`} x1={track.x} x2={track.x + bar} y1={pos(ch.peakDB)} y2={pos(ch.peakDB)} stroke={ZONE[audioZone(ch.peakDB)]} strokeWidth={1.5} />
              ) : (
                <Line key={`${name}p`} y1={track.y} y2={track.y + bar} x1={pos(ch.peakDB)} x2={pos(ch.peakDB)} stroke={ZONE[audioZone(ch.peakDB)]} strokeWidth={1.5} />
              )
            ) : null,
            <SvgText
              key={`${name}l`}
              x={vertical ? track.x + bar / 2 : 5}
              y={vertical ? height - 2 : track.y + bar / 2 + 3}
              fill="rgba(255,255,255,0.75)"
              fontSize={8}
              fontFamily={fonts.semibold}
              textAnchor="middle"
            >
              {name}
            </SvgText>,
            showDB ? (
              <SvgText
                key={`${name}d`}
                x={vertical ? track.x + bar / 2 : width - 11}
                y={vertical ? track.y + 9 : track.y + bar / 2 + 2.5}
                fill="rgba(255,255,255,0.8)"
                fontSize={6.5}
                fontFamily={fonts.medium}
                textAnchor="middle"
              >
                {audioLabel(level)}
              </SvgText>
            ) : null,
          ];
        })}
      </Svg>
    </View>
  );
}

// ───────────────────────────── False colour reference ─────────────────────────────

export const FALSE_COLOR_LEGEND_SIZE = { width: 264, height: 52 };

/** `MonitorFalseColorReference`: compact colour key over the live picture (dark plate), or themed in a sheet. */
export function FalseColorLegend({ reference, inspector }: { reference: FalseColorReference; inspector?: boolean }) {
  const { colors } = useTheme();
  const w = inspector ? undefined : FALSE_COLOR_LEGEND_SIZE.width - 18;
  const barH = inspector ? 14 : 8;
  const labelStyle = inspector
    ? { fontFamily: fonts.medium, fontSize: 10, color: colors.mutedForeground }
    : { fontFamily: fonts.medium, fontSize: 8, color: 'rgba(255,255,255,0.75)' };
  const labelH = inspector ? 13 : 10;
  return (
    <View
      pointerEvents="none"
      accessibilityLabel="False color reference key"
      style={
        inspector
          ? { gap: 5 }
          : [plate, { width: FALSE_COLOR_LEGEND_SIZE.width, height: FALSE_COLOR_LEGEND_SIZE.height, paddingHorizontal: 9, paddingTop: 6, gap: 4, backgroundColor: 'rgba(0,0,0,0.6)' }]
      }
    >
      {!inspector ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', height: 14 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: '#ffffff' }}>False color</Text>
          <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 9.5, color: 'rgba(255,255,255,0.7)', flexShrink: 1, marginLeft: 8 }}>
            {reference.subtitle}
          </Text>
        </View>
      ) : null}
      <View style={{ height: barH, width: w, borderRadius: inspector ? 5 : 3, overflow: 'hidden' }}>
        <Svg width="100%" height={barH}>
          <Defs>
            <LinearGradient id="fcNeutral" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="rgb(138,138,138)" />
              <Stop offset="1" stopColor="rgb(191,191,191)" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={barH} fill="url(#fcNeutral)" />
          {reference.segments.map((s, i) => (
            <Rect
              key={i}
              x={`${s.lower * 100}%`}
              y={0}
              width={`${Math.max(0.4, (s.upper - s.lower) * 100)}%`}
              height={barH}
              fill={`rgb(${Math.round(s.r * 255)},${Math.round(s.g * 255)},${Math.round(s.b * 255)})`}
            />
          ))}
        </Svg>
      </View>
      {reference.markers.length ? (
        <View style={{ height: labelH, width: w }}>
          {reference.markers.map((m, i) => (
            <Text
              key={i}
              numberOfLines={1}
              style={[labelStyle, { position: 'absolute', width: 32, textAlign: 'center', left: `${m.fraction * 100}%`, transform: [{ translateX: -16 }] }]}
            >
              {m.label}
            </Text>
          ))}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: w, height: labelH }}>
          {reference.axisLabels.map((l) => (
            <Text key={l} style={labelStyle}>
              {l}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/** Level bubble for a camera pointing near straight down / up. */
export function LevelBubble({ x, y }: { x: number; y: number }) {
  const r = 64;
  const span = 10;
  const d = Math.hypot(x, y);
  const level = d < 0.6;
  const k = d > span ? span / d : 1;
  const tint = level ? GOOD : WARM;
  return (
    <Svg width={2 * r + 4} height={2 * r + 4}>
      <Circle cx={r + 2} cy={r + 2} r={r} stroke="rgba(255,255,255,0.22)" strokeWidth={2} fill="none" />
      <Circle cx={r + 2} cy={r + 2} r={r / 2} stroke="rgba(255,255,255,0.34)" strokeWidth={1} fill="none" />
      <Line x1={r + 2 - 9} x2={r + 2 + 9} y1={r + 2} y2={r + 2} stroke="rgba(255,255,255,0.75)" strokeWidth={2} />
      <Line y1={r + 2 - 9} y2={r + 2 + 9} x1={r + 2} x2={r + 2} stroke="rgba(255,255,255,0.75)" strokeWidth={2} />
      <Circle cx={r + 2 + (x * k * r) / span} cy={r + 2 - (y * k * r) / span} r={6.5} fill={tint} />
    </Svg>
  );
}
