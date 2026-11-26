import {
	syncSheetPreview,
	sheetScrollProgress,
	previewSheetHeight,
} from "./sheet-preview-state";
import {
	createContext,
	type ComponentProps,
	memo,
	type ReactNode,
	type Ref,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Keyboard,
	KeyboardAvoidingView,
	FlatList,
	type FlatListProps,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	type ScrollViewProps,
	type StyleProp,
	Text,
	useWindowDimensions,
	View,
	type ViewStyle,
} from "react-native";
import {
	BottomSheetBackdrop,
	type BottomSheetBackdropProps,
	type BottomSheetBackgroundProps,
	type BottomSheetHandleProps,
	BottomSheetModal,
	BottomSheetScrollView,
	BottomSheetFlatList,
	BottomSheetView,
	useBottomSheetScrollableCreator,
	useScrollEventsHandlersDefault,
	type ScrollEventsHandlersHookType,
} from "@gorhom/bottom-sheet";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	Extrapolation,
	interpolate,
	type SharedValue,
	useAnimatedReaction,
	useDerivedValue,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
	withSpring,
	runOnUI,
	type WithSpringConfig,
} from "react-native-reanimated";
import {
	SafeAreaView,
	useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { SHEET_EXPANDED_MAX_WIDTH, isLargeWindow } from "@/constants/layout";
import {
	fonts,
	spacing,
	type ThemeColors,
	useTheme,
	useThemedStyles,
} from "@/constants/theme";
import { Icon } from "./icon";

type SheetProps = {
	horizontalInset?: number;
	maxWidth?: number;
	/** Native sheet top on the UI thread, including interactive drags and settling. */
	animatedPosition?: SharedValue<number>;
	/** Internal shared progress for coordinated editor chrome. */
	scrollProgress?: SharedValue<number>;
	reclaimHeight?: number;
	/** Preview trays keep a fixed snap and let content scroll without expanding. */
	variant?: "standard" | "preview";
	visible: boolean;
	title: string;
	onClose: () => void;
	/** Called once the modal and its closing animation have finished. */
	onDismiss?: () => void;
	children: ReactNode;
	/** Fixed controls outside the sheet’s scrolling content. */
	footer?: ReactNode;
	action?: ReactNode;
	/** Wrapper owns vertical scrolling. With false, use SheetScrollView/SheetFlatList for inner lists. */
	scroll?: boolean;
	/** Near full height (92% snap). Pair with expandable to pull edge-to-edge. */
	tall?: boolean;
	/** Tray gestures. Off also locks expansion when the body owns pan gestures (crop). */
	draggable?: boolean;
	/** Let content swipes move the sheet. Disable when a browser must own scrolling. */
	contentDraggable?: boolean;
	/** Title, close, and the pink dot. Off leaves a grabber so the body can sit higher. */
	header?: boolean;
	/** Expand by dragging the grabber or scrolling the body. Defaults on; false locks the height. */
	expandable?: boolean;
	/** Insets or layout overrides for the sheet's content area. */
	bodyStyle?: StyleProp<ViewStyle>;
	/** Distance above the bottom edge (or the keyboard when open). */
	bottomOffset?: number;
	/** Space left above the tray. Smaller than the default preview inset makes the sheet taller. */
	topInset?: number;
	/**
	 * Hits outside the card go to views behind it (preview handles).
	 * Gorhom backdrop uses enableTouchThrough; web uses an in-tree overlay.
	 */
	passthrough?: boolean;
};

const EXPAND_DISTANCE = 48;
const EXPAND_VELOCITY = 700;

function useExpandPan({
	enabled,
	expanded,
	onExpand,
	onDismiss,
}: {
	enabled: boolean;
	expanded: boolean;
	onExpand: () => void;
	onDismiss: () => void;
}) {
	return useMemo(() => {
		if (!enabled) return Gesture.Pan().enabled(false);
		return Gesture.Pan()
			.runOnJS(true)
			.activeOffsetY([-12, 12])
			.onEnd((event) => {
				const y = event.translationY;
				const v = event.velocityY;
				if (expanded) {
					if (y > EXPAND_DISTANCE || v > EXPAND_VELOCITY) onDismiss();
				} else if (y < -EXPAND_DISTANCE || v < -EXPAND_VELOCITY) {
					onExpand();
				} else if (y > EXPAND_DISTANCE || v > EXPAND_VELOCITY) {
					onDismiss();
				}
			});
	}, [enabled, expanded, onExpand, onDismiss]);
}

/** Fraction of the window kept above a non-tall tray so the preview stays visible. */
export const TRAY_PREVIEW_INSET_RATIO = 0.36;

/** Morphlet tray chrome — Gorhom is styled to match these. */
export const TRAY_CORNER_RADIUS = 32;
export const TRAY_HORIZONTAL_INSET = 16;
export const TRAY_BOTTOM_OFFSET = 16;
export const TRAY_MAX_WIDTH = 480;

/**
 * Where trays sit: centred along the bottom of the window (no dock), or inside
 * a panel — `left`/`width` across and `top`/`bottom` down the window — as the
 * editor's tablet layout docks them in its tools panel beside the viewer.
 * Docked, a tray has no backdrop and doesn't expand: the viewer and timeline
 * stay live beside it.
 */
type SheetDock = { left: number; width: number; top: number; bottom: number };
/** A docked tray's gap from its panel's sides. */
const DOCK_INSET = 8;
const SheetDockContext = createContext<SheetDock | null>(null);

export function SheetDockProvider({ dock, children }: { dock: SheetDock | null; children: ReactNode }) {
	return <SheetDockContext.Provider value={dock}>{children}</SheetDockContext.Provider>;
}

/** A tray's left edge and width: `maxWidth` at most, `inset` clear of its area's sides, centred in it. */
function trayFrame({
	windowWidth,
	dock,
	inset,
	maxWidth,
}: {
	windowWidth: number;
	dock: SheetDock | null;
	inset: number;
	maxWidth: number;
}) {
	if (dock) return { left: dock.left + DOCK_INSET, width: Math.max(0, dock.width - DOCK_INSET * 2) };
	const width = Math.max(0, Math.min(windowWidth - inset * 2, maxWidth));
	return { left: (windowWidth - width) / 2, width };
}

/**
 * A tray's gap from the window's bottom and top, and the most it may be tall, with a keyboard `keyboardHeight` tall
 * up (0 when none).
 *
 * Along the bottom of the window, the keyboard lifts the tray (Gorhom's interactive keyboard behaviour) and its
 * height is capped to what is left above the keyboard and below the status bar. Docked in a panel, the tray keeps the
 * panel's top and its bottom rises above a keyboard that reaches into the panel: Gorhom's lift is the keyboard's
 * height less the tray's bottom inset as an absolute value, so a keyboard shorter than the gap under the panel (an
 * iPad's shortcut bar, with a hardware keyboard) would have thrown the tray up over the header.
 */
function trayBounds({
	height,
	dock,
	keyboardHeight,
	insetTop,
	tall = false,
	topInset,
	bottomOffset,
}: {
	height: number;
	dock: SheetDock | null;
	keyboardHeight: number;
	insetTop: number;
	tall?: boolean;
	topInset?: number;
	bottomOffset?: number;
}) {
	const bottom = dock ? Math.max(0, height - dock.bottom, keyboardHeight) : (bottomOffset ?? TRAY_BOTTOM_OFFSET);
	const top = dock ? dock.top : (topInset ?? (tall ? 12 : Math.round(height * TRAY_PREVIEW_INSET_RATIO)));
	const keyboardRoom =
		!dock && keyboardHeight > 0 ? height - keyboardHeight - insetTop - spacing.sm : Number.POSITIVE_INFINITY;
	return { bottom, top, maxHeight: Math.max(120, Math.min(height - top - bottom, keyboardRoom)) };
}

/** A tray pulled to full height: the whole phone, a centred column on a tablet, or its whole dock. */
function expandedTrayFrame({
	windowWidth,
	windowHeight,
	dock,
}: {
	windowWidth: number;
	windowHeight: number;
	dock: SheetDock | null;
}) {
	if (dock) return { left: dock.left, width: dock.width };
	const width = isLargeWindow(windowWidth, windowHeight)
		? Math.min(windowWidth, SHEET_EXPANDED_MAX_WIDTH)
		: windowWidth;
	return { left: (windowWidth - width) / 2, width };
}
const TRAY_BACKDROP_OPACITY = 0.3;
const HANDLE_MARK_WIDTH = 36;
const HANDLE_MARK_HEIGHT = 4;

/** Releases a closed sheet whose onDismiss never arrived (see Sheet). */
const DISMISS_FALLBACK_MS = 3000;

/** Longer than Gorhom's default stiff spring so expand/collapse is visible. */
const EXPAND_SPRING: WithSpringConfig = {
	damping: 34,
	stiffness: 240,
	mass: 0.9,
	overshootClamping: true,
};

const SheetLayoutContext = createContext<{
	expanded: boolean;
	filled: boolean;
	inSheet: boolean;
	/** A `scroll={false}` body that sits inside the default body padding (see `bleed`). */
	padded?: boolean;
	scrollProgress?: SharedValue<number>;
}>({
	expanded: false,
	filled: false,
	inSheet: false,
	scrollProgress: undefined as SharedValue<number> | undefined,
});

/** Whether this sheet is pulled to full screen (expandable trays). */
export function useSheetLayout() {
	return useContext(SheetLayoutContext);
}

/** Extend Gorhom's native worklets without replacing its gesture handoff. */
const useSheetScrollEvents: ScrollEventsHandlersHookType = (ref, offset) => {
	const defaults = useScrollEventsHandlersDefault(ref, offset);
	const { scrollProgress } = useSheetLayout();
	const handleOnScroll: NonNullable<
		ReturnType<ScrollEventsHandlersHookType>["handleOnScroll"]
	> = useCallback(
		(event, context) => {
			"worklet";
			defaults.handleOnScroll?.(event, context);
			if (scrollProgress)
				scrollProgress.value = sheetScrollProgress(event.contentOffset.y);
		},
		[defaults.handleOnScroll, scrollProgress],
	);
	return { ...defaults, handleOnScroll };
};

type BleedProps = {
	/**
	 * The only child of a `scroll={false}` body: runs out over the body's padding and pads its own content instead, so
	 * rows scroll to the tray's edge rather than being clipped at its inset.
	 */
	bleed?: boolean;
};

// Undoes the body's padding (and the gap under a header: `body` in createStyles) and moves it inside the list.
const BLEED: ViewStyle = { marginHorizontal: -spacing.md, marginTop: -spacing.sm, marginBottom: -spacing.sm };
const BLEED_CONTENT: ViewStyle = { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm };

function useBleed<P extends { style?: unknown; contentContainerStyle?: unknown }>(
	props: P & BleedProps,
): P {
	const { padded } = useSheetLayout();
	const { bleed, ...rest } = props;
	if (!bleed) return rest as unknown as P;
	return {
		...rest,
		style: [padded && BLEED, props.style],
		contentContainerStyle: [BLEED_CONTENT, props.contentContainerStyle],
	} as unknown as P;
}

/** Register inner vertical scrollables with the sheet; ordinary views outside it. */
export function SheetScrollView(own: ScrollViewProps & BleedProps) {
	const { inSheet } = useSheetLayout();
	const props = useBleed(own);
	if (inSheet && Platform.OS !== "web" && !props.horizontal)
		return (
			<BottomSheetScrollView
				scrollEventsHandlersHook={useSheetScrollEvents}
				{...(props as ComponentProps<typeof BottomSheetScrollView>)}
				showsVerticalScrollIndicator={false}
				bounces={false}
				alwaysBounceVertical={false}
				showsHorizontalScrollIndicator={false}
			/>
		);
	return (
		<ScrollView
			{...props}
			showsVerticalScrollIndicator={false}
			bounces={false}
			alwaysBounceVertical={false}
			showsHorizontalScrollIndicator={false}
		/>
	);
}

export function SheetFlatList<T>(
	own: FlatListProps<T> & { ref?: Ref<FlatList<T>> } & BleedProps,
) {
	const { inSheet } = useSheetLayout();
	const props = useBleed(own);
	if (inSheet && Platform.OS !== "web")
		return (
			<BottomSheetFlatList
				scrollEventsHandlersHook={useSheetScrollEvents}
				{...(props as ComponentProps<typeof BottomSheetFlatList<T>>)}
				showsVerticalScrollIndicator={false}
				bounces={false}
				alwaysBounceVertical={false}
				showsHorizontalScrollIndicator={false}
			/>
		);
	return (
		<FlatList
			{...props}
			showsVerticalScrollIndicator={false}
			showsHorizontalScrollIndicator={false}
		/>
	);
}

/** FlashList / assistant-ui keep virtualization while the sheet owns scroll handoff. */
export function useSheetScrollComponent() {
	const { inSheet } = useSheetLayout();
	const NativeScroll = useBottomSheetScrollableCreator<ScrollViewProps>({
		scrollEventsHandlersHook: useSheetScrollEvents,
	});
	const Scroll = inSheet && Platform.OS !== "web" ? NativeScroll : ScrollView;
	const component = useCallback(
		(props: ScrollViewProps) => (
			<Scroll
				{...props}
				showsVerticalScrollIndicator={false}
				bounces={false}
				alwaysBounceVertical={false}
				showsHorizontalScrollIndicator={false}
			/>
		),
		[Scroll],
	);
	return inSheet ? component : undefined;
}

function expandT(index: SharedValue<number>) {
	"worklet";
	return interpolate(index.value, [0, 1], [0, 1], Extrapolation.CLAMP);
}

function SheetBackground({
	style,
	animatedIndex,
	expandProgress,
	color,
	pointerEvents,
	keepCorners = false,
}: BottomSheetBackgroundProps & {
	expandProgress: SharedValue<number>;
	color: string;
	/** Expanded but narrower than the window (a tablet): keep the rounded corners. */
	keepCorners?: boolean;
}) {
	useAnimatedReaction(
		() => expandT(animatedIndex),
		(value) => {
			if (expandProgress.value !== value) expandProgress.value = value;
		},
	);
	const radiusStyle = useAnimatedStyle(() => ({
		borderRadius: interpolate(
			expandT(animatedIndex),
			[0, 1],
			[TRAY_CORNER_RADIUS, keepCorners ? TRAY_CORNER_RADIUS : 0],
		),
	}));
	return (
		<Animated.View
			pointerEvents={pointerEvents}
			style={[
				style,
				{
					backgroundColor: color,
					borderCurve: "continuous",
					overflow: "hidden",
				},
				radiusStyle,
			]}
		/>
	);
}

/** Grabber padding tracks the snap on the UI thread so the notch inset does not jump. */
function SheetHandle({
	animatedIndex,
	style,
	indicatorStyle,
	safeTop,
}: BottomSheetHandleProps & {
	style?: StyleProp<ViewStyle>;
	indicatorStyle?: StyleProp<ViewStyle>;
	safeTop: number;
}) {
	const padStyle = useAnimatedStyle(() => ({
		paddingTop: interpolate(
			expandT(animatedIndex),
			[0, 1],
			[spacing.sm, safeTop + spacing.sm],
		),
		paddingBottom: spacing.xs,
		alignItems: "center" as const,
		justifyContent: "center" as const,
	}));
	const markStyle = useAnimatedStyle(() => {
		const t = expandT(animatedIndex);
		return {
			width: HANDLE_MARK_WIDTH + 12 * t,
			opacity: 0.72 + 0.28 * t,
		};
	});
	return (
		<Animated.View style={[style, padStyle]}>
			<Animated.View
				style={[
					{
						height: HANDLE_MARK_HEIGHT,
						borderRadius: HANDLE_MARK_HEIGHT / 2,
					},
					indicatorStyle,
					markStyle,
				]}
			/>
		</Animated.View>
	);
}

const SheetPreviewContext = createContext<{
	position: SharedValue<number>;
	owner: SharedValue<string>;
	collapse?: SharedValue<number>;
	reclaimHeight: number;
} | null>(null);

/** Connect preview trays to the editor picture without per-sheet position plumbing. */
export function SheetPreviewProvider({
	collapse,
	reclaimHeight = 52,
	position,
	children,
}: {
	position: SharedValue<number>;
	collapse?: SharedValue<number>;
	reclaimHeight?: number;
	children: ReactNode;
}) {
	const owner = useSharedValue("");
	const { height } = useWindowDimensions();
	useEffect(() => {
		runOnUI(() => {
			"worklet";
			if (!owner.value) position.value = height;
		})();
	}, [height, owner, position]);
	const value = useMemo(
		() => ({ position, owner, collapse, reclaimHeight }),
		[position, owner, collapse, reclaimHeight],
	);
	return (
		<SheetPreviewContext.Provider value={value}>
			{children}
		</SheetPreviewContext.Provider>
	);
}

/**
 * How many times `open` has turned on. A sheet that stays mounted while closed (one of several, under a SheetGate with
 * `keep`, or reopened while it was still sliding away) keys what it holds for one opening by it, so each opening starts
 * fresh in its first frame, not a frame after an effect resets it.
 */
export function useOpenCount(open: boolean): number {
	const [seen, setSeen] = useState({ open, count: 0 });
	// Adjusted while rendering (React renders again at once, before anything shows), so the new count is never late.
	if (seen.open !== open) setSeen({ open, count: open ? seen.count + 1 : seen.count });
	return open && !seen.open ? seen.count + 1 : seen.count;
}

/** The sheets under a SheetGate say while they are on screen (open, or still sliding away). */
const SheetGateContext = createContext<{
	hold: (id: string) => void;
	release: (id: string) => void;
} | null>(null);

/**
 * Renders a feature sheet only while it is `open` or one of its Sheets is still sliding away, so a closed sheet costs
 * nothing when the screen around it re-renders. With `keep`, a closed sheet stays mounted but frozen (React skips it)
 * instead, for sheets whose own state must outlive a close; it renders again, with fresh props, when it next opens.
 * `children` may be a function, so a closed sheet's elements aren't even made; a gate that stays closed doesn't render.
 */
export const SheetGate = memo(function SheetGate({
	open,
	keep = false,
	children,
}: {
	open: boolean;
	keep?: boolean;
	children: ReactNode | (() => ReactNode);
}) {
	const [live, setLive] = useState(open);
	if (open && !live) setLive(true);
	const openNow = useRef(open);
	// Set before the Sheets' passive effects release.
	useLayoutEffect(() => {
		openNow.current = open;
	}, [open]);
	const held = useRef(new Set<string>());
	const gate = useMemo(
		() => ({
			hold: (id: string) => {
				held.current.add(id);
			},
			release: (id: string) => {
				held.current.delete(id);
				if (!openNow.current && held.current.size === 0) setLive(false);
			},
		}),
		[],
	);
	// Closed with nothing on screen (its sheet never showed): done at once.
	useEffect(() => {
		if (!open && held.current.size === 0) setLive(false);
	}, [open]);
	const last = useRef<ReactNode>(null);
	if (open || live) last.current = typeof children === "function" ? children() : children;
	else if (!keep) return null;
	return <SheetGateContext.Provider value={gate}>{last.current}</SheetGateContext.Provider>;
}, (prev, next) => !prev.open && !next.open && prev.keep === next.keep);

/** Gorhom bottom sheet on native, chrome-matched to Morphlet; RN Modal on web. Morphlet stays a dep for later. */
export function Sheet(props: SheetProps) {
	const previewHost = useContext(SheetPreviewContext);
	const dock = useContext(SheetDockContext);
	const gate = useContext(SheetGateContext);
	const id = useId();
	const { height } = useWindowDimensions();
	const ownPosition = useSharedValue(height);
	const scrollProgress = useSharedValue(0);
	const collapse = previewHost?.collapse;
	const visible = props.visible;
	const preview = props.variant === "preview";
	const position = props.animatedPosition ?? ownPosition;
	useEffect(() => {
		if (Platform.OS === "web" && !visible) position.value = height;
	}, [visible, position, height]);
	const output = previewHost?.position;
	const owner = previewHost?.owner;
	useAnimatedReaction(
		() => ({
			top: preview ? position.value : height,
			scroll: scrollProgress.value,
		}),
		({ top, scroll }) => {
			if (output && owner) {
				syncSheetPreview(output, owner, id, top, height, visible);
				// A sheet that is closing leaves the header to the effect below: following the tray down would hand it back
				// only as the tray's slow exit finishes.
				if (collapse && visible && (owner.value === id || !owner.value))
					collapse.value =
						owner.value === id
							? scroll *
								Math.max(0, Math.min(1, (height - top) / (height * 0.5)))
							: 0;
			}
		},
		[
			preview,
			visible,
			height,
			id,
			output,
			owner,
			position,
			collapse,
			scrollProgress,
		],
	);
	// Closing: the header it collapsed comes back at once, not as the tray finishes leaving.
	useEffect(() => {
		if (visible || !collapse || !owner) return;
		runOnUI(() => {
			"worklet";
			if (owner.value === id) collapse.value = withTiming(0, { duration: 180 });
		})();
	}, [visible, collapse, owner, id]);
	useEffect(
		() => () => {
			if (output && owner)
				runOnUI(() => {
					"worklet";
					if (owner.value === id) {
						owner.value = "";
						output.value = height;
						if (collapse) collapse.value = 0;
					}
				})();
		},
		[output, owner, id, height, collapse],
	);
	const resolved = preview
		? {
				...props,
				animatedPosition: position,
				scrollProgress,
				reclaimHeight: props.reclaimHeight ?? previewHost?.reclaimHeight ?? 0,
				passthrough: props.passthrough ?? true,
			}
		: props;
	const inTree = Boolean(resolved.passthrough || dock) && Platform.OS === "web";
	// Shown until its close animation ends (the modal's onDismiss); an in-tree sheet has none and goes at once.
	const [shown, setShown] = useState(visible);
	if (visible && !shown) setShown(true);
	const settled = !visible && (inTree || !shown);
	useEffect(() => {
		if (!gate || settled) return;
		gate.hold(id);
		return () => gate.release(id);
	}, [gate, settled, id]);
	const { onDismiss } = props;
	const dismissed = useCallback(() => {
		setShown(false);
		onDismiss?.();
	}, [onDismiss]);
	// A dismiss that never comes (a native sheet closed while it was still mounting, a web modal closed before it
	// rendered or in a hidden tab) must not keep it mounted for good. Well past either close animation: Gorhom's
	// EXPAND_SPRING settles in about a second, RN-web's slide takes 250ms.
	const closing = !visible && !settled;
	useEffect(() => {
		if (!closing) return;
		const timer = setTimeout(() => setShown(false), DISMISS_FALLBACK_MS);
		return () => clearTimeout(timer);
	}, [closing]);
	// Closed and gone: none of the tray's hooks and layout run while the screen around it re-renders.
	if (settled) return null;
	if (inTree) return <PassthroughSheet {...resolved} />;
	if (Platform.OS === "web") return <FallbackSheet {...resolved} onDismiss={dismissed} />;
	return <GorhomSheet {...resolved} onDismiss={dismissed} />;
}

function GorhomSheet({
	horizontalInset = TRAY_HORIZONTAL_INSET,
	maxWidth = TRAY_MAX_WIDTH,
	scrollProgress,
	reclaimHeight: reclaimProp = 0,
	animatedPosition,
	variant = "standard",
	visible,
	title,
	onClose,
	onDismiss,
	children,
	footer,
	action,
	scroll = true,
	tall = false,
	draggable = true,
	contentDraggable = true,
	header = true,
	expandable: expandableProp = true,
	bodyStyle,
	passthrough: passthroughProp = false,
	bottomOffset,
	topInset: topInsetProp,
}: SheetProps) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const { height, width } = useWindowDimensions();
	// Expanded, a sheet fills a phone; on a tablet it stays a centred column.
	// Placed by margins: Gorhom pins the sheet to both sides of the window, so
	// alignSelf can't centre it (a capped tray sat at the left of a tablet).
	const dock = useContext(SheetDockContext);
	// Docked in a panel: no backdrop, no full-screen expand, no growing into the header's room; it sits in the panel's
	// rectangle (bottomOffset and topInset below).
	const passthrough = passthroughProp || dock !== null;
	const expandable = expandableProp && dock === null;
	const reclaimHeight = dock ? 0 : reclaimProp;
	const tray = trayFrame({ windowWidth: width, dock, inset: horizontalInset, maxWidth });
	const full = expandedTrayFrame({ windowWidth: width, windowHeight: height, dock });
	const keepCorners = full.width < width;
	const insets = useSafeAreaInsets();
	const sheetRef = useRef<BottomSheetModal>(null);
	const opened = useRef(false);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const expandProgress = useSharedValue(0);
	const previewTray = variant === "preview";
	const canExpand = expandable && draggable && !previewTray;
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (!visible) setExpanded(false);
	}, [visible]);
	useEffect(() => {
		if (visible) {
			opened.current = true;
			sheetRef.current?.present();
			return;
		}
		if (!opened.current) return;
		opened.current = false;
		sheetRef.current?.dismiss();
	}, [visible]);
	// The keyboard lifts the sheet by its own height, so a sheet as tall as the tray's cap would end up above the top of
	// the screen. While it is up the sheet is capped to what is left between the keyboard and the status bar.
	const [keyboardHeight, setKeyboardHeight] = useState(0);
	useEffect(() => {
		if (!visible) return;
		const ios = Platform.OS === "ios";
		const show = Keyboard.addListener(
			ios ? "keyboardWillShow" : "keyboardDidShow",
			(event) => setKeyboardHeight(event.endCoordinates.height),
		);
		const hide = Keyboard.addListener(
			ios ? "keyboardWillHide" : "keyboardDidHide",
			() => setKeyboardHeight(0),
		);
		return () => {
			show.remove();
			hide.remove();
			setKeyboardHeight(0);
		};
	}, [visible]);
	const {
		bottom: trayBottom,
		top: topGap,
		maxHeight,
	} = trayBounds({
		height,
		dock,
		keyboardHeight,
		insetTop: insets.top,
		tall,
		topInset: topInsetProp,
		bottomOffset,
	});
	const dockedSnap = Math.min(
		maxHeight,
		tall ? Math.round(height * 0.92) : maxHeight,
	);
	// Docked in a panel, a tray fills it at a fixed height, like an inspector: sized to its content, Gorhom measures a
	// scrolling body as empty and never opens it (seen in the web build running Gorhom).
	const docked = dock !== null;
	const snapPoints = useMemo(() => {
		if (previewTray || docked) return [dockedSnap];
		if (canExpand) return [dockedSnap, height];
		if (tall) return [dockedSnap];
		return undefined;
	}, [canExpand, tall, dockedSnap, docked, height, previewTray]);
	const previewSnaps = useDerivedValue<(string | number)[]>(() => {
		// A fixed browsing tray must not subscribe its snap height to scroll offsets.
		// Gorhom can relock the scrollable when a new snap arrives during its drag.
		if (reclaimHeight === 0) return [dockedSnap];
		return [
			previewSheetHeight(
				dockedSnap,
				scrollProgress?.value ?? 0,
				reclaimHeight,
				height - insets.top - trayBottom,
			),
		];
	});
	const bodyFill = canExpand || tall || previewTray || docked;
	const layout = useMemo(
		() => ({ expanded, filled: bodyFill, inSheet: true, padded: !scroll && !tall, scrollProgress }),
		[expanded, bodyFill, scroll, tall, scrollProgress],
	);
	const cardStyle = useAnimatedStyle(() => {
		const t = interpolate(
			expandProgress.value,
			[0, 1],
			[0, 1],
			Extrapolation.CLAMP,
		);
		return {
			marginLeft: tray.left + (full.left - tray.left) * t,
			marginRight:
				width - tray.left - tray.width +
				(tray.left + tray.width - full.left - full.width) * t,
			width: tray.width + (full.width - tray.width) * t,
			maxWidth: tray.width + (full.width - tray.width) * t,
			borderRadius: keepCorners ? TRAY_CORNER_RADIUS : TRAY_CORNER_RADIUS * (1 - t),
		};
	});
	const renderBackground = useCallback(
		(props: BottomSheetBackgroundProps) => (
			<SheetBackground
				{...props}
				expandProgress={expandProgress}
				color={colors.background}
				keepCorners={keepCorners}
			/>
		),
		[colors.background, expandProgress, keepCorners],
	);
	const renderHandle = useCallback(
		(props: BottomSheetHandleProps) => (
			<SheetHandle
				{...props}
				safeTop={insets.top}
				indicatorStyle={[
					styles.morphletHandleIndicator,
					{ backgroundColor: colors.borderStrong },
				]}
			/>
		),
		[insets.top, styles.morphletHandleIndicator, colors.borderStrong],
	);
	const renderBackdrop = useCallback(
		(props: BottomSheetBackdropProps) => (
			<BottomSheetBackdrop
				{...props}
				appearsOnIndex={0}
				disappearsOnIndex={-1}
				opacity={passthrough ? 0 : TRAY_BACKDROP_OPACITY}
				pressBehavior={passthrough ? "none" : "close"}
				enableTouchThrough={passthrough}
			/>
		),
		[passthrough],
	);
	const headerRow = (
		<View style={styles.trayHeader}>
			<View style={styles.titleRow}>
				<View style={styles.dot} />
				<Text style={styles.title}>{title}</Text>
			</View>
			<View style={styles.headerActions}>
				{action}
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`Close ${title}`}
					onPress={onClose}
					hitSlop={8}
				>
					<Icon icon={Cancel01Icon} size={20} color={colors.mutedForeground} />
				</Pressable>
			</View>
		</View>
	);
	const chrome = header ? headerRow : null;
	const body = scroll ? (
		<SheetScrollView
			style={
				(bodyFill ? styles.tallBody : undefined) as ScrollViewProps["style"]
			}
			contentContainerStyle={
				[styles.body, bodyStyle] as ComponentProps<
					typeof SheetScrollView
				>["contentContainerStyle"]
			}
			keyboardShouldPersistTaps="handled"
		>
			{chrome}
			{children}
		</SheetScrollView>
	) : bodyFill ? (
		// BottomSheetView registers itself as a static scrollable on mount. A
		// filled shell must let its inner list register instead (text, media, chat).
		<View style={[!tall && styles.body, styles.tallBody, bodyStyle]}>
			{chrome}
			{children}
		</View>
	) : (
		<BottomSheetView
			style={
				[styles.body, bodyStyle] as ComponentProps<
					typeof BottomSheetView
				>["style"]
			}
		>
			{chrome}
			{children}
		</BottomSheetView>
	);
	return (
		<BottomSheetModal
			animatedPosition={animatedPosition}
			ref={sheetRef}
			detached
			enableDynamicSizing={!canExpand && !tall && !previewTray && !docked}
			maxDynamicContentSize={maxHeight}
			snapPoints={previewTray ? previewSnaps : snapPoints}
			animationConfigs={EXPAND_SPRING}
			enablePanDownToClose={draggable}
			enableContentPanningGesture={
				draggable && contentDraggable && (previewTray || scroll || canExpand)
			}
			enableHandlePanningGesture={draggable}
			enableOverDrag={false}
			// Docked, trayBounds raises the tray over the keyboard itself (Gorhom would lift it by the wrong amount).
			keyboardBehavior={dock ? "extend" : "interactive"}
			keyboardBlurBehavior="restore"
			enableBlurKeyboardOnGesture
			android_keyboardInputMode="adjustPan"
			bottomInset={canExpand ? 0 : trayBottom}
			topInset={0}
			stackBehavior="replace"
			onDismiss={() => {
				if (animatedPosition) animatedPosition.value = height;
				if (scrollProgress) scrollProgress.value = 0;
				opened.current = false;
				// What the parent wants now, not what it wanted when the modal last rendered: a sheet the parent just closed
				// to open another dismisses after that, and closing "its" state again closed the new sheet as it opened.
				if (visibleRef.current) onCloseRef.current();
				onDismiss?.();
			}}
			onAnimate={(fromIndex, toIndex) => {
				// A downward gesture from full screen closes in one motion;
				// do not settle back at the initial preview snap first.
				if (canExpand && fromIndex === 1 && toIndex === 0)
					sheetRef.current?.dismiss();
			}}
			onChange={(index) => {
				if (index < 0 || !canExpand) return;
				setExpanded(index >= 1);
			}}
			backdropComponent={renderBackdrop}
			backgroundComponent={canExpand ? renderBackground : undefined}
			backgroundStyle={canExpand ? undefined : styles.morphletBackground}
			handleComponent={canExpand ? renderHandle : undefined}
			containerStyle={passthrough ? styles.passthroughHost : undefined}
			style={
				[
					canExpand ? styles.morphletChrome : styles.morphletCard,
					canExpand
						? cardStyle
						: {
								marginLeft: tray.left,
								marginRight: width - tray.left - tray.width,
								// Explicit: Gorhom places the card by its margins, so without a width it shrinks to its
								// content, and a list that doesn't stretch left the tray narrower than its frame, pinned left.
								width: tray.width,
								maxWidth: tray.width,
							},
				] as ComponentProps<typeof BottomSheetModal>["style"]
			}
			handleStyle={canExpand ? undefined : styles.morphletHandle}
			handleIndicatorStyle={[
				styles.morphletHandleIndicator,
				{ backgroundColor: colors.borderStrong },
			]}
		>
			<SheetLayoutContext.Provider value={layout}>
				{footer ? (
					<View style={bodyFill ? styles.tallBody : undefined}>
						{body}
						<View style={{ flexShrink: 0 }}>{footer}</View>
					</View>
				) : (
					body
				)}
			</SheetLayoutContext.Provider>
		</BottomSheetModal>
	);
}

