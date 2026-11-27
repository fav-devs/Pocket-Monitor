/**
 * The desktop player bridge (`docs/desktop-expo-port.md` §1.V): the clip plays in Rust
 * (`pm-desktop/src/player.rs`) through the native Vulkan picture under the web view, so the LUT,
 * zebra, peaking, false colour and mirror grade playback exactly as they grade live view. The web
 * never decodes or draws a frame: this hook only sends transport commands and reads
 * `player://state` (position at ≤ 10 Hz). Scrubs are coalesced to ≤ 30 seeks a second.
 *
 * It returns the same transport shape as `usePlaybackEngine`, so `PlaybackScreen` keeps one set
 * of controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraMediaItem } from '@/camera';
import { pmUrl } from '@/camera/desktop/media';
import { invoke, listen } from '@/camera/desktop/tauri';
import type { PlaybackEngine } from '../usePlaybackEngine';

/** `player://state` from Rust. */
export interface DesktopPlayerState {
  open: boolean;
  id: string;
  isPhoto: boolean;
  proxy: boolean;
  playing: boolean;
  ended: boolean;
  positionMs: number;
  durationMs: number;
  captureRate: number;
  conformTargets: number[];
  conform: number | null;
  conformLabel: string;
  speed: number;
  muted: boolean;
  looping: boolean;
  stripVersion: number;
  stripCount: number;
  colorMode: number | null;
  error: string | null;
}

export interface DesktopPlaybackEngine extends Omit<PlaybackEngine, 'player' | 'kind'> {
  kind: 'desktop';
  /** Rust is fetching the proxy or the still: done/total bytes. */
  fetching: { done: number; total: number | null } | null;
  /** The core's conform targets for this clip (below its capture rate). */
  conformTargets: number[];
  captureRate: number;
  /** "Low-Res" (the 720p proxy) or "Original". */
  rendition: string | null;
  /** The eight filmstrip frames as `pm://strip` URLs. */
  strip: string[];
  /** The graded frame on screen to `Pictures/Pocket Monitor`; resolves to the file path. */
  screenshot: () => Promise<string>;
}

const SEEK_INTERVAL_MS = 1000 / 30;

function errorText(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return 'This clip could not be played.';
}

export function useDesktopPlayback(options: {
  enabled: boolean;
  item: CameraMediaItem | undefined;
  loop: boolean;
  muted: boolean;
  conform: number | null;
}): DesktopPlaybackEngine {
  const { enabled, item, loop, muted, conform } = options;
  const id = enabled ? item?.id : undefined;
  const isPhoto = item?.kind === 'photo';
  const [state, setState] = useState<DesktopPlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState<{ done: number; total: number | null } | null>(null);
  const [seekingTo, setSeekingTo] = useState<number | null>(null);
  const seek = useRef({ timer: null as ReturnType<typeof setTimeout> | null, at: 0, pending: null as number | null });

  // Open the clip (or the still) in the native player; Rust fetches it first.
  useEffect(() => {
    if (!id) return;
    setState(null);
    setError(null);
    setFetching({ done: 0, total: null });
    const stops = [
      listen<DesktopPlayerState>('player://state', (next) => {
        if (next.id !== id) return;
        setState(next);
        setFetching(null);
        if (next.error) setError(next.error);
        setSeekingTo(null);
      }),
      listen<{ id: string; done: number; total: number | null }>('media://progress', (p) => {
        if (p.id === id) setFetching({ done: p.done, total: p.total });
      }),
      listen<{ id: string; reason: string }>('media://failed', (f) => {
        if (f.id !== id) return;
        setFetching(null);
        setError(f.reason || 'This clip could not be fetched.');
      }),
    ];
    invoke(isPhoto ? 'media_view' : 'media_play', { id }).catch((e) => {
      setFetching(null);
      setError(errorText(e));
    });
    // A cached proxy can open before the listeners are registered: read it back once.
    const late = setTimeout(() => {
      invoke<DesktopPlayerState>('player_state')
        .then((next) => {
          if (next.id !== id || !next.open) return;
          setState((current) => current ?? next);
          setFetching(null);
        })
        .catch(() => {});
    }, 600);
    return () => {
      clearTimeout(late);
      stops.forEach((s) => s());
    };
  }, [id, isPhoto]);

  // The player closes when the screen goes (the grid keeps live view held).
  useEffect(() => {
    if (!enabled) return;
    return () => {
      invoke('player_close').catch(() => {});
    };
  }, [enabled]);

  // Loop and sound, as the phones' preferences say.
  useEffect(() => {
    if (!enabled) return;
    invoke('player_options', { muted, looping: loop }).catch(() => {});
  }, [enabled, muted, loop, state?.open]);

  // The conform preview: the clock runs at the core's speed for the target.
  useEffect(() => {
    if (!enabled || !state?.open || isPhoto) return;
    if ((state.conform ?? null) === conform) return;
    invoke('player_conform', { target: conform }).catch(() => {});
  }, [enabled, conform, state?.open, state?.conform, isPhoto]);

  const durationMs = state?.durationMs ?? (item?.durationSec ?? 0) * 1000;
  const duration = durationMs / 1000;
  const fps = item?.fps ?? 30;

  const sendSeek = useCallback((ms: number) => {
    const s = seek.current;
    s.pending = ms;
    const flush = () => {
      s.timer = null;
      if (s.pending == null) return;
      const at = s.pending;
      s.pending = null;
      s.at = Date.now();
      invoke('player_seek', { positionMs: Math.round(at) }).catch(() => {});
    };
    const since = Date.now() - s.at;
    if (since >= SEEK_INTERVAL_MS) flush();
    else if (!s.timer) s.timer = setTimeout(flush, SEEK_INTERVAL_MS - since);
  }, []);

  useEffect(
    () => () => {
      if (seek.current.timer) clearTimeout(seek.current.timer);
    },
    [],
  );

  const play = useCallback(() => {
    invoke('player_toggle', { playing: true }).catch(() => {});
  }, []);
  const pause = useCallback(() => {
    invoke('player_toggle', { playing: false }).catch(() => {});
  }, []);
  const playing = !!state?.playing;
  const toggle = useCallback(() => (playing ? pause() : play()), [pause, play, playing]);
  const seekTo = useCallback(
    (seconds: number) => {
      const t = Math.min(Math.max(0, seconds), duration || 0);
      setSeekingTo(t);
      sendSeek(t * 1000);
    },
    [duration, sendSeek],
  );
  const position = seekingTo ?? (state?.positionMs ?? 0) / 1000;
  const stepFrames = useCallback(
    (frames: number) => {
      pause();
      const step = 1 / Math.max(1, fps);
      const frame = Math.round(position / step) + frames;
      seekTo(frame * step);
    },
    [fps, pause, position, seekTo],
  );

  const strip = useMemo(
    () => (state ? Array.from({ length: state.stripCount }, (_, i) => pmUrl('strip', `${state.stripVersion}/${i}`)) : []),
    [state?.stripVersion, state?.stripCount],
  );

  const screenshot = useCallback(() => invoke<string>('player_screenshot'), []);

  return {
    kind: 'desktop',
    ready: !!state?.open && !error,
    error,
    playing,
    position,
    duration,
    buffered: duration,
    reachedEnd: !!state?.ended,
    play,
    pause,
    toggle,
    seek: seekTo,
    stepFrames,
    fetching,
    conformTargets: state?.conformTargets ?? [],
    captureRate: state?.captureRate ?? 0,
    rendition: state ? (state.isPhoto ? null : state.proxy ? 'Low-Res' : 'Original') : null,
    strip,
    screenshot,
  };
}
