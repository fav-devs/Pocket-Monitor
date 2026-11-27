/**
 * Record all and a tile's own record press: one strict plan, one confirmation rule and the
 * operator's words for what came back. A group press is coordinated dispatch with per-camera
 * confirmation, never "sync" or "genlock".
 * Source of truth: OpenCine `OpenCineMulticam/RecordAll.swift`, `GroupRecord.swift`
 * (`RecordPlan.make`, strict policy) and `OpenCineAppKit/MultiviewCoordinator+Record.swift`
 * (`MultiviewRecordConfirmation`: an 8 s window, nothing is resent). Slots stand in for entries.
 */
export type RecordDirection = 'start' | 'stop';

/** What a member reports at the press (gathered by the coordinator from its session). */
export interface RecordCandidate {
  slot: number;
  name: string;
  /** Live and reporting: a command can be sent. */
  live: boolean;
  /** A connection, repair or earlier record step is still running. */
  busy: boolean;
  /** Camera-reported recording; null while unknown. */
  recording: boolean | null;
  /** The camera is in a mode that cannot record video (a photo mode). */
  photo?: boolean;
}

export type ExclusionReason = 'not-live' | 'busy' | 'recording-unknown' | 'photo-mode';

export interface RecordPlan {
  direction: RecordDirection;
  requested: number[];
  /** Cameras that will be commanded, in slot order. */
  targets: number[];
  /** Cameras already in the requested state: counted, never commanded. */
  satisfied: number[];
  exclusions: { slot: number; reason: ExclusionReason }[];
}

/** Strict: any exclusion and nothing is commanded, so one press never splits the group. */
export const isRefused = (p: RecordPlan) => p.exclusions.length > 0;
export const isExecutable = (p: RecordPlan) => !isRefused(p) && p.targets.length > 0;

/**
 * Stop when any requested camera reports recording, else start. `slot` null (or omitted) is
 * every member.
 */
export function planRecord(candidates: RecordCandidate[], slot: number | null = null): RecordPlan {
  const requested = (slot == null ? candidates : candidates.filter((c) => c.slot === slot)).slice().sort((a, b) => a.slot - b.slot);
  const direction: RecordDirection = requested.some((c) => c.recording === true) ? 'stop' : 'start';
  const targets: number[] = [];
  const satisfied: number[] = [];
  const exclusions: RecordPlan['exclusions'] = [];
  for (const c of requested) {
    if (!c.live) exclusions.push({ slot: c.slot, reason: 'not-live' });
    else if (c.busy) exclusions.push({ slot: c.slot, reason: 'busy' });
    else if (c.recording == null) exclusions.push({ slot: c.slot, reason: 'recording-unknown' });
    else if (direction === 'start' && c.photo) exclusions.push({ slot: c.slot, reason: 'photo-mode' });
    else if ((direction === 'start') === c.recording) satisfied.push(c.slot);
    else targets.push(c.slot);
  }
  return { direction, requested: requested.map((c) => c.slot), targets, satisfied, exclusions };
}

/** Whether the approved plan still describes the cameras now (rebuild and compare). */
export function planIsCurrent(plan: RecordPlan, candidates: RecordCandidate[], slot: number | null = null): boolean {
  const now = planRecord(candidates, slot);
  return JSON.stringify(now) === JSON.stringify(plan);
}

/** One command's outcome. */
export type RecordOutcome = 'confirmed' | 'refused' | 'unconfirmed' | 'failed' | 'superseded';

/** The confirmation window: a reply or a matching report within 8 s. */
export const RECORD_CONFIRM_WINDOW_MS = 8000;

export const RecordCopy = {
  progress: (d: RecordDirection) => (d === 'start' ? 'Starting cameras…' : 'Stopping cameras…'),
  waiting: 'Waiting for camera confirmation',
  changed: 'Cameras changed · try again',
  nothing: 'No camera ready to record',
};

/** One camera's note for its outcome; null leaves the tile as it is (superseded). */
export function recordNote(outcome: RecordOutcome, direction: RecordDirection): string | null {
  switch (outcome) {
    case 'confirmed':
      return direction === 'start' ? 'Recording' : 'Recording stopped';
    case 'refused':
      return 'Recording command rejected · check camera';
    case 'failed':
      return 'Not sent · check camera';
    case 'superseded':
      return null;
    default:
      return 'No confirmation · check camera';
  }
}

/** The group line: every target confirmed and every camera in the requested state, or how many did. */
export function recordSummary(direction: RecordDirection, targets: number, confirmed: number, allMatch: boolean): string {
  if (confirmed === targets && allMatch) return direction === 'start' ? `Recording on ${confirmed} ${confirmed === 1 ? 'camera' : 'cameras'}` : 'Recording stopped';
  return `${confirmed} of ${targets} confirmed · check camera tiles`;
}

const REASON_COPY: Record<ExclusionReason, string> = {
  'not-live': 'not connected',
  busy: 'busy',
  'recording-unknown': 'not reporting',
  'photo-mode': 'in a photo mode',
};

/** Why a strict plan sent nothing, e.g. "Pocket 3 is not connected". */
export function exclusionText(plan: RecordPlan, nameOf: (slot: number) => string): string {
  if (!plan.exclusions.length) return plan.targets.length ? '' : RecordCopy.nothing;
  const first = plan.exclusions[0];
  const more = plan.exclusions.length - 1;
  return `${nameOf(first.slot)} is ${REASON_COPY[first.reason]}${more > 0 ? ` · ${more} more` : ''}`;
}
