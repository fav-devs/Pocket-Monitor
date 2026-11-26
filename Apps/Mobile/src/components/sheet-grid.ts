import { useState } from "react";
import { type LayoutChangeEvent, useWindowDimensions } from "react-native";
import { TRAY_HORIZONTAL_INSET, TRAY_MAX_WIDTH } from "./sheet";
/** Start with the tray's capped width, then use its real content width. */
export function useSheetContentWidth(padding = 16) {
	const { width } = useWindowDimensions();
	const [measured, setMeasured] = useState(0);
	return {
		width:
			measured > 0
				? measured
				: Math.max(
						1,
						Math.min(width - TRAY_HORIZONTAL_INSET * 2, TRAY_MAX_WIDTH) -
							padding * 2,
					),
		onLayout: (event: LayoutChangeEvent) => {
			const next = event.nativeEvent.layout.width;
			if (next > 0 && next !== measured) setMeasured(next);
		},
	};
}
