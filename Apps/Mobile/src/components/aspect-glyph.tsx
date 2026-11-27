import { View } from "react-native";

/** A frame outline whose proportions show the ratio before reading its label. */
export function AspectGlyph({ ratio, color, size = 22 }: { ratio: number | null; color: string; size?: number }) {
  const width = ratio === null || ratio >= 1 ? size : Math.max(8, size * ratio);
  const height = ratio === null || ratio < 1 ? size : Math.max(8, size / ratio);
  return <View style={{ width, height, borderWidth: 1.5, borderColor: color, borderStyle: ratio === null ? "dashed" : "solid", borderRadius: 4, borderCurve: "continuous" }} />;
}
