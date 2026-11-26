import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCamera } from '@/camera';
import type { ColorMode } from '@/camera/types';
import {
  PEAKING_NOISE_GATE,
  PEAKING_RATIO_THRESHOLD,
  PEAKING_RGB,
  ZEBRA_HIGHLIGHT_IRE,
  ZEBRA_MIDTONE_IRE,
  ZEBRA_RGB,
  calibratedClipByte,
  snapDesqueeze,
  snapLutExposure,
  sourceColorForTransfer,
  transferForColorMode,
  zebraCodeThresholds,
  type AudioOrientation,
  type BuiltInLook,
  type CrushClipCompensation,
  type DesqueezeDirection,
  type FalseColorMode,
  type GuideAspect,
  type GuideFamily,
  type GuideSafeAreas,
  type MonitorTransfer,
  type NDNotation,
  type ParadeMode,
  type PeakingColor,
  type PeakingSense,
  type ScopeGuides,
  type StoredCenter,
  type VectorscopeZoom,
  type WaveformMode,
  type ZebraPaint,
  type ZebraUnit,
  STANDARD_SAFE_AREAS,
} from '@/core/media';
import type { PictureEffects } from '@modules/opc-native/src/types';
import { persistStorage } from './storage';

/**
 * Monitor assists (OpenCine `MonitorAssistState`). Raw tool ids are the chip labels and are
 * persisted: never rename. Additive changes only: add a field with a default.
 */
export type AssistTool =
  | 'LUT'
  | 'PEAK'
  | 'FALSE'
  | 'ZEBRA'
  | 'WAVE'
  | 'PARADE'
  | 'HISTO'
  | 'VECTOR'
  | 'LIGHTS'
  | 'ND'
  | 'EV'
  | 'AUDIO'
  | 'GUIDES'
  | 'GRID'
  | 'CROSS'
  | 'LEVEL'
  | 'DE-SQ'
  | 'MIRROR';

export const ASSIST_TOOLS: AssistTool[] = [
  'LUT',
  'PEAK',
  'FALSE',
  'ZEBRA',
  'WAVE',
  'PARADE',
  'HISTO',
  'VECTOR',
  'LIGHTS',
  'ND',
  'EV',
  'AUDIO',
  'GUIDES',
  'GRID',
  'CROSS',
  'LEVEL',
  'DE-SQ',
  'MIRROR',
];

export const ASSIST_TITLES: Record<AssistTool, string> = {
  LUT: 'LUT',
  PEAK: 'Peaking',
  FALSE: 'False Color',
  ZEBRA: 'Zebra',
  WAVE: 'Waveform',
  PARADE: 'RGB Parade',
  HISTO: 'Histogram',
  VECTOR: 'Vectorscope',
  LIGHTS: 'Traffic Lights',
  ND: 'ND Suggestion',
  EV: 'EV Meter',
  AUDIO: 'Audio Levels',
  GUIDES: 'Guides',
  GRID: 'Grid',
  CROSS: 'Crosshair',
  LEVEL: 'Level',
  'DE-SQ': 'Anamorphic Desqueeze',
  MIRROR: 'Mirror',
};

/** Tools with a long-press inspector (LEVEL and EV have none). */
export const hasConfiguration = (t: AssistTool) => t !== 'LEVEL' && t !== 'EV';

/** Tools that read the source curve. Playback measures the clip. */
export const SCOPE_TOOLS: AssistTool[] = ['WAVE', 'PARADE', 'HISTO', 'VECTOR', 'LIGHTS', 'ND'];

export type AssistContext = 'live' | 'playback';

/** Movable floating panels. */
export type ScopePanelId = 'waveform' | 'parade' | 'histogram' | 'vectorscope' | 'trafficLights' | 'ndMeter' | 'audio' | 'falseColorLegend';

export interface PanelPlacement {
  center?: StoredCenter;
  scale?: number;
}

export interface PanelSlots {
  landscape: PanelPlacement;
  portrait: PanelPlacement;
}

/**
 * `auto` follows the camera's colour mode (log → Rec.709 display transform; Rec.709 stays off).
 * `transform:<curve>` locks a display transform, `look:<name>` a generated grading look,
 * `custom:<id>` an imported `.cube`.
 */
export type LutSelection = 'auto' | `transform:${MonitorTransfer}` | `look:${BuiltInLook}` | `custom:${string}`;

export interface CustomLutEntry {
  id: string;
  name: string;
  size: number;
  addedAt: number;
}

