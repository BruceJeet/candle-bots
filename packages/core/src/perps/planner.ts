/**
 * (batch 6) The hedge planner: a pure function. Spot bags (their USD value and when it was priced), perp markets,
 * the account's positions and the config in; per-coin targets and the orders that reach them out. No I/O, no clock
 * of its own (the caller passes `now`).
 *
 * Rules:
 *  - Instrument: the coin's own perp when the config names one and the venue lists it (not delisted, a mark), else
 *    the proxy (default SOL). `perp: null` in a coin's config leaves that coin unhedged.
 *  - Target: short `ratio` x the bag's USD value, summed per perp coin, sized at the mark and rounded toward zero at
 *    the market's size step.
 *  - Kill rule: a bag whose price is older than `unpricedCloseSec` (or never priced) counts 0, so its share of the
 *    hedge is closed. A bag under `minBagUsd` counts 0.
 *  - Caps: margin (notional / leverage, leverage = min(maxLeverage, the market's max)) at most `maxMarginUsd` and 90 %
 *    of the account value when known; notional at most `maxNotionalUsd` when set. Over a cap, every target is scaled
 *    down by the same factor.
 *  - Band: no order while the position is within max(bandPct of the target, minOrderUsd) of it.
 *  - Orders: one per coin per plan. More short: a market open (never while opens are paused). Less short: a
 *    reduce-only close of the difference. Target zero, a flatten, or a long position on a hedge coin: a reduce-only
 *    close of the whole position.
 *  - A frozen coin (an order not yet reconciled, a position the book cannot explain) gets no order.
 *  - Only `managed` coins are ever traded: a position on any other coin is not the hedger's.
 */
import { floorSize, type PerpMarket } from "./venue.ts";

export interface HedgeCoinConfig {
  /** The coin's own Hyperliquid perp (e.g. "WIF", "kBONK"); null: never hedge this coin. */
  perp?: string | null;
  ratio?: number;
}

export interface HedgeConfig {
  proxy: string;
  /** Hedge ratio for proxy hedges (a fitted beta, when the caller passes one per bag, wins). */
  ratio: number;
  coins: Record<string, HedgeCoinConfig>;
  bandPct: number;
  minOrderUsd: number;
  maxLeverage: number;
  maxMarginUsd: number;
  maxNotionalUsd?: number;
  minBagUsd: number;
  unpricedCloseSec: number;
}

export interface BagIn {
  mint: string;
  /** The bag's value in USD at its last good price, null when never priced. */
  valueUsd: number | null;
  /** When that price was read. */
  pricedAt: number | null;
  /** A fitted ratio for a proxy hedge (beta), when the caller has one. */
  beta?: number | null;
}

export interface PlanInput {
  now: number;
  bags: BagIn[];
  markets: Map<string, PerpMarket>;
  /** Signed position per coin, as the venue reads it now. */
  positions: Map<string, number>;
  accountValueUsd: number | null;
  /** Coins that must not be traded this plan, with why. */
  frozen: Map<string, string>;
  /** Coins the hedger may trade (the proxy, configured perps, coins it traded before). */
  managed: Set<string>;
  flatten?: boolean;
  pauseOpens?: boolean;
  cfg: HedgeConfig;
}

export interface PlanOrder {
  coin: string;
  action: "open" | "close";
  side: "long" | "short";
  /** null: the whole position. */
  size: string | null;
  reduceOnly: boolean;
  reason: string;
  /** Rough order value at the mark (USD), for logs and alerts. */
  usd: number;
}

export type LineStatus = "in_band" | "order" | "frozen" | "no_market" | "paused" | "under_step";

export interface PlanLine {
  coin: string;
  mark: number | null;
  leverage: number | null;
  targetUsd: number;
  /** Signed: negative is short. */
  targetSz: number;
  actualSz: number;
  status: LineStatus;
  note?: string;
  mints: string[];
}

export type BagStatus = "hedged" | "unpriced" | "dust" | "unhedged" | "flatten";

export interface PlanBag {
  mint: string;
  coin: string | null;
  ratio: number;
  valueUsd: number | null;
  hedgeUsd: number;
  status: BagStatus;
  note?: string;
}

