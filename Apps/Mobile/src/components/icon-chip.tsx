import type { IconSvgElement } from "@hugeicons/react-native";
import { useTheme } from "@/constants/theme";
import { Icon } from "./icon";
import { Squircle } from "./squircle";

/** Squircle holding an icon — the web's "Create project" / upload chip. */
export function IconChip({
	icon,
	size = 44,
	background,
}: {
	icon: IconSvgElement;
	size?: number;
	background?: string;
}) {
	const { colors } = useTheme();
	return (
		<Squircle width={size} height={size} radius={Math.round(size * 0.32)} color={background ?? colors.accent}>
			<Icon icon={icon} size={size * 0.45} color={colors.foreground} strokeWidth={2} />
		</Squircle>
	);
}
