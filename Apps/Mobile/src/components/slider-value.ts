/** UI-thread slider mapping, including ranges whose endpoints are not whole steps. */
export function sliderValueAt(
	x: number,
	width: number,
	min: number,
	max: number,
	step: number,
): number {
	"worklet";
	const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
	if (ratio === 0) return min;
	if (ratio === 1) return max;
	const raw = min + ratio * (max - min);
	const snapped =
		min + Math.round((raw - min) / Math.max(Number.EPSILON, step)) * step;
	return Math.max(min, Math.min(max, snapped));
}
