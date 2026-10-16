/**
 * Cryptography for Encrypted Git Sync.
 *
 * Key hierarchy (repository format 2):
 *
 *   passphrase --PBKDF2(salt)--> key-encryption key (KEK)
 *   KEK --AES-GCM--> unwraps the master key stored in meta.json ("wrappedKey")
 *   master key --HKDF--> enc  (AES-256-GCM for file contents and the manifest)
 *                    \-> name (HMAC-SHA256 for non-reversible blob names)
 *
 * The master key never changes, so changing the passphrase only re-wraps it:
 * meta.json is rewritten, nothing else is re-encrypted.
 *
 * Format 1 (older repositories) had no wrapping: the PBKDF2 output *was* the
 * master key. Such repositories still open, and changing their passphrase
 * converts them to format 2 using that same master key, so all existing
 * blobs stay valid.
 *
 * Every encrypted blob has the layout
 *   [version (1 byte) | nonce (12 bytes) | ciphertext + GCM tag (16 bytes)]
 * and is bound to its location via additional authenticated data (AAD).
 */

import { asBuffer, concatBytes, fromBase64, toBase64, toHex, utf8Decode, utf8Encode } from "./encoding";

export const BLOB_FORMAT_VERSION = 1;
export const REPO_FORMAT_VERSION = 2;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;

const NONCE_LENGTH = 12;
const HEADER_LENGTH = 1 + NONCE_LENGTH;
const MASTER_KEY_LENGTH = 32;
const KEY_CHECK_PLAINTEXT = "encrypted-git-sync key check v1";
const KEY_CHECK_AAD = "egs:keycheck";

export interface KdfParams {
  name: "PBKDF2-SHA256";
  iterations: number;
  /** Base64-encoded random salt (16 bytes). Not secret. */
  salt: string;
}

/** Stored in plaintext as meta.json at the repository root. Contains no secrets. */
export interface RepoMeta {
  format: number;
  /**
   * Stable identity of the repository's master key (format 2). Unchanged by a
   * passphrase change; a different id means the repository was re-created.
   */
  repoId?: string;
  kdf: KdfParams;
  /** Format 2: the master key, encrypted with the passphrase-derived key. */
  wrappedKey?: string;
  /** Format 1: an encrypted known string, used to detect a wrong passphrase. */
  keyCheck?: string;
  createdAt: string;
  passphraseChangedAt?: string;
  /**
   * Ids of master keys this repository used before a key rotation, newest
   * first. Lets devices that synced before the rotation keep their sync state
   * instead of treating the repository as re-created.
   */
  previousRepoIds?: string[];
  rotatedAt?: string;
}

export interface VaultKeys {
  enc: CryptoKey;
  name: CryptoKey;
  /** Identity of the master key; see repoIdOf. */
  repoId: string;
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

/**
 * Identity of a repository's master key. Format 1 repositories have no
 * explicit id; their salt plays that role (and is kept as the id on upgrade).
 */
export function repoIdOf(meta: RepoMeta): string {
  return meta.repoId ?? meta.kdf.salt;
}

/** PBKDF2 stretch of the passphrase: 32 bytes. */
export async function stretchPassphrase(passphrase: string, kdf: KdfParams): Promise<Uint8Array> {
  if (kdf.name !== "PBKDF2-SHA256") throw new Error(`Unsupported KDF: ${String(kdf.name)}`);
  if (!passphrase) throw new Error("Passphrase must not be empty.");
  const s = subtle();
  const passKey = await s.importKey("raw", asBuffer(utf8Encode(passphrase.normalize("NFC"))), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await s.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: asBuffer(fromBase64(kdf.salt)), iterations: kdf.iterations },
    passKey,
    256,
  );
  return new Uint8Array(bits);
}

/** Splits the master key into the content and naming keys (unchanged since format 1). */
export async function keysFromMaster(master: Uint8Array, repoId: string): Promise<VaultKeys> {
  const s = subtle();
  const hkdfKey = await s.importKey("raw", asBuffer(master), "HKDF", false, ["deriveKey"]);
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
  return { enc, name, repoId };
}

async function aesGcm(key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return subtle().importKey("raw", asBuffer(key), { name: "AES-GCM" }, false, [usage]);
}

function wrapAad(repoId: string): string {
  return `egs:wrap:${repoId}`;
}

async function wrapMaster(master: Uint8Array, kek: Uint8Array, repoId: string): Promise<string> {
  const nonce = randomBytes(NONCE_LENGTH);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: asBuffer(nonce), additionalData: asBuffer(utf8Encode(wrapAad(repoId))), tagLength: 128 },
    await aesGcm(kek, "encrypt"),
    asBuffer(master),
  );
  return toBase64(concatBytes(new Uint8Array([BLOB_FORMAT_VERSION]), nonce, new Uint8Array(ct)));
}

async function unwrapMaster(wrapped: string, kek: Uint8Array, repoId: string): Promise<Uint8Array> {
  const data = fromBase64(wrapped);
  if (data.length < HEADER_LENGTH + 16 || data[0] !== BLOB_FORMAT_VERSION) throw new WrongPassphraseError();
  try {
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: asBuffer(data.subarray(1, HEADER_LENGTH)),
        additionalData: asBuffer(utf8Encode(wrapAad(repoId))),
        tagLength: 128,
      },
      await aesGcm(kek, "decrypt"),
      asBuffer(data.subarray(HEADER_LENGTH)),
    );
    return new Uint8Array(plain);
  } catch {
    throw new WrongPassphraseError();
  }
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

