/**
 * The trade rail the executor drives: Candle's linked-payer flow for a TEE wallet, step by step, so the
 * signature can be persisted BEFORE anything is broadcast:
 *    buildTrade (payer linked) -> signLinkedTransaction (our P-256 signer, through Candle's relay)
 *    -> [persist signature] -> submit (Candle broadcasts and confirms)
 * The SDK's one-shot trade() hides the signature until it has been sent, so it is not used here.
 */
import {
  CandleClient,
  EncryptedFileSecretStore,
  InMemorySecretStore,
  type BuildTradeRequest,
  type BuildTradeResult,
  type ExecutedTradeResult,
  type SecretStore,
  type TradeJob,
} from "@candledottv/agent-sdk";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b58encode } from "../solana/base58.ts";
import { addSecret } from "../redact.ts";
import { readCliEntry } from "./cliStore.ts";
import type { Config } from "../config.ts";

export interface TradeRail {
  /** Who pays: a linked TEE wallet (signed here, submitted by Candle) or the embedded wallet (Candle signs and sends inside build). */
  readonly payer: { type: "linked"; linkedWalletId: string } | { type: "main" };
  build(req: BuildTradeRequest): Promise<BuildTradeResult>;
  sign(unsignedTransactionBase64: string): Promise<string>;
  submit(clientTradeId: string, signedTransactionBase64: string): Promise<ExecutedTradeResult>;
  confirm(clientTradeId: string, signature: string): Promise<ExecutedTradeResult>;
  /** The trade's row in Candle's idempotency ledger, or null when the write never began (JOB_NOT_FOUND). */
  job(clientTradeId: string): Promise<TradeJob | null>;
}

/** base58 of a signed transaction's first signature (the fee payer's): its id on chain. */
export function signatureOfSigned(signedBase64: string): string {
  const raw = Buffer.from(signedBase64, "base64");
  // (0.5.0) A v1+ transaction starts with a version byte, not the signature count: refused (nothing is submitted),
  // never read as a wrong signature.
  if (raw.length && raw[0] & 0x80) throw new Error(`signed transaction version ${raw[0] & 0x7f} not read`);
  let n = 0;
  let shift = 0;
  let i = 0;
  for (; i < 3; i++) {
    const x = raw[i];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) break;
    shift += 7;
  }
  i++;
  if (n < 1 || raw.length < i + 64) throw new Error("signed transaction has no signature");
  const sig = raw.subarray(i, i + 64);
  if (sig.every((b) => b === 0)) throw new Error("signed transaction carries an empty signature");
  return b58encode(sig);
}

/** base58 of the recent blockhash inside a signed transaction (legacy or v0 message). */
export function blockhashOfSigned(signedBase64: string): string {
  const raw = Buffer.from(signedBase64, "base64");
  if (raw.length && raw[0] & 0x80) throw new Error(`signed transaction version ${raw[0] & 0x7f} not read`);
  const vec = (at: number): [number, number] => {
    let n = 0, shift = 0, i = at;
    for (; i < at + 3; i++) {
      n |= (raw[i] & 0x7f) << shift;
      if (!(raw[i] & 0x80)) return [n, i + 1];
      shift += 7;
    }
    throw new Error("bad shortvec");
  };
  let [nsig, at] = vec(0);
  at += 64 * nsig;
  if (raw[at] & 0x80) at += 1;      // v0 version prefix
  at += 3;                          // message header
  const [nkeys, after] = vec(at);
  at = after + 32 * nkeys;
  if (raw.length < at + 32) throw new Error("signed transaction too short for a blockhash");
  return b58encode(raw.subarray(at, at + 32));
}

/**
 * (0.5.0) The top-level program ids of a transaction's instructions (legacy or v0; signed or not). Program ids are
 * always static account keys (a v0 lookup table cannot supply one); an index past them throws. Inner calls (CPI) are
 * not visible here: a token's transfer hook, for one, is called by the token program (the mint check covers it).
 */
