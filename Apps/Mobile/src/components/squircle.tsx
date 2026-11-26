import { useMemo, type ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";

const DEFAULT_SMOOTHING = 0.8;

type SquircleProps = ViewProps & {
	width: number;
	height: number;
	radius: number;
	color: string;
	/** 0 = quarter-circles, 1 = max Figma/iOS continuous corners. */
	smoothing?: number;
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
};

/** Figma-style squircle fill with children laid over the path. */
export function Squircle({
	width,
	height,
	radius,
	color,
	smoothing = DEFAULT_SMOOTHING,
	style,
	children,
	...props
}: SquircleProps) {
	const d = useMemo(
		() => squirclePath({ width, height, radius, smoothing }),
		[width, height, radius, smoothing],
	);
	return (
		<View style={[{ width, height }, styles.box, style]} {...props}>
			<Svg width={width} height={height} style={[StyleSheet.absoluteFill, Platform.OS === 'web' && { zIndex: -1 }]} pointerEvents="none">
				<Path d={d} fill={color} />
			</Svg>
			{children}
		</View>
	);
}

const styles = StyleSheet.create({
	// Browser positioned SVGs otherwise paint over the unpositioned icon/text.
	box: { alignItems: "center", justifyContent: "center", overflow: "hidden", ...(Platform.OS === 'web' ? { zIndex: 0 } : {}) },
});

/** Equal-corner Figma squircle (https://www.figma.com/blog/desperately-seeking-squircles/). */
function squirclePath({
	width,
	height,
	radius,
	smoothing = DEFAULT_SMOOTHING,
}: {
	width: number;
	height: number;
	radius: number;
	smoothing?: number;
}): string {
	const budget = Math.min(width, height) / 2;
	const cornerRadius = Math.max(0, Math.min(radius, budget));
	if (cornerRadius < 0.5) return `M0 0H${width}V${height}H0Z`;
	const params = pathParamsForCorner({
		cornerRadius,
		cornerSmoothing: Math.max(0, Math.min(1, smoothing)),
		roundingAndSmoothingBudget: budget,
	});
	return [
		`M ${width - params.p} 0`,
		drawTopRight(params),
		`L ${width} ${height - params.p}`,
		drawBottomRight(params),
		`L ${params.p} ${height}`,
		drawBottomLeft(params),
		`L 0 ${params.p}`,
		drawTopLeft(params),
		"Z",
	].join(" ");
}

type CornerPathParams = {
	a: number;
	b: number;
	c: number;
	d: number;
	p: number;
	cornerRadius: number;
	arcSectionLength: number;
};

function pathParamsForCorner({
	cornerRadius,
	cornerSmoothing,
	roundingAndSmoothingBudget,
}: {
	cornerRadius: number;
	cornerSmoothing: number;
	roundingAndSmoothingBudget: number;
}): CornerPathParams {
	const maxSmoothing = roundingAndSmoothingBudget / cornerRadius - 1;
	const smoothing = Math.min(cornerSmoothing, maxSmoothing);
	const p = Math.min((1 + smoothing) * cornerRadius, roundingAndSmoothingBudget);
	const arcMeasure = 90 * (1 - smoothing);
	const arcSectionLength = Math.sin(toRadians(arcMeasure / 2)) * cornerRadius * Math.sqrt(2);
	const angleAlpha = (90 - arcMeasure) / 2;
	const p3ToP4 = cornerRadius * Math.tan(toRadians(angleAlpha / 2));
	const angleBeta = 45 * smoothing;
	const c = p3ToP4 * Math.cos(toRadians(angleBeta));
	const d = c * Math.tan(toRadians(angleBeta));
	const b = (p - arcSectionLength - c - d) / 3;
	const a = 2 * b;
	return { a, b, c, d, p, arcSectionLength, cornerRadius };
}

function drawTopRight({ a, b, c, d, cornerRadius, arcSectionLength }: CornerPathParams) {
	return `c ${a} 0 ${a + b} 0 ${a + b + c} ${d} a ${cornerRadius} ${cornerRadius} 0 0 1 ${arcSectionLength} ${arcSectionLength} c ${d} ${c} ${d} ${b + c} ${d} ${a + b + c}`;
}

function drawBottomRight({ a, b, c, d, cornerRadius, arcSectionLength }: CornerPathParams) {
	return `c 0 ${a} 0 ${a + b} ${-d} ${a + b + c} a ${cornerRadius} ${cornerRadius} 0 0 1 ${-arcSectionLength} ${arcSectionLength} c ${-c} ${d} ${-(b + c)} ${d} ${-(a + b + c)} ${d}`;
}

function drawBottomLeft({ a, b, c, d, cornerRadius, arcSectionLength }: CornerPathParams) {
	return `c ${-a} 0 ${-(a + b)} 0 ${-(a + b + c)} ${-d} a ${cornerRadius} ${cornerRadius} 0 0 1 ${-arcSectionLength} ${-arcSectionLength} c ${-d} ${-c} ${-d} ${-(b + c)} ${-d} ${-(a + b + c)}`;
}

function drawTopLeft({ a, b, c, d, cornerRadius, arcSectionLength }: CornerPathParams) {
	return `c 0 ${-a} 0 ${-(a + b)} ${d} ${-(a + b + c)} a ${cornerRadius} ${cornerRadius} 0 0 1 ${arcSectionLength} ${-arcSectionLength} c ${c} ${-d} ${b + c} ${-d} ${a + b + c} ${-d}`;
}

function toRadians(degrees: number) {
	return (degrees * Math.PI) / 180;
}
