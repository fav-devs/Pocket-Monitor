import { View } from 'react-native';
import {
  CRUSH_CLIP_OPTIONS,
  DESQUEEZE_PRESETS,
  FALSE_COLOR_MODE_LABEL,
  GUIDE_RATIOS,
  ND_NOTATION_LABEL,
  PEAKING_COLORS,
  PEAKING_RGB,
  PEAKING_SENSES,
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
  type FalseColorMode,
  type GuideAspect,
} from '@/core/media';
import { MText, colors, radius, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { useAssists, useSourceTransfer, type AssistTool } from '@/state/assists';
import { ColorDots, MenuHelp, MenuRow, MenuSection, Segmented, Slider, SwitchRow } from './menuKit';
import { FalseColorLegend } from './overlays/Meters';
import { LutPicker } from './LutPicker';

/** Long-press options for one tool (`MonitorToolInspector` bodies / `*Menus`). */
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
        <MenuSection>
          <CrushClipRow divider={false} help="Stops of crush/clip tolerance before a channel indicator glows. Shared with the histogram traffic lights." />
        </MenuSection>
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
      return <MenuHelp>Tap the toolbar button to show or hide the centre crosshair.</MenuHelp>;
    case 'DE-SQ':
      return <DesqueezeMenu />;
    case 'MIRROR':
      return <MirrorMenu />;
    case 'LEVEL':
      return <MenuHelp>Shows the camera's roll and tilt from the horizon. Near straight down or up, a bubble shows the lens offset.</MenuHelp>;
    case 'EV':
      return <MenuHelp>Shows the camera's metered exposure, or the picture's median against middle grey when the camera does not report one.</MenuHelp>;
  }
}

function PeakingMenu() {
  const o = useAssists((s) => s.options.peaking);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuSection>
      <MenuRow title="Sensitivity" help="Higher sensitivity catches finer edges but can get noisy on detailed scenes." stacked divider={false}>
        <Segmented options={PEAKING_SENSES} value={o.sense} onChange={(sense) => set('peaking', { sense })} />
      </MenuRow>
      <MenuRow title="Color" help="Choose the edge color that stays readable over your typical scene.">
        <ColorDots options={PEAKING_COLORS} value={o.color} onChange={(color) => set('peaking', { color })} rgb={(c) => PEAKING_RGB[c]} />
      </MenuRow>
      <SwitchRow title="Black & white" help="Show the picture in monochrome under the peaking strokes." value={o.mono} onChange={(mono) => set('peaking', { mono })} />
    </MenuSection>
  );
}

const FALSE_MODES: FalseColorMode[] = ['cinestop', 'video', 'ire', 'limits'];

function FalseColorMenu() {
  const o = useAssists((s) => s.options.falseColor);
  const set = useAssists((s) => s.setOption);
  const setOn = useAssists((s) => s.setOn);
  const { transfer, clipByte } = useSourceTransfer();
  return (
    <MenuSection>
      <MenuRow
        title="Scale"
        help={`CineStop paints scene stops around 18% grey for ${transferLabel(transfer)}: −2 green, −1 yellow-green, grey, +1 pink (skin), +2 yellow, red from the camera's clip. Video, IRE and Limits paint video levels on the WAVE axis.`}
        stacked
        divider={false}
      >
        <Segmented options={FALSE_MODES} value={o.mode} onChange={(mode) => set('falseColor', { mode })} title={(m) => FALSE_COLOR_MODE_LABEL[m]} />
      </MenuRow>
      <MenuRow title="Reference key" stacked>
        <FalseColorLegend reference={falseColorReference(o.mode, transfer, clipByte, transferLabel(transfer))} inspector />
      </MenuRow>
      <SwitchRow
        title="Reference Display"
        help="Show a compact color key over live view while False Color is active."
        value={o.reference}
        onChange={(reference) => {
          set('falseColor', { reference });
          if (reference) setOn('FALSE', true);
        }}
      />
    </MenuSection>
  );
}