export function programIdsOf(txBase64: string): string[] {
  const raw = Buffer.from(txBase64, "base64");
  let at = 0;
  const vec = (): number => {
    let n = 0, shift = 0;
    for (let i = 0; i < 3; i++) {
      if (at >= raw.length) throw new Error("transaction truncated");
      const x = raw[at++];
      n |= (x & 0x7f) << shift;
      if (!(x & 0x80)) return n;
      shift += 7;
    }
    throw new Error("bad shortvec");
  };
  // A v1 (and later) transaction starts with its version byte (0x80 | version) before the signatures.
  if (raw.length && raw[0] & 0x80) throw new Error(`transaction version ${raw[0] & 0x7f} not read`);
  const nsig = vec();
  at += 64 * nsig;
  if (at >= raw.length) throw new Error("transaction truncated");
  if (raw[at] & 0x80) {
    if ((raw[at] & 0x7f) !== 0) throw new Error(`transaction version ${raw[at] & 0x7f} not read`);
    at += 1;
  }
  at += 3; // header
  const nkeys = vec();
  const keys: string[] = [];
  for (let i = 0; i < nkeys; i++) {
    if (at + 32 > raw.length) throw new Error("transaction truncated");
    keys.push(b58encode(raw.subarray(at, at + 32)));
    at += 32;
  }
  at += 32; // recent blockhash
  const nix = vec();
  const out = new Set<string>();
  for (let i = 0; i < nix; i++) {
    if (at >= raw.length) throw new Error("transaction truncated");
    const pi = raw[at++];
    if (pi >= keys.length) throw new Error("program id outside the static keys");
    out.add(keys[pi]);
    const na = vec(); // account indexes (vec() moves `at`: read the count first)
    at += na;
    const dl = vec();
    at += dl;
    if (at > raw.length) throw new Error("transaction truncated");
  }
  return [...out];
}

/** (0.5.0) Programs a sell or buy on Candle's routes calls at the top level (ExecutorDeps.knownPrograms' default). */
export const KNOWN_PROGRAMS: readonly string[] = Object.freeze([
  "11111111111111111111111111111111", // System
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated token account
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", // Memo v1
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH", // DFlow aggregator
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
  "6wXTwJwdtA5RhNu6VyYnBzrV51TbsMpTbo5kZv2zdssG", // Candle curve
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
]);

/** A fetch that always carries a timeout (the SDK's own requests have none). */
export function timedFetch(timeoutMs: number, base: typeof fetch = fetch): typeof fetch {
  return ((input: any, init: any = {}) => {
    const t = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, t]) : t;
    return base(input, { ...init, signal });
  }) as typeof fetch;
}

export type ExecFn = (binary: string, args: string[]) => Promise<{ status: number; stdout: string }>;

const execFile: ExecFn = (binary, args) =>
  new Promise((resolve) => {
    try {
      const c = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", () => resolve({ status: 127, stdout: "" }));
      c.on("close", (code) => resolve({ status: code ?? 1, stdout: out }));
    } catch {
      resolve({ status: 127, stdout: "" });
    }
  });

/** base64 PKCS#8 DER (the CLI's single-line form) or PEM -> PEM, checked to be a P-256 private key. */
export function toPem(stored: string): string {
  const pem = stored.includes("BEGIN") ? stored : `-----BEGIN PRIVATE KEY-----\n${stored.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END PRIVATE KEY-----\n`;
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== "ec" || (k.asymmetricKeyDetails as any)?.namedCurve !== "prime256v1") throw new Error("signer key is not P-256");
  return pem;
}

