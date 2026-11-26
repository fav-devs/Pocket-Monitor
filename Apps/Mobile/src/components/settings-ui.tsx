import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { Icon } from "@/components/icon";
import { PullRefreshScrollView } from "@/components/pull-refresh-scroll-view";
import { Squircle } from "@/components/squircle";
import { CONTENT_MAX_WIDTH, centredColumn } from "@/constants/layout";
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";

const SETTINGS_ICON_WELL = 36;
const SETTINGS_ICON_RADIUS = 12;

export function SettingsPage({
	title,
	children,
	refreshing = false,
	onRefresh,
}: {
	title: string;
	children: ReactNode;
	refreshing?: boolean;
	onRefresh?: () => Promise<void>;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	return (
		<PullRefreshScrollView
			contentContainerStyle={[
				styles.content,
				// A reading column on a tablet; clear of the notch on a phone in landscape.
				centredColumn(CONTENT_MAX_WIDTH),
				{
					paddingTop: insets.top + spacing.sm,
					paddingBottom: Math.max(insets.bottom, 12) + spacing.xl,
					paddingLeft: Math.max(insets.left, spacing.md),
					paddingRight: Math.max(insets.right, spacing.md),
				},
			]}
			showsVerticalScrollIndicator={false}
			refreshing={refreshing}
			indicatorOffset={insets.top}
			onRefresh={onRefresh}
		>
			<View style={styles.heading}>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Back"
					onPress={() => {
						if (router.canGoBack()) router.back();
						else router.replace("/");
					}}
					hitSlop={8}
					style={({ pressed }) => [styles.back, pressed && styles.pressed]}
				>
					<Icon icon={ArrowLeft01Icon} size={24} color={colors.foreground} />
				</Pressable>
				<Text style={styles.title}>{title}</Text>
			</View>
			{children}
		</PullRefreshScrollView>
	);
}

export function SettingsGroup({
	label,
	tone = "default",
	children,
}: {
	label?: string;
	tone?: "default" | "accent";
	children: ReactNode;
}) {
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.groupBlock}>
			{label ? <Text style={styles.groupLabel}>{label}</Text> : null}
			<View style={[styles.group, tone === "accent" && styles.groupAccent]}>{children}</View>
		</View>
	);
}

/** A titled section that isn't a card (the Account page's profile), spaced like a SettingsGroup. */
export function SettingsSection({ label, children }: { label: string; children: ReactNode }) {
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.groupBlock}>
			<Text style={styles.groupLabel}>{label}</Text>
			{children}
		</View>
	);
}

export function SettingsRow({
	icon,
	iconBg,
	iconColor,
	title,
	subtitle,
	subtitleColor,
	accessory,
	chevron,
	onPress,
	disabled = false,
	last = false,
}: {
	icon: IconSvgElement;
	iconBg?: string;
	iconColor?: string;
	title: string;
	subtitle?: string;
	subtitleColor?: string;
	accessory?: ReactNode;
	chevron?: boolean;
	onPress?: () => void;
	disabled?: boolean;
	last?: boolean;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const well = iconBg ?? colors.surfaceStrong;
	const tint = iconColor ?? colors.foreground;
	const body = (
		<View style={[styles.row, !last && styles.rowBorder, disabled && styles.disabled]}>
			<Squircle width={SETTINGS_ICON_WELL} height={SETTINGS_ICON_WELL} radius={SETTINGS_ICON_RADIUS} color={well}>
				<Icon icon={icon} size={18} color={tint} />
			</Squircle>
			<View style={styles.rowText}>
				<Text numberOfLines={1} style={styles.rowTitle}>
					{title}
				</Text>
				{subtitle ? (
					<Text style={[styles.rowMeta, subtitleColor ? { color: subtitleColor } : null]}>{subtitle}</Text>
				) : null}
			</View>
			{accessory}
			{chevron ? <Icon icon={ArrowRight01Icon} size={16} color={colors.mutedForeground} /> : null}
		</View>
	);
	if (!onPress) return body;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={title}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => pressed && styles.pressed}
		>
			{body}
		</Pressable>
	);
}

export function SettingsDestructiveButton({
	title,
	icon,
	disabled = false,
	onPress,
}: {
	title: string;
	icon?: IconSvgElement;
	disabled?: boolean;
	onPress: () => void;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={title}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => [styles.signOut, (pressed || disabled) && styles.pressed]}
		>
			{icon ? <Icon icon={icon} size={18} color={colors.destructive} /> : null}
			<Text style={styles.signOutLabel}>{title}</Text>
		</Pressable>
	);
}

function createStyles(colors: ThemeColors) {
	const hairline = StyleSheet.hairlineWidth;
	return {
		content: { paddingHorizontal: spacing.md, gap: spacing.lg },
		heading: { gap: spacing.sm },
		back: { alignSelf: "flex-start" as const, paddingVertical: 4, marginLeft: -4 },
		title: { fontFamily: fonts.bold, fontSize: 32, letterSpacing: -0.8, color: colors.foreground },
		groupBlock: { gap: 8 },
		groupLabel: {
			fontFamily: fonts.medium,
			fontSize: 13,
			color: colors.mutedForeground,
			paddingHorizontal: 4,
		},
		group: {
			backgroundColor: colors.surface,
			borderRadius: radius.lg,
			overflow: "hidden" as const,
		},
		groupAccent: { backgroundColor: colors.primarySoft },
		row: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: 12,
			paddingHorizontal: spacing.md,
			paddingVertical: 13,
			minHeight: 52,
		},
		rowBorder: {
			borderBottomWidth: hairline,
			borderBottomColor: colors.border,
		},
		rowText: { flex: 1, minWidth: 0, gap: 2 },
		rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
		rowMeta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
		signOut: {
			minHeight: 52,
			flexDirection: "row" as const,
			alignItems: "center" as const,
			justifyContent: "center" as const,
			gap: spacing.sm,
		},
		signOutLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.destructive },
		pressed: { opacity: 0.75 },
		disabled: { opacity: 0.45 },
	};
}
