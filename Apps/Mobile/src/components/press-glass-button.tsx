import { type ReactNode, useState } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import type { GlassColorScheme } from "expo-glass-effect";
import { SafeGlass } from "./safe-glass";

/** Approved in Glass Lab; control dimensions remain the caller's choice. */
export const EDITOR_PRESS_GLASS = {
	radius: 12, tintColor: "rgba(0,0,0,0.28)", expansion: 20, duration: 0,
} as const;

export function PressGlassButton({ label, size, radius, surfaceColor, tintColor,
	appearance = "auto", expansion = 20, duration = 0, disabled = false, selected = false,
	expanded, onPress, children, footer, containerStyle,
}: {
	label: string; size: number; radius: number; surfaceColor: string; tintColor?: string;
	appearance?: GlassColorScheme; expansion?: number; duration?: number;
	disabled?: boolean; selected?: boolean; expanded?: boolean; onPress: () => void;
	children: ReactNode | ((pressed: boolean) => ReactNode);
	/** A toolbar caption stays still while only the glass face expands. */
	footer?: ReactNode; containerStyle?: StyleProp<ViewStyle>;
}) {
	const [pressed, setPressed] = useState(false);
	const scale = useSharedValue(1);
	const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
	return <Pressable accessibilityRole="button" accessibilityLabel={label}
		accessibilityState={{ disabled, selected, expanded }} disabled={disabled} hitSlop={4}
		onPressIn={() => { setPressed(true); scale.value = withSpring(1 + expansion / 100, { damping: 18, stiffness: 300, mass: 0.7 }); }}
		onPressOut={() => { setPressed(false); scale.value = withSpring(1, { damping: 20, stiffness: 360, mass: 0.7 }); }}
		onPress={onPress} style={[{ width: footer ? undefined : size, height: footer ? undefined : size, alignItems: "center", gap: 6, flexShrink: 0, overflow: "visible", zIndex: pressed ? 1 : 0, opacity: disabled ? 0.3 : 1 }, containerStyle]}>
		<Animated.View style={[{ overflow: "visible" }, pressStyle]}>
			<SafeGlass interactive colorScheme={appearance} tintColor={tintColor}
				glassEffectStyle={{ style: pressed ? "regular" : "none", animate: duration > 0, animationDuration: duration / 1000 }}
				style={{ width: size, height: size, borderRadius: Math.min(radius, size / 2), alignItems: "center", justifyContent: "center", backgroundColor: pressed ? "transparent" : surfaceColor }}>
				{typeof children === "function" ? children(pressed) : children}
			</SafeGlass>
		</Animated.View>
		{footer}
	</Pressable>;
}