function ZebraMenu() {
  const z = useAssists((s) => s.options.zebra);
  const set = useAssists((s) => s.setOption);
  const { transfer, clipByte } = useSourceTransfer();
  const maxDisplay = z.unit === 'IRE' ? 100 : 255;
  const zone = (which: 'highlight' | 'midtone') => {
    const ire = which === 'highlight' ? z.highlightIRE : z.midtoneIRE;
    const enabled = which === 'highlight' ? z.highlight : z.midtone;
    return (
      <>
        <SwitchRow
          title={which === 'highlight' ? 'Highlight' : 'Midtone'}
          help={
            which === 'highlight'
              ? 'High zebra warns when bright detail approaches clipping after the active log curve is compensated.'
              : 'Midtone zebra gives a curve-compensated reference band for faces or key subject exposure.'
          }
          value={enabled}
          onChange={(v) => set('zebra', which === 'highlight' ? { highlight: v } : { midtone: v })}
        />
        <View style={{ paddingLeft: 14, opacity: enabled ? 1 : 0.4 }} pointerEvents={enabled ? 'auto' : 'none'}>
          <MenuRow title="Threshold">
            <Slider
              label={`${which} threshold`}
              value={zebraDisplayValue(ire, z.unit, transfer, clipByte)}
              min={0}
              max={maxDisplay}
              onChange={(v) => {
                const next = zebraIreFromDisplay(v, z.unit, transfer, clipByte);
                set('zebra', which === 'highlight' ? { highlightIRE: next } : { midtoneIRE: next });
              }}
            />
          </MenuRow>
          <MenuRow title="Colour">
            <ColorDots
              options={which === 'highlight' ? ZEBRA_HIGHLIGHT_PALETTE : ZEBRA_MIDTONE_PALETTE}
              value={which === 'highlight' ? z.highlightColor : z.midtoneColor}
              onChange={(c) => set('zebra', which === 'highlight' ? { highlightColor: c } : { midtoneColor: c })}
              rgb={(c) => ZEBRA_RGB[c]}
            />
          </MenuRow>
        </View>
      </>
    );
  };
  return (
    <MenuSection>
      <MenuRow title="Units" help="Switch between native 0-255 encoded codes and a 0-100 monitoring IRE scale." divider={false}>
        <Segmented options={['Native', 'IRE'] as const} value={z.unit} onChange={(unit) => set('zebra', { unit })} title={(u) => (u === 'Native' ? '0-255' : 'IRE')} />
      </MenuRow>
      {zone('highlight')}
      {zone('midtone')}
    </MenuSection>
  );
}

function TraceMenu({ which }: { which: 'waveform' | 'parade' }) {
  const o = useAssists((s) => s.options[which]);
  const set = useAssists((s) => s.setOption);
  const modes = which === 'waveform' ? (['Luma', 'RGB'] as const) : (['RGB', 'YRGB'] as const);
  return (
    <>
      <MenuSection>
        <MenuRow title="Mode" divider={false}>
          <Segmented options={modes as readonly string[]} value={o.mode} onChange={(mode) => set(which, { mode } as never)} />
        </MenuRow>
        <MenuRow title="Brightness" help="Raise trace intensity when the scope is hard to read in bright light." stacked>
          <Slider label="Brightness" value={o.brightness} min={0} max={200} step={5} format={(v) => `${Math.round(v)}%`} onChange={(brightness) => set(which, { brightness })} />
        </MenuRow>
      </MenuSection>
      <MenuSection title="Guide lines">
        <SwitchRow title="Safe clip" divider={false} value={o.guides.clip} onChange={(clip) => set(which, { guides: { ...o.guides, clip } })} />
        <SwitchRow title="Safe crush" value={o.guides.crush} onChange={(crush) => set(which, { guides: { ...o.guides, crush } })} />
        <SwitchRow title="Middle gray" value={o.guides.middle} onChange={(middle) => set(which, { guides: { ...o.guides, middle } })} />
      </MenuSection>
      <ResetPanel id={which} />
    </>
  );
}

function CrushClipRow({ help, divider }: { help: string; divider?: boolean }) {
  const value = useAssists((s) => s.options.crushClip);
  const setCrushClip = useAssists((s) => s.setCrushClip);
  return (
    <MenuRow title="Crush/Clip Compensation" help={help} stacked divider={divider}>
      <Segmented options={CRUSH_CLIP_OPTIONS.map((o) => o.value)} value={value} onChange={setCrushClip} title={(v) => CRUSH_CLIP_OPTIONS.find((o) => o.value === v)!.label} />
    </MenuRow>
  );
}

