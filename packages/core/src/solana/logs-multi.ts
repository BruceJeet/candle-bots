/**
 * (0.6.0) Many logsSubscribe subscriptions (one address each, `mentions`) on one websocket, for per-coin trade logs.
 *
 * - Every address is subscribed on (re)connect; a subscription the server refuses or does not confirm within
 *   `confirmMs` is reported (onGap) and retried on the next connect.
 * - `maxSubscriptions` caps what one socket holds (the public RPC held 100 cleanly in a probe on Nov 5 2026; the default
 *   is half that). Addresses past the cap are reported, never silently dropped.
 * - Removing addresses does not wait on logsUnsubscribe (the public RPC left them unanswered in the probe): it sends
 *   them and stops delivering for those addresses. When more than half the held addresses go, the socket is rebuilt;
 *   so is it once `maxUnansweredUnsubscribes` are left unanswered (each may hold a subscription on the server's side).
 * - `resubscribe(address)` subscribes one address again in place (no rebuild).
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
  /**
   * logsUnsubscribe requests left unanswered past confirmMs (each may leave a server-side subscription toward the
   * server's cap) before the socket is rebuilt, which drops them all (default 20).
   */
  maxUnansweredUnsubscribes?: number;
  now?: () => number;
}

export interface MultiLogsSocket {
  /** Set the addresses to watch. Returns those held and those left out by the cap. */
  set(addresses: string[]): { held: string[]; overCap: string[] };
  /**
   * (0.6.0) Subscribe one held address again on this socket (its old subscription released): no rebuild, no gap for
   * the others. Its gap ("subscribing") ends on the new confirmation.
   */
  resubscribe?(address: string): void;
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
  /** logsUnsubscribe request id -> when sent; unanswered ones past confirmMs are counted. */
  const unsubPending = new Map<number, number>();
  let unanswered = 0;
  const maxUnanswered = o.maxUnansweredUnsubscribes ?? 20;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const clearConnectTimer = () => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
  };

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
    unsubPending.clear();
    unanswered = 0;
    for (const t of tries.values()) t.nextAt = 0;
    try {
      ws = new WS(url);
    } catch (e) {
      schedule(`connect: ${(e as Error).name}`);
      return;
    }
    // A socket that never opens (and never closes) would leave no ping and no stall check: give up on it. Only while
    // it is still connecting or stuck closing: a socket that opened or closed has its own handlers, and the timer is
    // cleared by both (one live loop: a closed socket's reconnect is already scheduled by its onclose).
    const mine = ws;
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      // Connecting (0), or stuck closing (2: a close whose onclose never fires; onclose clears this timer when it does).
      if (!closed && ws === mine && (mine.readyState === 0 || mine.readyState === 2)) {
        for (const a of want) openGap(a, "reconnect", lastMsg);
        teardown("connect timeout");
      }
    }, o.connectTimeoutMs ?? 15_000);
    connectTimer.unref?.();
    ws.onopen = () => {
      if (ws !== mine) return;
      clearConnectTimer();
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
        // Unsubscribes the server never answered: each may still hold a subscription on its side. Past the limit, a
        // fresh socket drops them all (every coin gets a short reconnect gap, as on any reconnect).
        for (const [id, at] of unsubPending) if (t - at > confirmMs) {
          unsubPending.delete(id);
          unanswered++;
        }
        if (unanswered >= maxUnanswered) {
          for (const a of want) openGap(a, "reconnect");
          teardown(`${unanswered} unsubscribes unanswered`);
          return;
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
      if (ws !== mine) return;
      lastMsg = now();
      let msg: any;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer).toString());
      } catch {
        return;
      }
      if (typeof msg.id === "number" && unsubPending.delete(msg.id)) return; // an unsubscribe answered
      if (typeof msg.id === "number" && pendingReq.has(msg.id)) {
        const p = pendingReq.get(msg.id)!;
        pendingReq.delete(msg.id);
        if (typeof msg.result === "number" && want.includes(p.address) && subId.has(p.address)) {
          // Already subscribed (a late answer to an earlier request was taken): release this second one.
          release(msg.result);
        } else if (typeof msg.result === "number" && want.includes(p.address)) {
          subId.set(p.address, msg.result);
          bySub.set(msg.result, p.address);
          tries.delete(p.address);
          closeGap(p.address);
        } else if (subId.has(p.address)) {
          // A refused retry for an address already subscribed (its late answer came first): nothing is missing.
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
          } else release(msg.result);
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
      if (ws !== mine) return; // a socket we already left: its close must not touch the live one
      clearConnectTimer();
      if (ping) clearInterval(ping);
      ping = null;
      setUp(false, "closed");
      // Nothing was heard after lastMsg: the gap starts there.
      for (const a of want) openGap(a, "reconnect", lastMsg);
      schedule("closed");
    };
  };

  const release = (id: number) => {
    if (!ws || ws.readyState !== 1) return;
    const rid = ++reqId;
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method: "logsUnsubscribe", params: [id] }));
      unsubPending.set(rid, now());
    } catch {
      /* closing */
    }
  };

  /** Drop this socket without waiting for its onclose (detached), then reconnect. */
  const teardown = (why: string) => {
    clearConnectTimer();
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
    // One reconnect pending at most: a second schedule replaces the first (never two loops).
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
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
        if (id !== undefined && !rebuild) release(id);
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
    resubscribe(a) {
      if (closed || !want.includes(a)) return;
      const id = subId.get(a);
      subId.delete(a);
      if (id !== undefined) {
        bySub.delete(id);
        release(id);
      }
      // A request still pending for it: its answer is an orphan to release (late).
      for (const [rid, p] of [...pendingReq]) if (p.address === a) {
        pendingReq.delete(rid);
        late.set(rid, a);
      }
      tries.delete(a);
      openGap(a, "subscribing");
      if (!queue.includes(a)) queue.push(a);
      void pumpQueue();
    },
    held: () => [...want],
    isUp: () => up,
    close() {
      closed = true;
      clearConnectTimer();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ping) clearInterval(ping);
      try {
        ws?.close();
      } catch {
        /* closing */
      }
    },
  };
}
