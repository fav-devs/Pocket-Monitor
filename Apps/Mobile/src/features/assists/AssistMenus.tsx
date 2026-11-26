import { useState } from 'react';
import { View } from 'react-native';
import { Chip } from '@/components/chip';
import { ChipRow, FieldSection } from '@/components/field-section';
import { SegmentedControl } from '@/components/segmented-control';
import { Slider } from '@/components/slider';
import {
  CRUSH_CLIP_OPTIONS,
  DESQUEEZE_PRESETS,
  FALSE_COLOR_MODE_LABEL,
  GUIDE_RATIOS,
  ND_NOTATION_LABEL,
  PEAKING_COLORS,
  PEAKING_RGB,
  PEAKING_SENSES,
  STANDARD_SAFE_AREAS,
  ZEBRA_HIGHLIGHT_PALETTE,
  ZEBRA_MIDTONE_PALETTE,
  ZEBRA_RGB,
  clampSafePercent,
  desqueezeLabel,
  falseColorReference,
  snapDesqueeze,
  transferLabel,
  zebraDisplayValue,
  zebraIreFromDisplay,
  type CrushClipCompensation,
  type FalseColorMode,
  type GuideAspect,
} from '@/core/media';
import { defaultAssistOptions, useAssists, useSourceTransfer, type AssistTool } from '@/state/assists';
import { MenuScroll, MenuTabs, Note, Swatches, SwitchRow, TextAction } from './menuKit';
import { FalseColorLegend } from './overlays/Meters';
import { LutPicker } from './LutPicker';

/**
 * A tool's options (`MonitorToolInspector` bodies): the whole body of its sheet, tabs pinned where it has sections.
 * Shared by the long-press sheet over the picture and Settings → View Assists.
 */
export function AssistMenu({ tool }: { tool: AssistTool }) {
  switch (tool) {
    case 'LUT':
      return <LutPicker />;
    case 'PEAK':
      return <PeakingMenu />;
    case 'FALSE':
      return <FalseColorMenu />;
    case 'ZEBRA':
      return <ZebraMenu />;
    case 'WAVE':
      return <TraceMenu which="waveform" />;
    case 'PARADE':
      return <TraceMenu which="parade" />;
    case 'HISTO':
      return <HistogramMenu />;
    case 'VECTOR':
      return <VectorscopeMenu />;
    case 'LIGHTS':
      return (
        <MenuScroll>
          <CrushClipSection />
          <Note>Stops of tolerance before a channel lamp glows. Shared with the histogram lamps.</Note>
        </MenuScroll>
      );
    case 'ND':
      return <NDMenu />;
    case 'AUDIO':
      return <AudioMenu />;
    case 'GUIDES':
      return <GuidesMenu />;
    case 'GRID':
      return <GridMenu />;
    case 'CROSS':
      return (
        <MenuScroll>
          <Note>Shows a cross at the centre of the picture.</Note>
        </MenuScroll>
      );
    case 'DE-SQ':
      return <DesqueezeMenu />;
    case 'MIRROR':
      return <MirrorMenu />;
    case 'LEVEL':
      return (
        <MenuScroll>
          <Note>The camera's roll and tilt from the horizon. Pointing straight down or up, a bubble shows the lens offset.</Note>
        </MenuScroll>
      );
    case 'EV':
      return (
        <MenuScroll>
          <Note>The camera's metered exposure, or the picture's median against middle grey when the camera reports none.</Note>
        </MenuScroll>
      );
  }
}

const pct = (v: number) => `${Math.round(v)}%`;

