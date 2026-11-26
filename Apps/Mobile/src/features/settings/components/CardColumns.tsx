import { Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

export const minimumColumnWidth = 275;

/** Wrap a card to span both columns. */
export function FullWidth({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/**
 * Settings cards in one column, or two once there is room (`MonitorCardColumns`). Cards are dealt
 * to the shorter column by measured height so two columns do not leave holes. A `FullWidth` child
 * spans both columns and starts a new band.
 */
export function CardColumns({ width, children, spacing = 10 }: { width: number; children: ReactNode; spacing?: number }) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{ fullWidth?: boolean }>[];
  const [heights, setHeights] = useState<Record<string, number>>({});
  const columns = width >= minimumColumnWidth * 2 + spacing ? 2 : 1;
  if (columns === 1) {
    return <View style={{ gap: spacing }}>{items}</View>;
  }
  // Split into bands at full-width cards, then deal each band into two columns.
  const bands: { full?: ReactElement; cols: ReactElement[][] }[] = [];
  let current: ReactElement[][] = [[], []];
  let colH = [0, 0];
  const flush = () => {
    if (current[0].length || current[1].length) bands.push({ cols: current });
    current = [[], []];
    colH = [0, 0];
  };
  for (const item of items) {
    if (item.type === FullWidth || item.props.fullWidth) {
      flush();
      bands.push({ full: item, cols: [] });
      continue;
    }
    const key = String(item.key);
    const h = heights[key] ?? 200;
    const col = colH[0] <= colH[1] ? 0 : 1;
    current[col].push(item);
    colH[col] += h + spacing;
  }
  flush();
  const measure = (key: string) => (e: { nativeEvent: { layout: { height: number } } }) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setHeights((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }));
  };
  return (
    <View style={{ gap: spacing }}>
      {bands.map((band, bi) =>
        band.full ? (
          <View key={`full-${bi}`}>{band.full}</View>
        ) : (
          <View key={`band-${bi}`} style={{ flexDirection: 'row', gap: spacing, alignItems: 'flex-start' }}>
            {band.cols.map((col, ci) => (
              <View key={ci} style={{ flex: 1, gap: spacing }}>
                {col.map((item) => (
                  <View key={String(item.key)} onLayout={measure(String(item.key))}>
                    {item}
                  </View>
                ))}
              </View>
            ))}
          </View>
        ),
      )}
    </View>
  );
}
