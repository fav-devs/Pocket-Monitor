/**
 * One transport for both picture sources: expo-video for clips with a URL, and a simulated
 * timeline for demo clips (no footage; `<LivePicture>` draws the stand-in picture).
 */
import { useEventListener } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PlaybackEngine {
  kind: 'video' | 'simulated';
  player: VideoPlayer;
  ready: boolean;
  error: string | null;
  playing: boolean;
  position: number;
  duration: number;
  buffered: number;
  reachedEnd: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  stepFrames: (frames: number) => void;
}

export function usePlaybackEngine(options: {
  uri: string | null;
  /** Clip length from metadata (the simulated timeline's length). */
  durationSec: number;
  fps: number;
  loop: boolean;
  muted: boolean;
  rate: number;
  autoplay: boolean;
  /** Changes when the clip changes. */
  itemKey: string;
}): PlaybackEngine {
  const { uri, durationSec, fps, loop, muted, rate, autoplay, itemKey } = options;
  const simulated = !uri;
  const player = useVideoPlayer(uri ?? null, (p) => {
    p.timeUpdateEventInterval = 0.1;
  });

  // ---- shared state
  const [ready, setReady] = useState(simulated);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [reachedEnd, setReachedEnd] = useState(false);

  // ---- simulated clock
  const sim = useRef({ position: 0, playing: false, last: 0 });
  const opts = useRef({ loop, rate, durationSec });
  opts.current = { loop, rate, durationSec };

  useEffect(() => {
    // New clip: reset.
    sim.current = { position: 0, playing: false, last: 0 };
    setPosition(0);
    setReachedEnd(false);
    setError(null);
    setReady(simulated);
    setPlaying(false);
    setVideoDuration(0);
    if (simulated && autoplay) {
      sim.current.playing = true;
      sim.current.last = Date.now();
      setPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, simulated]);

  useEffect(() => {
    if (!simulated) return;
    const id = setInterval(() => {
      const s = sim.current;
      if (!s.playing) return;
      const now = Date.now();
      const dt = ((now - s.last) / 1000) * opts.current.rate;
      s.last = now;
      let next = s.position + dt;
      const d = opts.current.durationSec;
      if (next >= d) {
        if (opts.current.loop) next = next % Math.max(0.001, d);
        else {
          next = d;
          s.playing = false;
          setPlaying(false);
          setReachedEnd(true);
        }
      }
      s.position = next;
      setPosition(next);
    }, 50);
    return () => clearInterval(id);
  }, [simulated]);

  // ---- expo-video
  useEffect(() => {
    if (simulated) return;
    player.loop = loop;
  }, [player, loop, simulated]);
  useEffect(() => {
    if (simulated) return;
    player.muted = muted;
  }, [player, muted, simulated]);
  useEffect(() => {
    if (simulated) return;
    player.playbackRate = rate;
  }, [player, rate, simulated]);

  useEventListener(player, 'statusChange', ({ status, error: e }) => {
    if (simulated) return;
    if (status === 'readyToPlay') {
      setReady(true);
      setError(null);
      setVideoDuration(player.duration || durationSec);
      if (autoplay && !player.playing && player.currentTime === 0) player.play();
    } else if (status === 'error') {
      setError(e?.message ?? 'This clip could not be played.');
    } else if (status === 'loading') setReady(false);
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (simulated) return;
    setPlaying(isPlaying);
    if (isPlaying) setReachedEnd(false);
  });
  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    if (simulated) return;
    setPosition(currentTime);
    if (bufferedPosition >= 0) setBuffered(bufferedPosition);
  });
  useEventListener(player, 'playToEnd', () => {
    if (simulated || loop) return;
    setReachedEnd(true);
    setPlaying(false);
  });

  const duration = simulated ? durationSec : videoDuration || durationSec;

  const play = useCallback(() => {
    setReachedEnd(false);
    if (simulated) {
      if (sim.current.position >= opts.current.durationSec) sim.current.position = 0;
      sim.current.playing = true;
      sim.current.last = Date.now();
      setPlaying(true);
    } else {
      if (player.duration && player.currentTime >= player.duration - 0.05) player.currentTime = 0;
      player.play();
    }
  }, [player, simulated]);

  const pause = useCallback(() => {
    if (simulated) {
      sim.current.playing = false;
      setPlaying(false);
    } else player.pause();
  }, [player, simulated]);

  const seek = useCallback(
    (seconds: number) => {
      const t = Math.min(Math.max(0, seconds), duration || 0);
      setReachedEnd(false);
      setPosition(t);
      if (simulated) {
        sim.current.position = t;
        sim.current.last = Date.now();
      } else player.currentTime = t;
    },
    [duration, player, simulated],
  );

  const stepFrames = useCallback(
    (frames: number) => {
      pause();
      const current = simulated ? sim.current.position : player.currentTime;
      const step = 1 / Math.max(1, fps);
      // Snap to the frame grid so repeated steps land on frame boundaries.
      const frame = Math.round(current / step) + frames;
      seek(frame * step);
    },
    [fps, pause, player, seek, simulated],
  );

  const toggle = useCallback(() => (playing ? pause() : play()), [pause, play, playing]);

  return {
    kind: simulated ? 'simulated' : 'video',
    player,
    ready,
    error,
    playing,
    position,
    duration,
    buffered: simulated ? duration : buffered,
    reachedEnd,
    play,
    pause,
    toggle,
    seek,
    stepFrames,
  };
}