function HistogramMenu() {
  const o = useAssists((s) => s.options.histogram);
  const set = useAssists((s) => s.setOption);
  return (
    <>
      <MenuSection>
        <SwitchRow
          title="Traffic Lights"
          divider={false}
          help="Show small RGB edge blocks for crushed and clipped channels. Clip lights from about a third of a stop under the camera's clip, the same point zebra 100% and CineStop use."
          value={o.trafficLights}
          onChange={(trafficLights) => set('histogram', { trafficLights })}
        />
        <CrushClipRow help="Stops of crush/clip tolerance before a traffic light glows. Shared with the goal-post meter." />
      </MenuSection>
      <ResetPanel id="histogram" />
    </>
  );
}

function VectorscopeMenu() {
  const o = useAssists((s) => s.options.vectorscope);
  const set = useAssists((s) => s.setOption);
  return (
    <>
      <MenuSection>
        <MenuRow title="Trace Zoom" help="Magnify low-saturation pictures. Log footage is measured through its display transform." divider={false}>
          <Segmented options={['1x', '2x', '4x'] as const} value={o.zoom} onChange={(zoom) => set('vectorscope', { zoom })} />
        </MenuRow>
        <MenuRow title="Brightness" stacked>
          <Slider label="Brightness" value={o.brightness} min={0} max={200} step={5} format={(v) => `${Math.round(v)}%`} onChange={(brightness) => set('vectorscope', { brightness })} />
        </MenuRow>
      </MenuSection>
      <ResetPanel id="vectorscope" />
    </>
  );
}

function NDMenu() {
  const o = useAssists((s) => s.options.nd);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuSection>
      <MenuRow title="Units" help="Stops vs middle gray, filter factor (ND16 / ND32 / ND64), or optical density (ND 0.3 = 1 stop)." stacked divider={false}>
        <Segmented options={['stops', 'factor', 'density'] as const} value={o.notation} onChange={(notation) => set('nd', { notation })} title={(n) => ND_NOTATION_LABEL[n]} />
      </MenuRow>
      <MenuHelp>Meters the live picture against middle gray and suggests a screw-on ND (stops and ND number) to balance it. The app cannot set a filter.</MenuHelp>
    </MenuSection>
  );
}

function AudioMenu() {
  const o = useAssists((s) => s.options.audio);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuSection>
      <MenuRow title="Orientation" divider={false}>
        <Segmented options={['Vertical', 'Horizontal'] as const} value={o.orientation} onChange={(orientation) => set('audio', { orientation })} />
      </MenuRow>
      <SwitchRow title="Show dB values" value={o.showDB} onChange={(showDB) => set('audio', { showDB })} />
      <MenuHelp>Meters the camera's audio. Available while live view is up.</MenuHelp>
    </MenuSection>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={{
        minWidth: 60,
        minHeight: 44,
        paddingHorizontal: 8,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: on ? withAlpha(colors.accent, 0.16) : colors.raised,
        borderWidth: 1,
        borderColor: on ? colors.accent : colors.border,
      }}
    >
      <MText size={12} weight="semibold" color={on ? colors.accent : colors.secondary}>
        {label}
      </MText>
    </PressableScale>
  );
}

