import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { Fragment, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/icon";
import { Spinner } from "@/components/spinner";
import { TOOLBAR_HEIGHT, WIDE_PAGE_PADDING } from "@/constants/layout";
import { fonts, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";
import { dragRegion, isHovered, useEscapeKey } from "./desktop";

export interface Crumb {
	label: string;
	/** Goes up to this level. The last crumb is the page itself and has none. */
	onPress?: () => void;
}

/**
 * The wide layout's page header: a slim toolbar row with the page title (or a breadcrumb,
 * `Display › Assists`) on the left and the page's actions as buttons on the right. Esc goes up one
 * level when the breadcrumb has a parent. The strip drags the window in the desktop app.
 */
export function PageToolbar({
	title,
	crumbs,
	detail,
	leading,
	actions,
	bordered = true,
	padding = WIDE_PAGE_PADDING,
}: {
	title?: string;
	/** Parents first; `title` is appended as the current page. */
	crumbs?: Crumb[];
	/** Muted text after the title (a count, a camera name). */
	detail?: string | null;
	/** Replaces the title (tabs, a selection count). */
	leading?: ReactNode;
	actions?: ReactNode;
	bordered?: boolean;
	padding?: number;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const parents = crumbs ?? [];
	const up = [...parents].reverse().find((c) => c.onPress)?.onPress;
	useEscapeKey(up, !!up);
	return (
		<View
			style={[styles.bar, bordered && styles.bordered, { paddingLeft: padding, paddingRight: padding - 8 }]}
			{...dragRegion("deep")}
		>
			<View style={styles.lead}>
				{leading ?? (
					<>
						{parents.map((c) => (
							<Fragment key={c.label}>
								<Pressable
									accessibilityRole="link"
									accessibilityLabel={`Back to ${c.label}`}
									disabled={!c.onPress}
									onPress={c.onPress}
									hitSlop={8}
									style={(state) => [styles.crumb, isHovered(state) && styles.crumbHover, state.pressed && styles.pressed]}
								>
									<Text numberOfLines={1} style={styles.crumbLabel}>
										{c.label}
									</Text>
								</Pressable>
								<Icon icon={ArrowRight01Icon} size={16} color={colors.mutedForeground} />
							</Fragment>
						))}
						{title ? (
							<Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
								{title}
							</Text>
						) : null}
					</>
				)}
				{detail ? (
					<Text numberOfLines={1} style={styles.detail}>
						{detail}
					</Text>
				) : null}
			</View>
			{actions ? <View style={styles.actions}>{actions}</View> : null}
		</View>
	);
}

/**
 * A toolbar button: an icon, a label or both, 32 high with a hover fill. `primary` is the ink
 * fill for the page's main action.
 */
export function ToolbarButton({
	icon,
	title,
	label,
	onPress,
	variant = "plain",
	disabled = false,
	active = false,
	busy = false,
	badge,
	destructive = false,
	testID,
}: {
	icon?: IconSvgElement;
	title?: string;
	/** Accessibility label; defaults to `title`. */
	label?: string;
	onPress: () => void;
	variant?: "plain" | "primary" | "secondary";
	disabled?: boolean;
	active?: boolean;
	busy?: boolean;
	badge?: number;
	destructive?: boolean;
	testID?: string;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const onInk = variant === "primary" || active;
	const tint = destructive ? colors.destructive : onInk ? colors.inkForeground : colors.foreground;
	return (
		<Pressable
			testID={testID}
			accessibilityRole="button"
			accessibilityLabel={label ?? title}
			accessibilityState={{ disabled, selected: active }}
			disabled={disabled}
			onPress={onPress}
			hitSlop={6}
			style={(state) => [
				styles.button,
				!title && styles.square,
				variant === "secondary" && styles.secondary,
				onInk && styles.ink,
				isHovered(state) && !disabled && (onInk ? styles.inkHover : styles.hover),
				state.pressed && styles.pressed,
				disabled && styles.disabled,
			]}
		>
			{busy ? (
				<Spinner size={16} opacity={1} color={tint} />
			) : icon ? (
				<Icon icon={icon} size={title ? 17 : 19} color={tint} strokeWidth={onInk ? 2 : 1.6} />
			) : null}
			{title ? <Text style={[styles.buttonLabel, { color: tint }]}>{title}</Text> : null}
			{badge ? (
				<View style={styles.badge}>
					<Text style={styles.badgeText}>{badge > 99 ? "99+" : String(badge)}</Text>
				</View>
			) : null}
		</Pressable>
	);
}

/** A thin vertical rule between toolbar button groups. */
export function ToolbarDivider() {
	const styles = useThemedStyles(createStyles);
	return <View style={styles.divider} />;
}

function createStyles(colors: ThemeColors) {
	return {
		bar: {
			height: TOOLBAR_HEIGHT,
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: 16,
			backgroundColor: colors.background,
		},
		bordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
		lead: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
		crumb: { borderRadius: 6, paddingHorizontal: 4, marginHorizontal: -4, paddingVertical: 2 },
		crumbHover: { backgroundColor: colors.surface },
		crumbLabel: { fontFamily: fonts.medium, fontSize: 20, letterSpacing: -0.3, color: colors.mutedForeground },
		title: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.3, color: colors.foreground },
		detail: { flexShrink: 1, marginLeft: 8, fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground },
		actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
		button: {
			height: 32,
			minWidth: 32,
			paddingHorizontal: 12,
			borderRadius: 9,
			flexDirection: "row" as const,
			alignItems: "center" as const,
			justifyContent: "center" as const,
			gap: 6,
		},
		square: { width: 32, paddingHorizontal: 0 },
		secondary: { backgroundColor: colors.surface },
		ink: { backgroundColor: colors.ink },
		hover: { backgroundColor: colors.surfaceStrong },
		inkHover: { opacity: 0.88 },
		buttonLabel: { fontFamily: fonts.semibold, fontSize: 13 },
		badge: {
			position: "absolute" as const,
			top: -3,
			right: -3,
			minWidth: 16,
			height: 16,
			paddingHorizontal: 4,
			borderRadius: 8,
			backgroundColor: colors.primary,
			alignItems: "center" as const,
			justifyContent: "center" as const,
		},
		badgeText: { fontFamily: fonts.semibold, fontSize: 10, color: "#ffffff" },
		divider: { width: StyleSheet.hairlineWidth, height: 20, marginHorizontal: 4, backgroundColor: colors.borderStrong },
		pressed: { opacity: 0.7 },
		disabled: { opacity: 0.4 },
	};
}
