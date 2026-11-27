import type { IconSvgElement } from "@hugeicons/react-native";
import { Pressable, Text } from "react-native";
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";
import { Icon } from "./icon";
import { Sheet } from "./sheet";

export interface SheetAction {
	label: string;
	icon: IconSvgElement;
	onPress: () => void;
	destructive?: boolean;
}

/** A short list of actions for one item, e.g. a project's rename/duplicate/delete. */
export function ActionSheet({
	visible,
	title,
	actions,
	onClose,
}: {
	visible: boolean;
	title: string;
	actions: SheetAction[];
	onClose: () => void;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	return (
		<Sheet visible={visible} title={title} onClose={onClose} expandable={false}>
			{actions.map((action) => {
				const color = action.destructive ? colors.destructive : colors.foreground;
				return (
					<Pressable
						key={action.label}
						accessibilityRole="button"
						accessibilityLabel={action.label}
						onPress={() => {
							onClose();
							action.onPress();
						}}
						style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.surface }]}
					>
						<Icon icon={action.icon} size={20} color={color} />
						<Text style={[styles.label, { color }]}>{action.label}</Text>
					</Pressable>
				);
			})}
		</Sheet>
	);
}

function createStyles(_colors: ThemeColors) {
	return {
		action: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: spacing.md,
			paddingHorizontal: spacing.sm,
			paddingVertical: spacing.sm + 4,
			borderRadius: radius.sm,
		},
		label: { fontFamily: fonts.medium, fontSize: 15 },
	};
}
