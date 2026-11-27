import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Icon } from '@/components/icon';
import { monitorPanel as P } from '@/constants/monitor';
import type { MonitorSheetPlacement } from '../layout/fieldMonitorLayout';

/**
 * A compact dark panel docked against the leading strip (Mimo's exposure, format and settings
 * panels): `rgba(20,20,20,0.92)`, rounded only on its open side, plain rows. Landscape docks it
 * at `placement.dock`; portrait lays it under the picture from `placement.topInset`. It sits in
 * the screen's own tree, so it drives whatever camera the surrounding scope holds.
 */
export function MonitorPanel({
  placement,
  visible,
  full = false,
  width,
  testID,
  label,
  children,
  scroll = true,
  onClose,
}: {
  placement: MonitorSheetPlacement;
  visible: boolean;
  /** Full height of the dock (the settings panel); otherwise sized to its content. */
  full?: boolean;
  /** Overrides the dock width (narrower panels such as exposure). */
  width?: number;
  testID?: string;
  label: string;
  children: ReactNode;
  /** The body scrolls (default); off when the body owns its own scroll or gestures. */
  scroll?: boolean;
  /** Portrait: a close key on the panel's top edge (the strip button it came from is under it). */
  onClose?: () => void;
}) {
  const { width: winW, height: winH } = useWindowDimensions();
  const t = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: visible ? 1 : 0, duration: 160, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [visible, t]);
  if (!visible) return null;

  const dock = placement.dock;
  const frame = dock
    ? {
        left: dock.left,
        top: dock.top,
        width: Math.min(width ?? dock.width, dock.width),
        maxHeight: dock.bottom - dock.top,
        ...(full ? { height: dock.bottom - dock.top } : null),
        borderTopRightRadius: P.radius,
        borderBottomRightRadius: P.radius,
      }
    : {
        left: 0,
        right: 0,
        top: placement.topInset,
        bottom: placement.bottomInset ?? 0,
        borderRadius: P.radius,
      };
  const slide = dock
    ? { transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }] }
    : { transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }] };
  const maxH = dock ? dock.bottom - dock.top : winH - placement.topInset - (placement.bottomInset ?? 0) - (onClose ? 32 : 0);
  // Under the picture the panel covers other controls, so it is near-opaque there.
  const fill = dock ? P.fill : 'rgba(20,20,20,0.98)';
  const closeKey =
    !dock && onClose ? (
      <View style={{ height: 32, alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: 6 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Close ${label}`} hitSlop={8} onPress={onClose} style={{ width: 44, height: 32, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={Cancel01Icon} size={18} color={P.muted} strokeWidth={2} />
        </Pressable>
      </View>
    ) : null;
  return (
    <Animated.View
      testID={testID}
      accessibilityLabel={label}
      accessibilityViewIsModal={false}
      style={[{ position: 'absolute', backgroundColor: fill, overflow: 'hidden', opacity: t, maxWidth: winW }, frame, slide]}
    >
      {closeKey}
      {scroll ? (
        <ScrollView
          style={{ maxHeight: maxH }}
          contentContainerStyle={{ paddingBottom: dock ? 8 : 24 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: full || !dock ? 1 : undefined, maxHeight: maxH }}>{children}</View>
      )}
    </Animated.View>
  );
}
