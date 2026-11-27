/**
 * Low-rate SoftAP-loss ownership; separate from encoder/decoder stall repair.
 * Source of truth: OpenCine `OpenCineDJI/CameraPathRecovery.swift`.
 */
export class CameraPathRecovery {
  static readonly reassociationGrace = 8;
  private absentSince: number | null = null;
  private requestedRecovery = false;

  reset(): void {
    this.absentSince = null;
    this.requestedRecovery = false;
  }

  /** Returns true exactly once when a sustained loss should route to SessionRecovery. */
  tick(now: number, pathReady: boolean, videoFresh: boolean, sessionActive: boolean, repairInFlight: boolean): boolean {
    if (!Number.isFinite(now) || !sessionActive || pathReady || videoFresh) {
      this.reset();
      return false;
    }
    if (now < (this.absentSince ?? now)) this.reset();
    if (this.absentSince === null) this.absentSince = now;
    if (repairInFlight || this.requestedRecovery || now - this.absentSince < CameraPathRecovery.reassociationGrace) return false;
    this.requestedRecovery = true;
    return true;
  }
}
