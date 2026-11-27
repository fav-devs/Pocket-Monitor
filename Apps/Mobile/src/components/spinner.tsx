import { useEffect } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import Animated, {
	Easing,
	cancelAnimation,
	useAnimatedProps,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "@/constants/theme";

/*
  Port of the web app's SpiralLoader (apps/web/src/components/ui/spinner.tsx),
  which plays two Lottie files. Both animate the same wavy stroke on a 16x16
  canvas: the path slides 8px left while Trim Paths start/end move, so a short
  squiggle appears to travel along it. The web loops 4 fast cycles (0.5s) then
  2 slow ones (1s); this does the same on the UI thread with a single clock.
*/

const VIEWBOX = 16;
const STROKE_WIDTH = 1.4;
const FAST_MS = 500;
const SLOW_MS = 1000;
const FAST_REPEATS = 4;
const SLOW_REPEATS = 2;
const FAST_TOTAL = FAST_MS * FAST_REPEATS;
const TOTAL_MS = FAST_TOTAL + SLOW_MS * SLOW_REPEATS;

// Path vertices and bezier tangents, as exported from the Lottie (origin-centred).
const VERTICES = [
	[-12, 6], [-4.975, -1.012], [-8, -6], [-11.025, -1.012], [-4, 6], [3.025, -1.012], [0, -6],
	[-3.025, -1.012], [4, 6], [11.025, -1.012], [8, -6], [4.98, -1.012], [12, 6],
];
const OUT = [
	[4.452, 0], [0.23, -2.627], [-2.218, 0], [0.289, 3.296], [4.452, 0], [0.23, -2.627], [-2.218, 0],
	[0.289, 3.296], [4.452, 0], [0.23, -2.627], [-2.218, 0], [0.292, 3.296], [0, 0],
];
const IN = [
	[0, 0], [-0.289, 3.296], [2.218, 0], [-0.23, -2.627], [-4.452, 0], [-0.289, 3.296], [2.218, 0],
	[-0.23, -2.627], [-4.452, 0], [-0.289, 3.296], [2.218, 0], [-0.232, -2.627], [-4.443, 0],
];

const PATH_D = VERTICES.reduce((d, v, i) => {
	if (i === 0) return `M${v[0]} ${v[1]}`;
	const p = VERTICES[i - 1];
	const c1 = [p[0] + OUT[i - 1][0], p[1] + OUT[i - 1][1]];
	const c2 = [v[0] + IN[i][0], v[1] + IN[i][1]];
	return `${d} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${v[0]} ${v[1]}`;
}, "");

function bezierPoint(t: number, a: number[], b: number[], c: number[], d: number[]) {
	const u = 1 - t;
	return [
		u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
		u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
	];
}

// Dash offsets need the real arc length, so measure it once by sampling.
const PATH_LENGTH = (() => {
	let length = 0;
	for (let i = 1; i < VERTICES.length; i++) {
		const a = VERTICES[i - 1];
		const d = VERTICES[i];
		const b = [a[0] + OUT[i - 1][0], a[1] + OUT[i - 1][1]];
		const c = [d[0] + IN[i][0], d[1] + IN[i][1]];
		let prev = a;
		for (let s = 1; s <= 24; s++) {
			const pt = bezierPoint(s / 24, a, b, c, d);
			length += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
			prev = pt;
		}
	}
	return length;
})();

// [x1, y1, x2, y2] CSS-style cubic-bezier easings, taken from the Lottie keyframes.
type Ease = readonly [number, number, number, number];
const FAST_START: Ease = [0.32, 0.154, 0.826, 0.579];
const FAST_END: Ease = [0.341, 0.488, 0.269, 0.75];
const SLOW_START: Ease = [0.32, 0.313, 0.826, 0.143];
const SLOW_END: Ease = [0.341, 0.992, 0.269, 0.491];

function cubicBezier(ease: Ease, x: number) {
	"worklet";
	const [x1, y1, x2, y2] = ease;
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	let t = x;
	for (let i = 0; i < 6; i++) {
		const err = ((ax * t + bx) * t + cx) * t - x;
		const slope = (3 * ax * t + 2 * bx) * t + cx;
		if (Math.abs(err) < 1e-5 || slope === 0) break;
		t -= err / slope;
	}
	return ((ay * t + by) * t + cy) * t;
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

type SpinnerSize = number | "small" | "large";

type SpinnerProps = {
	/** Pixels, or the ActivityIndicator sizes ("small" = 16, "large" = 36). */
	size?: SpinnerSize;
	color?: string;
	/** The web animation draws at 24% opacity; pass 1 for a stronger mark. */
	opacity?: number;
	style?: StyleProp<ViewStyle>;
	accessibilityLabel?: string;
};

export function Spinner({ size = 16, color, opacity = 0.24, style, accessibilityLabel = "Loading" }: SpinnerProps) {
	const { colors } = useTheme();
	const px = size === "small" ? 16 : size === "large" ? 36 : size;
	const clock = useSharedValue(0);

	useEffect(() => {
		clock.value = 0;
		clock.value = withRepeat(withTiming(TOTAL_MS, { duration: TOTAL_MS, easing: Easing.linear }), -1, false);
		return () => cancelAnimation(clock);
	}, [clock]);

	const animatedProps = useAnimatedProps(() => {
		const ms = clock.value;
		const fast = ms < FAST_TOTAL;
		const p = fast ? (ms % FAST_MS) / FAST_MS : ((ms - FAST_TOTAL) % SLOW_MS) / SLOW_MS;
		const start = (23 + 34 * cubicBezier(fast ? FAST_START : SLOW_START, p)) / 100;
		const end = (44 + 33 * cubicBezier(fast ? FAST_END : SLOW_END, p)) / 100;
		const visible = Math.max(0, end - start) * PATH_LENGTH;
		return {
			strokeDasharray: [visible, PATH_LENGTH * 2],
			strokeDashoffset: -start * PATH_LENGTH,
			// Path origin travels from x=12 to x=4 over each cycle.
			transform: [{ translateX: 12 - 8 * p }, { translateY: 8 }],
		};
	});

	return (
		<View
			accessibilityRole="progressbar"
			accessibilityLabel={accessibilityLabel}
			style={[{ width: px, height: px }, style]}
		>
			<Svg width={px} height={px} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
				<AnimatedPath
					d={PATH_D}
					fill="none"
					stroke={color ?? colors.foreground}
					strokeOpacity={opacity}
					strokeWidth={STROKE_WIDTH}
					strokeLinecap="round"
					strokeLinejoin="round"
					animatedProps={animatedProps}
				/>
			</Svg>
		</View>
	);
}
