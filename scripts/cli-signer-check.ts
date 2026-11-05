/**
 * A no-spend check of a `candle-cli` signer, offline: no network call, no Candle command, nothing written.
 *
 *   node --conditions=source scripts/cli-signer-check.ts --key-prefix <prefix> [--quorum <signerQuorumId>]
 *        [--config-dir <dir>] [--passphrase-env CANDLE_KEYRING_PASSPHRASE] [--expect CNDL-XXXX-XXXX-XXXX] [--json]
 *
 * Run from a candle-bots checkout, with the keyring passphrase in the named environment variable (for example under a
 * wrapper that loads it into this one process). It:
 *   1. reads the Candle CLI's signer index (config.json keySigners.entries) for the key prefix and picks one signer
 *      (by --quorum, or the only one);
 *   2. loads that signer from the CLI's encrypted file store through the core's candle-cli store (the same code a bot
 *      runs), which checks its public key against the index;
 *   3. prints its CNDL fingerprint (and compares it with the index and --expect);
 *   4. signs a fixed test payload (ECDSA P-256 / SHA-256, the primitive the SDK's authorization signature uses) and
 *      verifies the signature with the public key.
 * It never prints the key or the passphrase. Exit 0 only when every step passes; 1 when a check fails; 2 on bad usage.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CandleCliSignerStore, cliConfigDir } from "candle-bot-core/exec/trader";
import { cliFingerprint } from "candle-bot-core/exec/cliStore";
import { addSecret, redact } from "candle-bot-core/redact";

export interface CheckResult {
  ok: boolean;
  keyPrefix: string;
  configDir: string;
  indexEntries: number;
  fingerprint?: string;
  indexFingerprint?: string | null;
  expected?: string | null;
  signatureVerifies?: boolean;
  failure?: string;
}

function args(argv: string[]): Record<string, string | true> {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === "json") o.json = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`);
      o[k] = v;
    }
  }
  return o;
}

export async function check(opts: { keyPrefix: string; quorum?: string; configDir?: string; passphraseEnv: string; expect?: string }, env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const dir = cliConfigDir(opts.configDir ? { configDir: opts.configDir } : {}, env);
  const out: CheckResult = { ok: false, keyPrefix: opts.keyPrefix, configDir: dir, indexEntries: 0 };
  let entries: any[];
  try {
    entries = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))?.keySigners?.entries ?? [];
  } catch (e) {
    return { ...out, failure: `cannot read the CLI's signer index in ${join(dir, "config.json")} (${(e as NodeJS.ErrnoException).code ?? "not JSON"})` };
  }
  const mine = entries.filter((e) => e && e.keyPrefix === opts.keyPrefix && (!opts.quorum || e.signerQuorumId === opts.quorum));
  out.indexEntries = mine.length;
  if (mine.length !== 1) return { ...out, failure: mine.length ? `${mine.length} signers for key ${opts.keyPrefix} in the index; give --quorum` : `no signer for key ${opts.keyPrefix}${opts.quorum ? ` with quorum ${opts.quorum}` : ""} in the index` };
  const entry = mine[0];
  out.indexFingerprint = typeof entry.fingerprint === "string" ? entry.fingerprint : null;
  const pass = env[opts.passphraseEnv];
  if (!pass) return { ...out, failure: `${opts.passphraseEnv} is not set` };
  addSecret(pass);
  const store = new CandleCliSignerStore({ configPath: join(dir, "config.json"), file: { credentialsPath: join(dir, "credentials.enc"), passphrase: pass } }).forTeeWallet("signer-check", opts.keyPrefix, entry.signerQuorumId ?? null);
  let pem: string | null;
  try {
    pem = await store.get("signer-check");
  } catch (e) {
    return { ...out, failure: redact(String((e as Error).message)).split(pass).join("***") };
  }
  if (!pem) return { ...out, failure: `no signer entry for key ${opts.keyPrefix} in ${join(dir, "credentials.enc")}` };
  const pub = createPublicKey(createPrivateKey(pem));
  const spki = createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
  out.fingerprint = cliFingerprint(spki);
  out.expected = opts.expect ?? null;
  if (out.indexFingerprint && out.indexFingerprint !== out.fingerprint) return { ...out, failure: `fingerprint ${out.fingerprint} is not the index's ${out.indexFingerprint}` };
  if (opts.expect && opts.expect !== out.fingerprint) return { ...out, failure: `fingerprint ${out.fingerprint} is not the expected ${opts.expect}` };
  const payload = Buffer.from(JSON.stringify({ check: "candle-cli signer", keyPrefix: opts.keyPrefix, nonce: createHash("sha256").update(String(Date.now())).digest("hex") }));
  const sig = sign("sha256", payload, createPrivateKey(pem));
  out.signatureVerifies = verify("sha256", payload, pub, sig);
  if (!out.signatureVerifies) return { ...out, failure: "the signature does not verify with the signer's public key" };
  return { ...out, ok: true };
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, write = (s: string) => process.stdout.write(s)): Promise<number> {
  let o: Record<string, string | true>;
  try {
    o = args(argv);
  } catch (e) {
    write(`${(e as Error).message}\n`);
    return 2;
  }
  if (typeof o["key-prefix"] !== "string") {
    write("usage: cli-signer-check.ts --key-prefix <prefix> [--quorum <id>] [--config-dir <dir>] [--passphrase-env <NAME>] [--expect CNDL-…] [--json]\n");
    return 2;
  }
  const r = await check({ keyPrefix: o["key-prefix"], quorum: typeof o.quorum === "string" ? o.quorum : undefined, configDir: typeof o["config-dir"] === "string" ? o["config-dir"] : undefined, passphraseEnv: typeof o["passphrase-env"] === "string" ? o["passphrase-env"] : "CANDLE_KEYRING_PASSPHRASE", expect: typeof o.expect === "string" ? o.expect : undefined }, env);
  if (o.json) write(JSON.stringify(r) + "\n");
  else {
    write(`key ${r.keyPrefix}, CLI config ${r.configDir}, index entries ${r.indexEntries}\n`);
    if (r.fingerprint) write(`signer fingerprint ${r.fingerprint}${r.indexFingerprint ? ` (index: ${r.indexFingerprint})` : ""}${r.expected ? ` (expected: ${r.expected})` : ""}\n`);
    if (r.signatureVerifies !== undefined) write(`test signature verifies: ${r.signatureVerifies ? "yes" : "NO"}\n`);
    write(r.ok ? "OK\n" : `FAILED: ${r.failure}\n`);
  }
  return r.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
