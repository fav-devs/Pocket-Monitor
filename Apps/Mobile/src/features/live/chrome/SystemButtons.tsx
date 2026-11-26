import {
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowShrink02Icon,
  Film02Icon,
  LockIcon,
  Settings02Icon,
  SquareUnlock02Icon,
} from '@hugeicons/core-free-icons';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/icon';
import { type ThemeColors, useThemedStyles } from '@/constants/theme';
import { haptics } from '../haptics';
import { useLiveUi } from '../liveUiStore';
import { RailButton, onVideo } from './primitives';

/** `LiveLockButton`: locks every other live control (lock stays reachable). */
export function LiveLockButton() {
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  return (
    <RailButton
      testID="monitor.system.lock"
      icon={locked ? LockIcon : SquareUnlock02Icon}
      label={locked ? 'Unlock controls' : 'Lock controls'}
      caption={locked ? 'Locked' : 'Lock'}
      active={locked}
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
export function LiveDispToggle() {
  const disp = useLiveUi((s) => s.disp);
  const set = useLiveUi((s) => s.set);
  const styles = useThemedStyles(createStyles);
  return (
    <RailButton
      testID="monitor.system.display"
      label="Display"
      caption="DISP"
      accessibilityValue={{ text: disp === 'live' ? 'Controls shown' : 'Clean picture' }}
      onPress={() => {
        haptics.light();
        set({ disp: disp === 'live' ? 'clean' : 'live', captureSheet: null, zoomDialOpen: false });
      }}
    >
      <View style={styles.dashes}>
        <View style={[styles.dash, disp === 'live' && styles.dashOn]} />
        <View style={[styles.dash, disp === 'clean' && styles.dashOn]} />
      </View>
    </RailButton>
  );
}

export function LiveSettingsButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return <RailButton testID="monitor.system.settings" icon={Settings02Icon} label="Settings" onPress={onPress} disabled={disabled} />;
}

export function LiveMediaButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return <RailButton testID="monitor.system.media" icon={Film02Icon} label="Camera media" caption="Media" onPress={onPress} disabled={disabled} />;
}

/** Back to the camera list (closes the viewfinder, disconnects). ai-cut's close: a plain white glyph. */
export function LiveBackButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID="monitor.system.back"
      accessibilityRole="button"
      accessibilityLabel="Back to cameras"
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.back, disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
    >
      <Icon icon={ArrowLeft01Icon} size={20} color={onVideo.ink} strokeWidth={2} />
    </Pressable>
  );
}

/** `PortraitAspectToggle`: FIT ↔ FILL for the portrait picture. */
export function PortraitAspectToggle({ fill, onPress, disabled }: { fill: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <RailButton
      icon={fill ? ArrowShrink02Icon : ArrowExpand01Icon}
      label={fill ? 'Fit picture' : 'Fill picture'}
      caption={fill ? 'Fit' : 'Fill'}
      onPress={onPress}
      disabled={disabled}
    />
  );
}

function createStyles(colors: ThemeColors) {
  return {
    dashes: { flexDirection: 'row' as const, gap: 3 },
    dash: { width: 9, height: 3, borderRadius: 1.5, backgroundColor: onVideo.inkFaint },
    dashOn: { backgroundColor: colors.accent },
    back: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: onVideo.pill,
    },
  };
}
