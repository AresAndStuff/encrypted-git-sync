/**
 * Changes the repository passphrase.
 *
 * Only meta.json changes: the master key is re-wrapped with the new
 * passphrase. Notes, blob names and every device's sync state stay valid.
 * Other devices notice on their next sync: a remembered old passphrase no
 * longer works, so they ask for the new one.
 *
 * Older commits still contain the previous meta.json, which the old
 * passphrase can open. Changing the passphrase is therefore not enough if the
 * old one leaked; see the README.
 */

import { parseRepoMeta, rewrapRepoMeta, type RepoMeta, type VaultKeys } from "../core/crypto";
import { utf8Decode, utf8Encode } from "../core/encoding";
import { META_PATH } from "../core/syncEngine";
import { PushRejectedError, type ShadowRepo } from "./shadowRepo";

export interface ChangePassphraseOptions {
  /** PBKDF2 iterations for the new passphrase (default: the current default). */
  iterations?: number;
  now?: () => number;
  maxAttempts?: number;
  onProgress?: (message: string) => void;
}

export interface ChangePassphraseResult {
  head: string;
  meta: RepoMeta;
  keys: VaultKeys;
  /** True if a format 1 repository was converted to format 2. */
  upgraded: boolean;
}

export async function changeRepoPassphrase(
  repo: ShadowRepo,
  oldPassphrase: string,
  newPassphrase: string,
  options: ChangePassphraseOptions = {},
): Promise<ChangePassphraseResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const now = options.now ?? (() => Date.now());
  await repo.ensureInitialized();

  for (let attempt = 1; ; attempt++) {
    options.onProgress?.("Fetching…");
    const head = await repo.fetch();
    if (!head) throw new Error("The remote repository is empty. Sync once before changing the passphrase.");

    const tree = await repo.readTreeMap(head);
    const metaOid = tree.get(META_PATH);
    if (!metaOid) throw new Error("meta.json is missing; this does not look like an Encrypted Git Sync repository.");
    const current = parseRepoMeta(utf8Decode(await repo.readBlob(metaOid)));

    options.onProgress?.("Re-wrapping the key…");
    const { meta, keys } = await rewrapRepoMeta(
      current,
      oldPassphrase,
      newPassphrase,
      options.iterations,
      new Date(now()),
    );

    tree.set(META_PATH, await repo.writeBlob(utf8Encode(JSON.stringify(meta, null, 2) + "\n")));
    const commit = await repo.writeCommit(await repo.writeTreeMap(tree), head, "change passphrase", now());

    try {
      options.onProgress?.("Pushing…");
      await repo.push(commit);
      return { head: commit, meta, keys, upgraded: current.format < meta.format };
    } catch (e) {
      // Another device synced in between: start over on top of its commit.
      if (!(e instanceof PushRejectedError) || attempt >= maxAttempts) throw e;
    }
  }
}
