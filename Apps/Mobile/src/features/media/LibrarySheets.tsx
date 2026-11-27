import { GridViewIcon, LeftToRightListBulletIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { Pressable, Text, View } from 'react-native';
import type { ColorMode } from '@/camera';
import { Button } from '@/components/button';
import { Chip } from '@/components/chip';
import { ChipRow, FieldSection } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { Sheet } from '@/components/sheet';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { type MediaLayout, type MediaSort, type MediaThumbnailSize, useMediaPreferences } from '@/state/media';
import { type FilterChoice, type FilterOptions, sortOrder, sortTitles } from './gallery';
import { activeFilterCount, emptyFilters, type MediaFilters } from './libraryStore';
import { SwitchRow } from './MediaChips';

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Choices<T extends string | number>({ title, choices, active, onToggle }: { title: string; choices: FilterChoice<T>[]; active: T[]; onToggle: (v: T) => void }) {
  if (!choices.length) return null;
  return (
    <FieldSection title={title}>
      <ChipRow>
        {choices.map((c) => (
          <Chip key={String(c.value)} label={`${c.label} · ${c.count}`} selected={active.includes(c.value)} onPress={() => onToggle(c.value)} />
        ))}
      </ChipRow>
    </FieldSection>
  );
}

/** `MonitorMediaFilterForm`: resolution, frame rate and colour filters for the current tab. */
export function FilterSheet({
  visible,
  options,
  filters,
  onChange,
  onClose,
}: {
  visible: boolean;
  options: FilterOptions;
  filters: MediaFilters;
  onChange: (f: MediaFilters) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const nothing = !options.resolutions.length && !options.frameRates.length && !options.colors.length;
  const count = activeFilterCount(filters);
  return (
    <Sheet
      visible={visible}
      title={count ? `Filter · ${count}` : 'Filter'}
      onClose={onClose}
      expandable={false}
      footer={
        <View style={styles.footer}>
          <Button title="Clear" variant="secondary" disabled={!count} onPress={() => onChange(emptyFilters)} style={styles.flex} />
          <Button title="Done" onPress={onClose} style={styles.flex} />
        </View>
      }
    >
      {nothing ? <Text style={styles.muted}>Nothing in this tab to filter by.</Text> : null}
      <View style={[styles.sections, styles.firstUnderHeader]}>
        <Choices title="Resolution" choices={options.resolutions} active={filters.resolutions} onToggle={(v) => onChange({ ...filters, resolutions: toggle(filters.resolutions, v) })} />
        <Choices title="Frame rate" choices={options.frameRates} active={filters.frameRates} onToggle={(v) => onChange({ ...filters, frameRates: toggle(filters.frameRates, v) })} />
        <Choices<ColorMode> title="Color" choices={options.colors} active={filters.colors} onToggle={(v) => onChange({ ...filters, colors: toggle(filters.colors, v) })} />
      </View>
    </Sheet>
  );
}

/** Sort order, grid or list, thumbnail size, captions and grouping: how the library is shown. */
export function ViewSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const prefs = useMediaPreferences();
  return (
    <Sheet visible={visible} title="Sort and view" onClose={onClose} expandable={false}>
      <View>
        {sortOrder.map((key: MediaSort) => (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityState={{ checked: key === prefs.sort }}
            accessibilityLabel={`Sort by ${sortTitles[key].toLowerCase()}`}
            onPress={() => prefs.set('sort', key)}
            style={({ pressed }) => [styles.sortOption, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={styles.sortLabel}>{sortTitles[key]}</Text>
            {key === prefs.sort ? <Icon icon={Tick02Icon} size={20} color={colors.primary} /> : null}
          </Pressable>
        ))}
      </View>
      <View style={styles.sections}>
        <FieldSection title="Layout">
          <SegmentedControl<MediaLayout>
            accessibilityLabel="Layout"
            value={prefs.layout}
            onChange={(v) => prefs.set('layout', v)}
            options={[
              { value: 'grid', label: 'Grid', icon: GridViewIcon, accessibilityLabel: 'Grid view' },
              { value: 'list', label: 'List', icon: LeftToRightListBulletIcon, accessibilityLabel: 'List view' },
            ]}
          />
        </FieldSection>
        <FieldSection title="Thumbnails">
          <SegmentedControl<MediaThumbnailSize>
            accessibilityLabel="Thumbnail size"
            value={prefs.thumbnailSize}
            onChange={(v) => prefs.set('thumbnailSize', v)}
            options={[
              { value: 'small', label: 'Small', accessibilityLabel: 'Small thumbnails' },
              { value: 'medium', label: 'Medium', accessibilityLabel: 'Medium thumbnails' },
              { value: 'large', label: 'Large', accessibilityLabel: 'Large thumbnails' },
            ]}
          />
        </FieldSection>
        <View>
          <SwitchRow
            inset={false}
            title="Captions"
            disabled={prefs.layout !== 'grid'}
            value={prefs.layout === 'grid' && prefs.gridCaptions}
            onChange={(v) => prefs.set('gridCaptions', v)}
          />
          <SwitchRow inset={false} title="Group by day" value={prefs.groupByDay} onChange={(v) => prefs.set('groupByDay', v)} />
          <SwitchRow inset={false} last title="Stack bursts" value={prefs.stackBursts} onChange={(v) => prefs.set('stackBursts', v)} />
        </View>
      </View>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    footer: { flexDirection: 'row' as const, gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
    flex: { flex: 1 },
    sections: { gap: spacing.md, paddingBottom: spacing.sm },
    // The first section's hairline would double the sheet header's: tuck it under it.
    firstUnderHeader: { marginTop: -(spacing.sm + 1) },
    muted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground },
    sortOption: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      minHeight: 44,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    sortLabel: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
  };
}