export interface Plan {
  orders: PlanOrder[];
  lines: PlanLine[];
  bags: PlanBag[];
  /** Set when a cap scaled the targets down. */
  capped: { factor: number; by: string } | null;
}

/** The instrument a bag is hedged with, given what the venue lists now. */
export function instrumentFor(mint: string, cfg: HedgeConfig, markets: Map<string, PerpMarket>): { coin: string | null; ratio: number; own: boolean; note?: string } {
  const spec = cfg.coins[mint];
  if (spec && spec.perp === null) return { coin: null, ratio: 0, own: false, note: "perp: null (not hedged)" };
  if (spec?.perp) {
    const m = markets.get(spec.perp);
    if (m && !m.delisted && m.markPx !== null && m.markPx > 0) return { coin: spec.perp, ratio: spec.ratio ?? 1, own: true };
    return { coin: cfg.proxy, ratio: cfg.ratio, own: false, note: `own perp ${spec.perp} ${!m ? "not listed" : m.delisted ? "delisted" : "has no mark"}: proxy ${cfg.proxy}` };
  }
  return { coin: cfg.proxy, ratio: spec?.ratio ?? cfg.ratio, own: false };
}

export function planHedge(inp: PlanInput): Plan {
  const { cfg, markets } = inp;
  const bags: PlanBag[] = [];
  const perCoin = new Map<string, { usd: number; mints: string[] }>();
  for (const b of inp.bags) {
    const ins = instrumentFor(b.mint, cfg, markets);
    // A fitted beta applies to proxy hedges only (it is fitted against the proxy), and never to a configured ratio.
    const ratio = !ins.own && ins.coin !== null && cfg.coins[b.mint]?.ratio === undefined && b.beta !== undefined && b.beta !== null ? b.beta : ins.ratio;
    const fresh = b.valueUsd !== null && b.pricedAt !== null && inp.now - b.pricedAt <= cfg.unpricedCloseSec * 1000;
    let status: BagStatus;
    let hedgeUsd = 0;
    if (ins.coin === null) status = "unhedged";
    else if (inp.flatten) status = "flatten";
    else if (!fresh) status = "unpriced";
    else if (b.valueUsd! < cfg.minBagUsd) status = "dust";
    else {
      status = "hedged";
      hedgeUsd = Math.max(0, ratio * b.valueUsd!);
    }
    bags.push({ mint: b.mint, coin: ins.coin, ratio, valueUsd: b.valueUsd, hedgeUsd, status, ...(ins.note ? { note: ins.note } : {}) });
    if (ins.coin !== null) {
      const e = perCoin.get(ins.coin) ?? { usd: 0, mints: [] };
      e.usd += hedgeUsd;
      if (hedgeUsd > 0) e.mints.push(b.mint);
      perCoin.set(ins.coin, e);
    }
  }

  // Caps: one factor for every target.
  const levOf = (coin: string) => {
    const m = markets.get(coin);
    return m ? Math.max(1, Math.min(cfg.maxLeverage, m.maxLeverage)) : null;
  };
  let notional = 0;
  let margin = 0;
  for (const [coin, e] of perCoin) {
    const lev = levOf(coin);
    if (lev === null || e.usd <= 0) continue;
    notional += e.usd;
    margin += e.usd / lev;
  }
  let factor = 1;
  let by = "";
  const cap = (f: number, why: string) => {
    if (f < factor) {
      factor = f;
      by = why;
    }
  };
  if (margin > 0) {
    cap(cfg.maxMarginUsd / margin, "maxMarginUsd");
    if (inp.accountValueUsd !== null) cap(Math.max(0, (0.9 * inp.accountValueUsd) / margin), "account value");
  }
  if (cfg.maxNotionalUsd !== undefined && notional > 0) cap(cfg.maxNotionalUsd / notional, "maxNotionalUsd");
  factor = Math.max(0, Math.min(1, factor));

  const coins = new Set<string>([...perCoin.keys()]);
  for (const [c, szi] of inp.positions) if (szi !== 0 && inp.managed.has(c)) coins.add(c);

  const lines: PlanLine[] = [];
  const orders: PlanOrder[] = [];
  for (const coin of [...coins].sort()) {
    const m = markets.get(coin);
    const actual = inp.positions.get(coin) ?? 0;
    const targetUsd = (perCoin.get(coin)?.usd ?? 0) * factor;
    const mints = perCoin.get(coin)?.mints ?? [];
    const lev = levOf(coin);
    const line: PlanLine = { coin, mark: m?.markPx ?? null, leverage: lev, targetUsd, targetSz: 0, actualSz: actual, status: "in_band", mints };
    lines.push(line);
    if (!inp.managed.has(coin)) {
      // Never reached: every target coin is managed (the caller adds the proxy and configured perps).
      line.status = "frozen";
      line.note = "not a managed coin";
      continue;
    }
    const frozen = inp.frozen.get(coin);
    if (frozen) {
      line.status = "frozen";
      line.note = frozen;
      continue;
    }
    if (!m || m.markPx === null || !(m.markPx > 0)) {
      line.status = "no_market";
      line.note = !m ? "not listed" : "no mark";
      continue;
    }
    const mark = m.markPx;
    const step = 10 ** -m.szDecimals;
    const tsz = Number(floorSize(targetUsd / mark, m.szDecimals));
    line.targetSz = tsz === 0 ? 0 : -tsz;
    const closeAll = (reason: string, side: "long" | "short") => {
      line.status = "order";
      orders.push({ coin, action: "close", side, size: null, reduceOnly: true, reason, usd: Math.abs(actual) * mark });
    };
    if (actual > 0) {
      closeAll("wrong_side", "short");
      continue;
    }
    if (line.targetSz === 0) {
      if (actual < 0) closeAll(inp.flatten ? "flatten" : targetUsd > 0 ? "target_under_step" : "no_hedge_needed", "long");
      else if (targetUsd > 0) line.status = "under_step";
      continue;
    }
    const delta = line.targetSz - actual; // < 0: more short
    const deltaUsd = Math.abs(delta) * mark;
    const band = Math.max((cfg.bandPct / 100) * targetUsd, cfg.minOrderUsd);
    if (deltaUsd <= band || Math.abs(delta) < step / 2) continue;
    if (delta < 0) {
      if (inp.pauseOpens) {
        line.status = "paused";
        line.note = "opens paused";
        continue;
      }
      const size = floorSize(-delta, m.szDecimals);
      if (size === "0") continue;
      line.status = "order";
      orders.push({ coin, action: "open", side: "short", size, reduceOnly: false, reason: actual === 0 ? "hedge" : "add", usd: Number(size) * mark });
    } else {
      const size = floorSize(delta, m.szDecimals);
      if (size === "0") continue;
      line.status = "order";
      orders.push({ coin, action: "close", side: "long", size, reduceOnly: true, reason: factor < 1 && targetUsd < Math.abs(actual) * mark ? "cap" : "reduce", usd: Number(size) * mark });
    }
  }
  return { orders, lines, bags, capped: factor < 1 ? { factor, by } : null };
}

/**
 * The beta of a bag's returns to the proxy's, from paired price samples taken at the same times (oldest first):
 * cov(r_bag, r_proxy) / var(r_proxy) on log returns. Null with fewer than `minSamples` pairs or a flat proxy. The
 * result is clamped to [min, max].
 */
export function fitBeta(samples: Array<{ bag: number; proxy: number }>, opts: { minSamples: number; min: number; max: number }): number | null {
  const ok = samples.filter((s) => s.bag > 0 && s.proxy > 0);
  if (ok.length < opts.minSamples + 1) return null;
  const rb: number[] = [];
  const rp: number[] = [];
  for (let i = 1; i < ok.length; i++) {
    rb.push(Math.log(ok[i].bag / ok[i - 1].bag));
    rp.push(Math.log(ok[i].proxy / ok[i - 1].proxy));
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const mb = mean(rb);
  const mp = mean(rp);
  let cov = 0;
  let varp = 0;
  for (let i = 0; i < rb.length; i++) {
    cov += (rb[i] - mb) * (rp[i] - mp);
    varp += (rp[i] - mp) ** 2;
  }
  if (!(varp > 1e-18)) return null;
  return Math.max(opts.min, Math.min(opts.max, cov / varp));
}
