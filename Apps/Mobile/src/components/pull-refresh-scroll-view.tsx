import { type ReactNode, useEffect } from "react";
import { Platform, RefreshControl, type ScrollViewProps, View } from "react-native";
import Animated, {
	Extrapolation,
	interpolate,
	useAnimatedScrollHandler,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { Spinner } from "@/components/spinner";
import { useTheme } from "@/constants/theme";

/** How far a pull has to go before the spinner is fully shown (iOS follows the finger). */
const PULL_DISTANCE = 64;
const SPINNER_SIZE = 24;

type PullRefreshScrollViewProps = Omit<ScrollViewProps, "refreshControl" | "onScroll"> & {
	refreshing: boolean;
	/** Without it the list does not pull to refresh. */
	onRefresh?: () => void;
	/** Where the list starts below an overlaid header: the spinner appears under it. */
	indicatorOffset?: number;
	children: ReactNode;
};

/**
 * A ScrollView whose pull-to-refresh shows the app's Spinner. The platform
 * RefreshControl still does the pulling (so it feels native); its own
 * indicator is made invisible and the Spinner is drawn in its place.
 */
export function PullRefreshScrollView({
	refreshing,
	onRefresh,
	indicatorOffset = 0,
	children,
	...props
}: PullRefreshScrollViewProps) {
	const { colors } = useTheme();
	const offset = useSharedValue(0);
	const shown = useSharedValue(0);
	const onScroll = useAnimatedScrollHandler((event) => {
		offset.value = event.contentOffset.y;
	});

	useEffect(() => {
		shown.value = withTiming(refreshing ? 1 : 0, { duration: 180 });
	}, [refreshing, shown]);

	const indicator = useAnimatedStyle(() => {
		const pulled = Math.max(0, -offset.value);
		// Only iOS reports the pull as a negative offset; Android shows the spinner while refreshing.
		const progress = Platform.OS === "ios" ? interpolate(pulled, [0, PULL_DISTANCE], [0, 1], Extrapolation.CLAMP) : 0;
		const visible = Math.max(progress, shown.value);
		return {
			opacity: visible,
			transform: [{ translateY: Platform.OS === "ios" ? pulled / 2 : 0 }, { scale: 0.6 + 0.4 * visible }],
		};
	});

	return (
		<View style={{ flexGrow: 1, flexShrink: 1 }}>
			<Animated.ScrollView
				{...props}
				onScroll={onScroll}
				scrollEventThrottle={16}
				refreshControl={
					onRefresh ? (
					<RefreshControl
						refreshing={refreshing}
						onRefresh={onRefresh}
						progressViewOffset={indicatorOffset}
						tintColor="transparent"
						colors={["transparent"]}
						progressBackgroundColor="transparent"
					/>
					) : undefined
				}
			>
				{children}
			</Animated.ScrollView>
			<Animated.View
				pointerEvents="none"
				style={[
					{ position: "absolute", top: indicatorOffset + 12, left: 0, right: 0, alignItems: "center" },
					indicator,
				]}
			>
				<Spinner size={SPINNER_SIZE} color={colors.foreground} opacity={1} accessibilityLabel="Refreshing" />
			</Animated.View>
		</View>
	);
}
