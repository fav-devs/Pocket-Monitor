import type { ReactNode } from "react";
import { Switch, Text, View } from "react-native";
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";

/**
 * A titled group of controls. Flat: a small heading over its controls, no box. With `toggle` the heading carries the
 * group's on/off switch and the controls (children) are for the caller to show only while it is on.
 */
export function FieldSection({
	title,
	toggle,
	children,
}: {
	title: string;
	toggle?: { value: boolean; onChange: (value: boolean) => void };
	children?: ReactNode;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.section}>
			{toggle ? (
				<View style={styles.toggleRow}>
					<Text style={styles.toggleTitle}>{title}</Text>
					<Switch
						accessibilityLabel={title}
						value={toggle.value}
						onValueChange={toggle.onChange}
						trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
					/>
				</View>
			) : (
				<Text style={styles.title}>{title}</Text>
			)}
			{children ? <View style={styles.body}>{children}</View> : null}
		</View>
	);
}

export function ChipRow({ children }: { children: ReactNode }) {
	const styles = useThemedStyles(createStyles);
	return <View style={styles.chipRow}>{children}</View>;
}

function createStyles(colors: ThemeColors) {
	return {
		section: { gap: spacing.sm, paddingTop: spacing.md, borderTopWidth: 0.5, borderTopColor: colors.border },
		title: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase" as const, color: colors.mutedForeground },
		toggleRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, minHeight: 34 },
		toggleTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.foreground },
		body: { gap: spacing.md },
		chipRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: spacing.sm },
	};
}
