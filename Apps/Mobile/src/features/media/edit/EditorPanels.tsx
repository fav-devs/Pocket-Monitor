import {
  AiBeautifyIcon,
  Cancel01Icon,
  CubeIcon,
  DropletIcon,
  EyeIcon,
  FaceIdIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  LayoutTwoColumnIcon,
  MagicWand01Icon,
  PauseIcon,
  PlayIcon,
  Rotate01Icon,
  SparklesIcon,
  Sun03Icon,
  Tick02Icon,
  UnavailableIcon,
  Undo02Icon,
  VolumeHighIcon,
  VolumeMute02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Image } from 'expo-image';
import { useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, Pressable, ScrollView, Text, View } from 'react-native';
import { AspectGlyph } from '@/components/aspect-glyph';
import { Icon } from '@/components/icon';
import { fonts } from '@/constants/theme';
import {
  ASPECTS,
  FACE_KEYS,
  LOOKS,
  LOOK_CATEGORIES,
  MAX_ZOOM,
  defaultCrop,
  rotateKeepingFrame,
  setTrimPoint,
  zoomTo,
  type AspectId,
  type ClipEdit,
  type EditTool,
  type FaceKey,
  type Size,
} from '@/core/edit';
import { stripClock } from '../PlaybackFilmstrip';
import { TickSlider } from './TickSlider';

/**
 * Face retouch is rendered by a later stage (`PocketFaceRetouchStage` / `PocketFaceRetouchEffect`
 * in modules/pocket-native). Until it lands the Face panel shows its controls disabled.
 */
export const FACE_RETOUCH_READY = false;

export const TOOL_TITLES: Record<EditTool, string> = {
  filter: 'Filter',
  aspect: 'Aspect Ratio',
  rotate: 'Rotate',
  volume: 'Volume',
  face: 'Face',
  trim: 'Trim',
};

const muted = 'rgba(255,255,255,0.55)';
const well = 'rgba(255,255,255,0.12)';

/** A 44 pt bare icon button over the black editor (✕, ✓, play, compare). */
function BareButton({ icon, label, onPress, selected, size = 24, children }: { icon?: IconSvgElement; label: string; onPress: () => void; selected?: boolean; size?: number; children?: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      {children ?? (icon ? <Icon icon={icon} size={size} color={selected ? '#fedb2e' : '#ffffff'} strokeWidth={1.8} /> : null)}
    </Pressable>
  );
}

/**
 * The editor's frame around a tool (Mimo): a thin progress line, time · play · compare / Reset,
 * the tool's controls, then ✕ · title · ✓. ✕ puts the tool's fields back as they were on open.
 */
