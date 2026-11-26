import { Pressable, View } from 'react-native';
import { useCamera, type CameraState } from '@/camera';
import { MText, colors } from '@/theme';
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
import type { FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { readoutShadow, rectStyle } from '../chrome/primitives';

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
      label: e.shutterDenom && e.shutterDenom > 0 ? `EV 1/${e.shutterDenom}s` : 'EV',
      value: evLabel(e.ev),
    });
  } else {
    tiles.push({
      sheet: 'shutter',
      label: 'SHUTTER',
      value: shutterUsesAngle && !photo ? shutterAngleLabel(e.shutterDenom, s.format.fps) : shutterLabel(e.shutterDenom),
    });
  }
  tiles.push({ sheet: 'exposure', label: 'EXPOSURE', value: exposureModeLabel(e.mode) });
  tiles.push({ sheet: 'wb', label: 'WB', value: wbLabel(s.whiteBalance.preset, s.whiteBalance.kelvin) });
  tiles.push({ sheet: 'focus', label: 'FOCUS', value: FOCUS_LABEL[s.focus.mode] });
  if (s.capabilities.aperture) tiles.push({ sheet: 'aperture', label: 'APERTURE', value: apertureLabel(e.aperture) });
  if (s.capabilities.audioControls && !photo) tiles.push({ sheet: 'audio', label: 'AUDIO', value: audioLabel(s.audio.channel) });
  return tiles;
}

export function captureTileCount(s: CameraState) {
  return 5 + (s.capabilities.aperture ? 1 : 0) + (s.capabilities.audioControls && !isPhotoMode(s.format.shootingMode) ? 1 : 0);
}

function TileView({ tile, size, portrait }: { tile: Tile; size: number; portrait: boolean }) {
  const active = useLiveUi((s) => s.captureSheet === tile.sheet);
  const set = useLiveUi((s) => s.set);
  return (
    <Pressable
      testID={`monitor.capture.${tile.sheet}`}
      accessibilityRole="button"
      accessibilityLabel={tile.label}
      accessibilityValue={{ text: tile.value }}
      hitSlop={4}
      onPress={() => set({ captureSheet: active ? null : tile.sheet, gimbalPanel: 'none', zoomDialOpen: false })}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.72 : 1,
        paddingHorizontal: 2,
      })}
    >
      <MText size={size} weight="medium" mono numberOfLines={1} adjustsFontSizeToFit color={active ? colors.accent : colors.text} style={readoutShadow}>
        {tile.value}
      </MText>
      <MText
        size={portrait ? 9 : 9.5}
        weight="semibold"
        tracking={1.3}
        numberOfLines={1}
        color={active ? colors.accent : colors.secondary}
        style={[readoutShadow, { marginTop: 1 }]}
      >
        {tile.label}
      </MText>
    </Pressable>
  );
}

/** The live capture strip: one row in landscape, a three-column grid in phone portrait. */
export function CaptureControlBar({ layout }: { layout: FieldMonitorLayout }) {
  const shutterUsesAngle = usePreferences((p) => !!p.shutterUsesAngle);
  const key = useCamera((s) => JSON.stringify(captureTiles(s, shutterUsesAngle)));
  const tiles: Tile[] = JSON.parse(key);
  const locked = useLiveUi((s) => s.locked);
  const portraitGrid = layout.portrait && !layout.tablet;
  const size = layout.tablet ? 18 : 17;

  if (portraitGrid) {
    const rows: Tile[][] = [];
    for (let i = 0; i < tiles.length; i += 3) rows.push(tiles.slice(i, i + 3));
    return (
      <View
        pointerEvents={locked ? 'none' : 'box-none'}
        style={{ ...rectStyle(layout.values), opacity: locked ? 0.4 : 1, justifyContent: 'flex-end' }}
      >
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', height: 42, columnGap: 8 }}>
            {row.map((t) => (
              <TileView key={t.sheet} tile={t} size={size} portrait />
            ))}
            {row.length < 3 ? Array.from({ length: 3 - row.length }, (_, i) => <View key={`pad${i}`} style={{ flex: 1 }} />) : null}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View
      pointerEvents={locked ? 'none' : 'box-none'}
      style={{ ...rectStyle(layout.values), flexDirection: 'row', columnGap: 12, opacity: locked ? 0.4 : 1 }}
    >
      {tiles.map((t) => (
        <TileView key={t.sheet} tile={t} size={size} portrait={false} />
      ))}
    </View>
  );
}
