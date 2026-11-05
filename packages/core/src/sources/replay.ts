/**
 * (0.6.0) Record a series source and replay it: for tests, and to run a rule on recorded data before running it live.
 *
 *   const rec = new SeriesRecorder(source);   rec.snapshot()  -> one JSONL line per call (every watched coin's view)
 *   const rp = new ReplaySeries(lines);       rp.seek(t)      -> a SeriesSource answering as the source did at time t
 *   replay(lines, (src, at) => decide(...))   -> the decisions, in order (the same lines give the same decisions)
 */
import type { SeriesSource, SeriesView } from "./series.ts";

export interface SeriesSnapshot {
  at: number;
  views: Record<string, SeriesView>;
}

export class SeriesRecorder {
  private src: SeriesSource;
  private now: () => number;
  constructor(src: SeriesSource, now: () => number = Date.now) {
    this.src = src;
    this.now = now;
  }
  /** One snapshot of every watched coin, as a JSON line (no trailing newline). */
  snapshot(): string {
    const views: Record<string, SeriesView> = {};
    for (const m of this.src.watched()) {
      const v = this.src.series(m);
      if (v) views[m] = v;
    }
    return JSON.stringify({ at: this.now(), views } satisfies SeriesSnapshot);
  }
}

export function parseSnapshots(text: string): SeriesSnapshot[] {
  const out: SeriesSnapshot[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const s = JSON.parse(line) as SeriesSnapshot;
    if (typeof s.at !== "number" || !s.views || typeof s.views !== "object") throw new Error("replay: a line is not a series snapshot");
    out.push(s);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

export class ReplaySeries implements SeriesSource {
  readonly snapshots: SeriesSnapshot[];
  private i = -1;
  constructor(snaps: SeriesSnapshot[] | string) {
    this.snapshots = typeof snaps === "string" ? parseSnapshots(snaps) : [...snaps].sort((a, b) => a.at - b.at);
  }
  /** Answer as of time t: the last snapshot at or before it. */
  seek(t: number): void {
    let i = -1;
    for (let k = 0; k < this.snapshots.length && this.snapshots[k].at <= t; k++) i = k;
    this.i = i;
  }
  now(): number {
    return this.i >= 0 ? this.snapshots[this.i].at : 0;
  }
  series(mint: string): SeriesView | null {
    return this.i >= 0 ? this.snapshots[this.i].views[mint] ?? null : null;
  }
  subscribe(): void {
    /* a recording: what was watched is what it holds */
  }
  unsubscribe(): void {
    /* a recording */
  }
  watched(): string[] {
    return this.i >= 0 ? Object.keys(this.snapshots[this.i].views) : [];
  }
}

/** Step through every snapshot in order, calling `fn` at each; returns what it returned, flattened. */
export function replay<T>(snaps: SeriesSnapshot[] | string, fn: (src: ReplaySeries, at: number) => T[]): T[] {
  const src = new ReplaySeries(snaps);
  const out: T[] = [];
  for (const s of src.snapshots) {
    src.seek(s.at);
    out.push(...fn(src, s.at));
  }
  return out;
}