/**
 * The Candle CLI's own signer storage (OS keychain, service tv.candle.cli):
 *  - a TEE wallet bound to the API key signs with the KEY signer (`candle tee signer new --key <prefix>`): keychain
 *    account `key_signer_<keyPrefix>_<spkiSha256>`, indexed in ~/.config/candle/config.json `keySigners.entries`
 *    by keyPrefix and signerQuorumId;
 *  - an imported linked wallet signs with its own wallet signer: account `wallet_signer_<linkedWalletId>`.
 * get(linkedWalletId) returns the key signer when the wallet is the resolved TEE wallet, else the wallet signer.
 * The stored key's public key is checked against the index's spkiSha256. Nothing secret is ever logged.
 *
 * (0.5.0) `file`: the same entries read from the CLI's encrypted file store (credentials.enc; exec/cliStore.ts), with
 * the CLI's keyring passphrase, for a machine with no OS keychain. Read-only, as the keychain backends.
 */
export class CandleCliSignerStore implements SecretStore {
  private exec: ExecFn;
  private backend: "security" | "secret-tool" | "file";
  private configPath: string;
  private file: { credentialsPath: string; passphrase: string } | null;
  private keySigner: { linkedWalletId: string; keyPrefix: string; quorumId: string | null } | null = null;

  constructor(opts: { exec?: ExecFn; backend?: "security" | "secret-tool"; configPath?: string; file?: { credentialsPath: string; passphrase: string } } = {}) {
    this.exec = opts.exec ?? execFile;
    this.file = opts.file ?? null;
    this.backend = this.file ? "file" : opts.backend ?? (process.platform === "darwin" ? "security" : "secret-tool");
    this.configPath = opts.configPath ?? join(homedir(), ".config", "candle", "config.json");
  }

  forTeeWallet(linkedWalletId: string, keyPrefix: string, quorumId: string | null): this {
    this.keySigner = { linkedWalletId, keyPrefix, quorumId };
    return this;
  }

  private async read(account: string): Promise<string | null> {
    if (this.backend === "file") {
      const v = await readCliEntry(this.file!.credentialsPath, this.file!.passphrase, account);
      return v && v.trim() ? v.trim() : null;
    }
    const r = this.backend === "security"
      ? await this.exec("security", ["find-generic-password", "-s", "tv.candle.cli", "-a", account, "-w"])
      : await this.exec("secret-tool", ["lookup", "service", "tv.candle.cli", "account", account]);
    const v = r.stdout.trim();
    return r.status === 0 && v ? v : null;
  }

  async get(walletRef: string): Promise<string | null> {
    if (this.keySigner && walletRef === this.keySigner.linkedWalletId) {
      let entries: any[] = [];
      try {
        entries = JSON.parse(readFileSync(this.configPath, "utf8"))?.keySigners?.entries ?? [];
      } catch {
        return null;
      }
      const ks = this.keySigner;
      const mine = entries.filter((e) => e && e.keyPrefix === ks.keyPrefix && (!ks.quorumId || e.signerQuorumId === ks.quorumId));
      if (mine.length !== 1 || !/^[0-9a-f]{64}$/.test(String(mine[0].spkiSha256))) return null;
      const stored = await this.read(`key_signer_${ks.keyPrefix}_${mine[0].spkiSha256}`);
      if (!stored) return null;
      const pem = toPem(stored);
      addSecret(stored);
      // Every PEM line too (as the env store does): a line quoted alone in an error is masked as well.
      for (const line of pem.split(/\s+/)) if (line.length >= 16 && !line.startsWith("-----")) addSecret(line);
      const spki = createPublicKey(pem).export({ type: "spki", format: "der" });
      if (createHash("sha256").update(spki).digest("hex") !== mine[0].spkiSha256) throw new Error("key signer in the keychain does not match the CLI's index");
      return pem;
    }
    const stored = await this.read(`wallet_signer_${walletRef}`);
    if (!stored) return null;
    addSecret(stored);
    const pem = toPem(stored);
    for (const line of pem.split(/\s+/)) if (line.length >= 16 && !line.startsWith("-----")) addSecret(line);
    return pem;
  }

  async set(): Promise<void> {
    throw new Error("read-only: signers are created with the Candle CLI");
  }

  async delete(): Promise<void> {
    throw new Error("read-only");
  }
}

