import { requireNativeView } from 'expo';
import { Platform, View, type ViewProps } from 'react-native';
import type { ScopeViewProps, VideoViewProps } from './types';
import { PocketVideo } from './native';

const NativeVideoView: React.ComponentType<VideoViewProps & ViewProps> | null =
  PocketVideo && Platform.OS !== 'web' ? requireNativeView('PocketVideo', 'PocketVideoView') : null;
const NativeScopeView: React.ComponentType<ScopeViewProps & ViewProps> | null =
  PocketVideo && Platform.OS !== 'web' ? requireNativeView('PocketVideo', 'PocketScopeView') : null;

/** Native decoded picture with GPU effects. Renders black if the native module is missing. */
export function PocketVideoView(props: VideoViewProps & ViewProps) {
  if (!NativeVideoView) return <View {...props} style={[{ backgroundColor: '#000' }, props.style]} />;
  return <NativeVideoView {...props} />;
}

/** Native GPU scope (waveform / parade / histogram / vectorscope) fed straight from the decoder. */
export function PocketScopeView(props: ScopeViewProps & ViewProps) {
  if (!NativeScopeView) return <View {...props} />;
  return <NativeScopeView {...props} />;
}

export const hasNativeVideo = NativeVideoView != null;
