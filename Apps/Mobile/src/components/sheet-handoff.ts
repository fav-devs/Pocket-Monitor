/** A modal's next action waits until its native dismissal has completed. */
export function createSheetHandoff() {
	let closing = false;
	let next: (() => void) | undefined;
	return {
		get closing() {
			return closing;
		},
		request(action?: () => void) {
			if (closing) return false;
			closing = true;
			next = action;
			return true;
		},
		didDismiss() {
			const action = next;
			next = undefined;
			closing = false;
			action?.();
		},
		cancel() {
			next = undefined;
			closing = false;
		},
	};
}
