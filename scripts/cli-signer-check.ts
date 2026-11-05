/**
 * A no-spend check of a `candle-cli` signer, offline: no network call, no Candle command, nothing written.
 *
 *   node --conditions=source scripts/cli-signer-check.ts --key-prefix <prefix> [--quorum <signerQuorumId>]
 *        [--config-dir <dir>] [--passphrase-env CANDLE_KEYRING_PASSPHRASE] [--expect CNDL-XXXX-XXXX-XXXX] [--json]
 *
 * Run from a candle-bots checkout, with the keyring passphrase in the named environment variable (for example under a
 * wrapper that loads it into this one process). It:
 *   1-2. selects and loads the signer exactly as a bot would: the core's makeSecretStore with a candle-cli signer
 *      config (--expect as its fingerprint pin, --quorum as the wallet's signer quorum; with neither it refuses, as the
 *      bot does), which checks the public key against the CLI's index;
 *   3. prints its CNDL fingerprint (and compares it with the index and --expect);
 *   4. signs a fixed test payload (ECDSA P-256 / SHA-256, the primitive the SDK's authorization signature uses) and
 *      verifies the signature with the public key.
 * It never prints the key or the passphrase. Exit 0 only when every step passes; 1 when a check fails; 2 on bad usage.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cliConfigDir, makeSecretStore } from "candle-bot-core/exec/trader";
import type { Config } from "candle-bot-core/config";
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

export async function check(opts: { keyPrefix: string; quorum?: string; configDir?: string; passphraseEnv: string; expect?: string }, env: NodeJS.ProcessEnv = process.env): Promise<CheckResult & { warnings: string[] }> {
  const dir = cliConfigDir(opts.configDir ? { configDir: opts.configDir } : {}, env);
  const warnings: string[] = [];
  const out: CheckResult & { warnings: string[] } = { ok: false, keyPrefix: opts.keyPrefix, configDir: dir, indexEntries: 0, warnings };
  let entries: any[] = [];
  try {
    entries = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))?.keySigners?.entries ?? [];
  } catch (e) {
    return { ...out, failure: `cannot read the CLI's signer index in ${join(dir, "config.json")} (${(e as NodeJS.ErrnoException).code ?? "not JSON"})` };
  }
  out.indexEntries = entries.filter((e) => e && e.keyPrefix === opts.keyPrefix).length;
  const pass = env[opts.passphraseEnv];
  if (pass) addSecret(pass);
  // The bot's own selection, not a copy of it: makeSecretStore with the same signer config a bot would carry (--expect
  // is the fingerprint pin, --quorum stands for the signer quorum Candle gives the wallet). So an OK here proves the
  // bot would load this signer, and every refusal is the bot's (no quorum and no pin, a passphrase under 8 characters,
  // an ambiguous index, a mismatch).
  const cfg = { signer: { store: "candle-cli", passphraseEnv: opts.passphraseEnv, configDir: dir, ...(opts.expect ? { fingerprint: opts.expect } : {}) } } as unknown as Config;
  const ref = "signer-check";
  let pem: string | null;
  try {
    const store = await makeSecretStore(cfg, { linkedWalletId: ref, privyWalletId: "", keyPrefix: opts.keyPrefix, privyAppId: "", signerQuorumId: opts.quorum ?? null }, env, (m) => warnings.push(m));
    pem = await store.get(ref);
  } catch (e) {
    const msg = redact(String((e as Error).message));
    // A passphrase under 8 characters is refused (never used), and masking it could garble ordinary words.
    return { ...out, failure: pass && pass.length >= 8 ? msg.split(pass).join("***") : msg };
  }
  if (!pem) return { ...out, failure: `no signer for key ${opts.keyPrefix}` };
  const pub = createPublicKey(createPrivateKey(pem));
  const spki = createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
  out.fingerprint = cliFingerprint(spki);
  out.expected = opts.expect ?? null;
  const entry = entries.find((e) => e && e.keyPrefix === opts.keyPrefix && e.spkiSha256 === spki);
  out.indexFingerprint = entry && typeof entry.fingerprint === "string" ? entry.fingerprint : null;
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
    for (const w of r.warnings) write(`warning: ${w}\n`);
    write(r.ok ? "OK\n" : `FAILED: ${r.failure}\n`);
  }
  return r.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