export interface AssistOptions {
  lut: { selection: LutSelection; intensity: number; exposureStops: number; custom: CustomLutEntry[] };
  peaking: { color: PeakingColor; sense: PeakingSense; mono: boolean };
  falseColor: { mode: FalseColorMode; reference: boolean };
  zebra: {
    unit: ZebraUnit;
    highlight: boolean;
    highlightIRE: number;
    highlightColor: ZebraPaint;
    midtone: boolean;
    midtoneIRE: number;
    midtoneColor: ZebraPaint;
  };
  waveform: { mode: WaveformMode; brightness: number; guides: ScopeGuides };
  parade: { mode: ParadeMode; brightness: number; guides: ScopeGuides };
  vectorscope: { zoom: VectorscopeZoom; brightness: number };
  histogram: { trafficLights: boolean };
  /** Shared by HISTO lamps and the LIGHTS meter. */
  crushClip: CrushClipCompensation;
  nd: { notation: NDNotation };
  audio: { orientation: AudioOrientation; showDB: boolean };
  guides: { family: GuideFamily; selected: GuideAspect[]; mask: boolean; safe: GuideSafeAreas };
  grid: { thirds: boolean; phi: boolean; diagonal: boolean };
  desqueeze: { factor: number; direction: DesqueezeDirection };
  mirror: { horizontal: boolean; vertical: boolean };
}

/** Option groups that are objects (patched with `setOption`). */
export type OptionGroup = Exclude<keyof AssistOptions, 'crushClip'>;

export const defaultAssistOptions: AssistOptions = {
  lut: { selection: 'auto', intensity: 1, exposureStops: 0, custom: [] },
  peaking: { color: 'Red', sense: 'Med', mono: false },
  falseColor: { mode: 'cinestop', reference: true },
  zebra: {
    unit: 'IRE',
    highlight: true,
    highlightIRE: ZEBRA_HIGHLIGHT_IRE,
    highlightColor: 'White',
    midtone: true,
    midtoneIRE: ZEBRA_MIDTONE_IRE,
    midtoneColor: 'Amber',
  },
  waveform: { mode: 'RGB', brightness: 100, guides: { clip: true, crush: true, middle: true } },
  parade: { mode: 'RGB', brightness: 100, guides: { clip: true, crush: true, middle: true } },
  vectorscope: { zoom: '1x', brightness: 100 },
  histogram: { trafficLights: true },
  crushClip: 0,
  nd: { notation: 'factor' },
  audio: { orientation: 'Vertical', showDB: false },
  guides: { family: 'Film', selected: ['2.39:1'], mask: false, safe: STANDARD_SAFE_AREAS },
  grid: { thirds: true, phi: false, diagonal: false },
  desqueeze: { factor: 1.33, direction: 'horizontal' },
  mirror: { horizontal: true, vertical: false },
};

const allOff = (): Record<AssistTool, boolean> =>
  Object.fromEntries(ASSIST_TOOLS.map((t) => [t, false])) as Record<AssistTool, boolean>;

const emptyPanels = (): Record<ScopePanelId, PanelSlots> => ({
  waveform: { landscape: {}, portrait: {} },
  parade: { landscape: {}, portrait: {} },
  histogram: { landscape: {}, portrait: {} },
  vectorscope: { landscape: {}, portrait: {} },
  trafficLights: { landscape: {}, portrait: {} },
  ndMeter: { landscape: {}, portrait: {} },
  audio: { landscape: {}, portrait: {} },
  falseColorLegend: { landscape: {}, portrait: {} },
});

interface PersistedAssists {
  /** Live tool switches. LUT is armed by default (it is Auto → off for Rec.709 sources). */
  on: Record<AssistTool, boolean>;
  /** Playback tool switches (`playbackVisibleTools`). */
  playbackOn: Record<AssistTool, boolean>;
  options: AssistOptions;
  chipOrder: AssistTool[];
  panels: Record<ScopePanelId, PanelSlots>;
}

interface AssistStore extends PersistedAssists {
  /** Tool whose inspector is open (not persisted). */
  configureTool: AssistTool | null;
  configureContext: AssistContext;
  isOn: (tool: AssistTool, context?: AssistContext) => boolean;
  toggle: (tool: AssistTool, context?: AssistContext) => void;
  setOn: (tool: AssistTool, on: boolean, context?: AssistContext) => void;
  setOption: <K extends OptionGroup>(key: K, patch: Partial<AssistOptions[K]>) => void;
  setCrushClip: (value: CrushClipCompensation) => void;
  setPanel: (id: ScopePanelId, slot: 'landscape' | 'portrait', patch: PanelPlacement) => void;
  resetPanels: () => void;
  moveChip: (tool: AssistTool, toIndex: number) => void;
  openInspector: (tool: AssistTool | null, context?: AssistContext) => void;
  addCustomLut: (entry: CustomLutEntry) => void;
  removeCustomLut: (id: string) => void;
  reset: () => void;
}

