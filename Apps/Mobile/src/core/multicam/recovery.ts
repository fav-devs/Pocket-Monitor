/**
 * One Multiview member's bounded recovery budget: the integration owns the ladder, this only
 * counts attempts so a failing member stops retrying on its own and never takes healthy peers
 * with it. A sustained healthy period restores the budget.
 * Source of truth: OpenCine `OpenCineMulticam/Recovery.swift` (`RecoveryBudget`) and
 * `OpenCineDJI/MultiviewRecovery.swift` (two rejoins, reset after 30 s healthy). Times are ms.
 */
export type RecoveryStatus = { kind: 'healthy' } | { kind: 'recovering'; attempt: number; of: number } | { kind: 'exhausted' };

export class RecoveryBudget {
  used = 0;
  exhausted = false;
  private healthySince: number | null = null;

  constructor(
    readonly limit = 2,
    readonly resetAfterHealthyMs = 30_000,
  ) {}

  get status(): RecoveryStatus {
    if (this.exhausted) return { kind: 'exhausted' };
    return this.healthySince == null && this.used > 0 ? { kind: 'recovering', attempt: this.used, of: this.limit } : { kind: 'healthy' };
  }

  /** Reports the member's health as the integration judges it. */
  observe(healthy: boolean, now: number): void {
    if (this.exhausted) return;
    if (!healthy) {
      this.healthySince = null;
      return;
    }
    const since = this.healthySince ?? now;
    this.healthySince = since;
    if (now - since >= this.resetAfterHealthyMs) this.used = 0;
  }

  /** Whether another attempt may start; exhausts the budget once the limit is used. */
  beginAttempt(): boolean {
    if (this.exhausted || this.used >= this.limit) {
      this.exhausted = true;
      return false;
    }
    this.used += 1;
    return true;
  }

  /** No automatic attempt remains: the member waits for the operator. */
  exhaust(): void {
    this.exhausted = true;
    this.healthySince = null;
  }

  /** The operator's retry: a fresh budget. */
  reset(): void {
    this.used = 0;
    this.exhausted = false;
    this.healthySince = null;
  }
}

/**
 * The coordinator's deadline on a member's repair (`MultiviewRepairResult.race`): `work`'s own
 * result when it settles first, `onDeadline` when the deadline passes first. A late result is
 * dropped; a rejected `work` resolves to `onError`.
 */
export function raceDeadline<T>(work: Promise<T>, deadlineMs: number, onDeadline: T, onError: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(onDeadline), deadlineMs);
    work.then(finish, () => finish(onError));
  });
}
