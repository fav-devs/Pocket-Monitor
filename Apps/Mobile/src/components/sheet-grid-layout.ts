/** Round down so fractional layout widths never push the last tile onto another row. */
export function sheetGridTileWidth(
	width: number,
	columns = 3,
	gap = 8,
): number {
	return Math.max(1, Math.floor((width - gap * (columns - 1)) / columns));
}