function GuidesMenu() {
  const o = useAssists((s) => s.options.guides);
  const set = useAssists((s) => s.setOption);
  const toggle = (a: GuideAspect) => {
    const has = o.selected.includes(a);
    const next = has ? o.selected.filter((x) => x !== a) : [...o.selected, a];
    set('guides', { selected: next.length ? next : [a] });
  };
  const safe = o.safe;
  return (
    <>
      <MenuSection>
        <MenuRow title="Family" divider={false}>
          <Segmented options={['Film', 'Social'] as const} value={o.family} onChange={(family) => set('guides', { family })} />
        </MenuRow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 12 }}>
          {GUIDE_RATIOS[o.family].map((a) => (
            <Chip key={a} label={a} on={o.selected.includes(a)} onPress={() => toggle(a)} />
          ))}
        </View>
        <SwitchRow title="Mask outside frame" value={o.mask} onChange={(mask) => set('guides', { mask })} />
      </MenuSection>
      <MenuSection title="Safe areas">
        <SwitchRow
          title="Action safe"
          divider={false}
          help="A dashed line inside each frame line. Keep the action inside it to leave room to stabilize or reframe."
          value={safe.actionSafe}
          onChange={(actionSafe) => set('guides', { safe: { ...safe, actionSafe } })}
        />
        {safe.actionSafe ? (
          <MenuRow title="Action size">
            <Slider label="Action safe size" value={safe.actionPercent} min={50} max={99} format={(v) => `${v}%`} onChange={(v) => set('guides', { safe: { ...safe, actionPercent: clampSafePercent(v) } })} />
          </MenuRow>
        ) : null}
        <SwitchRow
          title="Title safe"
          help="A dotted line inside each frame line for text and graphics."
          value={safe.titleSafe}
          onChange={(titleSafe) => set('guides', { safe: { ...safe, titleSafe } })}
        />
        {safe.titleSafe ? (
          <MenuRow title="Title size">
            <Slider label="Title safe size" value={safe.titlePercent} min={50} max={99} format={(v) => `${v}%`} onChange={(v) => set('guides', { safe: { ...safe, titlePercent: clampSafePercent(v) } })} />
          </MenuRow>
        ) : null}
      </MenuSection>
    </>
  );
}

function GridMenu() {
  const o = useAssists((s) => s.options.grid);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuSection>
      <SwitchRow title="Thirds" divider={false} value={o.thirds} onChange={(thirds) => set('grid', { thirds })} />
      <SwitchRow title="Phi Grid" value={o.phi} onChange={(phi) => set('grid', { phi })} />
      <SwitchRow title="Diagonal" value={o.diagonal} onChange={(diagonal) => set('grid', { diagonal })} />
    </MenuSection>
  );
}

function DesqueezeMenu() {
  const o = useAssists((s) => s.options.desqueeze);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuSection>
      <MenuRow title="Factor" stacked divider={false}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {DESQUEEZE_PRESETS.map((f) => (
            <Chip key={f} label={desqueezeLabel(f)} on={Math.abs(o.factor - f) < 0.005} onPress={() => set('desqueeze', { factor: f })} />
          ))}
        </View>
      </MenuRow>
      <MenuRow title="Custom">
        <Slider label="Desqueeze factor" value={o.factor} min={1} max={2} step={0.01} format={desqueezeLabel} onChange={(v) => set('desqueeze', { factor: snapDesqueeze(v) })} />
      </MenuRow>
      <MenuRow title="Direction">
        <Segmented options={['horizontal', 'vertical'] as const} value={o.direction} onChange={(direction) => set('desqueeze', { direction })} title={(d) => (d === 'horizontal' ? 'Horizontal' : 'Vertical')} />
      </MenuRow>
      <MenuHelp>
        Match your anamorphic lens or adapter. Horizontal widens the picture; Vertical corrects a rotated adapter. The full picture fits on screen. Recordings, exports and scope measurements stay unchanged.
      </MenuHelp>
    </MenuSection>
  );
}

function MirrorMenu() {
  const o = useAssists((s) => s.options.mirror);
  const set = useAssists((s) => s.setOption);
  return (
    <MenuSection>
      <MenuHelp>Flips the monitor for a camera pointed back at you or mounted upside down. The recording and the scopes are never mirrored.</MenuHelp>
      <SwitchRow title="Horizontal" help="Left-to-right, for a camera pointed back at you." value={o.horizontal} onChange={(horizontal) => set('mirror', { horizontal })} />
      <SwitchRow title="Vertical" help="Top-to-bottom, for an underslung mount. Both on turns it 180°." value={o.vertical} onChange={(vertical) => set('mirror', { vertical })} />
    </MenuSection>
  );
}

function ResetPanel({ id }: { id: 'waveform' | 'parade' | 'histogram' | 'vectorscope' }) {
  const setPanel = useAssists((s) => s.setPanel);
  return (
    <PressableScale
      accessibilityLabel="Reset position and size"
      onPress={() => {
        setPanel(id, 'landscape', { center: undefined, scale: undefined });
        setPanel(id, 'portrait', { center: undefined, scale: undefined });
      }}
      style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <MText size={12} color={colors.muted}>
        Reset position and size
      </MText>
    </PressableScale>
  );
}
