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
  const openGap = (a: string, reason: string) => {
    if (gapOpen.has(a)) return;
    gapOpen.add(a);
    h.onGapStart?.(a, reason, now());
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
    try {
      ws = new WS(url);
    } catch (e) {
      schedule(`connect: ${(e as Error).name}`);
      return;
    }
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
          openGap(p.address, "subscription not confirmed");
        }
        if (t - lastMsg > stallMs) {
          setUp(false, "stalled");
          try {
            ws?.close();
          } catch {
            /* closing */
          }
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
          closeGap(p.address);
        } else openGap(p.address, `subscription refused${msg.error ? `: ${String(msg.error.message ?? "").slice(0, 80)}` : ""}`);
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
      for (const a of want) openGap(a, "reconnect");
      schedule("closed");
    };
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
