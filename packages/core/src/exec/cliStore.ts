/**
 * (0.5.0) Read-only access to the Candle CLI's encrypted file store (`credentials.enc`), where the CLI keeps signers
 * on a machine with no OS keychain (Linux without `secret-tool`).
 *
 * Format (Candle CLI 0.13.9; the same as @candledottv/agent-sdk's EncryptedFileSecretStore, whose writer "mirrors the
 * CLI's secret-store.ts"): one JSON object; each entry `{ salt, iv, ciphertext, iterations }`, base64, a key from
 * PBKDF2-HMAC-SHA256(passphrase, salt, iterations) and AES-GCM-256 (12-byte IV, the tag appended to the ciphertext).
 *
 * Fail closed: a file that is not that object, an entry of any other shape (other fields, other sizes, an iteration
 * count out of range) or one that does not decrypt (a wrong passphrase: AES-GCM's tag check) is an error, never a
 * guess. Nothing here writes the file. No error or log names the passphrase.
 */
import { readFileSync } from "node:fs";

export class CliStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliStoreError";
  }
}

/** What this version knows of the format. */
export const CLI_STORE_FORMAT = Object.freeze({ fields: ["ciphertext", "iterations", "iv", "salt"], saltBytes: 16, ivBytes: 12, minIterations: 100_000, maxIterations: 10_000_000, tagBytes: 16 });

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function b64(v: unknown, what: string, ref: string): Uint8Array<ArrayBuffer> {
  if (typeof v !== "string" || !B64.test(v) || v.length % 4 !== 0) throw new CliStoreError(`credentials.enc entry "${ref}": ${what} is not base64 (a format this version does not know)`);
  const buf = Buffer.from(v, "base64");
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

/** The store's JSON object (refused unless it is a plain object of entries). */
function readStore(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    throw new CliStoreError(code === "ENOENT" ? `no Candle CLI store at ${path}` : `cannot read the Candle CLI store at ${path} (${code ?? "error"})`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new CliStoreError(`the Candle CLI store at ${path} is not JSON (a format this version does not know)`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new CliStoreError(`the Candle CLI store at ${path} is not an object of entries (a format this version does not know)`);
  return obj as Record<string, unknown>;
}

/** The names of the entries (no values decrypted): for picking a signer by its name. */
export function cliStoreRefs(path: string): string[] {
  return Object.keys(readStore(path));
}

/**
 * One entry, decrypted. Null when the store has no entry by that name. Throws CliStoreError for a store or an entry it
 * cannot read, including a wrong passphrase.
 */
export async function readCliEntry(path: string, passphrase: string, ref: string): Promise<string | null> {
  if (!passphrase) throw new CliStoreError("no Candle CLI keyring passphrase given");
  const store = readStore(path);
  if (!Object.hasOwn(store, ref)) return null;
  const e = store[ref];
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new CliStoreError(`credentials.enc entry "${ref}" is not an object (a format this version does not know)`);
  const keys = Object.keys(e).sort();
  if (keys.join(",") !== CLI_STORE_FORMAT.fields.join(",")) throw new CliStoreError(`credentials.enc entry "${ref}" has fields ${keys.join(", ")}; this version knows ${CLI_STORE_FORMAT.fields.join(", ")} only`);
  const o = e as Record<string, unknown>;
  const it = o.iterations;
  if (typeof it !== "number" || !Number.isInteger(it) || it < CLI_STORE_FORMAT.minIterations || it > CLI_STORE_FORMAT.maxIterations) throw new CliStoreError(`credentials.enc entry "${ref}": iterations ${String(it)} out of the range this version knows`);
  const salt = b64(o.salt, "salt", ref);
  const iv = b64(o.iv, "iv", ref);
  const ct = b64(o.ciphertext, "ciphertext", ref);
  if (salt.length !== CLI_STORE_FORMAT.saltBytes || iv.length !== CLI_STORE_FORMAT.ivBytes || ct.length <= CLI_STORE_FORMAT.tagBytes) throw new CliStoreError(`credentials.enc entry "${ref}": salt, iv or ciphertext of a size this version does not know`);
  let plain: ArrayBuffer;
  try {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: it, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    // Never the passphrase, never the cause's text (WebCrypto's messages are generic, but nothing of the input is echoed).
    throw new CliStoreError(`could not decrypt "${ref}" in ${path}: the keyring passphrase is wrong for this file, or the entry is damaged`);
  }
  return new TextDecoder().decode(plain);
}

const FP_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The CLI's signer fingerprint (`CNDL-XXXX-XXXX-XXXX`) from the SPKI's SHA-256 (64 lowercase hex): the first 15 hex
 * digits as 60 bits, 12 base32 characters (Crockford's alphabet), in three groups. Candle CLI 0.13.9 `EZ()`.
 */
export function cliFingerprint(spkiSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(spkiSha256)) throw new Error("cliFingerprint: spkiSha256 must be 64 lowercase hex");
  const bits = Array.from(spkiSha256.slice(0, 15), (h) => Number.parseInt(h, 16).toString(2).padStart(4, "0")).join("");
  let out = "";
  for (let i = 0; i < 60; i += 5) out += FP_ALPHABET[Number.parseInt(bits.slice(i, i + 5), 2)];
  return `CNDL-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}
