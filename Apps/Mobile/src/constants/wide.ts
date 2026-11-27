// Pure sizes for the wide layout (no React Native import, so tests can read them).

/**
 * The wide (desktop) layout: a persistent sidebar, split-view Settings, toolbar page headers.
 * Decided from the window's width alone, so a desktop window, a browser, an iPad in landscape and
 * a big Android tablet get it, and a phone or a narrow desktop window keeps the phone layout.
 */
export const WIDE_LAYOUT_MIN_WIDTH = 960;
/** The app sidebar in the wide layout. */
export const SIDEBAR_WIDTH = 240;
/** Settings' section list, the second column in the wide layout. */
export const SETTINGS_LIST_WIDTH = 248;
/** The widest a page of settings or reading content gets in the wide layout (left-aligned). */
export const READABLE_MAX_WIDTH = 760;
/** Page gutter in the wide layout. */
export const WIDE_PAGE_PADDING = 40;
/** The slim page toolbar in the wide layout (also the macOS title-bar strip it sits in). */
export const TOOLBAR_HEIGHT = 52;

export function isWideWindow(width: number) {
	return width >= WIDE_LAYOUT_MIN_WIDTH;
}
