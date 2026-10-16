/** Fixtures that reproduce data written by older plugin versions. */
import {
  encryptBytes,
  keysFromMaster,
  randomBytes,
  stretchPassphrase,
  type KdfParams,
  type RepoMeta,
  type VaultKeys,
} from "../../src/core/crypto";
import { toBase64, utf8Encode } from "../../src/core/encoding";

/** Builds meta.json exactly as plugin version 0.1.0 did (repository format 1). */
export async function createFormat1Meta(passphrase: string, iterations = 1_000): Promise<{ meta: RepoMeta; keys: VaultKeys }> {
  const kdf: KdfParams = { name: "PBKDF2-SHA256", iterations, salt: toBase64(randomBytes(16)) };
  const keys = await keysFromMaster(await stretchPassphrase(passphrase, kdf), kdf.salt);
  const keyCheck = await encryptBytes(keys, utf8Encode("encrypted-git-sync key check v1"), "egs:keycheck");
  return { meta: { format: 1, kdf, keyCheck: toBase64(keyCheck), createdAt: new Date().toISOString() }, keys };
}
