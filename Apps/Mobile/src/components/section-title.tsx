import { Text, View } from "react-native";
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";

/** "● My projects" section heading from the web dashboard. */
export function SectionTitle({ title, dot }: { title: string; dot?: string }) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.row}>
			<View style={[styles.dot, { backgroundColor: dot ?? colors.dotPink }]} />
			<Text style={styles.title}>{title}</Text>
		</View>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		row: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.sm + 2 },
		dot: { width: 7, height: 7, borderRadius: 4 },
		title: { fontFamily: fonts.semibold, fontSize: 18, color: colors.foreground },
	};
}
