import type { IconSvgElement } from "@hugeicons/react-native";
import {
	Pressable,
	type PressableProps,
	Text,
	View,
} from "react-native";
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";
import { Icon } from "./icon";
import { Spinner } from "@/components/spinner";

type Variant = "primary" | "secondary" | "ghost";

interface ButtonProps extends Omit<PressableProps, "children"> {
	title: string;
	variant?: Variant;
	icon?: IconSvgElement;
	loading?: boolean;
	size?: "md" | "lg";
	/** Red label, for sign out and deletes. */
	destructive?: boolean;
}

/** Squircle button — ink primary like the web's "Import"/"Export". */
export function Button({
	title,
	variant = "primary",
	icon,
	loading = false,
	size = "md",
	destructive = false,
	disabled,
	style,
	...props
}: ButtonProps) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const labelColor = destructive
		? colors.destructive
		: variant === "primary"
			? colors.inkForeground
			: variant === "ghost"
				? colors.mutedForeground
				: colors.foreground;
	return (
		<Pressable
			accessibilityRole="button"
			disabled={disabled || loading}
			style={(state) => [
				styles.base,
				size === "lg" && styles.large,
				styles[variant],
				(disabled || loading) && styles.disabled,
				state.pressed && styles.pressed,
				typeof style === "function" ? style(state) : style,
			]}
			{...props}
		>
			{loading ? (
				<Spinner opacity={1} color={labelColor} />
			) : (
				<View style={styles.content}>
					{icon ? <Icon icon={icon} size={18} color={labelColor} /> : null}
					<Text style={[styles.label, { color: labelColor }]}>{title}</Text>
				</View>
			)}
		</Pressable>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		base: {
			minHeight: 40,
			borderRadius: radius.md,
			paddingHorizontal: spacing.md,
			alignItems: "center" as const,
			justifyContent: "center" as const,
		},
		large: { minHeight: 50, paddingHorizontal: spacing.lg },
		primary: { backgroundColor: colors.ink },
		secondary: {
			backgroundColor: colors.background,
			borderWidth: 1,
			borderColor: colors.border,
		},
		ghost: { backgroundColor: "transparent" },
		disabled: { opacity: 0.4 },
		pressed: { opacity: 0.75 },
		content: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.sm },
		label: { fontFamily: fonts.semibold, fontSize: 15 },
	};
}