function PeakingMenu() {
  const o = useAssists((s) => s.options.peaking);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuScroll>
      <FieldSection title="Sensitivity">
        <SegmentedControl accessibilityLabel="Sensitivity" options={PEAKING_SENSES.map((v) => ({ value: v, label: v }))} value={o.sense} onChange={(sense) => set('peaking', { sense })} />
        <Note>Higher catches finer edges but can get noisy.</Note>
      </FieldSection>
      <FieldSection title="Colour">
        <Swatches label="Peaking colour" options={PEAKING_COLORS} value={o.color} onChange={(color) => set('peaking', { color })} rgb={(c) => PEAKING_RGB[c]} />
      </FieldSection>
      <FieldSection title="Picture">
        <SwitchRow title="Black & white" detail="Monochrome under the peaking." value={o.mono} onChange={(mono) => set('peaking', { mono })} />
      </FieldSection>
    </MenuScroll>
  );
}

const FALSE_MODES: FalseColorMode[] = ['cinestop', 'video', 'ire', 'limits'];

function FalseColorMenu() {
  const o = useAssists((s) => s.options.falseColor);
  const set = useAssists((s) => s.setOption);
  const setOn = useAssists((s) => s.setOn);
  const { transfer, clipByte } = useSourceTransfer();
  return (
    <MenuScroll>
      <FieldSection title="Scale">
        <SegmentedControl accessibilityLabel="False color scale" options={FALSE_MODES.map((m) => ({ value: m, label: FALSE_COLOR_MODE_LABEL[m] }))} value={o.mode} onChange={(mode) => set('falseColor', { mode })} />
        <Note>
          {o.mode === 'cinestop'
            ? `Scene stops around 18% grey for ${transferLabel(transfer)}: −2 green, −1 yellow-green, grey, +1 pink (skin), +2 yellow, red at clip.`
            : 'Video levels on the waveform axis.'}
        </Note>
      </FieldSection>
      <FieldSection title="Key">
        <FalseColorLegend reference={falseColorReference(o.mode, transfer, clipByte, transferLabel(transfer))} inspector />
        <SwitchRow
          title="Show key on picture"
          value={o.reference}
          onChange={(reference) => {
            set('falseColor', { reference });
            if (reference) setOn('FALSE', true);
          }}
        />
      </FieldSection>
    </MenuScroll>
  );
}

type ZebraTab = 'highlight' | 'midtone';

