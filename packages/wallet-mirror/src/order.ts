/**
 * The order of a leader's trades of one coin, across slots and inside a slot. A slot can hold several of the leader's
 * transactions, and the order they arrived in, or a balance rule, cannot always say which came first. Inside a slot:
 *
 *   1. the chain's order, when every trade has its place from a signature list ("rpc");
 *   2. otherwise the trades' own balances: the order in which each trade's before-balance equals the previous one's
 *      after-balance, and, when the leader's balance before the slot is known, the first's before-balance equals it.
 *      Taken when exactly one order fits;
 *   3. otherwise, when several orders fit, the order the notifications arrived in if it is one of them;
 *   4. otherwise unknown (no order fits, which means something moved the balance between the trades, such as a
 *      transfer; or several fit and arrival does not pick one): the caller owes nothing on it and alerts, until the
 *      chain's order arrives from a signature list.
 */
import type { LeaderTradeRow } from "./ledger.ts";

/** Most trades of one coin in one slot ordered by their balances (permutations above this are not tried). */
export const MAX_CHAIN = 8;

const before = (r: LeaderTradeRow) => BigInt(r.held_before);
const after = (r: LeaderTradeRow) => BigInt(r.held_after);

/** Orders whose balances chain (each before = the previous after), at most `cap` of them. */
export function chains(rows: LeaderTradeRow[], cap = 50): LeaderTradeRow[][] {
  const out: LeaderTradeRow[][] = [];
  const used = new Array(rows.length).fill(false);
  const cur: LeaderTradeRow[] = [];
  const dfs = () => {
    if (out.length >= cap) return;
    if (cur.length === rows.length) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      if (used[i]) continue;
      if (cur.length && after(cur[cur.length - 1]) !== before(rows[i])) continue;
      used[i] = true;
      cur.push(rows[i]);
      dfs();
      cur.pop();
      used[i] = false;
    }
  };
  dfs();
  return out;
}

/** One slot's trades (one leader, one coin) in order, or null when the order cannot be known. */
export function orderSlot(rows: LeaderTradeRow[], priorAfter: bigint | null): LeaderTradeRow[] | null {
  if (rows.length <= 1) return [...rows];
  if (rows.every((r) => r.slot_pos_from === "rpc" && r.slot_pos !== null)) return [...rows].sort((a, b) => a.slot_pos! - b.slot_pos!);
  let found = rows.length <= MAX_CHAIN ? chains(rows) : [];
  // The leader's balance before the slot, when known, must start the chain: a chain that does not start there is a
  // false fit (a balance moved between the trades), not an order.
  if (priorAfter !== null) found = found.filter((c) => before(c[0]) === priorAfter);
  if (found.length === 1) return found[0];
  if (found.length > 1 && rows.every((r) => r.slot_pos_from === "arrival" && r.slot_pos !== null)) {
    const arrived = [...rows].sort((a, b) => a.slot_pos! - b.slot_pos!);
    const sig = (c: LeaderTradeRow[]) => c.map((r) => r.signature).join(",");
    if (found.some((c) => sig(c) === sig(arrived))) return arrived;
  }
  return null;
}

/**
 * Every trade from `fromSlot` on (one leader, one coin), in order. `unknownSlot`: the first slot whose order cannot be
 * known; the trades before it are returned in order, nothing from it on.
 */
export function sequence(rows: LeaderTradeRow[], priorAfter: bigint | null): { rows: LeaderTradeRow[]; unknownSlot: number | null } {
  const slots = new Map<number, LeaderTradeRow[]>();
  for (const r of rows) {
    const l = slots.get(r.slot) ?? [];
    l.push(r);
    slots.set(r.slot, l);
  }
  const out: LeaderTradeRow[] = [];
  let prior = priorAfter;
  for (const slot of [...slots.keys()].sort((a, b) => a - b)) {
    const o = orderSlot(slots.get(slot)!, prior);
    if (!o) return { rows: out, unknownSlot: slot };
    out.push(...o);
    prior = after(o[o.length - 1]);
  }
  return { rows: out, unknownSlot: null };
}
