import { Pressable, View } from 'react-native';
import { useCamera } from '@/camera';
import { MText, colors, radius, withAlpha } from '@/theme';
import { elapsedLabel } from '../format';
import { useLiveUi } from '../liveUiStore';
import { PanelSurface } from '../chrome/primitives';

/** Optional stop-recording confirmation (Settings → Recording → Confirm stop). */
export function StopConfirmSheet({ onStop }: { onStop: () => void }) {
  const open = useLiveUi((s) => s.stopConfirmOpen);
  const set = useLiveUi((s) => s.set);
  const recording = useCamera((s) => s.recording.recording);
  const elapsed = useCamera((s) => s.recording.elapsedSec);
  if (!open || !recording) return null;
  const cancel = () => set({ stopConfirmOpen: false });
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable accessibilityLabel="Cancel" onPress={cancel} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }} />
      <PanelSurface radius={radius.lg} style={{ width: 300, padding: 18, gap: 12 }}>
        <View accessibilityRole="header">
          <MText size={16} weight="semibold">
            Stop recording?
          </MText>
          <MText size={12} color={colors.muted}>
            Take length {elapsedLabel(elapsed)}
          </MText>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            onPress={cancel}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 44,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: withAlpha('#FFFFFF', 0.08),
              opacity: pressed ? 0.72 : 1,
            })}
          >
            <MText size={14} weight="semibold">
              Cancel
            </MText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onStop}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 44,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.recording,
              opacity: pressed ? 0.72 : 1,
            })}
          >
            <MText size={14} weight="semibold">
              Stop
            </MText>
          </Pressable>
        </View>
      </PanelSurface>
    </View>
  );
}
