/**
 * (0.5.0) Mint accounts and the junk check run before a bot adopts (or sells) a coin it did not buy. Pure, no I/O.
 *
 * SPL Token mint (82 bytes): mint_authority COption<Pubkey> @0 (tag u32 + 32), supply u64 @36, decimals u8 @44,
 * is_initialized @45, freeze_authority COption<Pubkey> @46. Token-2022 pads the base to 165 bytes, then the account
 * type (1 = mint) @165 and the extensions as TLV from @166: type u16, length u16, value.
 *
 * The check refuses (returns why) a mint whose transfers a wallet does not control or that would make a sell sign
 * another program's code. Refused: a transfer hook with a program set, a permanent delegate, non-transferable, default
 * account state frozen, a paused mint, confidential-transfer extensions, a transfer fee over the cap (either epoch's),
 * any extension type this check does not know, a mint not owned by a token program, an uninitialised mint. Allowed:
 * metadata and group pointers and their data, a mint close authority, interest-bearing and scaled UI amounts (display
 * only: raw amounts, which the ledger uses, are unchanged), a transfer hook or a pause switch that is not set (their
 * authority could set one later: a bot re-checks before each sell).
 */
import { b58encode } from "../solana/base58.ts";
import { DecodeError, type AccountValue } from "./curve.ts";
import { TOKEN_2022, TOKEN_PROGRAM } from "./pump.ts";

export const EXT = {
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  DefaultAccountState: 6,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  PermanentDelegate: 12,
  TransferHook: 14,
  ConfidentialTransferFeeConfig: 16,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  TokenGroup: 21,
  GroupMemberPointer: 22,
  TokenGroupMember: 23,
  ConfidentialMintBurn: 24,
  ScaledUiAmount: 25,
  Pausable: 26,
} as const;

const NAMES = new Map<number, string>(Object.entries(EXT).map(([k, v]) => [v, k]));

export interface MintExtension {
  type: number;
  name: string;
  /** The fields the check reads (base58 keys, bps, flags). */
  fields: Record<string, unknown>;
}

export interface MintInfo {
  program: "token" | "token-2022";
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: MintExtension[];
}

const ZERO = "11111111111111111111111111111111";

function optKey(b: Uint8Array, at: number): string | null {
  const k = b58encode(b.subarray(at, at + 32));
  return k === ZERO ? null : k;
}

export function decodeMint(v: AccountValue | null | undefined): MintInfo {
  if (!v) throw new DecodeError("mint_missing");
  if (v.owner !== TOKEN_PROGRAM && v.owner !== TOKEN_2022) throw new DecodeError("mint_owner");
  const d = v.data;
  if (!Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new DecodeError("mint_layout");
  const b = new Uint8Array(Buffer.from(d[0], "base64"));
  if (b.length < 82) throw new DecodeError("mint_layout");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[45] !== 1) throw new DecodeError("mint_uninitialized");
  const info: MintInfo = {
    program: v.owner === TOKEN_2022 ? "token-2022" : "token",
    decimals: b[44],
    supply: dv.getBigUint64(36, true),
    mintAuthority: dv.getUint32(0, true) === 1 ? b58encode(b.subarray(4, 36)) : null,
    freezeAuthority: dv.getUint32(46, true) === 1 ? b58encode(b.subarray(50, 82)) : null,
    extensions: [],
  };
  if (b.length === 82) return info;
  if (info.program !== "token-2022" || b.length < 166 || b[165] !== 1) throw new DecodeError("mint_layout");
  let at = 166;
  while (at + 4 <= b.length) {
    const type = dv.getUint16(at, true);
    const len = dv.getUint16(at + 2, true);
    if (type === 0 && len === 0) break; // uninitialised padding
    if (at + 4 + len > b.length) throw new DecodeError("mint_layout");
    const val = b.subarray(at + 4, at + 4 + len);
    const vv = new DataView(val.buffer, val.byteOffset, val.byteLength);
    const fields: Record<string, unknown> = {};
    const need = (n: number) => {
      if (len < n) throw new DecodeError("mint_layout");
    };
    switch (type) {
      case EXT.TransferFeeConfig:
        need(108);
        fields.olderBps = vv.getUint16(88, true);
        fields.newerBps = vv.getUint16(106, true);
        fields.newerEpoch = vv.getBigUint64(90, true);
        fields.authority = optKey(val, 0);
        break;
      case EXT.DefaultAccountState:
        need(1);
        fields.state = val[0];
        break;
      case EXT.PermanentDelegate:
        need(32);
        fields.delegate = optKey(val, 0);
        break;
      case EXT.TransferHook:
        need(64);
        fields.authority = optKey(val, 0);
        fields.program = optKey(val, 32);
        break;
      case EXT.Pausable:
        need(33);
        fields.authority = optKey(val, 0);
        fields.paused = val[32] !== 0;
        break;
      case EXT.MintCloseAuthority:
        need(32);
        fields.authority = optKey(val, 0);
        break;
      default:
        break;
    }
    info.extensions.push({ type, name: NAMES.get(type) ?? `unknown_${type}`, fields });
    at += 4 + len;
  }
  return info;
}

/** Display-only or descriptive extensions: never change who controls a transfer or what a sell signs. */
const BENIGN = new Set<number>([EXT.MintCloseAuthority, EXT.MetadataPointer, EXT.TokenMetadata, EXT.GroupPointer, EXT.TokenGroup, EXT.GroupMemberPointer, EXT.TokenGroupMember, EXT.InterestBearingConfig, EXT.ScaledUiAmount]);

export interface JunkOptions {
  /** Highest transfer fee (bps, either epoch's config) a coin may carry. Default 0: any transfer fee refuses. */
  maxTransferFeeBps?: number;
}

/** Why this mint must not be adopted or sold by a bot, or null when it is a plain transferable token. */
export function junkReason(m: MintInfo, opts: JunkOptions = {}): string | null {
  const cap = opts.maxTransferFeeBps ?? 0;
  for (const e of m.extensions) {
    if (BENIGN.has(e.type)) continue;
    switch (e.type) {
      case EXT.TransferFeeConfig: {
        const bps = Math.max(Number(e.fields.olderBps), Number(e.fields.newerBps));
        if (bps > cap) return `transfer_fee ${bps} bps > ${cap}`;
        continue;
      }
      case EXT.TransferHook:
        if (e.fields.program) return `transfer_hook ${e.fields.program}`;
        continue;
      case EXT.PermanentDelegate:
        if (e.fields.delegate) return `permanent_delegate ${e.fields.delegate}`;
        continue;
      case EXT.DefaultAccountState:
        if (e.fields.state === 2) return "default_account_state_frozen";
        continue;
      case EXT.Pausable:
        if (e.fields.paused) return "paused";
        continue;
      case EXT.NonTransferable:
        return "non_transferable";
      case EXT.ConfidentialTransferMint:
      case EXT.ConfidentialTransferFeeConfig:
      case EXT.ConfidentialMintBurn:
        return `confidential (${e.name})`;
      default:
        return `extension ${e.name}`;
    }
  }
  return null;
}
