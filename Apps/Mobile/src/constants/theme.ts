import {
	createContext,
	createElement,
	useContext,
	useMemo,
	type ReactNode,
} from "react";
import { StyleSheet, useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, type Theme } from "expo-router";

export type ThemeColors = {
	background: string;
	foreground: string;
	mutedForeground: string;
	panel: string;
	surface: string;
	surfaceStrong: string;
	border: string;
	borderStrong: string;
	primary: string;
	primarySoft: string;
	primarySoftBorder: string;
	ink: string;
	inkForeground: string;
	accent: string;
	page: string;
	pageMuted: string;
	mint: string;
	dotPink: string;
	dotBlue: string;
	dotYellow: string;
	destructive: string;
	destructiveSoft: string;
	success: string;
	warning: string;
	preview: string;
	clip: string;
	clipBorder: string;
	clipBand: string;
	fab: string;
	fabForeground: string;
};

const shared = {
	primary: "#17a9f3",
	accent: "#fedb2e",
	mint: "#21ffd6",
	dotPink: "#d6155f",
	dotBlue: "#3b4ee8",
	dotYellow: "#fedb2e",
	success: "#22c55e",
	preview: "#000000",
} as const;

const lightColors: ThemeColors = {
	...shared,
	background: "#ffffff",
	foreground: "#1c1c1c",
	mutedForeground: "#808080",
	panel: "#f9fafb",
	surface: "#f5f5f5",
	surfaceStrong: "#ebebeb",
	border: "#e8e8e8",
	borderStrong: "#dedede",
	primarySoft: "#f0f8ff",
	primarySoftBorder: "#e0f1ff",
	ink: "#1c1c1c",
	inkForeground: "#ffffff",
	page: "#f2f2f2",
	pageMuted: "#666666",
	destructive: "#e51b1b",
	destructiveSoft: "#fdeeee",
	warning: "#d97706",
	clip: "#eef1f5",
	clipBorder: "#d9dee5",
	clipBand: "#bfe6fb",
	fab: "#1c1c1c",
	fabForeground: "#ffffff",
};

const darkColors: ThemeColors = {
	...shared,
	background: "#0d0d0d",
	foreground: "#f4f4f4",
	mutedForeground: "#8b8b8b",
	panel: "#161616",
	surface: "#1a1a1a",
	surfaceStrong: "#242424",
	border: "#2a2a2a",
	borderStrong: "#3a3a3a",
	primarySoft: "#0a2540",
	primarySoftBorder: "#16445a",
	ink: "#f4f4f4",
	inkForeground: "#111111",
	page: "#0d0d0d",
	pageMuted: "#8b8b8b",
	destructive: "#ff6b6b",
	destructiveSoft: "#3a1515",
	warning: "#fbbf24",
	clip: "#2a2e35",
	clipBorder: "#3a4048",
	clipBand: "#1a4a66",
	fab: "#ffffff",
	fabForeground: "#111111",
};

export const fonts = {
	regular: "SNPro_400Regular",
	medium: "SNPro_500Medium",
	semibold: "SNPro_600SemiBold",
	bold: "SNPro_700Bold",
	mono: "SNPro_500Medium",
} as const;

export const spacing = {
	xs: 4,
	sm: 8,
	md: 16,
	lg: 24,
	xl: 32,
} as const;

export const radius = {
	sm: 10,
	md: 16,
	lg: 22,
	xl: 28,
	pill: 999,
} as const;

type AppTheme = {
	scheme: "light" | "dark";
	colors: ThemeColors;
	navigationTheme: Theme;
};

const ThemeContext = createContext<AppTheme | null>(null);

function navigationThemeFor(
	scheme: "light" | "dark",
	colors: ThemeColors,
): Theme {
	const base = scheme === "dark" ? DarkTheme : DefaultTheme;
	return {
		...base,
		colors: {
			...base.colors,
			primary: colors.primary,
			background: colors.background,
			card: colors.background,
			text: colors.foreground,
			border: colors.border,
		},
	};
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
	const scheme = useColorScheme() === "dark" ? "dark" : "light";
	const colors = scheme === "dark" ? darkColors : lightColors;
	const value = useMemo<AppTheme>(
		() => ({
			scheme,
			colors,
			navigationTheme: navigationThemeFor(scheme, colors),
		}),
		[scheme, colors],
	);
	return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): AppTheme {
	const theme = useContext(ThemeContext);
	if (!theme) throw new Error("useTheme must be used inside AppThemeProvider");
	return theme;
}

export function useThemedStyles<
	T extends Parameters<typeof StyleSheet.create>[0],
>(factory: (colors: ThemeColors) => T): T {
	const { colors } = useTheme();
	return useMemo(() => themedStyles(factory, colors), [colors, factory]);
}

/** Each factory's styles per palette, made once and shared by every instance (StyleSheet.create is slow on web). */
const themedStylesCache = new WeakMap<object, WeakMap<ThemeColors, unknown>>();

function themedStyles<T extends Parameters<typeof StyleSheet.create>[0]>(factory: (colors: ThemeColors) => T, colors: ThemeColors): T {
	let byColors = themedStylesCache.get(factory);
	if (!byColors) themedStylesCache.set(factory, (byColors = new WeakMap()));
	const held = byColors.get(colors);
	if (held) return held as T;
	const made = buildThemedStyles(factory, colors);
	byColors.set(colors, made);
	return made;
}

function buildThemedStyles<T extends Parameters<typeof StyleSheet.create>[0]>(factory: (colors: ThemeColors) => T, colors: ThemeColors): T {
	// Continuous corners are the app's default, rather than an opt-in on each new surface.
	// Explicit curves, circles, and capsules retain their intended geometry.
	const styles = Object.fromEntries(
		Object.entries(factory(colors)).map(([key, value]) => {
			const style = value as {
				borderRadius?: number;
				borderCurve?: "circular" | "continuous";
				width?: number | string;
				height?: number | string;
			};
			const r = style.borderRadius;
			const capsule =
				typeof style.width === "number" &&
				typeof style.height === "number" &&
				r !== undefined &&
				r >= Math.min(style.width, style.height) / 2;
			const smooth =
				typeof r === "number" &&
				r > 0 &&
				r < radius.pill &&
				!capsule &&
				style.borderCurve === undefined;
			return [key, smooth ? { ...style, borderCurve: "continuous" } : value];
		}),
	) as T;
	return StyleSheet.create(styles);
}
