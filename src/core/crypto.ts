/**
 * Cryptography for Encrypted Git Sync.
 *
 * - The passphrase is stretched with PBKDF2-SHA256 (salt stored in the repo).
 * - HKDF splits the result into two independent keys:
 *     enc  - AES-256-GCM for file contents and the manifest
 *     name - HMAC-SHA256 for deterministic, non-reversible blob names
 * - Every encrypted blob has the layout
 *     [version (1 byte) | nonce (12 bytes) | ciphertext + GCM tag (16 bytes)]
 *   and is bound to its location via additional authenticated data (AAD),
 *   so blobs cannot be swapped between paths without detection.
 */

import { asBuffer, concatBytes, fromBase64, toBase64, toHex, utf8Decode, utf8Encode } from "./encoding";

export const BLOB_FORMAT_VERSION = 1;
export const REPO_FORMAT_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

const NONCE_LENGTH = 12;
const HEADER_LENGTH = 1 + NONCE_LENGTH;
const KEY_CHECK_PLAINTEXT = "encrypted-git-sync key check v1";
const KEY_CHECK_AAD = "egs:keycheck";

export interface KdfParams {
  name: "PBKDF2-SHA256";
  iterations: number;
  /** Base64-encoded random salt (16 bytes). Not secret. */
  salt: string;
}

/** Stored in plaintext as meta.json at the repository root. */
export interface RepoMeta {
  format: number;
  kdf: KdfParams;
  /** Base64 of an encrypted known string, used to detect a wrong passphrase. */
  keyCheck: string;
  createdAt: string;
}

export interface VaultKeys {
  enc: CryptoKey;
  name: CryptoKey;
  /** Salt the keys were derived with; used to detect a re-keyed repository. */
  salt: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase for this repository.");
    this.name = "WrongPassphraseError";
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

function subtle(): SubtleCrypto {
  const c = typeof crypto === "undefined" ? undefined : crypto;
  if (!c?.subtle) throw new Error("Web Crypto API is not available in this environment.");
  return c.subtle;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export async function deriveKeys(passphrase: string, kdf: KdfParams): Promise<VaultKeys> {
  if (kdf.name !== "PBKDF2-SHA256") throw new Error(`Unsupported KDF: ${String(kdf.name)}`);
  if (!passphrase) throw new Error("Passphrase must not be empty.");

  const s = subtle();
  const passKey = await s.importKey("raw", asBuffer(utf8Encode(passphrase.normalize("NFC"))), "PBKDF2", false, [
    "deriveBits",
  ]);
  const master = await s.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: asBuffer(fromBase64(kdf.salt)), iterations: kdf.iterations },
    passKey,
    256,
  );
  const hkdfKey = await s.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: asBuffer(utf8Encode(info)),
  });

  const enc = await s.deriveKey(hkdf("egs/v1/enc"), hkdfKey, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const name = await s.deriveKey(hkdf("egs/v1/name"), hkdfKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
    "sign",
  ]);
  return { enc, name, salt: kdf.salt };
}

export async function encryptBytes(keys: VaultKeys, plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: asBuffer(nonce), additionalData: asBuffer(utf8Encode(aad)), tagLength: 128 },
    keys.enc,
    asBuffer(plaintext),
  );
  return concatBytes(new Uint8Array([BLOB_FORMAT_VERSION]), nonce, new Uint8Array(ciphertext));
}

export async function decryptBytes(keys: VaultKeys, data: Uint8Array, aad: string): Promise<Uint8Array> {
  if (data.length < HEADER_LENGTH + 16) throw new DecryptionError("Encrypted blob is too short.");
  const version = data[0];
  if (version !== BLOB_FORMAT_VERSION) {
    throw new DecryptionError(`Unsupported blob format version ${version}. Update the plugin.`);
  }
  const nonce = data.subarray(1, HEADER_LENGTH);
  const ciphertext = data.subarray(HEADER_LENGTH);
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: asBuffer(nonce), additionalData: asBuffer(utf8Encode(aad)), tagLength: 128 },
      keys.enc,
      asBuffer(ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    throw new DecryptionError(`Could not decrypt "${aad}": wrong key or tampered data.`);
  }
}

export async function createRepoMeta(
  passphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<{ meta: RepoMeta; keys: VaultKeys }> {
  const kdf: KdfParams = { name: "PBKDF2-SHA256", iterations, salt: toBase64(randomBytes(16)) };
  const keys = await deriveKeys(passphrase, kdf);
  const keyCheck = await encryptBytes(keys, utf8Encode(KEY_CHECK_PLAINTEXT), KEY_CHECK_AAD);
  const meta: RepoMeta = {
    format: REPO_FORMAT_VERSION,
    kdf,
    keyCheck: toBase64(keyCheck),
    createdAt: new Date().toISOString(),
  };
  return { meta, keys };
}

/** Derives keys for an existing repository and verifies the passphrase. */
export async function unlockRepo(meta: RepoMeta, passphrase: string): Promise<VaultKeys> {
  if (meta.format > REPO_FORMAT_VERSION) {
    throw new Error(`Repository format ${meta.format} is newer than this plugin supports. Update the plugin.`);
  }
  const keys = await deriveKeys(passphrase, meta.kdf);
  try {
    const check = await decryptBytes(keys, fromBase64(meta.keyCheck), KEY_CHECK_AAD);
    if (utf8Decode(check) !== KEY_CHECK_PLAINTEXT) throw new WrongPassphraseError();
  } catch {
    throw new WrongPassphraseError();
  }
  return keys;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", asBuffer(data));
  return toHex(new Uint8Array(digest));
}

/**
 * Deterministic storage location for a vault path. Stable across devices and
 * syncs (so unchanged files keep their blob), but reveals nothing about the path.
 */
export async function blobPathFor(keys: VaultKeys, vaultPath: string): Promise<string> {
  const mac = await subtle().sign("HMAC", keys.name, asBuffer(utf8Encode(`path:${vaultPath.normalize("NFC")}`)));
  const hex = toHex(new Uint8Array(mac));
  return `blobs/${hex.slice(0, 2)}/${hex.slice(2)}`;
}

export function parseRepoMeta(text: string): RepoMeta {
  const meta = JSON.parse(text) as RepoMeta;
  if (typeof meta?.format !== "number" || !meta.kdf?.salt || !meta.keyCheck) {
    throw new Error("meta.json is missing or malformed; this does not look like an Encrypted Git Sync repository.");
  }
  return meta;
}