function PassthroughSheet({
	horizontalInset = TRAY_HORIZONTAL_INSET,
	maxWidth = TRAY_MAX_WIDTH,
	visible,
	title,
	onClose,
	children,
	footer,
	action,
	scroll = true,
	header = true,
	bodyStyle,
	variant,
	animatedPosition,
	topInset,
	bottomOffset,
}: SheetProps) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const { width, height } = useWindowDimensions();
	const dock = useContext(SheetDockContext);
	const tray = trayFrame({ windowWidth: width, dock, inset: horizontalInset, maxWidth });
	if (!visible) return null;
	const previewTray = variant === "preview";
	// A preview tray given the room above it is as tall as the rest and sits its bottom offset up, as on a phone (trayBounds).
	const sized = previewTray && !dock && topInset !== undefined;
	const bottomGap = sized ? (bottomOffset ?? TRAY_BOTTOM_OFFSET) : Math.max(TRAY_BOTTOM_OFFSET, insets.bottom);
	const previewHeight = sized ? Math.max(120, height - topInset - bottomGap) : null;
	return (
		<SheetLayoutContext.Provider
			value={{ expanded: false, filled: previewTray || dock !== null, inSheet: true, padded: !scroll }}
		>
			<View
				pointerEvents="box-none"
				style={[
					styles.passthroughRoot,
					dock
						? { top: dock.top, bottom: height - dock.bottom, paddingLeft: tray.left, paddingRight: width - tray.left - tray.width }
						: { paddingLeft: tray.left, paddingRight: width - tray.left - tray.width },
				]}
			>
				<View
					onLayout={(event) => {
						if (animatedPosition)
							animatedPosition.value = event.nativeEvent.layout.y;
					}}
					pointerEvents="auto"
					style={[
						styles.passthroughPanel,
						{ maxWidth: tray.width },
						previewTray && (previewHeight === null ? styles.previewPanel : { height: previewHeight, maxHeight: previewHeight }),
						dock ? { flex: 1, marginBottom: DOCK_INSET } : { marginBottom: bottomGap },
					]}
				>
					{header ? (
						<View style={styles.header}>
							<View style={styles.titleRow}>
								<View style={styles.dot} />
								<Text style={styles.title}>{title}</Text>
							</View>
							<View style={styles.headerActions}>
								{action}
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`Close ${title}`}
									onPress={onClose}
									hitSlop={8}
								>
									<Icon
										icon={Cancel01Icon}
										size={20}
										color={colors.mutedForeground}
									/>
								</Pressable>
							</View>
						</View>
					) : (
						<View style={styles.grabberHeader}>
							<View style={styles.handle} />
						</View>
					)}
					{scroll ? (
						<ScrollView
							showsVerticalScrollIndicator={false}
							showsHorizontalScrollIndicator={false}
							style={[styles.clipView, (previewTray || dock) && styles.tallBody]}
							contentContainerStyle={[styles.body, bodyStyle]}
							keyboardShouldPersistTaps="handled"
							automaticallyAdjustKeyboardInsets={false}
						>
							{children}
						</ScrollView>
					) : (
						<View
							style={[
								styles.body,
								styles.clipView,
								(previewTray || dock) && styles.tallBody,
								bodyStyle,
							]}
						>
							{children}
						</View>
					)}
					{footer}
				</View>
			</View>
		</SheetLayoutContext.Provider>
	);
}

