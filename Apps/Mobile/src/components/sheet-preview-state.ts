/** UI-thread ownership prevents a closing tray from moving a newly opened tray's preview. */
export function syncSheetPreview(
	position: { value: number },
	owner: { value: string },
	id: string,
	top: number,
	height: number,
	visible: boolean,
) {
	"worklet";
	if (visible && top < height - 1) owner.value = id;
	if (owner.value !== id) return;
	position.value = top;
	if (top >= height - 1) owner.value = "";
}

/** Ignore the first few pixels; scrolling back to the top restores all chrome. */
export function sheetScrollProgress(offset: number) {
	"worklet";
	return Math.max(0, Math.min(1, (offset - 16) / 96));
}

export function previewSheetHeight(
	docked: number,
	progress: number,
	reclaim: number,
	maximum: number,
) {
	"worklet";
	return Math.min(maximum, docked + progress * reclaim);
}
