import { View } from 'react-native';
import type { PictureRect } from '@/camera';

/**
 * Stub — the assists feature replaces this. Draws every non-per-pixel assist (grid, guides,
 * crosshair, level, meters, scopes panels, legends) inside the picture rect.
 */
export default function AssistOverlays(_props: { pictureRect: PictureRect; context: 'live' | 'playback' }) {
  return <View pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }} />;
}
