/**
 * The trigger: the one thing a bot supplies to the engine (besides its config section). It is a source of
 * candidates and a judge of each one. The engine owns everything after a `buy` verdict: the caps, the order, the
 * executor, the exits, the controls and status.json.
 *
 *   each cycle:  poll() -> new candidates join the pending set
 *                for each pending candidate: decide() -> wait (ask again next cycle) | skip | buy
 *                a buy passes the engine's own caps (PAUSE_BUYS, maxPerCoin, maxOpen, lifetimeSol, the ticket size)
 *                and becomes a position in `opening` with one buy order
 *
 * A trigger never trades and never touches the ledger's positions or orders: it reads them through the context.
 */
import type { Alerter } from "./alerts.ts";
import type { Config } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { Rpc } from "./solana/rpc.ts";

/** Something the trigger wants judged: a coin, when and where it was seen, and the trigger's own data. */
export interface Candidate {
  mint: string;
  /** "solana" (the only chain the core trades). */
  chain: string;
  /** When the trigger first saw it (ms). */
  seenAtMs: number;
  /** Where it came from, the trigger's word (e.g. "api", "chain", "file", "clock"). */
  source: string;
  /** Why it is a candidate, for logs. */
  reason?: string;
  /** The trigger's own data for this candidate (e.g. the launch record). Not read by the engine. */
  meta?: unknown;
}

/** A buy verdict. Every field but `reason` is optional; the engine fills the defaults. */
export interface BuyVerdict {
  verdict: "buy";
  /** The order's reason (ledger orders.reason). */
  reason: string;
  /** Ticket in lamports, at most buy.sol (default buy.sol). A larger one is refused as a skip. */
  lamports?: bigint;
  /** No attempt of the buy is built after this time (ms); null or absent: no deadline. */
  deadlineAtMs?: number | null;
  /** Tokens the trigger expects for the ticket (raw): the cap on adopting tokens of an uncertain buy (Candle's build replaces it once one answers). */
  expectedOutRaw?: bigint | null;
  /** The coin's decimals when known (default 6). */
  decimals?: number;
  /** Stored with the position as JSON (positions.launch_json). Default: the candidate's meta. */
  context?: unknown;
  /** Extra fields for the buy_order / dry_buy event (after position and mint); a function gets the buy's time. */
  log?: Record<string, unknown> | ((nowMs: number) => Record<string, unknown>);
}

/** Anything but an exact "wait", "skip" or a well-typed "buy" is taken as a skip. */
export type Verdict = BuyVerdict | { verdict: "wait"; reason: string } | { verdict: "skip"; reason: string };

/** The engine's caps as they stand for one coin, for triggers that want to skip early (the engine checks them again). */
export interface EntryCaps {
  open: number;
  entriesForMint: number;
  lifetimeLamports: bigint;
  paused: boolean;
}

/** What the engine knows about a pending candidate. */
export interface PendingInfo {
  firstSeenMs: number;
  /** The last wait reason ("" before the first verdict). */
  lastReason: string;
}

/** Handed to every trigger call. */
export interface TriggerContext {
  readonly cfg: Config;
  readonly ledger: Ledger;
  readonly rpc: Rpc;
  readonly log: Logger;
  readonly alerter: Alerter;
  /** This run's mode: positions and caps are per mode. */
  readonly dry: boolean;
  now(): number;
  caps(mint: string): EntryCaps;
  /** STOP or a signal was seen: return soon. */
  shouldStop(): boolean;
}

export interface Trigger {
  readonly name: string;
  /** The status.json `stats` key that counts candidates (default "candidates"). */
  readonly candidateLabel?: string;
  /** Prefix of buy order ids (clientTradeId `<prefix>-<uuid>`), default "bot". */
  readonly buyIdPrefix?: string;
  /** Prefix of sell order ids, default "bots". */
  readonly sellIdPrefix?: string;
  /** Start any sources (sockets, timers). The engine never calls it; the runner does, before the first cycle. */
  start?(): Promise<void>;
  stop?(): void;
  /** Candidates new since the last call. One already pending is replaced (its wait state starts over). */
  poll(ctx: TriggerContext): Candidate[] | Promise<Candidate[]>;
  /** The verdict on one pending candidate. A throw ends this cycle's entries step (logged, cycle_step_failed); the candidate stays pending. */
  decide(c: Candidate, ctx: TriggerContext, pending: PendingInfo): Promise<Verdict> | Verdict;
  /**
   * Every verdict, after the engine's own cap check (so a buy the caps refuse arrives here as a skip). Called before
   * the buy order is placed. Optional: without it the engine logs candidate_wait / candidate_skip itself.
   */
  onVerdict?(c: Candidate, v: Verdict, ctx: TriggerContext, pending: PendingInfo): void;
  /** After each entries step (bookkeeping that is not about one candidate). */
  afterEntries?(ctx: TriggerContext): void;
  /** Extra status.json fields, placed after `alertsSent`. */
  status?(pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown>;
}
