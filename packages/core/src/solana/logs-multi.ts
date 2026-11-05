/**
 * (0.6.0) Many logsSubscribe subscriptions (one address each, `mentions`) on one websocket, for per-coin trade logs.
 *
 * - Every address is subscribed on (re)connect; a subscription the server refuses or does not confirm within
 *   `confirmMs` is reported (onGap) and retried on the next connect.
 * - `maxSubscriptions` caps what one socket holds (the public RPC held 100 cleanly in a probe on Nov 5 2026; the default
 *   is half that). Addresses past the cap are reported, never silently dropped.
 * - Removing addresses does not wait on logsUnsubscribe (the public RPC left them unanswered in the probe): it sends
 *   them and stops delivering for those addresses. When more than half the held addresses go, the socket is rebuilt.
 * - Down (closed, refused, stalled: no message, not even a ping reply, for `stallMs`): reconnect with backoff; every
 *   held address gets a gap from the moment it went down to the moment its subscription is confirmed again.
 * Failed transactions are delivered with their `err` (the caller drops them before counting volume).
 */
export interface MultiLogsEvent {
  address: string;
  signature: string;
  err: unknown;
  logs: string[];
  slot: number;
}

export interface MultiLogsHandlers {
  onLogs: (e: MultiLogsEvent) => void;
  /** An address's logs are not being seen from `from` (ms) until it is confirmed again; `reason` says why. */
  onGapStart?: (address: string, reason: string, at: number) => void;
  /** The address's subscription is confirmed (again): its gap, if any, ends here. */
  onGapEnd?: (address: string, at: number) => void;
  onState?: (up: boolean, why?: string) => void;
  /** An address's subscription has failed (refused or unconfirmed) this many times in a row; it keeps retrying. */
  onTrouble?: (address: string, tries: number, why: string) => void;
}

export interface MultiLogsOptions {
  WebSocketImpl?: typeof WebSocket;
  maxSubscriptions?: number;
  commitment?: "confirmed" | "finalized";
  maxBackoffMs?: number;
  pingMs?: number;
  stallMs?: number;
  confirmMs?: number;
  /** Gap between subscribe requests, ms (polite pacing). */
  paceMs?: number;
  /** A socket that has not opened by then is dropped and reconnected (ms, default 15 s). */
  connectTimeoutMs?: number;
  /** Failed subscriptions in a row before onTrouble (default 3). */
  troubleAfter?: number;
  now?: () => number;
}

export interface MultiLogsSocket {
  /** Set the addresses to watch. Returns those held and those left out by the cap. */
  set(addresses: string[]): { held: string[]; overCap: string[] };
  held(): string[];
  isUp(): boolean;
  close(): void;
}

export const DEFAULT_MAX_SUBSCRIPTIONS = 50;

