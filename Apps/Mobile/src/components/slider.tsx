import { Undo02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./icon";
import Animated, {
	runOnJS,
	runOnUI,
	useSharedValue,
	useAnimatedStyle,
} from "react-native-reanimated";
import { sliderValueAt } from "./slider-value";
import { type ReactNode, useRef, useEffect, useCallback, useMemo, useState } from "react";
import {
	type LayoutChangeEvent,
	StyleSheet,
	Text,
	TextInput,
	View,
	Pressable,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
	fonts,
	spacing,
	type ThemeColors,
	useTheme,
	useThemedStyles,
} from "@/constants/theme";

/**
 * The slider value a typed number stands for. A slider shows its value through `format` ("150%", "30°", "0.50s"), so
 * the number you read is mapped back through the same format at both ends: whatever scale the display uses, typing
 * what you read gives that value. Null when the display isn't a number (nothing to type).
 */
function valueFromTyped(text: string, format: (value: number) => string, min: number, max: number): number | null {
	const typed = Number.parseFloat(text.replace(",", ".").replace(/[^0-9+\-.]/g, ""));
	const low = Number.parseFloat(format(min));
	const high = Number.parseFloat(format(max));
	if (!Number.isFinite(typed) || !Number.isFinite(low) || !Number.isFinite(high) || low === high) return null;
	const value = min + ((typed - low) * (max - min)) / (high - low);
	return Math.min(max, Math.max(min, Math.round(value * 1e6) / 1e6));
}

/**
 * Labelled slider. `onChange` fires live while dragging (preview), `onEnd`
 * once on release (commit) — the same preview/commit split the web editor's
 * property fields use.
 */
const formatRounded = (value: number) => String(Math.round(value));

export function Slider({
	label,
	value,
	min,
	max,
	step = 1,
	format = formatRounded,
	onChange,
	onEnd,
	tone = "ink",
	accessory,
	resetValue,
	origin,
	track,
}: {
	label?: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	format?: (value: number) => string;
	onChange: (value: number) => void;
	onEnd: (value: number) => void;
	tone?: "ink" | "primary" | "accent";
	/** Beside the value in the label row (a keyframe ◇, say). */
	accessory?: ReactNode;
	/** Optional baseline; a small reset appears only after this value changes. */
	resetValue?: number;
	/** Where the fill starts, as a value between min and max (0, for a slider that goes both ways); the left end when unset. */
	origin?: number;
	/** Colours the track blends through, left to right (a temperature or hue slider): no fill then, just the thumb. */
	track?: readonly [string, string, ...string[]];
}) {
	const clamped = Math.min(max, Math.max(min, value));
	const width = useSharedValue(0);
	const shown = useSharedValue(clamped);
	const dragging = useSharedValue(false);
	const lastSent = useSharedValue(clamped);
	const lastSentAt = useSharedValue(0);
	const callbacks = useRef({ onChange, onEnd });
	callbacks.current = { onChange, onEnd };
	// Tap the number to type it: getting exactly 0 by dragging can take a minute.
	const [typing, setTyping] = useState<string | null>(null);
	const shownText = format(clamped);
	const unit = shownText.replace(/^[\s+\-\d.,]+/, "").trim();
	const editable = Number.isFinite(Number.parseFloat(shownText)) && valueFromTyped(shownText, format, min, max) !== null;
	const commitTyped = () => {
		const text = typing;
		setTyping(null);
		if (text === null) return;
		const next = valueFromTyped(text, format, min, max);
		if (next === null || next === clamped) return;
		runOnUI((value: number) => {
			"worklet";
			shown.set(value);
		})(next);
		callbacks.current.onChange(next);
		callbacks.current.onEnd(next);
	};
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		runOnUI((next: number) => {
			"worklet";
			if (!dragging.value) shown.set(next);
		})(clamped);
	}, [clamped, shown, dragging]);
	const change = useCallback((next: number) => {
		if (mounted.current) callbacks.current.onChange(next);
	}, []);
	const finish = useCallback(
		(next: number) => {
			if (!mounted.current) return;
			callbacks.current.onEnd(next);
			dragging.set(false);
		},
		[dragging],
	);
	// Built once per range: the parent re-renders while a drag previews, and a new gesture reconfigures the handler.
	const pan = useMemo(
		() =>
			Gesture.Pan()
				.minDistance(0)
				.onBegin((event) => {
					if (width.value <= 0) return;
					dragging.set(true);
					const next = sliderValueAt(event.x, width.value, min, max, step);
					shown.set(next);
					lastSent.set(next);
					lastSentAt.set(Date.now());
					runOnJS(change)(next);
				})
				.onUpdate((event) => {
					if (!dragging.value) return;
					const next = sliderValueAt(event.x, width.value, min, max, step);
					shown.set(next);
					const now = Date.now();
					// Keep finger feedback at display rate; plan the expensive editor preview at most 20 Hz.
					if (next !== lastSent.value && now - lastSentAt.value >= 50) {
						lastSent.set(next);
						lastSentAt.set(now);
						runOnJS(change)(next);
					}
				})
				.onFinalize(() => {
					if (dragging.value) runOnJS(finish)(shown.value);
				}),
		[change, dragging, finish, lastSent, lastSentAt, max, min, shown, step, width],
	);
	const thumbMotion = useAnimatedStyle(() => ({
		transform: [
			{
				translateX:
					((shown.value - min) / (max - min || 1)) * width.value - THUMB / 2,
			},
		],
	}));
	const fillMotion = useAnimatedStyle(() => {
		const fraction = (shown.value - min) / (max - min || 1);
		const from =
			origin === undefined
				? 0
				: Math.max(0, Math.min(1, (origin - min) / (max - min || 1)));
		return {
			transform: [
				{ translateX: ((fraction + from) / 2 - 0.5) * width.value },
				{ scaleX: Math.abs(fraction - from) },
			],
		};
	});

	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const accent = tone === "primary" ? colors.primary : colors.ink;
	const fillColor = tone === "accent" ? colors.accent : accent;

	return (
		<View style={styles.root}>
			{label ? (
				<View
					style={[
						styles.labelRow,
						resetValue !== undefined && { minHeight: 24 },
					]}
				>
					<Text style={styles.label}>{label}</Text>
					<View style={styles.valueRow}>
						{typing !== null ? (
							<View style={styles.typedRow}>
								<TextInput
									accessibilityLabel={`${label ?? "Value"}, type a number`}
									autoFocus
									selectTextOnFocus
									keyboardType="numbers-and-punctuation"
									returnKeyType="done"
									value={typing}
									onChangeText={setTyping}
									onSubmitEditing={commitTyped}
									onBlur={commitTyped}
									style={styles.typed}
								/>
								{unit ? <Text style={styles.value}>{unit}</Text> : null}
							</View>
						) : editable ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`${label ?? "Value"}, ${shownText}. Tap to type a number`}
								hitSlop={8}
								onPress={() => setTyping(shownText.replace(unit, "").trim())}
							>
								<Text style={[styles.value, styles.valueTappable]}>{shownText}</Text>
							</Pressable>
						) : (
							<Text style={styles.value}>{shownText}</Text>
						)}
						{accessory}
						{resetValue !== undefined &&
						Math.abs(clamped - resetValue) > 0.000001 ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Reset ${label ?? "value"}`}
								hitSlop={6}
								onPress={() => {
									const next = Math.max(min, Math.min(max, resetValue));
									runOnUI((value: number) => {
										"worklet";
										shown.set(value);
										dragging.set(false);
										lastSent.set(value);
									})(next);
									finish(next);
								}}
								style={({ pressed }) => ({
									width: 24,
									height: 24,
									alignItems: "center",
									justifyContent: "center",
									opacity: pressed ? 0.6 : 1,
								})}
							>
								<Icon
									icon={Undo02Icon}
									size={15}
									color={colors.mutedForeground}
								/>
							</Pressable>
						) : null}
					</View>
				</View>
			) : null}
			<GestureDetector gesture={pan}>
				<View
					accessibilityRole="adjustable"
					accessibilityLabel={label ?? "Slider"}
					accessibilityValue={{ text: format(clamped) }}
					style={styles.hit}
					onLayout={(event: LayoutChangeEvent) => {
						width.set(event.nativeEvent.layout.width);
					}}
				>
					<View style={[styles.track, track && styles.trackWide]}>
						{track ? (
							<LinearGradient
								colors={track}
								start={{ x: 0, y: 0.5 }}
								end={{ x: 1, y: 0.5 }}
								style={StyleSheet.absoluteFill}
							/>
						) : null}
						<Animated.View
							style={[
								styles.fill,
								fillMotion,
								track && { opacity: 0 },
								{
									backgroundColor: fillColor,
								},
							]}
						/>
					</View>
					<Animated.View
						style={[
							styles.thumb,
							thumbMotion,
							{
								backgroundColor: accent,
							},
						]}
					/>
				</View>
			</GestureDetector>
		</View>
	);
}

const THUMB = 22;

function createStyles(colors: ThemeColors) {
	return {
		root: { gap: spacing.xs },
		labelRow: {
			flexDirection: "row" as const,
			justifyContent: "space-between" as const,
			alignItems: "center" as const,
		},
		valueRow: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: spacing.sm,
		},
		label: { fontFamily: fonts.medium, fontSize: 13, color: colors.foreground },
		value: {
			fontFamily: fonts.medium,
			fontSize: 13,
			color: colors.mutedForeground,
			minWidth: 44,
			textAlign: "right" as const,
		},
		valueTappable: { color: colors.foreground, textDecorationLine: "underline" as const, textDecorationStyle: "dotted" as const },
		typedRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2 },
		typed: {
			fontFamily: fonts.medium,
			fontSize: 13,
			color: colors.foreground,
			minWidth: 52,
			paddingVertical: 2,
			paddingHorizontal: 8,
			borderRadius: 6,
			backgroundColor: colors.surfaceStrong,
			textAlign: "right" as const,
		},
		hit: { height: 32, justifyContent: "center" as const },
		track: {
			height: 4,
			borderRadius: 2,
			backgroundColor: colors.surfaceStrong,
			overflow: "hidden" as const,
		},
		trackWide: { height: 12, borderRadius: 6 },
		// Full-width + scaleX (from the left) so Morphlet's layout spring does
		// not interpolate width/left while dragging.
		fill: { height: 4, width: "100%" as const, backgroundColor: colors.ink },
		thumb: {
			position: "absolute" as const,
			left: 0,
			top: (32 - THUMB) / 2,
			width: THUMB,
			height: THUMB,
			borderRadius: THUMB / 2,
			backgroundColor: colors.ink,
			borderWidth: 3,
			borderColor: colors.background,
			shadowColor: "#000",
			shadowOpacity: 0.15,
			shadowRadius: 4,
			shadowOffset: { width: 0, height: 1 },
		},
	};
}