function FallbackSheet({
	horizontalInset = TRAY_HORIZONTAL_INSET,
	maxWidth = TRAY_MAX_WIDTH,
	variant = "standard",
	visible,
	title,
	onClose,
	onDismiss,
	children,
	footer,
	action,
	scroll = true,
	tall = false,
	header = true,
	expandable = true,
	draggable = true,
	bodyStyle,
}: SheetProps) {
	const { colors } = useTheme();
	const styles = useThemedStyles(createStyles);
	const { width, height } = useWindowDimensions();
	const dock = useContext(SheetDockContext);
	const tray = trayFrame({ windowWidth: width, dock, inset: horizontalInset, maxWidth });
	const full = expandedTrayFrame({ windowWidth: width, windowHeight: height, dock });
	const keepCorners = full.width < width;
	const previewTray = variant === "preview";
	const canExpand = expandable && draggable && !previewTray;
	const [expanded, setExpanded] = useState(false);
	const expandTValue = useSharedValue(0);
	useEffect(() => {
		if (!visible) setExpanded(false);
	}, [visible]);
	useEffect(() => {
		expandTValue.value = withSpring(expanded ? 1 : 0, EXPAND_SPRING);
	}, [expanded, expandTValue]);
	const expand = useCallback(() => setExpanded(true), []);
	const expandPan = useExpandPan({
		enabled: canExpand,
		expanded,
		onExpand: expand,
		onDismiss: onClose,
	});
	const filled = tall || expanded || previewTray;
	const rootMotion = useAnimatedStyle(() => ({
		paddingLeft: tray.left + (full.left - tray.left) * expandTValue.value,
		paddingRight:
			width - tray.left - tray.width +
			(tray.left + tray.width - full.left - full.width) * expandTValue.value,
		paddingBottom: TRAY_BOTTOM_OFFSET * (1 - expandTValue.value),
	}));
	const panelMotion = useAnimatedStyle(() => ({
		borderRadius: keepCorners ? TRAY_CORNER_RADIUS : TRAY_CORNER_RADIUS * (1 - expandTValue.value),
		maxWidth: tray.width + (full.width - tray.width) * expandTValue.value,
	}));
	const grabber = canExpand ? (
		<GestureDetector gesture={expandPan}>
			<View
				collapsable={false}
				accessible
				accessibilityRole="adjustable"
				accessibilityLabel="Sheet size"
				accessibilityHint={
					expanded ? "Drag down to close" : "Drag up for full screen"
				}
				accessibilityValue={{ text: expanded ? "full screen" : "preview" }}
				style={styles.handleHit}
			>
				<View style={[styles.handle, styles.handleMark]} />
			</View>
		</GestureDetector>
	) : (
		<View style={styles.handle} />
	);
	return (
		<SheetLayoutContext.Provider value={{ expanded, filled, inSheet: true, padded: !scroll && !filled }}>
			<Modal
				visible={visible}
				transparent
				animationType="slide"
				onRequestClose={onClose}
				onDismiss={onDismiss}
			>
				<KeyboardAvoidingView
					style={styles.fallbackHost}
					behavior={Platform.OS === "ios" ? "padding" : undefined}
				>
					<Animated.View
						style={[
							styles.root,
							expanded && styles.expandedRoot,
							expanded
								? { paddingLeft: full.left, paddingRight: width - full.left - full.width }
								: { paddingLeft: tray.left, paddingRight: width - tray.left - tray.width },
							canExpand ? rootMotion : null,
						]}
					>
						<Pressable
							accessibilityLabel="Close"
							style={styles.backdrop}
							onPress={onClose}
						/>
						<Animated.View
							style={[
								styles.panel,
								!expanded && { maxWidth: tray.width },
								tall && !expanded && styles.tallPanel,
								previewTray && styles.previewPanel,
								expanded && styles.expandedPanel,
								canExpand ? panelMotion : null,
							]}
						>
							<SafeAreaView
								edges={expanded ? ["top"] : ["bottom"]}
								style={styles.fallbackFill}
							>
								{grabber}
								{header ? (
									<View style={styles.header}>
										<View style={styles.titleRow}>
											<View style={styles.dot} />
											<Text style={styles.title}>{title}</Text>
										</View>
										<View style={styles.headerActions}>
											{action}
											<Pressable
												accessibilityRole="button"
												accessibilityLabel={`Close ${title}`}
												onPress={onClose}
												hitSlop={8}
											>
												<Icon
													icon={Cancel01Icon}
													size={20}
													color={colors.mutedForeground}
												/>
											</Pressable>
										</View>
									</View>
								) : null}
								{scroll ? (
									<ScrollView
										showsVerticalScrollIndicator={false}
										showsHorizontalScrollIndicator={false}
										style={filled ? styles.tallBody : styles.clipView}
										contentContainerStyle={[styles.body, bodyStyle]}
										keyboardShouldPersistTaps="handled"
										automaticallyAdjustKeyboardInsets={false}
									>
										{children}
									</ScrollView>
								) : (
									<View
										style={[
											filled ? styles.tallBody : styles.body,
											styles.clipView,
											bodyStyle,
										]}
									>
										{children}
									</View>
								)}
								{footer}
							</SafeAreaView>
						</Animated.View>
					</Animated.View>
				</KeyboardAvoidingView>
			</Modal>
		</SheetLayoutContext.Provider>
	);
}

