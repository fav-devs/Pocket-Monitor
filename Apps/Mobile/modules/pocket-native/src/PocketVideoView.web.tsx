import { View, type ViewProps } from 'react-native';
import type { ScopeViewProps, VideoViewProps } from './types';

// The web picture and scopes are drawn by src/features/picture (WebGL/canvas), not here.
export function PocketVideoView(props: VideoViewProps & ViewProps) {
  return <View {...props} style={[{ backgroundColor: '#000' }, props.style]} />;
}
export function PocketScopeView(props: ScopeViewProps & ViewProps) {
  return <View {...props} />;
}
export const hasNativeVideo = false;