const initial = (): PersistedAssists => ({
  on: { ...allOff(), LUT: true },
  playbackOn: { ...allOff(), LUT: true },
  options: defaultAssistOptions,
  chipOrder: ASSIST_TOOLS,
  panels: emptyPanels(),
});

export const useAssists = create<AssistStore>()(
  persist(
    (set, get) => ({
      ...initial(),
      configureTool: null,
      configureContext: 'live',
      isOn: (tool, context = 'live') => (context === 'live' ? get().on[tool] : get().playbackOn[tool]),
      toggle: (tool, context = 'live') => {
        const key = context === 'live' ? 'on' : 'playbackOn';
        set((s) => ({ [key]: { ...s[key], [tool]: !s[key][tool] } }) as Partial<AssistStore>);
      },
      setOn: (tool, on, context = 'live') => {
        const key = context === 'live' ? 'on' : 'playbackOn';
        set((s) => ({ [key]: { ...s[key], [tool]: on } }) as Partial<AssistStore>);
      },
      setOption: (key, patch) => set((s) => ({ options: { ...s.options, [key]: { ...(s.options[key] as object), ...patch } } })),
      setCrushClip: (value) => set((s) => ({ options: { ...s.options, crushClip: value } })),
      setPanel: (id, slot, patch) =>
        set((s) => ({ panels: { ...s.panels, [id]: { ...s.panels[id], [slot]: { ...s.panels[id][slot], ...patch } } } })),
      resetPanels: () => set({ panels: emptyPanels() }),
      moveChip: (tool, toIndex) =>
        set((s) => {
          const order = s.chipOrder.filter((t) => t !== tool);
          order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, tool);
          return { chipOrder: order };
        }),
      openInspector: (tool, context = 'live') => set({ configureTool: tool, configureContext: context }),
      addCustomLut: (entry) =>
        set((s) => ({
          options: {
            ...s.options,
            lut: { ...s.options.lut, custom: [entry, ...s.options.lut.custom.filter((c) => c.id !== entry.id)], selection: `custom:${entry.id}` },
          },
        })),
      removeCustomLut: (id) =>
        set((s) => ({
          options: {
            ...s.options,
            lut: {
              ...s.options.lut,
              custom: s.options.lut.custom.filter((c) => c.id !== id),
              selection: s.options.lut.selection === `custom:${id}` ? 'auto' : s.options.lut.selection,
            },
          },
        })),
      reset: () => set({ ...initial(), configureTool: null }),
    }),
    {
      name: 'pm.assists.v1',
      storage: persistStorage,
      partialize: (s): PersistedAssists => ({
        on: s.on,
        playbackOn: s.playbackOn,
        options: s.options,
        chipOrder: s.chipOrder,
        panels: s.panels,
      }),
      // Deep-merge so a new option or tool added later keeps its default for old saves.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedAssists>;
        const options = { ...current.options } as AssistOptions;
        if (p.options) {
          for (const k of Object.keys(current.options) as (keyof AssistOptions)[]) {
            const saved = p.options[k];
            const base = current.options[k];
            (options as unknown as Record<string, unknown>)[k] =
              saved && typeof saved === 'object' && !Array.isArray(saved) && typeof base === 'object' ? { ...base, ...saved } : (saved ?? base);
          }
        }
        const order = (p.chipOrder ?? []).filter((t) => ASSIST_TOOLS.includes(t));
        for (const t of ASSIST_TOOLS) if (!order.includes(t)) order.push(t);
        return {
          ...current,
          on: { ...current.on, ...(p.on ?? {}) },
          playbackOn: { ...current.playbackOn, ...(p.playbackOn ?? {}) },
          options,
          chipOrder: order,
          panels: { ...current.panels, ...(p.panels ?? {}) },
        };
      },
    },
  ),
);

// ───────────────────────────── Derived picture effects ─────────────────────────────

export interface ResolvedLut {
  /** Display transform the picture applies first (`PictureEffects.sourceColor`). */
  displayTransform: MonitorTransfer;
  /** Registered LUT id, if a cube is the look. */
  lutId: string | null;
  /** Operator-facing status, e.g. "Auto · D-Log M → Rec.709". */
  label: string;
}

const transformTitle = (t: MonitorTransfer) =>
  ({ rec709: 'Rec.709', hdr: 'HLG → Rec.709', dlog: 'D-Log → Rec.709', dlog2: 'D-Log2 → Rec.709', dlogm: 'D-Log M → Rec.709' })[t];