function createStyles(colors: ThemeColors) {
	return {
		fallbackHost: { flex: 1 },
		fallbackFill: { flex: 1 },
		root: {
			flex: 1,
			justifyContent: "flex-end" as const,
			paddingHorizontal: TRAY_HORIZONTAL_INSET,
			paddingBottom: TRAY_BOTTOM_OFFSET,
			alignItems: "center" as const,
		},
		morphletChrome: {
			alignSelf: "center" as const,
			overflow: "hidden" as const,
			borderCurve: "continuous" as const,
		},
		morphletCard: {
			marginHorizontal: TRAY_HORIZONTAL_INSET,
			alignSelf: "center" as const,
			maxWidth: TRAY_MAX_WIDTH,
			overflow: "hidden" as const,
			borderRadius: TRAY_CORNER_RADIUS,
			borderCurve: "continuous" as const,
		},
		morphletBackground: {
			backgroundColor: colors.background,
			borderRadius: TRAY_CORNER_RADIUS,
			borderCurve: "continuous" as const,
		},
		expandedRoot: {
			paddingHorizontal: 0,
			paddingBottom: 0,
		},
		expandedPanel: {
			height: "100%" as const,
			maxHeight: "100%" as const,
			maxWidth: "100%" as const,
			width: "100%" as const,
			borderRadius: 0,
			borderCurve: "continuous" as const,
		},
		morphletHandle: {
			paddingTop: spacing.sm,
			paddingBottom: spacing.xs,
			paddingHorizontal: 0,
		},
		morphletHandleIndicator: {
			width: 36,
			height: 4,
			borderRadius: 2,
		},
		passthroughHost: { pointerEvents: "box-none" as const },
		passthroughRoot: {
			position: "absolute" as const,
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			justifyContent: "flex-end" as const,
			paddingHorizontal: TRAY_HORIZONTAL_INSET,
			zIndex: 20,
			alignItems: "center" as const,
		},
		passthroughPanel: {
			backgroundColor: colors.background,
			borderRadius: TRAY_CORNER_RADIUS,
			borderCurve: "continuous" as const,
			paddingTop: spacing.sm,
			overflow: "hidden" as const,
			width: "100%" as const,
			maxWidth: TRAY_MAX_WIDTH,
		},
		backdrop: {
			position: "absolute" as const,
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			backgroundColor: `rgba(0,0,0,${TRAY_BACKDROP_OPACITY})`,
		},
		panel: {
			maxHeight: "75%" as const,
			width: "100%" as const,
			maxWidth: TRAY_MAX_WIDTH,
			backgroundColor: colors.background,
			borderRadius: TRAY_CORNER_RADIUS,
			borderCurve: "continuous" as const,
			paddingTop: spacing.sm,
			overflow: "hidden" as const,
		},
		tallPanel: { height: "88%" as const, maxHeight: "88%" as const },
		previewPanel: { height: "64%" as const, maxHeight: "64%" as const },
		handle: {
			alignSelf: "center" as const,
			width: 36,
			height: 4,
			borderRadius: 2,
			backgroundColor: colors.borderStrong,
			marginBottom: spacing.sm,
		},
		handleHit: {
			alignSelf: "stretch" as const,
			alignItems: "center" as const,
			paddingVertical: 14,
		},
		handleMark: { marginBottom: 0 },
		expandableHeader: {
			alignItems: "center" as const,
			paddingTop: spacing.sm,
			paddingBottom: spacing.sm,
			gap: spacing.sm,
		},
		headerBar: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			justifyContent: "space-between" as const,
			paddingHorizontal: spacing.md,
			alignSelf: "stretch" as const,
		},
		header: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			justifyContent: "space-between" as const,
			paddingHorizontal: spacing.md,
			paddingBottom: spacing.sm,
			borderBottomWidth: 1,
			borderBottomColor: colors.border,
		},
		trayHeader: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			justifyContent: "space-between" as const,
			paddingHorizontal: spacing.md,
			minHeight: 36,
			paddingTop: 0,
			paddingBottom: 0,
		},
		grabberHeader: {
			alignItems: "center" as const,
			paddingTop: spacing.sm,
			paddingBottom: spacing.xs,
		},
		titleRow: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: spacing.sm,
			flexShrink: 1,
		},
		dot: {
			width: 6,
			height: 6,
			borderRadius: 3,
			backgroundColor: colors.dotPink,
		},
		title: {
			fontFamily: fonts.semibold,
			fontSize: 15,
			color: colors.foreground,
			flexShrink: 1,
		},
		headerActions: {
			flexDirection: "row" as const,
			alignItems: "center" as const,
			gap: spacing.md,
		},
		// Less under the content than around it: the tray already floats clear of the screen edge.
		body: {
			paddingHorizontal: spacing.md,
			paddingTop: spacing.sm,
			paddingBottom: spacing.sm,
			gap: spacing.sm,
		},
		clipView: { overflow: "hidden" as const, minHeight: 0 },
		tallBody: { flex: 1, overflow: "hidden" as const, minHeight: 0 },
		tallView: { flex: 1 },
	};
}
