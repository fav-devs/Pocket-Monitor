import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { fonts, spacing, type ThemeColors, useThemedStyles } from "@/constants/theme";

/**
 * A sheet's sections as words in a row, the chosen one underlined (Volume | Fade | Audio FX). The row scrolls sideways
 * when the words don't fit; `trailing` (a Save button, say) stays at its end.
 */
export function TabRow<T extends string>({
	tabs,
	selected,
	onSelect,
	trailing,
}: {
	tabs: ReadonlyArray<{ id: T; label: string }>;
	/** Null underlines none. */
	selected: T | null;
	onSelect: (id: T) => void;
	trailing?: ReactNode;
}) {
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.row}>
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				keyboardShouldPersistTaps="handled"
				style={styles.scroll}
				contentContainerStyle={styles.tabs}
				accessibilityRole="tablist"
			>
				{tabs.map((tab) => {
					const on = tab.id === selected;
					return (
						<Pressable
							key={tab.id}
							accessibilityRole="tab"
							accessibilityLabel={tab.label}
							accessibilityState={{ selected: on }}
							onPress={() => onSelect(tab.id)}
							hitSlop={6}
							style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}
						>
							<Text numberOfLines={1} style={[styles.label, on && styles.labelOn]}>
								{tab.label}
							</Text>
							<View style={[styles.line, on && styles.lineOn]} />
						</Pressable>
					);
				})}
			</ScrollView>
			{trailing ? <View style={styles.trailing}>{trailing}</View> : null}
		</View>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		row: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: spacing.sm,
			borderBottomWidth: 1,
			borderBottomColor: colors.border,
		},
		scroll: { flexGrow: 1, flexShrink: 1 },
		tabs: { gap: spacing.md + 4, paddingTop: 2 },
		tab: { alignItems: "center" as const, gap: 7, paddingTop: 6 },
		label: { fontFamily: fonts.medium, fontSize: 15, color: colors.mutedForeground },
		labelOn: { fontFamily: fonts.semibold, color: colors.foreground },
		line: { height: 2, alignSelf: "stretch" as const, borderRadius: 1 },
		lineOn: { backgroundColor: colors.primary },
		trailing: { paddingBottom: 6 },
	};
}