function newKdf(iterations: number): KdfParams {
  return { name: "PBKDF2-SHA256", iterations, salt: toBase64(randomBytes(16)) };
}

async function wrappedMeta(
  master: Uint8Array,
  repoId: string,
  passphrase: string,
  iterations: number,
  createdAt: string,
): Promise<RepoMeta> {
  const kdf = newKdf(iterations);
  const kek = await stretchPassphrase(passphrase, kdf);
  return {
    format: REPO_FORMAT_VERSION,
    repoId,
    kdf,
    wrappedKey: await wrapMaster(master, kek, repoId),
    createdAt,
  };
}

/** New repository: random master key, wrapped with the passphrase. */
export async function createRepoMeta(
  passphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<{ meta: RepoMeta; keys: VaultKeys }> {
  const master = randomBytes(MASTER_KEY_LENGTH);
  const repoId = toHex(randomBytes(16));
  const meta = await wrappedMeta(master, repoId, passphrase, iterations, new Date().toISOString());
  return { meta, keys: await keysFromMaster(master, repoId) };
}

/** How many previous key ids a rotated meta.json remembers. */
const MAX_PREVIOUS_REPO_IDS = 10;

/**
 * Key rotation: a brand-new random master key (and repoId) for an existing
 * repository. Unlike rewrapRepoMeta, everything must then be re-encrypted
 * with the returned keys; see git/rotateKey.ts.
 */
export async function createRotatedMeta(
  previous: RepoMeta,
  newPassphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
  now = new Date(),
): Promise<{ meta: RepoMeta; keys: VaultKeys }> {
  if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`The new passphrase must have at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const { meta, keys } = await createRepoMeta(newPassphrase, iterations);
  meta.createdAt = previous.createdAt;
  meta.rotatedAt = now.toISOString();
  meta.previousRepoIds = [repoIdOf(previous), ...(previous.previousRepoIds ?? [])].slice(0, MAX_PREVIOUS_REPO_IDS);
  return { meta, keys };
}

/** True if `id` is this repository's current or a previous master key id. */
export function isSameRepository(meta: RepoMeta, id: string): boolean {
  return repoIdOf(meta) === id || (meta.previousRepoIds ?? []).includes(id);
}

/** Recovers the master key with the passphrase (any supported format). */
async function masterKeyFor(meta: RepoMeta, passphrase: string): Promise<Uint8Array> {
  if (meta.format > REPO_FORMAT_VERSION) {
    throw new Error(`Repository format ${meta.format} is newer than this plugin supports. Update the plugin.`);
  }
  const stretched = await stretchPassphrase(passphrase, meta.kdf);
  if (meta.format >= 2) {
    if (!meta.wrappedKey) throw new Error("meta.json has no wrapped key.");
    return unwrapMaster(meta.wrappedKey, stretched, repoIdOf(meta));
  }
  // Format 1: the stretched passphrase is the master key; verify it.
  const keys = await keysFromMaster(stretched, repoIdOf(meta));
  try {
    const check = await decryptBytes(keys, fromBase64(meta.keyCheck ?? ""), KEY_CHECK_AAD);
    if (utf8Decode(check) !== KEY_CHECK_PLAINTEXT) throw new WrongPassphraseError();
  } catch {
    throw new WrongPassphraseError();
  }
  return stretched;
}

/** Derives the keys for an existing repository and verifies the passphrase. */
export async function unlockRepo(meta: RepoMeta, passphrase: string): Promise<VaultKeys> {
  return keysFromMaster(await masterKeyFor(meta, passphrase), repoIdOf(meta));
}

/**
 * Returns meta.json for a new passphrase. The master key and repoId stay the
 * same, so every blob, blob name and device state remains valid. Format 1
 * repositories are upgraded to format 2 in the process.
 */
export async function rewrapRepoMeta(
  meta: RepoMeta,
  oldPassphrase: string,
  newPassphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
  now = new Date(),
): Promise<{ meta: RepoMeta; keys: VaultKeys }> {
  if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`The new passphrase must have at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const master = await masterKeyFor(meta, oldPassphrase);
  const repoId = repoIdOf(meta);
  const next = await wrappedMeta(master, repoId, newPassphrase, iterations, meta.createdAt);
  next.passphraseChangedAt = now.toISOString();
  // Keep rotation history so devices from before a rotation are still recognised.
  if (meta.previousRepoIds) next.previousRepoIds = meta.previousRepoIds;
  if (meta.rotatedAt) next.rotatedAt = meta.rotatedAt;
  return { meta: next, keys: await keysFromMaster(master, repoId) };
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
  const keyMaterial = meta?.format >= 2 ? meta.wrappedKey && meta.repoId : meta?.keyCheck;
  if (typeof meta?.format !== "number" || !meta.kdf?.salt || !keyMaterial) {
    throw new Error("meta.json is missing or malformed; this does not look like an Encrypted Git Sync repository.");
  }
  return meta;
}