function ZebraMenu() {
  const z = useAssists((s) => s.options.zebra);
  const set = useAssists((s) => s.setOption);
  const { transfer, clipByte } = useSourceTransfer();
  const [tab, setTab] = useState<ZebraTab>('highlight');
  const maxDisplay = z.unit === 'IRE' ? 100 : 255;
  const high = tab === 'highlight';
  const ire = high ? z.highlightIRE : z.midtoneIRE;
  const enabled = high ? z.highlight : z.midtone;
  const shown = zebraDisplayValue(ire, z.unit, transfer, clipByte);
  const setThreshold = (v: number) => {
    const next = zebraIreFromDisplay(v, z.unit, transfer, clipByte);
    set('zebra', high ? { highlightIRE: next } : { midtoneIRE: next });
  };
  return (
    <>
      <MenuTabs
        tabs={[
          { id: 'highlight', label: 'Highlight' },
          { id: 'midtone', label: 'Midtone' },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      <MenuScroll key={tab}>
        <FieldSection title="Stripes">
          <SwitchRow
            title={high ? 'Show highlight zebra' : 'Show midtone zebra'}
            detail={high ? 'Warns as bright detail nears clipping, through the log curve.' : 'A reference band for faces or the key subject.'}
            value={enabled}
            onChange={(v) => set('zebra', high ? { highlight: v } : { midtone: v })}
          />
          <View style={{ opacity: enabled ? 1 : 0.45 }} pointerEvents={enabled ? 'auto' : 'none'}>
            <Slider label="Threshold" value={shown} min={0} max={maxDisplay} tone="primary" onChange={setThreshold} onEnd={setThreshold} />
          </View>
        </FieldSection>
        <FieldSection title="Colour">
          <View style={{ opacity: enabled ? 1 : 0.45 }} pointerEvents={enabled ? 'auto' : 'none'}>
            <Swatches
              label={high ? 'Highlight colour' : 'Midtone colour'}
              options={high ? ZEBRA_HIGHLIGHT_PALETTE : ZEBRA_MIDTONE_PALETTE}
              value={high ? z.highlightColor : z.midtoneColor}
              onChange={(c) => set('zebra', high ? { highlightColor: c } : { midtoneColor: c })}
              rgb={(c) => ZEBRA_RGB[c]}
            />
          </View>
        </FieldSection>
        <FieldSection title="Units">
          <SegmentedControl
            accessibilityLabel="Zebra units"
            options={[
              { value: 'Native', label: '0–255' },
              { value: 'IRE', label: 'IRE' },
            ]}
            value={z.unit}
            onChange={(unit) => set('zebra', { unit })}
          />
        </FieldSection>
      </MenuScroll>
    </>
  );
}

function TraceMenu({ which }: { which: 'waveform' | 'parade' }) {
  const o = useAssists((s) => s.options[which]);
  const set = useAssists((s) => s.setOption);
  const modes = which === 'waveform' ? (['Luma', 'RGB'] as const) : (['RGB', 'YRGB'] as const);
  const brightness = (v: number) => set(which, { brightness: v });
  return (
    <MenuScroll>
      <FieldSection title="Mode">
        <SegmentedControl<string> accessibilityLabel="Trace mode" options={modes.map((m) => ({ value: m, label: m }))} value={o.mode} onChange={(mode) => set(which, { mode } as never)} />
      </FieldSection>
      <FieldSection title="Trace">
        <Slider label="Brightness" value={o.brightness} min={0} max={200} step={5} tone="primary" resetValue={100} format={pct} onChange={brightness} onEnd={brightness} />
      </FieldSection>
      <FieldSection title="Guide lines">
        <View>
          <SwitchRow title="Safe clip" value={o.guides.clip} onChange={(clip) => set(which, { guides: { ...o.guides, clip } })} />
          <SwitchRow title="Safe crush" value={o.guides.crush} onChange={(crush) => set(which, { guides: { ...o.guides, crush } })} />
          <SwitchRow title="Middle grey" value={o.guides.middle} onChange={(middle) => set(which, { guides: { ...o.guides, middle } })} />
        </View>
      </FieldSection>
      <ResetPanel id={which} />
    </MenuScroll>
  );
}

function CrushClipSection() {
  const value = useAssists((s) => s.options.crushClip);
  const setCrushClip = useAssists((s) => s.setCrushClip);
  return (
    <FieldSection title="Crush / clip tolerance (stops)">
      <SegmentedControl
        accessibilityLabel="Crush and clip compensation"
        options={CRUSH_CLIP_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onChange={(v) => setCrushClip(Number(v) as CrushClipCompensation)}
      />
    </FieldSection>
  );
}

function HistogramMenu() {
  const o = useAssists((s) => s.options.histogram);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuScroll>
      <FieldSection title="Lamps">
        <SwitchRow
          title="Traffic lights"
          detail="Edge lamps for crushed and clipped channels, from a third of a stop under clip."
          value={o.trafficLights}
          onChange={(trafficLights) => set('histogram', { trafficLights })}
        />
      </FieldSection>
      <CrushClipSection />
      <Note>Shared with the traffic-light meter.</Note>
      <ResetPanel id="histogram" />
    </MenuScroll>
  );
}

function VectorscopeMenu() {
  const o = useAssists((s) => s.options.vectorscope);
  const set = useAssists((s) => s.setOption);
  const brightness = (v: number) => set('vectorscope', { brightness: v });
  return (
    <MenuScroll>
      <FieldSection title="Zoom">
        <SegmentedControl accessibilityLabel="Trace zoom" options={(['1x', '2x', '4x'] as const).map((z) => ({ value: z, label: z }))} value={o.zoom} onChange={(zoom) => set('vectorscope', { zoom })} />
        <Note>Magnifies low-saturation pictures. Log is measured through its display transform.</Note>
      </FieldSection>
      <FieldSection title="Trace">
        <Slider label="Brightness" value={o.brightness} min={0} max={200} step={5} tone="primary" resetValue={100} format={pct} onChange={brightness} onEnd={brightness} />
      </FieldSection>
      <ResetPanel id="vectorscope" />
    </MenuScroll>
  );
}

function NDMenu() {
  const o = useAssists((s) => s.options.nd);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuScroll>
      <FieldSection title="Units">
        <SegmentedControl accessibilityLabel="ND units" options={(['stops', 'factor', 'density'] as const).map((n) => ({ value: n, label: ND_NOTATION_LABEL[n] }))} value={o.notation} onChange={(notation) => set('nd', { notation })} />
        <Note>Stops, filter factor (ND16 / ND32 / ND64) or optical density (ND 0.3 = 1 stop).</Note>
      </FieldSection>
      <Note>Meters the picture against middle grey and suggests a screw-on ND. The app can't set a filter.</Note>
    </MenuScroll>
  );
}

function AudioMenu() {
  const o = useAssists((s) => s.options.audio);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuScroll>
      <FieldSection title="Orientation">
        <SegmentedControl accessibilityLabel="Meter orientation" options={(['Vertical', 'Horizontal'] as const).map((v) => ({ value: v, label: v }))} value={o.orientation} onChange={(orientation) => set('audio', { orientation })} />
      </FieldSection>
      <FieldSection title="Readout">
        <SwitchRow title="Show dB values" value={o.showDB} onChange={(showDB) => set('audio', { showDB })} />
      </FieldSection>
      <Note>Meters the camera's audio while live view is up.</Note>
    </MenuScroll>
  );
}

