import { Pressable, Text, View } from 'react-native';
import { useCamera, type CameraState } from '@/camera';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import {
  FOCUS_LABEL,
  apertureLabel,
  audioLabel,
  evLabel,
  exposureModeLabel,
  isPhotoMode,
  isoLabel,
  shutterAngleLabel,
  shutterLabel,
  wbLabel,
} from '../format';
import { READOUT_PAD, READOUT_TILE_H, type FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { onVideo, rectStyle } from '../chrome/primitives';

interface Tile {
  sheet: CaptureSheetId;
  label: string;
  value: string;
}

/** The tiles the strip offers, in upstream order (`CaptureControlBar`). */
export function captureTiles(s: CameraState, shutterUsesAngle: boolean): Tile[] {
  const e = s.exposure;
  const photo = isPhotoMode(s.format.shootingMode);
  const tiles: Tile[] = [{ sheet: 'iso', label: 'ISO', value: isoLabel(e.iso, e.isoAuto) }];
  if (e.mode === 'auto') {
    tiles.push({
      sheet: 'ev',
      label: e.shutterDenom && e.shutterDenom > 0 ? `EV 1/${e.shutterDenom}` : 'EV',
      value: evLabel(e.ev),
    });
  } else {
    tiles.push({
      sheet: 'shutter',
      label: 'Shutter',
      value: shutterUsesAngle && !photo ? shutterAngleLabel(e.shutterDenom, s.format.fps) : shutterLabel(e.shutterDenom),
    });
  }
  tiles.push({ sheet: 'exposure', label: 'Exposure', value: exposureModeLabel(e.mode) });
  tiles.push({ sheet: 'wb', label: 'WB', value: wbLabel(s.whiteBalance.preset, s.whiteBalance.kelvin) });
  tiles.push({ sheet: 'focus', label: 'Focus', value: FOCUS_LABEL[s.focus.mode] });
  if (s.capabilities.aperture) tiles.push({ sheet: 'aperture', label: 'Aperture', value: apertureLabel(e.aperture) });
  if (s.capabilities.audioControls && !photo) tiles.push({ sheet: 'audio', label: 'Audio', value: audioLabel(s.audio.channel) });
  return tiles;
}

export function captureTileCount(s: CameraState) {
  return 5 + (s.capabilities.aperture ? 1 : 0) + (s.capabilities.audioControls && !isPhotoMode(s.format.shootingMode) ? 1 : 0);
}

function TileView({ tile, fill }: { tile: Tile; fill: boolean }) {
  const styles = useThemedStyles(createStyles);
  const active = useLiveUi((s) => s.captureSheet === tile.sheet);
  const set = useLiveUi((s) => s.set);
  return (
    <Pressable
      testID={`monitor.capture.${tile.sheet}`}
      accessibilityRole="button"
      accessibilityLabel={tile.label}
      accessibilityValue={{ text: tile.value }}
      accessibilityState={{ selected: active }}
      onPress={() => set({ captureSheet: active ? null : tile.sheet, gimbalPanel: 'none', zoomDialOpen: false })}
      style={({ pressed }) => [styles.tile, fill && styles.tileFill, active && styles.tileActive, pressed && !active && styles.pressed]}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.value, active && styles.valueActive]}>
        {tile.value}
      </Text>
      <Text numberOfLines={1} style={[styles.caption, active && styles.captionActive]}>
        {tile.label}
      </Text>
    </Pressable>
  );
}

/**
 * The capture readout strip: the values on one dark plate, each a tap target that opens its
 * sheet; the open one turns white (ai-cut's options-over-video). One row in landscape, rows of
 * `valuesPerRow` in portrait.
 */
export function CaptureControlBar({ layout }: { layout: FieldMonitorLayout }) {
  const styles = useThemedStyles(createStyles);
  const shutterUsesAngle = usePreferences((p) => !!p.shutterUsesAngle);
  const key = useCamera((s) => JSON.stringify(captureTiles(s, shutterUsesAngle)));
  const tiles: Tile[] = JSON.parse(key);
  const locked = useLiveUi((s) => s.locked);

  if (layout.portrait) {
    const per = Math.max(1, layout.valuesPerRow);
    const rows: Tile[][] = [];
    for (let i = 0; i < tiles.length; i += per) rows.push(tiles.slice(i, i + per));
    return (
      <View pointerEvents={locked ? 'none' : 'box-none'} style={[rectStyle(layout.values), styles.plate, locked && styles.locked]}>
        {rows.map((row, r) => (
          <View key={r} style={styles.row}>
            {row.map((t) => (
              <TileView key={t.sheet} tile={t} fill />
            ))}
            {row.length < per ? Array.from({ length: per - row.length }, (_, i) => <View key={`pad${i}`} style={styles.tileFill} />) : null}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View pointerEvents="box-none" style={[rectStyle(layout.values), styles.centre]}>
      <View pointerEvents={locked ? 'none' : 'auto'} style={[styles.plate, styles.row, locked && styles.locked]}>
        {tiles.map((t) => (
          <TileView key={t.sheet} tile={t} fill={false} />
        ))}
      </View>
    </View>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    centre: { alignItems: 'center' as const, justifyContent: 'flex-end' as const },
    plate: { padding: READOUT_PAD, borderRadius: 14, backgroundColor: onVideo.plate, maxWidth: '100%' as const },
    row: { flexDirection: 'row' as const, height: READOUT_TILE_H },
    tile: {
      minWidth: 58,
      height: READOUT_TILE_H,
      paddingHorizontal: 8,
      borderRadius: 10,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    tileFill: { flex: 1, minWidth: 0, paddingHorizontal: 2 },
    tileActive: { backgroundColor: onVideo.chosen },
    value: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 18, color: onVideo.ink, fontVariant: ['tabular-nums' as const] },
    valueActive: { color: onVideo.dark },
    caption: { fontFamily: fonts.medium, fontSize: 10, lineHeight: 13, color: onVideo.inkMuted },
    captionActive: { color: 'rgba(17,17,17,0.6)' },
    locked: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
  };
}
