import { type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { Icon } from "@/components/icon";
import { PullRefreshScrollView } from "@/components/pull-refresh-scroll-view";
import { Squircle } from "@/components/squircle";
import { CONTENT_MAX_WIDTH, READABLE_MAX_WIDTH, WIDE_PAGE_PADDING, centredColumn, useWideLayout } from "@/constants/layout";
import { isHovered } from "./desktop";
import { type Crumb, PageToolbar } from "./page-toolbar";
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from "@/constants/theme";

const SETTINGS_ICON_WELL = 36;
const SETTINGS_ICON_RADIUS = 12;

export function SettingsPage({
	title,
	children,
	refreshing = false,
	onRefresh,
	crumbs,
	toolbarTitle,
	actions,
}: {
	title: string;
	children: ReactNode;
	refreshing?: boolean;
	onRefresh?: () => Promise<void>;
	/** Wide layout: the levels above this page (`Media › Settings`). */
	crumbs?: Crumb[];
	/** Wide layout: the toolbar's title when it differs from the phone's big title. */
	toolbarTitle?: string;
	/** Wide layout: buttons at the toolbar's end. */
	actions?: ReactNode;
}) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const wide = useWideLayout();
	if (wide) {
		return (
			<WidePage title={toolbarTitle ?? title} crumbs={crumbs} actions={actions}>
				{children}
			</WidePage>
		);
	}
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

/**
 * A page in the wide layout: the slim toolbar (title or breadcrumb, actions), then the page's
 * content in a left-aligned readable column that scrolls under it.
 */
export function WidePage({
	title,
	crumbs,
	detail,
	actions,
	children,
	maxWidth = READABLE_MAX_WIDTH,
}: {
	title: string;
	crumbs?: Crumb[];
	detail?: string | null;
	actions?: ReactNode;
	children: ReactNode;
	maxWidth?: number;
}) {
	const styles = useThemedStyles(createStyles);
	return (
		<View style={styles.widePage}>
			<PageToolbar title={title} crumbs={crumbs} detail={detail} actions={actions} />
			<ScrollView
				style={styles.wideScroll}
				contentContainerStyle={[styles.content, styles.wideContent, { maxWidth: maxWidth + WIDE_PAGE_PADDING * 2 }]}
				keyboardShouldPersistTaps="handled"
			>
				{children}
			</ScrollView>
		</View>
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
	const wide = useWideLayout();
	const well = iconBg ?? colors.surfaceStrong;
	const tint = iconColor ?? colors.foreground;
	const body = (
		<View style={[styles.row, wide && styles.rowWide, !last && styles.rowBorder, disabled && styles.disabled]}>
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
			style={(state) => [isHovered(state) && !disabled && styles.rowHover, state.pressed && styles.pressed]}
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
		widePage: { flex: 1, backgroundColor: colors.background },
		wideScroll: { flex: 1 },
		wideContent: {
			width: "100%" as const,
			paddingHorizontal: WIDE_PAGE_PADDING,
			paddingTop: 28,
			paddingBottom: 56,
		},
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
		rowWide: { minHeight: 48, paddingVertical: 10 },
		rowHover: { backgroundColor: colors.surfaceStrong },
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
