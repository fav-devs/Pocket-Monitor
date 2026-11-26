import { useState } from 'react';
import { View } from 'react-native';
import { Check, Trash2, Upload } from 'lucide-react-native';
import { BUILT_IN_LOOKS, LUT_EXPOSURE, evLabel, isLogTransfer, snapLutExposure, type MonitorTransfer } from '@/core/media';
import { MText, colors, minTouch, spacing } from '@/theme';
import { PressableScale } from '@/ui';
import { deleteCustomLut, pickAndImportCube, useLutVersion } from '@/features/picture/lutLibrary';
import { resolveLut, useAssists, useSourceTransfer, type LutSelection } from '@/state/assists';
import { MenuHelp, MenuRow, MenuSection, Slider, TextButton } from './menuKit';

const TRANSFORMS: { sel: LutSelection; title: string; curve: MonitorTransfer }[] = [
  { sel: 'transform:dlogm', title: 'D-Log M → Rec.709', curve: 'dlogm' },
  { sel: 'transform:dlog', title: 'D-Log → Rec.709', curve: 'dlog' },
  { sel: 'transform:dlog2', title: 'D-Log2 → Rec.709', curve: 'dlog2' },
  { sel: 'transform:hdr', title: 'HLG → Rec.709', curve: 'hdr' },
];

function Row({ title, detail, selected, onPress, onDelete }: { title: string; detail?: string; selected: boolean; onPress: () => void; onDelete?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border }}>
      <PressableScale
        noScale
        onPress={onPress}
        accessibilityLabel={title}
        accessibilityState={{ selected }}
        style={{ flex: 1, minHeight: minTouch + 4, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
      >
        <View style={{ width: 22, alignItems: 'center' }}>{selected ? <Check size={18} color={colors.accent} strokeWidth={2.2} /> : null}</View>
        <View style={{ flex: 1 }}>
          <MText size={13} weight={selected ? 'semibold' : 'regular'} color={selected ? colors.accent : colors.text}>
            {title}
          </MText>
          {detail ? (
            <MText size={11} color={colors.muted}>
              {detail}
            </MText>
          ) : null}
        </View>
      </PressableScale>
      {onDelete ? (
        <PressableScale onPress={onDelete} accessibilityLabel={`Delete ${title}`} style={{ width: minTouch, height: minTouch, alignItems: 'center', justifyContent: 'center' }}>
          <Trash2 size={18} color={colors.muted} strokeWidth={1.8} />
        </PressableScale>
      ) : null}
    </View>
  );
}

/** LUT catalog: Auto display transform, locked transforms, generated looks, imported `.cube`s. */
export function LutPicker() {
  const lut = useAssists((s) => s.options.lut);
  const lutOn = useAssists((s) => s.on.LUT);
  const set = useAssists((s) => s.setOption);
  const setOn = useAssists((s) => s.setOn);
  const { transfer } = useSourceTransfer();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useLutVersion();
  const resolved = resolveLut(lut, lutOn, transfer);
  const choose = (selection: LutSelection) => {
    set('lut', { selection });
    setOn('LUT', true);
    setMessage(null);
  };
  const importCube = async () => {
    setBusy(true);
    const r = await pickAndImportCube();
    setBusy(false);
    if (r.ok) {
      setOn('LUT', true);
      setMessage(`Imported ${r.entry.name} (${r.entry.size}³).`);
    } else if (!r.canceled) setMessage(r.error ?? 'Import failed.');
  };
  return (
    <>
      <MenuSection>
        <MenuRow title="Now showing" divider={false}>
          <MText size={12} weight="semibold" color={lutOn ? colors.accent : colors.muted} numberOfLines={1} style={{ flexShrink: 1 }}>
            {resolved.label}
          </MText>
        </MenuRow>
        <Row
          title="Auto"
          detail={transfer === 'rec709' ? 'Follows the camera colour. Rec.709 needs no LUT.' : `Follows the camera colour: ${TRANSFORMS.find((t) => t.curve === transfer)?.title ?? ''}`}
          selected={lut.selection === 'auto'}
          onPress={() => choose('auto')}
        />
        {TRANSFORMS.map((t) => (
          <Row key={t.sel} title={t.title} detail="Display transform" selected={lut.selection === t.sel} onPress={() => choose(t.sel)} />
        ))}
      </MenuSection>
      <MenuSection title="Creative">
        {BUILT_IN_LOOKS.map((l) => (
          <Row key={l} title={l} selected={lut.selection === `look:${l}`} onPress={() => choose(`look:${l}`)} />
        ))}
      </MenuSection>
      <MenuSection title="Custom">
        {lut.custom.map((c) => (
          <Row
            key={c.id}
            title={c.name}
            detail={`${c.size}³ .cube`}
            selected={lut.selection === `custom:${c.id}`}
            onPress={() => choose(`custom:${c.id}`)}
            onDelete={() => void deleteCustomLut(c.id)}
          />
        ))}
        <View style={{ paddingVertical: spacing.md, gap: spacing.sm, borderTopWidth: lut.custom.length ? 1 : 0, borderTopColor: colors.border }}>
          <TextButton label={busy ? 'Importing…' : 'Import .cube'} tone="accent" onPress={importCube} icon={<Upload size={16} color={colors.accent} strokeWidth={2} />} />
          {message ? (
            <MText size={11} color={message.startsWith('Imported') ? colors.linkStable : colors.linkWatch}>
              {message}
            </MText>
          ) : null}
          <MText size={11} color={colors.muted}>
            3D .cube files up to 65³. Official camera LUTs are not bundled: import the manufacturer's file for its exact look.
          </MText>
        </View>
      </MenuSection>
      <MenuSection title="Look">
        <MenuRow title="Intensity" divider={false} stacked>
          <Slider label="LUT intensity" value={Math.round(lut.intensity * 100)} min={0} max={100} step={5} format={(v) => `${Math.round(v)}%`} onChange={(v) => set('lut', { intensity: v / 100 })} />
        </MenuRow>
        {isLogTransfer(transfer) ? (
          <MenuRow title="Input exposure" help="Expose to the right, then pull here so the look's middle grey lands. Not camera EV." stacked>
            <Slider
              label="LUT input exposure"
              value={lut.exposureStops}
              min={LUT_EXPOSURE.min}
              max={LUT_EXPOSURE.max}
              step={LUT_EXPOSURE.step}
              format={(v) => evLabel(snapLutExposure(v))}
              onChange={(v) => set('lut', { exposureStops: snapLutExposure(v) })}
            />
          </MenuRow>
        ) : (
          <MenuHelp>Input exposure is available for log curves.</MenuHelp>
        )}
      </MenuSection>
    </>
  );
}
