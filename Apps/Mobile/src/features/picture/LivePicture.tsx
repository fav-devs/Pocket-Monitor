import { View, type LayoutRectangle } from 'react-native';
import type { VideoSource } from '@/camera';

export interface LivePictureProps {
  source: VideoSource;
  resizeMode?: 'fit' | 'fill';
  /** Reports where the picture is drawn inside this view (for overlays and touch mapping). */
  onPictureRect?: (rect: LayoutRectangle) => void;
}

/** Stub — the picture feature replaces this (native decoder view / WebGL demo renderer + effects). */
export default function LivePicture(_props: LivePictureProps) {
  return <View style={{ flex: 1, backgroundColor: '#000' }} />;
}
