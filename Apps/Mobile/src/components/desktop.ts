import { useEffect, useRef } from "react";
import { Platform, type PressableStateCallbackType } from "react-native";

/**
 * Small helpers for the wide (desktop) layout: pointer hover, keyboard Esc, the macOS title bar
 * and the page-wide web styles (focus rings, scrollbars). All are inert on a phone.
 */

const isWeb = Platform.OS === "web";

/** Pressable's `hovered` (react-native-web reports it; native leaves it out). */
export function isHovered(state: PressableStateCallbackType) {
	return (state as PressableStateCallbackType & { hovered?: boolean }).hovered === true;
}

/**
 * Props that make a View a window drag region in the Tauri app (`data-tauri-drag-region`). `deep`:
 * the whole subtree drags, except buttons, links and fields inside it. Nothing on native.
 */
export function dragRegion(mode: "deep" | "self" = "deep"): object {
	return isWeb ? { dataSet: { tauriDragRegion: mode === "deep" ? "deep" : "" } } : {};
}

/** Marks app chrome (sidebars, toolbars) on web: no text selection, like a desktop app. */
export function chromeRegion(): object {
	return isWeb ? { dataSet: { pocketChrome: "" } } : {};
}

function hasTauri() {
	return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

function isMacUserAgent() {
	if (typeof navigator === "undefined") return false;
	return /Mac OS X|Macintosh/.test(navigator.userAgent ?? "") && !/iPhone|iPad/.test(navigator.userAgent ?? "");
}

/** Web preview of the macOS title bar strip (`?macChrome=1`). */
function macChromePreview() {
	if (!isWeb || typeof window === "undefined") return false;
	return /(?:^|[?&])macChrome=1(?:&|$)/.test(window.location?.search ?? "");
}

/**
 * True in the macOS desktop app, whose window runs its content under a transparent title bar
 * (`titleBarStyle: Overlay` in tauri.conf.json): the top strip must stay clear for the traffic
 * lights and drag the window.
 */
export const macOverlayTitleBar = isWeb && ((hasTauri() && isMacUserAgent()) || macChromePreview());

/**
 * The macOS window's title bar: `overlay` while the app shell is shown (content under the traffic
 * lights), `visible` for the full-bleed monitor so its chrome keeps the window it was laid out for.
 */
export function setMacTitleBar(style: "overlay" | "visible") {
	if (!macOverlayTitleBar || !hasTauri()) return;
	const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args?: object): Promise<unknown> } }).__TAURI_INTERNALS__;
	internals.invoke("plugin:window|set_title_bar_style", { label: "main", value: style }).catch(() => {});
}

/** Esc runs `handler` while `enabled` (web only). Ignored while typing in a field or when a dialog took it. */
export function useEscapeKey(handler: (() => void) | null | undefined, enabled = true) {
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		if (!isWeb || !enabled || typeof window === "undefined") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || !latest.current) return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
			// A sheet or dialog over the page closes first.
			if (document.querySelector('[aria-modal="true"]')) return;
			e.preventDefault();
			latest.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled]);
}

let stylesInstalled = false;

/**
 * Page-wide web styles for the wide layout: a visible keyboard focus ring, thin scrollbars that
 * only show where a page scrolls, and no text selection on chrome. Installed once.
 */
export function installDesktopStyles() {
	if (!isWeb || stylesInstalled || typeof document === "undefined") return;
	stylesInstalled = true;
	const style = document.createElement("style");
	style.setAttribute("data-pocket", "desktop");
	style.textContent = `
[role="button"]:focus-visible, [role="link"]:focus-visible, [role="tab"]:focus-visible, [role="radio"]:focus-visible, [role="menuitem"]:focus-visible,
[role="switch"]:focus-visible, [role="checkbox"]:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid #17a9f3; outline-offset: 2px;
}
[role="button"]:focus:not(:focus-visible) { outline: none; }
* { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.45) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(128,128,128,0.6); }
[data-pocket-chrome] { user-select: none; -webkit-user-select: none; }
`;
	document.head.appendChild(style);
}
