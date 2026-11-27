import { type ComponentProps } from "react";
import { Platform, TextInput, type TextInputProps } from "react-native";
import { BottomSheetTextInput, useBottomSheetInternal } from "@gorhom/bottom-sheet";
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";

export function TextField({ style, ...props }: TextInputProps) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const sheet = useBottomSheetInternal(true);
	const inputStyle = [styles.input, style];
	if (sheet && Platform.OS !== "web") {
		return (
			<BottomSheetTextInput
				placeholderTextColor={colors.mutedForeground}
				style={inputStyle as ComponentProps<typeof BottomSheetTextInput>["style"]}
				{...props}
			/>
		);
	}
	return (
		<TextInput
			placeholderTextColor={colors.mutedForeground}
			style={inputStyle}
			{...props}
		/>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		input: {
			minHeight: 50,
			borderRadius: radius.md,
			borderWidth: 1,
			borderColor: colors.border,
			backgroundColor: colors.background,
			paddingHorizontal: spacing.md,
			color: colors.foreground,
			fontFamily: fonts.regular,
			fontSize: 16,
		},
	};
}
