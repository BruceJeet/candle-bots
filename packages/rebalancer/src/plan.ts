/**
 * The rebalancing plan: a pure function, weights and holdings in, orders out. No I/O, no clock.
 *
 * The wallet's value V is its free SOL (balance less the reserve, never under zero) plus each target coin's holding at
 * its price. Each coin's weight is its value over V; SOL's weight is free SOL over V. Coins the config does not name
 * are not counted and never traded.
 *
 *  - **An unpriced coin blocks the plan.** A target coin whose price is unknown (null, zero or not finite) gives no
 *    orders at all, and the plan says which coins blocked it. Never a guess.
 *  - **Bands.** A coin trades only when its weight is off its target by more than `bandPct` percentage points.
 *  - **Sells first.** Overweight coins sell down to their target, the farthest off first, each limited to what the bot
 *    can sell (`sellableRaw`: the tokens its ledger holds for the coin).
 *  - **Buys** go to underweight coins, the farthest off first, up to their target. They are paid from SOL above SOL's
 *    own target less the band, so a buy never takes SOL's weight under its band; the SOL the sells bring counts (at
 *    their value at these prices). Each buy is at most `maxTicketSol`.
 *  - **Caps.** `maxSolPerRun` caps the SOL moved by the whole plan (sells and buys together, at these prices): sells
 *    take it first. An order under `minTradeSol` (after the caps) is dropped, and the plan says so.
 *  - `side` "sell" or "buy" plans one side only (a run plans its sells, waits for them, then plans its buys from the
 *    wallet as it is then, with `budgetSol` the SOL left of `maxSolPerRun`).
 *
 * Amounts: sells in raw tokens (rounded down), buys in lamports (rounded down).
 */

export interface PlanCoin {
  mint: string;
  /** Tokens the wallet holds (raw). */
  raw: bigint;
  /** Tokens the bot can sell (its ledger's lots in the coin, raw). At most `raw` is used. */
  sellableRaw: bigint;
  decimals: number;
  /** SOL per whole token, or null when it cannot be read. */
  priceSol: number | null;
}

export interface PlanInput {
  /** Target weights per coin; with `solWeight` they sum to 1. */
  targets: Record<string, number>;
  solWeight: number;
  solLamports: bigint;
  reserveLamports: bigint;
  coins: PlanCoin[];
  bandPct: number;
  minTradeSol: number;
  maxSolPerRun: number;
  maxTicketSol: number;
  side?: "both" | "sell" | "buy";
  /** The SOL this plan may still move (default maxSolPerRun). */
  budgetSol?: number;
}

export interface PlanRow {
  mint: string;
  valueSol: number;
  weight: number;
  target: number;
  /** weight - target, in percentage points. */
  offPct: number;
  action: "sell" | "buy" | "hold";
}

export interface PlanOrder {
  mint: string;
  side: "sell" | "buy";
  /** The order's value at these prices (SOL). */
  sol: number;
  /** Sells: raw tokens. */
  raw?: bigint;
  /** Buys: lamports. */
  lamports?: bigint;
  why: string;
}

export interface Plan {
  /** Coins that could not be priced: when set, there are no orders. */
  blocked: string[] | null;
  totalSol: number;
  freeSol: number;
  sol: { valueSol: number; weight: number; target: number; offPct: number };
  rows: PlanRow[];
  orders: PlanOrder[];
  dropped: Array<{ mint: string; side: "sell" | "buy"; sol: number; why: string }>;
  movedSol: number;
}

const priced = (p: number | null): p is number => p !== null && Number.isFinite(p) && p > 0;
const LAMPORTS = 1e9;

/** The raw tokens worth `sol` at `price` (rounded down; a value within 1e-6 raw of a whole unit counts as it), at most `max`. */
function rawFor(sol: number, price: number, decimals: number, max: bigint): bigint {
  if (!(sol > 0) || !(price > 0)) return 0n;
  const x = Math.floor((sol / price) * 10 ** decimals + 1e-6);
  const raw = Number.isFinite(x) && x > 0 ? BigInt(x) : 0n;
  return raw > max ? max : raw;
}

