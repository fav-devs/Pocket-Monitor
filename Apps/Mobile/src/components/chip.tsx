import { Pressable, Text, type StyleProp, type ViewStyle } from "react-native";
import { fonts, radius, spacing, type ThemeColors, useThemedStyles } from "@/constants/theme";

/** Segmented choice (aspect ratios, speeds, fps) — selected uses the ink surface. */
export function Chip({
	label,
	selected,
	onPress,
	disabled = false,
	style,
}: {
	label: string;
	selected: boolean;
	onPress: () => void;
	disabled?: boolean;
	style?: StyleProp<ViewStyle>;
}) {
	const styles = useThemedStyles(createStyles);
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ selected, disabled }}
			accessibilityLabel={label}
			onPress={onPress}
			disabled={disabled}
			style={({ pressed }) => [
				styles.chip,
				selected && styles.selected,
				disabled && { opacity: 0.4 },
				pressed && { opacity: 0.7 },
				style,
			]}
		>
			<Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
		</Pressable>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		chip: {
			paddingHorizontal: spacing.md - 2,
			paddingVertical: 8,
			borderRadius: radius.sm,
			borderWidth: 1,
			borderColor: colors.border,
			backgroundColor: colors.background,
			alignItems: "center" as const,
			justifyContent: "center" as const,
		},
		selected: { backgroundColor: colors.ink, borderColor: colors.ink },
		label: { fontFamily: fonts.medium, fontSize: 13, color: colors.foreground },
		selectedLabel: { color: colors.inkForeground },
	};
}