type GuidesTab = 'frames' | 'safe';

function GuidesMenu() {
  const o = useAssists((s) => s.options.guides);
  const set = useAssists((s) => s.setOption);
  const [tab, setTab] = useState<GuidesTab>('frames');
  const toggle = (a: GuideAspect) => {
    const has = o.selected.includes(a);
    const next = has ? o.selected.filter((x) => x !== a) : [...o.selected, a];
    set('guides', { selected: next.length ? next : [a] });
  };
  const safe = o.safe;
  const action = (v: number) => set('guides', { safe: { ...safe, actionPercent: clampSafePercent(v) } });
  const title = (v: number) => set('guides', { safe: { ...safe, titlePercent: clampSafePercent(v) } });
  return (
    <>
      <MenuTabs
        tabs={[
          { id: 'frames', label: 'Frame lines' },
          { id: 'safe', label: 'Safe areas' },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      <MenuScroll key={tab}>
        {tab === 'frames' ? (
          <>
            <FieldSection title="Family">
              <SegmentedControl accessibilityLabel="Guide family" options={(['Film', 'Social'] as const).map((f) => ({ value: f, label: f }))} value={o.family} onChange={(family) => set('guides', { family })} />
            </FieldSection>
            <FieldSection title="Ratios">
              <ChipRow>
                {GUIDE_RATIOS[o.family].map((a) => (
                  <Chip key={a} label={a} selected={o.selected.includes(a)} onPress={() => toggle(a)} style={{ minWidth: 64, minHeight: 40 }} />
                ))}
              </ChipRow>
            </FieldSection>
            <FieldSection title="Outside the frame">
              <SwitchRow title="Mask" detail="Darkens the picture outside the frame lines." value={o.mask} onChange={(mask) => set('guides', { mask })} />
            </FieldSection>
          </>
        ) : (
          <>
            <FieldSection title="Action safe">
              <SwitchRow title="Show" detail="Dashed, inside each frame. Room to stabilise or reframe." value={safe.actionSafe} onChange={(actionSafe) => set('guides', { safe: { ...safe, actionSafe } })} />
              {safe.actionSafe ? (
                <Slider label="Size" value={safe.actionPercent} min={50} max={99} tone="primary" resetValue={STANDARD_SAFE_AREAS.actionPercent} format={pct} onChange={action} onEnd={action} />
              ) : null}
            </FieldSection>
            <FieldSection title="Title safe">
              <SwitchRow title="Show" detail="Dotted, inside each frame, for text and graphics." value={safe.titleSafe} onChange={(titleSafe) => set('guides', { safe: { ...safe, titleSafe } })} />
              {safe.titleSafe ? (
                <Slider label="Size" value={safe.titlePercent} min={50} max={99} tone="primary" resetValue={STANDARD_SAFE_AREAS.titlePercent} format={pct} onChange={title} onEnd={title} />
              ) : null}
            </FieldSection>
          </>
        )}
      </MenuScroll>
    </>
  );
}

function GridMenu() {
  const o = useAssists((s) => s.options.grid);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuScroll>
      <FieldSection title="Lines">
        <View>
          <SwitchRow title="Thirds" value={o.thirds} onChange={(thirds) => set('grid', { thirds })} />
          <SwitchRow title="Phi grid" value={o.phi} onChange={(phi) => set('grid', { phi })} />
          <SwitchRow title="Diagonal" value={o.diagonal} onChange={(diagonal) => set('grid', { diagonal })} />
        </View>
      </FieldSection>
    </MenuScroll>
  );
}

function DesqueezeMenu() {
  const o = useAssists((s) => s.options.desqueeze);
  const set = useAssists((s) => s.setOption);
  const custom = (v: number) => set('desqueeze', { factor: snapDesqueeze(v) });
  return (
    <MenuScroll>
      <FieldSection title="Factor">
        <ChipRow>
          {DESQUEEZE_PRESETS.map((f) => (
            <Chip key={f} label={desqueezeLabel(f)} selected={Math.abs(o.factor - f) < 0.005} onPress={() => set('desqueeze', { factor: f })} style={{ minWidth: 60, minHeight: 40 }} />
          ))}
        </ChipRow>
        <Slider label="Custom" value={o.factor} min={1} max={2} step={0.01} tone="primary" resetValue={defaultAssistOptions.desqueeze.factor} format={desqueezeLabel} onChange={custom} onEnd={custom} />
      </FieldSection>
      <FieldSection title="Direction">
        <SegmentedControl
          accessibilityLabel="Desqueeze direction"
          options={[
            { value: 'horizontal', label: 'Horizontal' },
            { value: 'vertical', label: 'Vertical' },
          ]}
          value={o.direction}
          onChange={(direction) => set('desqueeze', { direction })}
        />
        <Note>Horizontal widens the picture; Vertical corrects a rotated adapter. Recordings and scopes stay unchanged.</Note>
      </FieldSection>
    </MenuScroll>
  );
}

function MirrorMenu() {
  const o = useAssists((s) => s.options.mirror);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuScroll>
      <FieldSection title="Flip">
        <View>
          <SwitchRow title="Horizontal" detail="For a camera pointed back at you." value={o.horizontal} onChange={(horizontal) => set('mirror', { horizontal })} />
          <SwitchRow title="Vertical" detail="For an underslung mount. Both turn it 180°." value={o.vertical} onChange={(vertical) => set('mirror', { vertical })} />
        </View>
      </FieldSection>
      <Note>The recording and the scopes are never mirrored.</Note>
    </MenuScroll>
  );
}

function ResetPanel({ id }: { id: 'waveform' | 'parade' | 'histogram' | 'vectorscope' }) {
  const setPanel = useAssists((s) => s.setPanel);
  return (
    <TextAction
      label="Reset position and size"
      onPress={() => {
        setPanel(id, 'landscape', { center: undefined, scale: undefined });
        setPanel(id, 'portrait', { center: undefined, scale: undefined });
      }}
    />
  );
}
