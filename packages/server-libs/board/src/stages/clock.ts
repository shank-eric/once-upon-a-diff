/** How long each stage of one build took, in order, for the slow-build log line (Board.build). */
export type StageTimes = [stage: string, ms: number][];

/** Marks the end of each stage of a build: `mark('readLive')` records the time since the last mark. */
export class StageClock {
  readonly times: StageTimes = [];
  private last = performance.now();

  mark(stage: string): void {
    const now = performance.now();
    this.times.push([stage, Math.round(now - this.last)]);
    this.last = now;
  }
}
