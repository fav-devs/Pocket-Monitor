import { ChevronLeft, Clapperboard, Expand, Lock, LockOpen, Settings, Shrink } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { MText, colors, radius } from '@/theme';
import { haptics } from '../haptics';
import { useLiveUi } from '../liveUiStore';
import { ChromeButton } from './primitives';

/** `LiveLockButton`: locks every other live control (lock stays reachable). */
export function LiveLockButton({ size }: { size: number }) {
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  return (
    <ChromeButton
      testID="monitor.system.lock"
      icon={locked ? Lock : LockOpen}
      label={locked ? 'Unlock controls' : 'Lock controls'}
      active={locked}
      size={size}
      onPress={() => {
        haptics.medium();
        // The Motion Control run pill stays: Stop must remain reachable while locked.
        const panel = useLiveUi.getState().gimbalPanel;
        set({ locked: !locked, captureSheet: null, gimbalPanel: panel === 'runPill' ? 'runPill' : 'none', zoomDialOpen: false });
      }}
    />
  );
}

/** `LiveDispToggle`: DISP 1 (live chrome) ↔ DISP 2 (clean picture). Two dashes show which. */
export function LiveDispToggle({ width, height }: { width: number; height: number }) {
  const disp = useLiveUi((s) => s.disp);
  const set = useLiveUi((s) => s.set);
  return (
    <Pressable
      testID="monitor.system.display"
      accessibilityRole="button"
      accessibilityLabel="Display"
      accessibilityValue={{ text: disp === 'live' ? 'Controls shown' : 'Clean picture' }}
      hitSlop={Math.max(0, (44 - height) / 2)}
      onPress={() => {
        haptics.light();
        set({ disp: disp === 'live' ? 'clean' : 'live', captureSheet: null, zoomDialOpen: false });
      }}
      style={({ pressed }) => ({
        width,
        height,
        borderRadius: radius.md + 2,
        backgroundColor: 'rgba(20,21,22,0.78)',
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <MText size={13} weight="semibold" tracking={0.8} color={colors.secondary}>
        DISP
      </MText>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        <View style={{ width: 11, height: 3, borderRadius: 1.5, backgroundColor: disp === 'live' ? colors.accent : colors.faint }} />
        <View style={{ width: 11, height: 3, borderRadius: 1.5, backgroundColor: disp === 'clean' ? colors.accent : colors.faint }} />
      </View>
    </Pressable>
  );
}

export function LiveSettingsButton({ size, onPress, disabled }: { size: number; onPress: () => void; disabled?: boolean }) {
  return <ChromeButton testID="monitor.system.settings" icon={Settings} label="Settings" size={size} onPress={onPress} disabled={disabled} />;
}

export function LiveMediaButton({ size, onPress, disabled }: { size: number; onPress: () => void; disabled?: boolean }) {
  return <ChromeButton testID="monitor.system.media" icon={Clapperboard} label="Camera media" size={size} onPress={onPress} disabled={disabled} />;
}

/** Back to the camera list (closes the viewfinder, disconnects). */
export function LiveBackButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      testID="monitor.system.back"
      accessibilityRole="button"
      accessibilityLabel="Back to cameras"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(0,0,0,0.45)',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
      })}
    >
      <ChevronLeft size={22} color={colors.text} />
    </Pressable>
  );
}

/** `PortraitAspectToggle`: FIT ↔ FILL for the portrait picture. */
export function PortraitAspectToggle({ fill, onPress, disabled }: { fill: boolean; onPress: () => void; disabled?: boolean }) {
  const Icon = fill ? Shrink : Expand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={fill ? 'Fit picture' : 'Fill picture'}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(0,0,0,0.55)',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
      })}
    >
      <Icon size={18} color={colors.text} />
    </Pressable>
  );
}
