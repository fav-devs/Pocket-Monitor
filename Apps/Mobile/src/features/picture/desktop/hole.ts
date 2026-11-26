/**
 * DOM helpers for the desktop picture hole. Pure DOM, no React, so they can be tested.
 */

/** `picture://fit` from the Rust render thread: the drawn letterbox, CSS px of the viewport. */
export interface DesktopFit {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

const STYLE_ID = 'pm-desktop-hole';
const ATTRIBUTE = 'data-pm-hole';
const counts = new WeakMap<Element, number>();

/**
 * Makes `node` and every ancestor up to `<html>` transparent (a `!important` rule on a data
 * attribute, so react-native-web's classes and React's inline styles are left alone), so the
 * native picture under the web view shows through. Returns the undo. Nested holes are counted.
 */
export function punchThrough(node: Element): () => void {
  const doc = node.ownerDocument;
  if (doc && !doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `[${ATTRIBUTE}]{background-color:transparent !important;background-image:none !important}`;
    doc.head?.appendChild(style);
  }
  const marked: Element[] = [];
  for (let element: Element | null = node; element; element = element.parentElement) {
    counts.set(element, (counts.get(element) ?? 0) + 1);
    element.setAttribute(ATTRIBUTE, '');
    marked.push(element);
  }
  return () => {
    for (const element of marked) {
      const left = (counts.get(element) ?? 1) - 1;
      counts.set(element, left);
      if (left <= 0) element.removeAttribute(ATTRIBUTE);
    }
  };
}