/** Resolve the LUT selection against the source curve (`LUTResolver`, without DJI cubes). */
export function resolveLut(lut: AssistOptions['lut'], enabled: boolean, source: MonitorTransfer): ResolvedLut {
  if (!enabled) return { displayTransform: 'rec709', lutId: null, label: 'Off' };
  const sel = lut.selection;
  if (sel === 'auto') {
    return source === 'rec709'
      ? { displayTransform: 'rec709', lutId: null, label: 'Auto · Off for Rec.709' }
      : { displayTransform: source, lutId: null, label: `Auto · ${transformTitle(source)}` };
  }
  if (sel.startsWith('transform:')) {
    const t = sel.slice('transform:'.length) as MonitorTransfer;
    return { displayTransform: t, lutId: null, label: transformTitle(t) };
  }
  // A cube is fed the camera signal; `lutIntensity` mixes it with the source's display transform.
  if (sel.startsWith('look:')) return { displayTransform: source, lutId: sel, label: sel.slice(5) };
  const id = sel.slice('custom:'.length);
  const entry = lut.custom.find((c) => c.id === id);
  return entry ? { displayTransform: source, lutId: sel, label: entry.name } : { displayTransform: source, lutId: null, label: 'Missing LUT' };
}

export interface EffectsInputs {
  on: Record<AssistTool, boolean>;
  options: AssistOptions;
  colorMode: ColorMode | null | undefined;
  iso: number | null | undefined;
}

/** Pure derivation, shared by `usePictureEffects` and tests. */
export function derivePictureEffects({ on, options, colorMode, iso }: EffectsInputs): PictureEffects & {
  signal: PictureEffects['sourceColor'];
  clipByte: number;
} {
  const transfer = transferForColorMode(colorMode);
  const clipByte = calibratedClipByte(transfer, iso ?? null);
  const lut = resolveLut(options.lut, on.LUT, transfer);
  const z = options.zebra;
  const zc = zebraCodeThresholds(
    { highlight: z.highlight, highlightIRE: z.highlightIRE, midtone: z.midtone, midtoneIRE: z.midtoneIRE },
    transfer,
    clipByte,
  );
  const zebraOn = on.ZEBRA && (zc.highlight != null || zc.midtoneLower != null);
  return {
    sourceColor: sourceColorForTransfer(lut.displayTransform),
    signal: sourceColorForTransfer(transfer),
    clipByte,
    lutId: lut.lutId,
    lutIntensity: Math.min(1, Math.max(0, options.lut.intensity)),
    lutExposureStops: snapLutExposure(options.lut.exposureStops),
    falseColor: on.FALSE ? options.falseColor.mode : null,
    zebra: zebraOn
      ? {
          // Contract units: monitor IRE on the WAVE axis (max RGB for highlight, luma ±5 for midtone).
          upper: z.highlight ? z.highlightIRE : 1000,
          lower: z.midtone ? z.midtoneIRE : null,
          paint: ZEBRA_RGB[z.highlightColor],
          stripes: true,
          midtone:
            zc.midtoneLower != null && zc.midtoneUpper != null
              ? { lower: zc.midtoneLower, upper: zc.midtoneUpper, paint: ZEBRA_RGB[z.midtoneColor] }
              : null,
        }
      : null,
    peaking: on.PEAK
      ? {
          color: PEAKING_RGB[options.peaking.color],
          ratioThreshold: PEAKING_RATIO_THRESHOLD[options.peaking.sense],
          noiseGate: PEAKING_NOISE_GATE[options.peaking.sense],
        }
      : null,
    desqueeze: { factor: on['DE-SQ'] ? snapDesqueeze(options.desqueeze.factor) : 1, direction: options.desqueeze.direction },
    mirror: on.MIRROR && options.mirror.horizontal,
    mirrorVertical: on.MIRROR && options.mirror.vertical,
    monochrome: on.PEAK && options.peaking.mono,
  };
}

/**
 * PictureEffects for the picture renderer, from the store and the camera's colour mode.
 * `context` 'playback' reads the playback tool switches; `colorModeOverride` lets a playback
 * screen pass the clip's own colour mode.
 */
export function usePictureEffects(context: AssistContext = 'live', colorModeOverride?: ColorMode | null): PictureEffects {
  const on = useAssists((s) => (context === 'live' ? s.on : s.playbackOn));
  const options = useAssists((s) => s.options);
  const cameraColor = useCamera((s) => s.format.colorMode);
  const iso = useCamera((s) => s.exposure.iso);
  const colorMode = colorModeOverride ?? cameraColor;
  return useMemo(() => derivePictureEffects({ on, options, colorMode, iso }), [on, options, colorMode, iso]);
}

/** The source curve and live clip ceiling the scopes and meters should use. */
export function useSourceTransfer(colorModeOverride?: ColorMode | null): { transfer: MonitorTransfer; clipByte: number } {
  const cameraColor = useCamera((s) => s.format.colorMode);
  const iso = useCamera((s) => s.exposure.iso);
  const transfer = transferForColorMode(colorModeOverride ?? cameraColor);
  return useMemo(() => ({ transfer, clipByte: calibratedClipByte(transfer, iso) }), [transfer, iso]);
}