/** The Candle CLI's config folder for a `candle-cli` signer: configDir, else $CANDLE_CONFIG_DIR, else ~/.config/candle. */
export function cliConfigDir(s: { configDir?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return s.configDir ?? (env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle"));
}

export async function makeSecretStore(cfg: Config, w: ResolvedWallet, env: NodeJS.ProcessEnv = process.env): Promise<SecretStore> {
  const s = cfg.signer;
  if (!s) throw new Error("config.signer is required to trade");
  if (s.store === "keychain") return new CandleCliSignerStore().forTeeWallet(w.linkedWalletId, w.keyPrefix, w.signerQuorumId);
  if (s.store === "candle-cli") {
    const pass = env[s.passphraseEnv];
    if (!pass) throw new Error(`signer.passphraseEnv: ${s.passphraseEnv} is not set`);
    addSecret(pass);
    const dir = cliConfigDir(s, env);
    return new CandleCliSignerStore({ configPath: join(dir, "config.json"), file: { credentialsPath: join(dir, "credentials.enc"), passphrase: pass } }).forTeeWallet(w.linkedWalletId, w.keyPrefix, w.signerQuorumId);
  }
  if (s.store === "file") {
    const pass = env[s.passphraseEnv];
    if (!pass) throw new Error(`signer.passphraseEnv: ${s.passphraseEnv} is not set`);
    addSecret(pass);
    return new EncryptedFileSecretStore(s.path, pass);
  }
  const pem = env[s.pemEnv];
  if (!pem) throw new Error(`signer.pemEnv: ${s.pemEnv} is not set`);
  addSecret(pem);
  for (const line of pem.split(/\s+/)) if (line.length >= 16 && !line.startsWith("-----")) addSecret(line);
  const m = new InMemorySecretStore();
  await m.set(w.linkedWalletId, toPem(pem));
  return m;
}

export interface ResolvedWallet {
  linkedWalletId: string;
  privyWalletId: string;
  keyPrefix: string;
  privyAppId: string;
  signerQuorumId: string | null;
}

/**
 * The TEE wallet this API key may trade from (GET /api/v1/agent/wallets/trading, every page), with the key's prefix
 * and Candle's Privy app id from the same answer. Config pins (linkedWalletId, privyWalletId, privyAppId) must match.
 */
export async function resolveWallet(cfg: Config, apiKey: string, f: typeof fetch = fetch): Promise<ResolvedWallet> {
  const get = async (path: string) => {
    const r = await f(cfg.apiUrl + path, { headers: { "x-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as any;
  };
  const rows: any[] = [];
  let head: any = null;
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const body = await get(`/api/v1/agent/wallets/trading${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    head ??= body;
    rows.push(...(body.page ?? []));
    if (body.isDone !== false || !body.continueCursor) break;
    cursor = body.continueCursor;
  }
  const row = rows.find((r) => r.address === cfg.wallet && r.chain === "solana" && r.active !== false);
  if (!row) throw new Error(`wallet ${cfg.wallet} is not a TEE wallet this API key can trade from (GET /api/v1/agent/wallets/trading)`);
  const id = row.id ?? row._id;
  if (!id || !row.privyWalletId) throw new Error(`wallet ${cfg.wallet}: Candle returned no wallet id or Privy wallet id`);
  const appId = head?.privyAppId ?? cfg.privyAppId;
  if (!appId) throw new Error("Candle returned no privyAppId for this key; set config.privyAppId");
  if (cfg.privyAppId && cfg.privyAppId !== appId) throw new Error("config.privyAppId does not match the one Candle returns for this key");
  if (cfg.linkedWalletId && cfg.linkedWalletId !== id) throw new Error("config.linkedWalletId does not match the wallet's row");
  if (cfg.privyWalletId && cfg.privyWalletId !== row.privyWalletId) throw new Error("config.privyWalletId does not match the wallet's row");
  let quorum: string | null = row.signerQuorumId ?? null;
  if (!quorum) {
    try {
      const all = await get("/api/v1/agent/wallets");
      quorum = (all.page ?? []).find((r: any) => (r._id ?? r.id) === id)?.signerQuorumId ?? null;
    } catch {
      quorum = null;
    }
  }
  return { linkedWalletId: id, privyWalletId: row.privyWalletId, keyPrefix: String(head?.keyPrefix ?? ""), privyAppId: appId, signerQuorumId: quorum };
}

/**
 * The account's embedded wallet: GET /api/v1/agent/wallets/embedded must name `wallet` as its Solana address, and the
 * key must not be denied the wallet (embeddedWalletPermission) nor the wallet undelegated (Candle could not sign).
 */
export async function resolveEmbedded(cfg: Config, apiKey: string, f: typeof fetch = fetch): Promise<{ address: string; permission: string | null }> {
  const r = await f(cfg.apiUrl + "/api/v1/agent/wallets/embedded", { headers: { "x-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GET /api/v1/agent/wallets/embedded: HTTP ${r.status}`);
  const b = (await r.json()) as any;
  const sol = b?.wallets?.solana ?? {};
  if (sol.address !== cfg.wallet) throw new Error(`wallet ${cfg.wallet} is not this API key's embedded Solana wallet (Candle names ${sol.address ?? "none"})`);
  if (b?.embeddedWalletPermission === "denied") throw new Error("this API key is denied the embedded wallet (embeddedWalletPermission: denied)");
  if (sol.delegated === false) throw new Error("the embedded wallet is not delegated: Candle cannot sign for it");
  return { address: sol.address, permission: b?.embeddedWalletPermission ?? null };
}

/** payer main: buildTrade executes the trade inside the call (Candle signs and broadcasts); there is nothing to sign here. */
export class EmbeddedRail implements TradeRail {
  readonly payer = { type: "main" as const };
  private client: CandleClient;
  constructor(client: CandleClient) {
    this.client = client;
  }
  build(req: BuildTradeRequest) {
    return this.client.buildTrade(req);
  }
  async sign(): Promise<string> {
    throw Object.assign(new Error("payer main has nothing to sign"), { code: "NOT_SIGNABLE", status: 400 });
  }
  async submit(): Promise<ExecutedTradeResult> {
    throw Object.assign(new Error("payer main has nothing to submit"), { code: "NOT_SUBMITTABLE", status: 400 });
  }
  confirm(clientTradeId: string, signature: string) {
    return this.client.confirmTrade({ clientTradeId, signature });
  }
  async job(clientTradeId: string) {
    try {
      return await this.client.getTradeJob(clientTradeId);
    } catch (e) {
      if ((e as any)?.code === "JOB_NOT_FOUND") return null;
      throw e;
    }
  }
}

export class SdkRail implements TradeRail {
  readonly payer: { type: "linked"; linkedWalletId: string };
  private client: CandleClient;
  private w: ResolvedWallet;
  constructor(client: CandleClient, wallet: ResolvedWallet) {
    this.client = client;
    this.w = wallet;
    this.payer = { type: "linked", linkedWalletId: wallet.linkedWalletId };
  }
  build(req: BuildTradeRequest) {
    return this.client.buildTrade(req);
  }
  async sign(unsignedTransactionBase64: string) {
    const r = await this.client.signLinkedTransaction({ linkedWalletId: this.w.linkedWalletId, privyWalletId: this.w.privyWalletId, chain: "solana", unsignedTransactionBase64 });
    if (r.encoding && r.encoding !== "base64") throw new Error(`sign relay returned encoding ${r.encoding}`);
    return r.signedTransaction;
  }
  submit(clientTradeId: string, signed: string) {
    return this.client.submit({ clientTradeId, signedTransactions: [signed] });
  }
  confirm(clientTradeId: string, signature: string) {
    return this.client.confirmTrade({ clientTradeId, signature });
  }
  async job(clientTradeId: string) {
    try {
      return await this.client.getTradeJob(clientTradeId);
    } catch (e) {
      if ((e as any)?.code === "JOB_NOT_FOUND") return null;
      throw e;
    }
  }
}
