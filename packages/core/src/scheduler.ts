/**
 * (batch 5) Timed runs that survive a restart: a schedule fires on a fixed grid (every `everySec` seconds, optionally
 * anchored to a UTC time of day), each run is claimed in the ledger BEFORE the bot acts on it, and a run in flight
 * blocks the next run of the same schedule.
 *
 *  - **Never twice.** A claim is one ledger transaction: the run count goes up, the run is marked in flight and the next
 *    slot is set. A restart finds the run in flight (`inflight()`), never due again; the bot settles it (its orders
 *    run to their end) and calls `finish`.
 *  - **Never a burst.** Slots that passed while the bot was down, or while a run was still in flight, are missed. The
 *    policy (`missed`) says what happens: `skip` (default) runs nothing for them and waits for the next slot; `once`
 *    runs one catch-up run now, however many were missed. A slot whose time is still within `graceSec` (plus the
 *    jitter) is on time, not missed.
 *  - **The grid.** Without `atUtc` the first run is due when the schedule is first stored (the bot's first `due()`), then every
 *    `everySec`. With `atUtc` ("HH:MM" or "HH:MM:SS", UTC) the slots are that time of day plus whole multiples of
 *    `everySec`, counted from 1970-01-01; `everySec` must then divide a day or be whole days. A slot is never moved by
 *    a late run: the next slot is always the grid's.
 *  - **Jitter** (`jitterSec`): each slot fires at a random delay in [0, jitterSec) after it, drawn once when the slot is
 *    set and stored, so a restart does not draw again.
 *  - **End.** `maxRuns` (every run counts, catch-up runs too) and `until` (no run starts at or after it).
 *  - **Changes.** A schedule whose spec changed is re-anchored: the next slot follows the last slot run (or now). Its
 *    run count and history stay. A schedule removed from the config keeps its rows; a run of it still in flight is
 *    still returned by `inflight()` so it can be settled.
 *
 * Dry and live rows are kept apart (`dry` is part of every key). The tables are created on first use by the
 * Scheduler (`create table if not exists`); the core schema is unchanged. Time comes from `now()`, jitter from
 * `random()`: a test drives both.
 */
import { createHash } from "node:crypto";
import { ConfigError, num, str, type Obj } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";

export type MissedPolicy = "skip" | "once";

export interface ScheduleSpec {
  /** Stable name: the ledger keys the schedule's state by it. */
  id: string;
  everySec: number;
  /** "HH:MM" or "HH:MM:SS", UTC, or null. */
  atUtc: string | null;
  jitterSec: number;
  missed: MissedPolicy;
  /** How late a slot may still run as on time (seconds, on top of the jitter). */
  graceSec: number;
  maxRuns: number | null;
  /** No run starts at or after this time (ms), or null. */
  untilMs: number | null;
}

