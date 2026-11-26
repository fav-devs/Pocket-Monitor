import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { useTheme } from "@/constants/theme";

// Same icon set as the web app (@hugeicons/core-free-icons).
export function Icon({
	icon,
	size = 20,
	color,
	strokeWidth = 1.5,
}: {
	icon: IconSvgElement;
	size?: number;
	color?: string;
	strokeWidth?: number;
}) {
	const { colors } = useTheme();
	return <HugeiconsIcon icon={icon} size={size} color={color ?? colors.foreground} strokeWidth={strokeWidth} />;
}
