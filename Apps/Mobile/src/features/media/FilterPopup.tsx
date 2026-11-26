import { View } from 'react-native';
import type { ColorMode } from '@/camera';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale, SectionHeader } from '@/ui';
import type { FilterChoice, FilterOptions } from './gallery';
import { activeFilterCount, emptyFilters, type MediaFilters } from './libraryStore';
import { ActionButton, CardHeader, CardScroll, OverlayCard } from './MediaOverlays';

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function ChoiceRow<T extends string | number>({
  title,
  choices,
  active,
  onToggle,
}: {
  title: string;
  choices: FilterChoice<T>[];
  active: T[];
  onToggle: (v: T) => void;
}) {
  if (!choices.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={title} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {choices.map((c) => {
          const on = active.includes(c.value);
          return (
            <PressableScale
              key={String(c.value)}
              accessibilityLabel={`${title} ${c.label}`}
              accessibilityState={{ selected: on }}
              onPress={() => onToggle(c.value)}
              style={{
                minHeight: 44,
                paddingHorizontal: 12,
                borderRadius: 9,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: on ? withAlpha(colors.accent, 0.18) : 'rgba(255,255,255,0.05)',
                borderWidth: 1,
                borderColor: on ? withAlpha(colors.accent, 0.6) : 'transparent',
              }}
            >
              <MText size={12} weight="semibold" color={on ? colors.text : colors.secondary}>
                {c.label}
              </MText>
              <MText size={10.5} color={colors.faint} mono>
                {c.count}
              </MText>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

/** `MonitorMediaFilterForm`: format, frame rate and colour filters for the current tab. */
export function FilterPopup({
  options,
  filters,
  onChange,
  onClose,
}: {
  options: FilterOptions;
  filters: MediaFilters;
  onChange: (f: MediaFilters) => void;
  onClose: () => void;
}) {
  const nothing = !options.resolutions.length && !options.frameRates.length && !options.colors.length;
  const count = activeFilterCount(filters);
  return (
    <OverlayCard onDismiss={onClose} maxWidth={420} label="Filter library">
      <CardHeader title="Filter" subtitle={count ? `${count} active` : 'Narrow this tab'} onClose={onClose} />
      <CardScroll>
        {nothing ? (
          <MText size={12} color={colors.muted}>
            Nothing in this tab to filter by.
          </MText>
        ) : null}
        <ChoiceRow title="Resolution" choices={options.resolutions} active={filters.resolutions} onToggle={(v) => onChange({ ...filters, resolutions: toggle(filters.resolutions, v) })} />
        <ChoiceRow title="Frame rate" choices={options.frameRates} active={filters.frameRates} onToggle={(v) => onChange({ ...filters, frameRates: toggle(filters.frameRates, v) })} />
        <ChoiceRow<ColorMode> title="Color" choices={options.colors} active={filters.colors} onToggle={(v) => onChange({ ...filters, colors: toggle(filters.colors, v) })} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <ActionButton title="Clear" tone="plain" disabled={!count} onPress={() => onChange(emptyFilters)} />
          <ActionButton title="Done" onPress={onClose} />
        </View>
      </CardScroll>
    </OverlayCard>
  );
}