/** The keys parseSchedule reads (a bot that adds its own keys to the same object lists these as allowed too). */
export const SCHEDULE_KEYS = ["id", "everySec", "atUtc", "jitterSec", "missed", "graceSec", "maxRuns", "until"];
export const DAY_SEC = 86_400;
/** The shortest interval a schedule may have. */
export const MIN_EVERY_SEC = 10;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TOD = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Milliseconds into the UTC day of an "HH:MM[:SS]". */
export function todMs(atUtc: string): number {
  const m = TOD.exec(atUtc);
  if (!m) throw new ConfigError(`atUtc: "${atUtc}" is not HH:MM or HH:MM:SS`);
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** One schedule from a config object (only the SCHEDULE_KEYS; the caller checks for unknown keys). */
export function parseSchedule(o: Obj, where: string): ScheduleSpec {
  const id = str(o, "id", where, { re: ID });
  if (id === undefined) throw new ConfigError(`${where}.id: required`);
  const everySec = num(o, "everySec", where, { min: MIN_EVERY_SEC, max: 366 * DAY_SEC, int: true });
  const atUtc = str(o, "atUtc", where, { optional: true }) ?? null;
  if (atUtc !== null) {
    if (!TOD.test(atUtc)) throw new ConfigError(`${where}.atUtc: "HH:MM" or "HH:MM:SS" (UTC)`);
    if (!(DAY_SEC % everySec === 0 || everySec % DAY_SEC === 0)) throw new ConfigError(`${where}.everySec: with atUtc it must divide a day (86400 s) or be whole days`);
  }
  const jitterSec = num(o, "jitterSec", where, { min: 0, int: true, def: 0 });
  const graceSec = num(o, "graceSec", where, { min: 0, int: true, def: Math.min(60, Math.floor(everySec / 2)) });
  if (jitterSec + graceSec >= everySec) throw new ConfigError(`${where}: jitterSec + graceSec must be under everySec`);
  const missed = (str(o, "missed", where, { def: "skip" }) as MissedPolicy);
  if (missed !== "skip" && missed !== "once") throw new ConfigError(`${where}.missed: "skip" (default) or "once"`);
  const maxRuns = o.maxRuns === undefined ? null : num(o, "maxRuns", where, { min: 1, int: true });
  let untilMs: number | null = null;
  const until = str(o, "until", where, { optional: true });
  if (until !== undefined) {
    // A full ISO time with its zone: a bare date or a local time would depend on where the bot runs.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(Date.parse(until))) throw new ConfigError(`${where}.until: an ISO time with its zone, e.g. "2026-12-31T00:00:00Z"`);
    untilMs = Date.parse(until);
  }
  return { id, everySec, atUtc, jitterSec, missed, graceSec, maxRuns, untilMs };
}

/** What a change to these fields re-anchors (maxRuns, until and missed apply as they are, with no re-anchor). */
export function gridHash(s: ScheduleSpec): string {
  return createHash("sha256").update(JSON.stringify([s.everySec, s.atUtc, s.jitterSec])).digest("hex").slice(0, 16);
}

/** The grid's anchor: the time of day for `atUtc`, else the first time the schedule was stored. */
export function anchorOf(s: ScheduleSpec, firstMs: number): number {
  return s.atUtc ? todMs(s.atUtc) : firstMs;
}

/** The first slot of the grid at or after `t`. */
export function slotAtOrAfter(s: ScheduleSpec, anchor: number, t: number): number {
  const e = s.everySec * 1000;
  return anchor + Math.ceil((t - anchor) / e) * e;
}

/** The last slot of the grid at or before `t`. */
export function slotAtOrBefore(s: ScheduleSpec, anchor: number, t: number): number {
  const e = s.everySec * 1000;
  return anchor + Math.floor((t - anchor) / e) * e;
}

export type RunStatus = "done" | "skipped" | "failed" | "blocked" | "interrupted";

/** A claimed run. `slotMs` is the grid slot it serves; `missed` counts the slots passed over before it. */
export interface Run {
  id: string;
  run: number;
  slotMs: number;
  startedAt: number;
  catchUp: boolean;
  missed: number;
  /** What the bot stored with setRef (its orders, its phase), or null. */
  ref: unknown;
}

interface Row {
  id: string;
  dry: number;
  spec_hash: string;
  anchor_ms: number;
  next_slot_ms: number;
  fire_at_ms: number;
  runs: number;
  inflight_run: number | null;
  inflight_slot_ms: number | null;
  inflight_at: number | null;
  ref_json: string | null;
  last_slot_ms: number | null;
  missed_total: number;
  last_missed_at: number | null;
  ended: string | null;
}

const TABLES = `
create table if not exists schedules (
  id text not null, dry integer not null, spec_hash text not null, anchor_ms integer not null,
  next_slot_ms integer not null, fire_at_ms integer not null, runs integer not null default 0,
  inflight_run integer, inflight_slot_ms integer, inflight_at integer, ref_json text,
  last_slot_ms integer, missed_total integer not null default 0, last_missed_at integer, ended text,
  created_at integer not null, updated_at integer not null,
  primary key (id, dry)
);
create table if not exists schedule_runs (
  id text not null, dry integer not null, run integer not null, slot_ms integer not null, started_at integer not null,
  catch_up integer not null default 0, missed integer not null default 0, finished_at integer, status text, detail text,
  primary key (id, dry, run)
);
`;

export interface SchedulerDeps {
  ledger: Ledger;
  specs: ScheduleSpec[];
  dry: boolean;
  now?: () => number;
  /** [0, 1): the jitter draw (default Math.random). */
  random?: () => number;
  log?: Logger;
}

export class Scheduler {
  private d: SchedulerDeps;
  private now: () => number;
  private random: () => number;
  private specs: Map<string, ScheduleSpec>;
  private dry: number;

  constructor(d: SchedulerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
    this.dry = d.dry ? 1 : 0;
    this.specs = new Map();
    for (const s of d.specs) {
      if (this.specs.has(s.id)) throw new ConfigError(`schedule id "${s.id}" used twice`);
      this.specs.set(s.id, s);
    }
    d.ledger.db.exec(TABLES);
  }

  private synced = false;

  /**
   * Store each configured schedule, or re-anchor a changed one. Called by the first `due()` (and `nextAt()`), not by the
   * constructor: a schedule's first slot (without atUtc) is when the bot is first ready to run it, not when it was
   * built (a bot that reads the chain before its first run would otherwise miss that slot).
   */
  start(): void {
    if (this.synced) return;
    this.sync();
    this.synced = true;
  }

  private jitter(s: ScheduleSpec): number {
    return s.jitterSec > 0 ? Math.floor(this.random() * s.jitterSec * 1000) : 0;
  }

  private row(id: string): Row | undefined {
    return this.d.ledger.db.prepare("select * from schedules where id = ? and dry = ?").get(id, this.dry) as Row | undefined;
  }

  /** Store each configured schedule (first start) or re-anchor it (its grid changed). */
  private sync(): void {
    const now = this.now();
    this.d.ledger.tx(() => {
      for (const s of this.specs.values()) {
        const r = this.row(s.id);
        const hash = gridHash(s);
        if (!r) {
          const anchor = anchorOf(s, now);
          // Without atUtc the first run is due now; with it, at the first slot from now on.
          const next = s.atUtc ? slotAtOrAfter(s, anchor, now) : now;
          this.d.ledger.db.prepare("insert into schedules (id, dry, spec_hash, anchor_ms, next_slot_ms, fire_at_ms, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(s.id, this.dry, hash, anchor, next, next + this.jitter(s), now, now);
          this.d.log?.info("schedule_added", { schedule: s.id, firstAt: new Date(next).toISOString() });
          continue;
        }
        if (r.spec_hash === hash) {
          // maxRuns raised or until moved: an ended schedule may run again (no re-anchor; missed slots follow the policy).
          if (r.ended !== null && this.endOf(s, r, r.next_slot_ms, now) === null) {
            this.d.ledger.db.prepare("update schedules set ended = null, updated_at = ? where id = ? and dry = ?").run(now, s.id, this.dry);
            this.d.log?.info("schedule_resumed", { schedule: s.id });
          }
          continue;
        }
        // The grid changed: re-anchored after the last slot run (or now), the history kept.
        const anchor = s.atUtc ? anchorOf(s, now) : (r.last_slot_ms ?? now);
        const next = r.last_slot_ms === null ? (s.atUtc ? slotAtOrAfter(s, anchor, now) : now) : slotAtOrAfter(s, anchor, r.last_slot_ms + 1);
        this.d.ledger.db.prepare("update schedules set spec_hash = ?, anchor_ms = ?, next_slot_ms = ?, fire_at_ms = ?, ended = null, updated_at = ? where id = ? and dry = ?")
          .run(hash, anchor, next, next + this.jitter(s), now, s.id, this.dry);
        this.d.log?.info("schedule_changed", { schedule: s.id, nextAt: new Date(next).toISOString() });
      }
    });
  }

  /** Why a schedule has ended (maxRuns, until), or null. */
  private endOf(s: ScheduleSpec, r: Row, slot: number, now: number): string | null {
    if (s.maxRuns !== null && r.runs >= s.maxRuns) return "maxRuns";
    if (s.untilMs !== null && (slot >= s.untilMs || now >= s.untilMs)) return "until";
    return null;
  }

  /**
   * Claim every run due now (each in its own ledger transaction, committed before this returns) and apply the missed
   * policy. A schedule with a run in flight, or ended, is passed over.
   */
  due(): Run[] {
    this.start();
    const out: Run[] = [];
    for (const s of this.specs.values()) {
      const r = this.claimOne(s);
      if (r) out.push(r);
    }
    return out;
  }

  private claimOne(s: ScheduleSpec): Run | null {
    return this.d.ledger.tx(() => {
      const now = this.now();
      const r = this.row(s.id);
      if (!r || r.inflight_run !== null || r.ended !== null) return null;
      // The next slot more than one interval ahead (the clock was set back, or a stored row from a later time): the
      // grid is re-anchored one interval from now (with atUtc, the first time-of-day slot from then), so the schedule
      // neither sits idle until that far slot nor fires at once.
      if (r.next_slot_ms - now > s.everySec * 1000) {
        const e = s.everySec * 1000;
        const anchor = s.atUtc ? anchorOf(s, now) : now + e;
        const next = s.atUtc ? slotAtOrAfter(s, anchor, now + e) : now + e;
        this.d.ledger.db.prepare("update schedules set anchor_ms = ?, next_slot_ms = ?, fire_at_ms = ?, updated_at = ? where id = ? and dry = ?").run(anchor, next, next + this.jitter(s), now, s.id, this.dry);
        this.d.log?.warn("schedule_reanchored", { schedule: s.id, was: new Date(r.next_slot_ms).toISOString(), nextAt: new Date(next).toISOString() });
        return null;
      }
      if (now < r.fire_at_ms) {
        // Not due: ended already if no run can come (maxRuns used, or the next slot at or past until).
        if (s.maxRuns !== null && r.runs >= s.maxRuns) this.end(s, "maxRuns", now);
        else if (s.untilMs !== null && r.next_slot_ms >= s.untilMs) this.end(s, "until", now);
        return null;
      }
      const e = s.everySec * 1000;
      // The latest slot at or before now (at least next_slot: now >= fire_at >= next_slot). Every slot before it is at
      // least everySec old, past grace + jitter (parseSchedule keeps those under everySec): missed.
      const latest = r.next_slot_ms + Math.floor((now - r.next_slot_ms) / e) * e;
      const before = Math.round((latest - r.next_slot_ms) / e);
      const onTime = now - latest <= (s.graceSec + s.jitterSec) * 1000;
      const missed = before + (onTime ? 0 : 1);
      const end = this.endOf(s, r, latest, now);
      if (end) {
        this.end(s, end, now);
        return null;
      }
      if (!onTime && s.missed === "skip") {
        const next = latest + e;
        this.d.ledger.db.prepare("update schedules set next_slot_ms = ?, fire_at_ms = ?, missed_total = missed_total + ?, last_missed_at = ?, updated_at = ? where id = ? and dry = ?")
          .run(next, next + this.jitter(s), missed, now, now, s.id, this.dry);
        this.d.log?.warn("schedule_missed", { schedule: s.id, missed, policy: "skip", nextAt: new Date(next).toISOString() });
        return null;
      }
      const run = r.runs + 1;
      const next = latest + e;
      this.d.ledger.db.prepare(
        `update schedules set runs = ?, inflight_run = ?, inflight_slot_ms = ?, inflight_at = ?, ref_json = null, last_slot_ms = ?,
           next_slot_ms = ?, fire_at_ms = ?, missed_total = missed_total + ?, last_missed_at = case when ? > 0 then ? else last_missed_at end, updated_at = ?
         where id = ? and dry = ? and inflight_run is null and runs = ?`,
      ).run(run, run, latest, now, latest, next, next + this.jitter(s), missed, missed, now, now, s.id, this.dry, r.runs);
      this.d.ledger.db.prepare("insert into schedule_runs (id, dry, run, slot_ms, started_at, catch_up, missed) values (?, ?, ?, ?, ?, ?, ?)")
        .run(s.id, this.dry, run, latest, now, onTime ? 0 : 1, missed);
      if (missed > 0) this.d.log?.warn("schedule_missed", { schedule: s.id, missed, policy: onTime ? "on time" : "once", run });
      this.d.log?.info("schedule_run", { schedule: s.id, run, slot: new Date(latest).toISOString(), lateMs: now - latest, catchUp: !onTime });
      return { id: s.id, run, slotMs: latest, startedAt: now, catchUp: !onTime, missed, ref: null };
    });
  }

  private end(s: ScheduleSpec, why: string, now: number): void {
    this.d.ledger.db.prepare("update schedules set ended = ?, updated_at = ? where id = ? and dry = ?").run(why, now, s.id, this.dry);
    this.d.log?.info("schedule_ended", { schedule: s.id, why });
  }

  /** Every run in flight (this mode), schedules no longer configured included. */
  inflight(): Run[] {
    const rows = this.d.ledger.db.prepare("select s.*, r.catch_up cu, r.missed m from schedules s left join schedule_runs r on r.id = s.id and r.dry = s.dry and r.run = s.inflight_run where s.dry = ? and s.inflight_run is not null order by s.id").all(this.dry) as unknown as Array<Row & { cu: number | null; m: number | null }>;
    return rows.map((r) => ({ id: r.id, run: r.inflight_run!, slotMs: r.inflight_slot_ms!, startedAt: r.inflight_at!, catchUp: r.cu === 1, missed: r.m ?? 0, ref: r.ref_json === null ? null : JSON.parse(r.ref_json) }));
  }

  /** Store what the bot needs to settle a run in flight after a restart (its orders, its phase). */
  setRef(id: string, run: number, ref: unknown): void {
    this.d.ledger.db.prepare("update schedules set ref_json = ?, updated_at = ? where id = ? and dry = ? and inflight_run = ?").run(JSON.stringify(ref), this.now(), id, this.dry, run);
  }

  /** End a run in flight. Returns false when that run is not the one in flight (already finished). */
  finish(id: string, run: number, status: RunStatus, detail: string): boolean {
    const now = this.now();
    return this.d.ledger.tx(() => {
      const r = this.d.ledger.db.prepare("update schedules set inflight_run = null, inflight_slot_ms = null, inflight_at = null, ref_json = null, updated_at = ? where id = ? and dry = ? and inflight_run = ?").run(now, id, this.dry, run);
      if (Number(r.changes) !== 1) return false;
      this.d.ledger.db.prepare("update schedule_runs set finished_at = ?, status = ?, detail = ? where id = ? and dry = ? and run = ?").run(now, status, detail.slice(0, 2000), id, this.dry, run);
      this.d.log?.info("schedule_run_end", { schedule: id, run, status, detail: detail.slice(0, 300) });
      return true;
    });
  }

  /** The last `n` runs of a schedule, newest first. */
  runs(id: string, n = 10): Array<{ run: number; slotMs: number; startedAt: number; finishedAt: number | null; status: string | null; detail: string | null; catchUp: boolean; missed: number }> {
    const rows = this.d.ledger.db.prepare("select * from schedule_runs where id = ? and dry = ? order by run desc limit ?").all(id, this.dry, n) as any[];
    return rows.map((r) => ({ run: r.run, slotMs: r.slot_ms, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, detail: r.detail, catchUp: r.catch_up === 1, missed: r.missed }));
  }

  /** The next time a schedule fires (ms), or null when it has ended or has a run in flight. */
  nextAt(id: string): number | null {
    this.start();
    const r = this.row(id);
    return !r || r.ended !== null || r.inflight_run !== null ? null : r.fire_at_ms;
  }

  /** For status.json: each configured schedule's state and last run. */
  status(): Array<Record<string, unknown>> {
    const iso = (t: number | null | undefined) => (t === null || t === undefined ? null : new Date(t).toISOString());
    return [...this.specs.values()].map((s) => {
      const r = this.row(s.id);
      const last = this.runs(s.id, 1)[0];
      return {
        id: s.id, everySec: s.everySec, atUtc: s.atUtc, missedPolicy: s.missed, runs: r?.runs ?? 0, maxRuns: s.maxRuns, until: iso(s.untilMs),
        ended: r?.ended ?? null, nextAt: r && r.ended === null ? iso(r.fire_at_ms) : null,
        inflight: r && r.inflight_run !== null ? { run: r.inflight_run, slot: iso(r.inflight_slot_ms), since: iso(r.inflight_at) } : null,
        missedTotal: r?.missed_total ?? 0,
        last: last ? { run: last.run, slot: iso(last.slotMs), status: last.status ?? "in flight", detail: last.detail, finishedAt: iso(last.finishedAt), catchUp: last.catchUp } : null,
      };
    });
  }
}
