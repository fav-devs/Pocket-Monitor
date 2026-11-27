/**
 * What the phone's gesture runtime shows: the status pill's state and its line. Pure, so it is
 * tested without React or the native module.
 */
import type { GestureHold } from '@/core/gestures/drive';

/** What the phone's gesture runtime is doing, for the status pill. */
export interface PhoneGestureStatus {
  /** `off`: gestures off or not on the live view. `waiting`: on, but there is no picture to read yet. */
  state: 'off' | 'starting' | 'running' | 'waiting' | 'failed';
  source: 'cameraFeed' | 'frontCamera';
  /** What the models run on ("GPU", "CPU", "Vision", "Demo"). */
  provider: string | null;
  /** How long the models took on the last picture. */
  ms: number | null;
  error: string | null;
  /** The microphone for the double clap. */
  microphone: 'off' | 'on' | 'denied';
  /** The record gesture's hold, filling. */
  hold: GestureHold | null;
  /** The last thing a gesture did ("GESTURE: RECENTRE"), and when (ms). */
  notice: { text: string; at: number } | null;
}

/** How long a gesture's notice replaces the timing in the pill. */
export const NOTICE_MS = 2500;

/** "GESTURE: RECENTRE" → "Gesture: recentre", as the desktop's hold pill writes its line. */
export function noticeLabel(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The status pill's line: "Gestures · 12 ms", a gesture's notice for a moment, or what is wrong. */
export function statusLine(status: PhoneGestureStatus, now: number): string | null {
  if (status.state === 'off') return null;
  if (status.notice && now - status.notice.at < NOTICE_MS) return noticeLabel(status.notice.text);
  const front = status.source === 'frontCamera' ? 'Front camera · ' : '';
  switch (status.state) {
    case 'starting':
      return `Gestures · ${front}starting`;
    case 'waiting':
      return 'Gestures · no picture';
    case 'failed':
      return `Gestures · ${status.error ?? 'not running'}`;
    case 'running':
      return `Gestures · ${front}${status.ms != null ? `${Math.round(status.ms)} ms` : (status.provider ?? 'starting')}`;
  }
}
