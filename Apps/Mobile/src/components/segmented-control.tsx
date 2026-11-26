import type { IconSvgElement } from "@hugeicons/react-native";
import { Pressable, Text, View } from "react-native";
import { fonts, radius, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";
import { Icon } from "./icon";

interface SegmentedOption<T extends string> {
	value: T;
	/** Shown when there's no icon; read out when there's no accessibilityLabel. */
	label: string;
	icon?: IconSvgElement;
	accessibilityLabel?: string;
}

/**
 * One choice from a few, as joined segments on a track with the chosen one inked (text alignment, letter case). `value`
 * null shows none chosen.
 */
export function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
	accessibilityLabel,
}: {
	options: ReadonlyArray<SegmentedOption<T>>;
	value: T | null;
	onChange: (value: T) => void;
	accessibilityLabel?: string;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
			{options.map((option) => {
				const on = option.value === value;
				return (
					<Pressable
						key={option.value}
						accessibilityRole="radio"
						accessibilityLabel={option.accessibilityLabel ?? option.label}
						accessibilityState={{ checked: on }}
						onPress={() => onChange(option.value)}
						style={({ pressed }) => [styles.segment, on && styles.segmentOn, pressed && !on && { opacity: 0.7 }]}
					>
						{option.icon ? (
							<Icon icon={option.icon} size={18} color={on ? colors.inkForeground : colors.foreground} />
						) : (
							<Text numberOfLines={1} style={[styles.label, on && styles.labelOn]}>
								{option.label}
							</Text>
						)}
					</Pressable>
				);
			})}
		</View>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		track: {
			flexDirection: "row" as const,
			padding: 3,
			borderRadius: radius.pill,
			backgroundColor: colors.surface,
			borderWidth: 1,
			borderColor: colors.border,
		},
		segment: {
			flex: 1,
			minHeight: 34,
			alignItems: "center" as const,
			justifyContent: "center" as const,
			borderRadius: radius.pill,
		},
		segmentOn: { backgroundColor: colors.ink },
		label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.foreground },
		labelOn: { color: colors.inkForeground },
	};
}
