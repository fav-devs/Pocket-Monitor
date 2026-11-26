import { type ReactNode } from "react";
import {
	Platform,
	StyleSheet,
	View,
	type StyleProp,
	type ViewProps,
	type ViewStyle,
} from "react-native";
import { requireOptionalNativeModule } from "expo";
import { BlurView } from "expo-blur";
import type { GlassViewProps } from "expo-glass-effect";
import { useTheme } from "@/constants/theme";

type GlassModule = typeof import("expo-glass-effect");

function loadGlass(): GlassModule | null {
	if (Platform.OS !== "ios") return null;
	if (!requireOptionalNativeModule("ExpoGlassEffect")) return null;
	try {
		const mod = require("expo-glass-effect") as GlassModule;
		const compiled =
			typeof mod.isLiquidGlassAvailable === "function" &&
			mod.isLiquidGlassAvailable();
		const api =
			typeof mod.isGlassEffectAPIAvailable !== "function" ||
			mod.isGlassEffectAPIAvailable();
		return compiled && api ? mod : null;
	} catch {
		return null;
	}
}

const glass = loadGlass();
export const nativeGlassAvailable = glass !== null;

/** Liquid glass on iOS 26+. BlurView on older iOS. Translucent panel on Android/web. */
export function SafeGlass({
	children,
	style,
	interactive = false,
	glassEffectStyle = "regular",
	tintColor,
	colorScheme,
	...viewProps
}: ViewProps & {
	children?: ReactNode;
	style?: StyleProp<ViewStyle>;
	interactive?: boolean;
	glassEffectStyle?: GlassViewProps["glassEffectStyle"];
	tintColor?: GlassViewProps["tintColor"];
	colorScheme?: GlassViewProps["colorScheme"];
}) {
	const { scheme, colors } = useTheme();
	const tint = scheme === "dark" ? "dark" : "light";
	const wash =
		scheme === "dark" ? "rgba(22,22,22,0.72)" : "rgba(249,250,251,0.78)";
	// Shape the native material itself; an outer SVG mask would clip its optics.
	// Callers can still choose circular corners through their style.
	const surfaceStyle: StyleProp<ViewStyle> = [{ borderCurve: "continuous" }, style];
	if (glass) {
		return (
			<glass.GlassView
				{...viewProps}
				style={surfaceStyle as never}
				isInteractive={interactive}
				glassEffectStyle={glassEffectStyle}
				tintColor={tintColor}
				colorScheme={colorScheme ?? scheme}
			>
				{children}
			</glass.GlassView>
		);
	}
	const effect = typeof glassEffectStyle === "object" ? glassEffectStyle.style : glassEffectStyle;
	if (effect === "none") return <View {...viewProps} style={surfaceStyle}>{children}</View>;
	if (Platform.OS === "ios") {
		return (
			<BlurView {...viewProps} style={[surfaceStyle, tintColor ? { backgroundColor: tintColor } : undefined]} intensity={effect === "clear" ? 16 : 48} tint={colorScheme === "auto" || !colorScheme ? tint : colorScheme}>
				{children}
			</BlurView>
		);
	}
	return (
		<View
			{...viewProps}
			style={[
				{
					backgroundColor: tintColor ?? wash,
					borderColor: colors.border,
					borderWidth: StyleSheet.hairlineWidth,
				},
				surfaceStyle,
			]}
		>
			{children}
		</View>
	);
}
