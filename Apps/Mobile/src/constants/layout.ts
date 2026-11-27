import { useWindowDimensions } from "react-native";

// Sizes for big screens: an iPad, an Android tablet, an unfolded foldable, a
// wide split-view window. Decided from the window, not the device, so a narrow
// iPad split view gets the phone layout.

/** A window whose short side is at least this is large (Android's large-screen class, 600 dp). */
const LARGE_SCREEN_SHORT_SIDE = 600;
/** The widest a column of reading content (settings, lists) gets before it centres. */
export const CONTENT_MAX_WIDTH = 720;
/** The widest a form (sign-in) gets. */
export const FORM_MAX_WIDTH = 440;
/** The widest an expanded sheet gets on a large screen (it still fills a phone). */
export const SHEET_EXPANDED_MAX_WIDTH = 720;

export function isLargeWindow(width: number, height: number) {
	return Math.min(width, height) >= LARGE_SCREEN_SHORT_SIDE;
}

/** The window's size and whether it is a big screen. */
export function useScreenSize() {
	const { width, height } = useWindowDimensions();
	return { width, height, large: isLargeWindow(width, height), landscape: width > height };
}

/**
 * How many columns of tiles at least `minTile` wide fit `width` with `gap`
 * between them, between `min` and `max`.
 */
export function gridColumns(width: number, minTile: number, gap: number, min: number, max: number) {
	const fit = Math.floor((width + gap) / (minTile + gap));
	return Math.max(min, Math.min(max, fit));
}

/** A column `maxWidth` wide at most, centred: style for a scroll view's content or a form. */
export function centredColumn(maxWidth: number) {
	return { width: "100%" as const, maxWidth, alignSelf: "center" as const };
}
