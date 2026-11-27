import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
	Cancel01Icon,
	Tick02Icon,
	Undo02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "./icon";
import { fonts, useTheme } from "@/constants/theme";

/** An inline second tap confirms a sheet reset; cancel never edits the project. */
export function ResetAction({
	onReset,
	disabled = false,
	label = "Reset all",
	accessibilityLabel = label,
}: {
	onReset: () => void;
	disabled?: boolean;
	label?: string;
	accessibilityLabel?: string;
}) {
	const { colors } = useTheme();
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (disabled) setArmed(false);
	}, [disabled]);
	return (
		<View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={
					armed
						? `Confirm ${accessibilityLabel.toLowerCase()}`
						: accessibilityLabel
				}
				accessibilityHint={
					armed ? "Resets these settings" : "Tap again to confirm"
				}
				accessibilityState={{ disabled }}
				disabled={disabled}
				onPress={() => {
					if (armed) {
						setArmed(false);
						onReset();
					} else setArmed(true);
				}}
				style={({ pressed }) => ({
					minHeight: 36,
					paddingHorizontal: 10,
					flexDirection: "row",
					gap: 5,
					alignItems: "center",
					justifyContent: "center",
					borderRadius: 12,
					borderCurve: "continuous",
					backgroundColor: armed ? colors.success : colors.surface,
					opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
				})}
			>
				<Icon
					icon={armed ? Tick02Icon : Undo02Icon}
					size={16}
					color={armed ? "#052e16" : colors.foreground}
				/>
				<Text
					style={{
						fontFamily: fonts.medium,
						fontSize: 12,
						color: armed ? "#052e16" : colors.foreground,
					}}
				>
					{armed ? "Reset" : label}
				</Text>
			</Pressable>
			{armed ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Cancel reset"
					onPress={() => setArmed(false)}
					style={({ pressed }) => ({
						width: 36,
						height: 36,
						borderRadius: 12,
						borderCurve: "continuous",
						alignItems: "center",
						justifyContent: "center",
						backgroundColor: colors.destructiveSoft,
						opacity: pressed ? 0.7 : 1,
					})}
				>
					<Icon icon={Cancel01Icon} size={18} color={colors.destructive} />
				</Pressable>
			) : null}
		</View>
	);
}