export function EditorChrome({
  tool,
  position,
  duration,
  playing,
  onToggle,
  compare,
  onCompare,
  onReset,
  resetDisabled,
  onCancel,
  onApply,
  children,
}: {
  tool: EditTool;
  position: number;
  duration: number;
  playing: boolean;
  onToggle: () => void;
  /** Shown for colour tools. */
  compare?: boolean;
  onCompare?: () => void;
  /** Shown for geometry / volume / trim tools. */
  onReset?: () => void;
  resetDisabled?: boolean;
  onCancel: () => void;
  onApply: () => void;
  children: ReactNode;
}) {
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: 2, backgroundColor: 'rgba(255,255,255,0.22)' }}>
        <View style={{ width: `${fraction * 100}%`, height: 2, backgroundColor: '#ffffff' }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
        <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: '#ffffff', fontVariant: ['tabular-nums'] }}>
          {stripClock(position)}
          <Text style={{ color: muted }}>{` / ${stripClock(duration)}`}</Text>
        </Text>
        <BareButton icon={playing ? PauseIcon : PlayIcon} label={playing ? 'Pause' : 'Play'} onPress={onToggle} size={26} />
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          {onCompare ? (
            <BareButton icon={LayoutTwoColumnIcon} label="Compare before and after" selected={compare} onPress={onCompare} />
          ) : onReset ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reset ${TOOL_TITLES[tool].toLowerCase()}`}
              accessibilityState={{ disabled: !!resetDisabled }}
              disabled={resetDisabled}
              onPress={onReset}
              hitSlop={6}
              style={({ pressed }) => ({ height: 44, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: resetDisabled ? 0.35 : pressed ? 0.6 : 1 })}
            >
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: muted }}>Reset</Text>
              <Icon icon={Undo02Icon} size={18} color={muted} strokeWidth={1.8} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={{ minHeight: 150, justifyContent: 'center' }}>{children}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
        <BareButton icon={Cancel01Icon} label={`Cancel ${TOOL_TITLES[tool].toLowerCase()}`} onPress={onCancel} size={26} />
        <Text style={{ flex: 1, textAlign: 'center', fontFamily: fonts.semibold, fontSize: 16, color: '#ffffff' }}>{TOOL_TITLES[tool]}</Text>
        <BareButton icon={Tick02Icon} label={`Apply ${TOOL_TITLES[tool].toLowerCase()}`} onPress={onApply} size={26} />
      </View>
    </View>
  );
}

/** A round 60 pt choice (Face items, Rotate actions). */
function RoundChoice({ icon, label, selected, onPress, disabled }: { icon: IconSvgElement; label: string; selected?: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ alignItems: 'center', gap: 8, width: 72, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 30,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1.5,
          borderColor: selected ? '#ffffff' : 'rgba(255,255,255,0.22)',
        }}
      >
        <Icon icon={icon} size={26} color="#ffffff" strokeWidth={1.7} />
      </View>
      <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 12, color: selected ? '#ffffff' : muted }}>
        {label}
      </Text>
    </Pressable>
  );
}

type Change = (edit: ClipEdit) => void;

// ───────────────────────────── Filter ─────────────────────────────

const CARD = 64;
const CARD_GAP = 10;

/** Filter: LUT Hub, category tabs, look cards (thumbnails of the current frame), strength drum. */
export function FilterBody({
  edit,
  onChange,
  thumbs,
  lutName,
  onLutHub,
}: {
  edit: ClipEdit;
  onChange: Change;
  thumbs: Record<string, string>;
  /** Display name of the applied imported LUT. */
  lutName: string | null;
  onLutHub: () => void;
}) {
  const [target, setTarget] = useState<'look' | 'lut'>(edit.look || !edit.lut ? 'look' : 'lut');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [activeTab, setActiveTab] = useState<string>(edit.look ? (LOOKS.find((l) => l.id === edit.look)?.category ?? 'original') : 'original');

  type Card = { id: string; name: string; category: string; kind: 'none' | 'lut' | 'look' };
  const cards = useMemo<Card[]>(() => {
    const list: Card[] = [{ id: 'none', name: 'None', category: 'original', kind: 'none' }];
    if (edit.lut) list.push({ id: `custom:${edit.lut}`, name: lutName ?? 'LUT', category: 'original', kind: 'lut' });
    for (const l of LOOKS) list.push({ id: l.id, name: l.name, category: l.category, kind: 'look' });
    return list;
  }, [edit.lut, lutName]);
  const firstIndex = (category: string) => Math.max(0, cards.findIndex((c) => c.category === category));
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / (CARD + CARD_GAP));
    const c = cards[Math.min(cards.length - 1, Math.max(0, i))];
    if (c && c.category !== activeTab) setActiveTab(c.category);
  };

  const strength = target === 'lut' && edit.lut ? edit.lutStrength : edit.lookStrength;
  const showStrength = (target === 'lut' && !!edit.lut) || (target === 'look' && !!edit.look);

  const pick = (c: Card) => {
    if (c.kind === 'none') {
      onChange({ ...edit, look: null, lut: null });
      setTarget('look');
    } else if (c.kind === 'lut') {
      setTarget('lut');
    } else {
      onChange({ ...edit, look: c.id, lookStrength: edit.look === c.id ? edit.lookStrength : 1 });
      setTarget('look');
    }
  };
  const selected = (c: Card) =>
    c.kind === 'none' ? !edit.look && !edit.lut : c.kind === 'lut' ? target === 'lut' : edit.look === c.id && target === 'look';

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="LUT Hub"
          onPress={onLutHub}
          style={({ pressed }) => ({ width: 72, alignItems: 'center', gap: 8, paddingBottom: 2, opacity: pressed ? 0.7 : 1 })}
        >
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: well, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={CubeIcon} size={24} color="#ffffff" strokeWidth={1.7} />
          </View>
          <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 12, color: muted }}>
            LUT Hub
          </Text>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 18, paddingHorizontal: 12 }}>
            {LOOK_CATEGORIES.map((c) => (
              <Pressable
                key={c.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeTab === c.id }}
                onPress={() => {
                  setActiveTab(c.id);
                  scroll.current?.scrollTo({ x: firstIndex(c.id) * (CARD + CARD_GAP), animated: true });
                }}
                hitSlop={8}
                style={{ height: 32, flexDirection: 'row', alignItems: 'center', gap: 4 }}
              >
                {c.id === 'pro' ? <Icon icon={SparklesIcon} size={14} color={activeTab === c.id ? '#ffffff' : muted} strokeWidth={2} /> : null}
                <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: activeTab === c.id ? '#ffffff' : muted }}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView
            ref={scroll}
            horizontal
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={64}
            contentContainerStyle={{ gap: CARD_GAP, paddingHorizontal: 12 }}
          >
            {cards.map((c) => {
              const on = selected(c);
              const thumb = c.kind === 'look' ? thumbs[c.id] : c.kind === 'lut' ? (thumbs[c.id] ?? thumbs.original) : undefined;
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  accessibilityLabel={c.kind === 'none' ? 'No filter' : c.name}
                  accessibilityState={{ selected: on }}
                  onPress={() => pick(c)}
                  style={({ pressed }) => ({ width: CARD, gap: 6, alignItems: 'center', opacity: pressed ? 0.75 : 1 })}
                >
                  <View
                    style={{
                      width: CARD,
                      height: CARD,
                      borderRadius: 10,
                      borderCurve: 'continuous',
                      overflow: 'hidden',
                      backgroundColor: well,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 2,
                      borderColor: on ? '#ffffff' : 'transparent',
                    }}
                  >
                    {thumb ? <Image source={{ uri: thumb }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} contentFit="cover" transition={0} /> : null}
                    {c.kind === 'none' ? <Icon icon={UnavailableIcon} size={26} color="rgba(255,255,255,0.7)" strokeWidth={1.6} /> : null}
                    {c.kind === 'lut' ? (
                      <View style={{ position: 'absolute', right: 4, bottom: 4, width: 20, height: 20, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon icon={CubeIcon} size={13} color="#ffffff" strokeWidth={2} />
                      </View>
                    ) : null}
                  </View>
                  <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 11, color: on ? '#ffffff' : muted, maxWidth: CARD + 6 }}>
                    {c.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
      <View style={{ height: 56, paddingHorizontal: 16 }}>
        {showStrength ? (
          <TickSlider
            label={target === 'lut' ? 'LUT strength' : 'Filter strength'}
            value={Math.round(strength * 100)}
            onChange={(v) => onChange(target === 'lut' ? { ...edit, lutStrength: v / 100 } : { ...edit, lookStrength: v / 100 })}
          />
        ) : null}
      </View>
    </View>
  );
}

// ───────────────────────────── Aspect ─────────────────────────────

const ASPECT_TILES = ASPECTS.filter((a) => a.id !== 'original');

/** Aspect Ratio: 16:9 · 9:16 · 4:3 · 3:4 · 1:1; drag / pinch the picture to frame; zoom drum. */
export function AspectBody({ edit, onChange, source }: { edit: ClipEdit; onChange: Change; source: Size }) {
  const choose = (id: AspectId) => onChange({ ...edit, crop: id === edit.crop.aspect ? edit.crop : defaultCrop(id) });
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, paddingHorizontal: 12 }}>
        {ASPECT_TILES.map((a) => {
          const on = edit.crop.aspect === a.id;
          return (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityLabel={`Aspect ratio ${a.label}`}
              accessibilityState={{ selected: on }}
              onPress={() => choose(a.id)}
              style={({ pressed }) => ({
                flex: 1,
                maxWidth: 58,
                height: 58,
                borderRadius: 10,
                borderCurve: 'continuous',
                backgroundColor: on ? '#ffffff' : well,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <AspectGlyph ratio={a.ratio} color={on ? '#111111' : '#ffffff'} size={20} />
              <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: on ? '#111111' : '#ffffff' }}>{a.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ height: 56, paddingHorizontal: 16 }}>
        <TickSlider
          label="Zoom"
          min={100}
          max={MAX_ZOOM * 100}
          value={Math.round(edit.crop.zoom * 100)}
          format={(v) => `${(v / 100).toFixed(1)}×`}
          onChange={(v) => onChange({ ...edit, crop: zoomTo(source, edit.rotation, edit.crop, v / 100) })}
        />
      </View>
    </View>
  );
}

// ───────────────────────────── Rotate ─────────────────────────────

export function RotateBody({ edit, onChange }: { edit: ClipEdit; onChange: Change }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 18 }}>
      <RoundChoice icon={Rotate01Icon} label={edit.rotation ? `${edit.rotation}°` : 'Rotate'} selected={edit.rotation !== 0} onPress={() => onChange(rotateKeepingFrame(edit))} />
      <RoundChoice icon={FlipHorizontalIcon} label="Mirror" selected={edit.flipH} onPress={() => onChange({ ...edit, flipH: !edit.flipH })} />
      <RoundChoice icon={FlipVerticalIcon} label="Flip" selected={edit.flipV} onPress={() => onChange({ ...edit, flipV: !edit.flipV })} />
    </View>
  );
}

// ───────────────────────────── Volume ─────────────────────────────

export function VolumeBody({ edit, onChange }: { edit: ClipEdit; onChange: Change }) {
  const last = useRef(edit.volume > 0 ? edit.volume : 1);
  if (edit.volume > 0) last.current = edit.volume;
  const mutedNow = edit.volume <= 0.001;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        <RoundChoice
          icon={mutedNow ? VolumeMute02Icon : VolumeHighIcon}
          label={mutedNow ? 'Muted' : 'Mute'}
          selected={mutedNow}
          onPress={() => onChange({ ...edit, volume: mutedNow ? last.current : 0 })}
        />
      </View>
      <View style={{ height: 56, paddingHorizontal: 16 }}>
        <TickSlider label="Volume" min={0} max={200} value={Math.round(edit.volume * 100)} format={(v) => `${Math.round(v)}%`} onChange={(v) => onChange({ ...edit, volume: v / 100 })} />
      </View>
    </View>
  );
}

// ───────────────────────────── Face ─────────────────────────────

const FACE_ITEMS: { key: FaceKey; label: string; icon: IconSvgElement }[] = [
  { key: 'auto', label: 'Auto', icon: MagicWand01Icon },
  { key: 'smooth', label: 'Smooth', icon: DropletIcon },
  { key: 'brighten', label: 'Brighten', icon: Sun03Icon },
  { key: 'slim', label: 'Slim', icon: FaceIdIcon },
  { key: 'eyes', label: 'Eyes', icon: EyeIcon },
];

export function FaceBody({ edit, onChange }: { edit: ClipEdit; onChange: Change }) {
  const [item, setItem] = useState<FaceKey>(FACE_KEYS.find((k) => edit.face[k] > 0) ?? 'smooth');
  const ready = FACE_RETOUCH_READY;
  return (
    <View style={{ gap: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4, paddingHorizontal: 12, flexGrow: 1, justifyContent: 'center' }}>
        {FACE_ITEMS.map((f) => (
          <RoundChoice key={f.key} icon={f.icon} label={f.label} selected={item === f.key} disabled={!ready} onPress={() => setItem(f.key)} />
        ))}
      </ScrollView>
      <View style={{ height: 56, paddingHorizontal: 16, justifyContent: 'center' }}>
        {ready ? (
          <TickSlider
            label={`${FACE_ITEMS.find((f) => f.key === item)?.label ?? 'Face'} strength`}
            value={Math.round(edit.face[item] * 100)}
            onChange={(v) => onChange({ ...edit, face: { ...edit.face, [item]: v / 100 } })}
          />
        ) : (
          <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: well }}>
            <Icon icon={AiBeautifyIcon} size={14} color={muted} strokeWidth={1.8} />
            <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: muted }}>Coming soon</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ───────────────────────────── Trim ─────────────────────────────

export function TrimBody({ edit, onChange, position, duration }: { edit: ClipEdit; onChange: Change; position: number; duration: number }) {
  const start = edit.trim?.start ?? 0;
  const end = edit.trim?.end ?? duration;
  const f = (t: number) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0);
  const point = (which: 'start' | 'end', label: string, value: number) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Set ${label.toLowerCase()} at the playhead`}
      onPress={() => onChange(setTrimPoint(edit, which, position, duration))}
      style={({ pressed }) => ({ minWidth: 112, height: 52, borderRadius: 14, borderCurve: 'continuous', backgroundColor: well, alignItems: 'center', justifyContent: 'center', gap: 2, opacity: pressed ? 0.7 : 1 })}
    >
      <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: muted }}>{label}</Text>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 15, color: '#ffffff', fontVariant: ['tabular-nums'] }}>{stripClock(value)}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 16, paddingHorizontal: 16 }}>
      <View accessibilityLabel={`Kept ${stripClock(start)} to ${stripClock(end)}`} style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: `${f(start) * 100}%`, width: `${(f(end) - f(start)) * 100}%`, top: 0, bottom: 0, backgroundColor: '#fedb2e' }} />
        <View style={{ position: 'absolute', left: `${f(position) * 100}%`, width: 2, marginLeft: -1, top: 0, bottom: 0, backgroundColor: '#ffffff' }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12 }}>
        {point('start', 'Start', start)}
        {point('end', 'End', end)}
      </View>
    </View>
  );
}