export function multiLogs(url: string, h: MultiLogsHandlers, o: MultiLogsOptions = {}): MultiLogsSocket {
  const WS = o.WebSocketImpl ?? WebSocket;
  const now = o.now ?? Date.now;
  const cap = o.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
  const commitment = o.commitment ?? "confirmed";
  const stallMs = o.stallMs ?? 90_000;
  const confirmMs = o.confirmMs ?? 15_000;
  const paceMs = o.paceMs ?? 100;
  const troubleAfter = o.troubleAfter ?? 3;
  /** Failed subscription attempts per address (refused or unconfirmed), and when the next try is due. */
  const tries = new Map<string, { n: number; nextAt: number }>();
  /** Requests we stopped waiting for: a late answer is accepted if still wanted, else unsubscribed. */
  const late = new Map<number, string>();
  const failed = (a: string, why: string) => {
    if (!want.includes(a)) return; // an address no longer wanted: nothing to retry, no gap to open
    const t = tries.get(a) ?? { n: 0, nextAt: 0 };
    t.n++;
    t.nextAt = now() + Math.min(60_000, 2_000 * 2 ** Math.min(t.n, 5));
    tries.set(a, t);
    openGap(a, why);
    if (t.n >= troubleAfter) h.onTrouble?.(a, t.n, why);
  };
  let want: string[] = [];
  /** address -> server subscription id (confirmed on this socket). */
  const subId = new Map<string, number>();
  const bySub = new Map<number, string>();
  /** request id -> address waiting for confirmation. */
  const pendingReq = new Map<number, { address: string; at: number }>();
  /** Addresses whose gap is open. */
  const gapOpen = new Set<string>();
  let ws: WebSocket | null = null;
  let up = false;
  let closed = false;
  let failures = 0;
  let reqId = 1000;
  let lastMsg = now();
  let ping: ReturnType<typeof setInterval> | null = null;
  let queue: string[] = [];
  let pumping = false;

  const setUp = (v: boolean, why?: string) => {
    if (v !== up) {
      up = v;
      h.onState?.(v, why);
    }
  };
  const openGap = (a: string, reason: string, at = now()) => {
    if (gapOpen.has(a)) return;
    gapOpen.add(a);
    h.onGapStart?.(a, reason, at);
  };
  const closeGap = (a: string) => {
    if (!gapOpen.delete(a)) return;
    h.onGapEnd?.(a, now());
  };

  const pumpQueue = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && ws && ws.readyState === 1 && !closed) {
        const a = queue.shift()!;
        if (!want.includes(a) || subId.has(a)) continue;
        const id = ++reqId;
        pendingReq.set(id, { address: a, at: now() });
        try {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [a] }, { commitment }] }));
        } catch {
          pendingReq.delete(id);
          break;
        }
        if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
      }
    } finally {
      pumping = false;
    }
  };

  const connect = () => {
    if (closed) return;
    subId.clear();
    bySub.clear();
    pendingReq.clear();
    late.clear();
    for (const t of tries.values()) t.nextAt = 0;
    try {
      ws = new WS(url);
    } catch (e) {
      schedule(`connect: ${(e as Error).name}`);
      return;
    }
    // A socket that never opens (and never closes) would leave no ping and no stall check: give up on it.
    const mine = ws;
    setTimeout(() => {
      if (!closed && ws === mine && mine.readyState !== 1) {
        for (const a of want) openGap(a, "reconnect", lastMsg);
        teardown("connect timeout");
      }
    }, o.connectTimeoutMs ?? 15_000);
    ws.onopen = () => {
      failures = 0;
      setUp(true);
      lastMsg = now();
      queue = [...want];
      void pumpQueue();
      if (ping) clearInterval(ping);
      ping = setInterval(() => {
        const t = now();
        // Unconfirmed subscriptions past confirmMs: a gap for that address (retried on the next connect).
        for (const [id, p] of pendingReq) if (t - p.at > confirmMs) {
          pendingReq.delete(id);
          late.set(id, p.address);
          if (late.size > 1000) late.delete(late.keys().next().value as number);
          failed(p.address, "subscription not confirmed");
        }
        // Retry, with backoff, what is wanted but not subscribed (refused, unconfirmed) while the socket stays up.
        const pendingAddrs = new Set([...pendingReq.values()].map((p) => p.address));
        const retry = want.filter((a) => !subId.has(a) && !pendingAddrs.has(a) && !queue.includes(a) && (tries.get(a)?.nextAt ?? Infinity) <= t);
        if (retry.length) {
          queue.push(...retry);
          void pumpQueue();
        }
        if (t - lastMsg > stallMs) {
          // A stalled socket heard nothing since lastMsg: the gap starts there, not now. Torn down at once (a
          // half-open connection's onclose can come minutes late, or never) and reconnected.
          for (const a of want) openGap(a, "stalled", lastMsg);
          teardown("stalled");
          return;
        }
        try {
          ws?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }));
        } catch {
          /* the close handler reconnects */
        }
      }, o.pingMs ?? 15_000);
    };
    ws.onmessage = (m: MessageEvent) => {
      lastMsg = now();
      let msg: any;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer).toString());
      } catch {
        return;
      }
      if (typeof msg.id === "number" && pendingReq.has(msg.id)) {
        const p = pendingReq.get(msg.id)!;
        pendingReq.delete(msg.id);
        if (typeof msg.result === "number" && want.includes(p.address)) {
          subId.set(p.address, msg.result);
          bySub.set(msg.result, p.address);
          tries.delete(p.address);
          closeGap(p.address);
        } else failed(p.address, `subscription refused${msg.error ? `: ${String(msg.error.message ?? "").slice(0, 80)}` : ""}`);
        return;
      }
      if (typeof msg.id === "number" && late.has(msg.id)) {
        // An answer after we stopped waiting: kept if the address is still wanted and unsubscribed, else released.
        const a = late.get(msg.id)!;
        late.delete(msg.id);
        if (typeof msg.result === "number") {
          if (want.includes(a) && !subId.has(a)) {
            subId.set(a, msg.result);
            bySub.set(msg.result, a);
            tries.delete(a);
            closeGap(a);
          } else {
            try {
              ws?.send(JSON.stringify({ jsonrpc: "2.0", id: ++reqId, method: "logsUnsubscribe", params: [msg.result] }));
            } catch {
              /* closing */
            }
          }
        }
        return;
      }
      if (msg.method === "logsNotification") {
        const sub = msg.params?.subscription;
        const a = bySub.get(sub);
        const v = msg.params?.result?.value;
        if (!a || !want.includes(a) || !v || typeof v.signature !== "string") return;
        h.onLogs({ address: a, signature: v.signature, err: v.err ?? null, logs: Array.isArray(v.logs) ? v.logs : [], slot: msg.params?.result?.context?.slot ?? 0 });
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      ping = null;
      setUp(false, "closed");
      // Nothing was heard after lastMsg: the gap starts there.
      for (const a of want) openGap(a, "reconnect", lastMsg);
      schedule("closed");
    };
  };

  /** Drop this socket without waiting for its onclose (detached), then reconnect. */
  const teardown = (why: string) => {
    if (ping) clearInterval(ping);
    ping = null;
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* closing */
      }
    }
    setUp(false, why);
    schedule(why);
  };

  const schedule = (why: string) => {
    if (closed) return;
    failures++;
    const delay = Math.min(o.maxBackoffMs ?? 30_000, 500 * 2 ** Math.min(failures, 8)) * (0.5 + Math.random() / 2);
    setUp(false, why);
    setTimeout(connect, delay);
  };

  connect();

  return {
    set(addresses) {
      const uniq = [...new Set(addresses)];
      const held = uniq.slice(0, cap);
      const overCap = uniq.slice(cap);
      const gone = want.filter((a) => !held.includes(a));
      const rebuild = want.length > 0 && gone.length > want.length / 2;
      // A removed address whose subscription is still pending: its answer, when it comes, is an orphan to release.
      for (const [id, p] of [...pendingReq]) if (gone.includes(p.address)) {
        pendingReq.delete(id);
        late.set(id, p.address);
      }
      for (const a of gone) tries.delete(a);
      for (const a of gone) {
        const id = subId.get(a);
        subId.delete(a);
        if (id !== undefined) bySub.delete(id);
        gapOpen.delete(a);
        if (id !== undefined && ws && ws.readyState === 1 && !rebuild) {
          try {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++reqId, method: "logsUnsubscribe", params: [id] }));
          } catch {
            /* closing */
          }
        }
      }
      const added = held.filter((a) => !want.includes(a));
      want = held;
      for (const a of added) openGap(a, "subscribing");
      if (rebuild && ws) {
        // Many removals: a fresh socket is cheaper than many unanswered unsubscribes.
        try {
          ws.close();
        } catch {
          /* closing */
        }
      } else {
        queue.push(...added);
        void pumpQueue();
      }
      return { held, overCap };
    },
    held: () => [...want],
    isUp: () => up,
    close() {
      closed = true;
      if (ping) clearInterval(ping);
      try {
        ws?.close();
      } catch {
        /* closing */
      }
    },
  };
}