export function plan(i: PlanInput): Plan {
  const side = i.side ?? "both";
  const free = i.solLamports > i.reserveLamports ? i.solLamports - i.reserveLamports : 0n;
  const freeSol = Number(free) / LAMPORTS;
  const byMint = new Map(i.coins.map((c) => [c.mint, c]));
  const mints = Object.keys(i.targets);
  const blocked = mints.filter((m) => !priced(byMint.get(m)?.priceSol ?? null));
  const value = (m: string) => {
    const c = byMint.get(m)!;
    return (Number(c.raw) / 10 ** c.decimals) * (c.priceSol as number);
  };
  const empty = (b: string[] | null, total = 0): Plan => ({ blocked: b, totalSol: total, freeSol, sol: { valueSol: freeSol, weight: total > 0 ? freeSol / total : 0, target: i.solWeight, offPct: 0 }, rows: [], orders: [], dropped: [], movedSol: 0 });
  if (blocked.length) return empty(blocked);
  const total = freeSol + mints.reduce((s, m) => s + value(m), 0);
  if (!(total > 0)) return empty(null);
  const band = i.bandPct / 100;
  const rows: PlanRow[] = mints.map((m) => {
    const v = value(m);
    const w = v / total;
    const t = i.targets[m];
    const off = w - t;
    return { mint: m, valueSol: v, weight: w, target: t, offPct: off * 100, action: off > band ? "sell" : off < -band ? "buy" : "hold" };
  });
  const solW = freeSol / total;
  const orders: PlanOrder[] = [];
  const dropped: Plan["dropped"] = [];
  let budget = Math.max(0, i.budgetSol ?? i.maxSolPerRun);
  let solAfter = freeSol;

  // Sells: farthest overweight first, down to the target, within what the bot holds and the budget.
  if (side !== "buy") {
    for (const r of rows.filter((x) => x.action === "sell").sort((a, b) => b.offPct - a.offPct)) {
      const c = byMint.get(r.mint)!;
      const sellable = c.sellableRaw < c.raw ? c.sellableRaw : c.raw;
      const sellableSol = c.raw > 0n ? r.valueSol * (Number(sellable) / Number(c.raw)) : 0;
      let sol = r.valueSol - r.target * total;
      let why = `${r.offPct.toFixed(2)} pp over target`;
      let limit = "";
      if (sol > sellableSol) {
        sol = sellableSol;
        limit = "the tokens the bot holds";
      }
      if (sol > budget) {
        sol = budget;
        limit = "maxSolPerRun";
      }
      if (limit) why += `; limited by ${limit}`;
      if (!(sol > 0) || sol < i.minTradeSol) {
        dropped.push({ mint: r.mint, side: "sell", sol: Math.max(0, sol), why: sol > 0 ? `under minTradeSol ${i.minTradeSol}${limit ? ` (limited by ${limit})` : ""}` : `nothing left: ${limit}` });
        continue;
      }
      const raw = rawFor(sol, c.priceSol as number, c.decimals, sellable);
      if (raw <= 0n) {
        dropped.push({ mint: r.mint, side: "sell", sol, why: "rounds to zero tokens" });
        continue;
      }
      orders.push({ mint: r.mint, side: "sell", sol, raw, why });
      budget -= sol;
      solAfter += sol;
    }
  }

  // Buys: farthest underweight first, up to the target, paid from SOL above SOL's target less the band.
  if (side !== "sell") {
    let funds = Math.max(0, solAfter - Math.max(0, i.solWeight - band) * total);
    for (const r of rows.filter((x) => x.action === "buy").sort((a, b) => a.offPct - b.offPct)) {
      let sol = r.target * total - r.valueSol;
      let why = `${(-r.offPct).toFixed(2)} pp under target`;
      let limit = "";
      if (sol > i.maxTicketSol) {
        sol = i.maxTicketSol;
        limit = "the largest ticket (buy.sol)";
      }
      if (sol > funds) {
        sol = funds;
        limit = "SOL above its own band";
      }
      if (sol > budget) {
        sol = budget;
        limit = "maxSolPerRun";
      }
      if (limit) why += `; limited by ${limit}`;
      if (!(sol > 0) || sol < i.minTradeSol) {
        dropped.push({ mint: r.mint, side: "buy", sol: Math.max(0, sol), why: sol > 0 ? `under minTradeSol ${i.minTradeSol}${limit ? ` (limited by ${limit})` : ""}` : `nothing left: ${limit}` });
        continue;
      }
      // Rounded down; within 1e-6 lamports of a whole one counts as it (0.15 - 0.1 is 0.04999999999999999 in floats).
      const lamports = BigInt(Math.floor(sol * LAMPORTS + 1e-6));
      orders.push({ mint: r.mint, side: "buy", sol, lamports, why });
      budget -= sol;
      funds -= sol;
    }
  }
  return {
    blocked: null,
    totalSol: total,
    freeSol,
    sol: { valueSol: freeSol, weight: solW, target: i.solWeight, offPct: (solW - i.solWeight) * 100 },
    rows,
    orders,
    dropped,
    movedSol: orders.reduce((s, o) => s + o.sol, 0),
  };
}

/** The plan as text: every coin's weight and target, every order and every dropped trade (the `plan` command, the logs). */
export function planText(p: Plan, label: (mint: string) => string = (m) => m): string {
  const out: string[] = [];
  if (p.blocked) {
    out.push(`BLOCKED: no price for ${p.blocked.map(label).join(", ")}; no orders`);
    return out.join("\n");
  }
  const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
  out.push(`wallet value ${p.totalSol.toFixed(6)} SOL (free SOL ${p.freeSol.toFixed(6)})`);
  out.push(`  SOL  ${pct(p.sol.weight)} (target ${pct(p.sol.target)}, ${p.sol.offPct >= 0 ? "+" : ""}${p.sol.offPct.toFixed(2)} pp)`);
  for (const r of p.rows) out.push(`  ${label(r.mint)}  ${r.valueSol.toFixed(6)} SOL  ${pct(r.weight)} (target ${pct(r.target)}, ${r.offPct >= 0 ? "+" : ""}${r.offPct.toFixed(2)} pp) ${r.action}`);
  if (!p.orders.length) out.push("orders: none");
  for (const o of p.orders) out.push(`  ${o.side.toUpperCase()} ${label(o.mint)} ${o.sol.toFixed(6)} SOL${o.raw !== undefined ? ` (${o.raw} raw)` : ""}${o.lamports !== undefined ? ` (${o.lamports} lamports)` : ""}: ${o.why}`);
  for (const d of p.dropped) out.push(`  dropped ${d.side} ${label(d.mint)} ${d.sol.toFixed(6)} SOL: ${d.why}`);
  out.push(`SOL moved: ${p.movedSol.toFixed(6)}`);
  return out.join("\n");
}
