# Maintaining Encrypted Git Sync

Notes for whoever works on this code next (including future you). Read this
before changing anything in `src/core/crypto.ts`, `src/core/manifest.ts` or the
repository layout: mistakes there can make people's notes unreadable.

## Layout and boundaries

```
src/core/      platform-neutral logic, no Obsidian imports, fully unit-tested
src/git/       Git operations on the encrypted "shadow" repository
src/obsidian/  adapters to Obsidian's API (vault, HTTP, secrets, dialogs)
src/main.ts    wiring: commands, timers, notices, session key
src/cli/       recovery tool (Node), shares src/core with the plugin
tests/         unit tests + end-to-end tests against a real `git http-backend`
```

Rule of thumb: if it can be tested without Obsidian, it belongs in `src/core`
or `src/git`. `main.ts` should only orchestrate.

## Invariants (do not break)

1. **Blob format** `[version | nonce | ciphertext+tag]` with the blob path as
   AAD. Changing it needs a new `BLOB_FORMAT_VERSION` and code that still reads
   the old one.
2. **HKDF info strings** `egs/v1/enc` and `egs/v1/name` in `keysFromMaster`.
   Changing them changes every key and every blob path. Never edit them.
3. **Blob paths** are `HMAC(name key, "path:" + NFC(path))`. Changing this
   orphans every existing blob.
4. **meta.json** contains no secrets. Formats: 1 (passphrase is the key,
   `keyCheck`), 2 (random master key in `wrappedKey`, `repoId`). Every plugin
   version must keep reading every older format.
5. **repoId** identifies the master key. Passphrase change: same repoId.
   Key rotation: new repoId, old one added to `previousRepoIds`. Devices compare
   it (via `isSameRepository`) to tell a rotation from a wiped remote.
6. **Never delete local files because the remote "lost" them** unless the base
   state says this device synced them. The planner and the remote-reset check
   in `syncEngine.ts` enforce this; keep the e2e tests for it green.
7. **Sync state is saved only after a successful push.** Otherwise a failed
   push would make the next sync think remote files were deleted.
8. **Mobile:** `main.js` may only `require("obsidian")`. No Node built-ins, no
   regex lookbehind, no `structuredClone`. `tests/bundle.test.ts` checks this.

## Changing the repository format

1. Bump `REPO_FORMAT_VERSION` in `crypto.ts`.
2. Teach `parseRepoMeta` and `masterKeyFor` the new format; keep the old paths.
3. Older plugins refuse newer formats with a clear message
   (`unlockRepo` checks `meta.format`). Note in the README which version is
   needed on all devices before the new format is written.
4. Add a fixture for the old format in `tests/helpers/legacy.ts` and an e2e
   test that an old repository keeps working and upgrades.

## Operations that rewrite the remote

| Operation          | File                      | History        | Push           |
|--------------------|---------------------------|----------------|----------------|
| Sync               | `core/syncEngine.ts`      | appends        | normal, retried |
| Squash             | `git/squash.ts`           | rewritten      | force + lease  |
| Change passphrase  | `git/changePassphrase.ts` | appends        | normal, retried |
| Rotate key         | `git/rotateKey.ts`        | replaced (1 commit) | force + lease |

"Lease" means: compare the remote head right before the force-push with the
head the operation started from, and abort if it moved. isomorphic-git has no
`--force-with-lease`, so this check is done by hand.

## Testing

```sh
npm test          # everything (needs `git` with http-backend on PATH)
npm run lint      # Obsidian's official review rules; keep 0 errors
npx vitest run tests/sync.e2e.test.ts -t "rotation"   # one area
```

End-to-end tests run several simulated devices (`Device` in
`tests/sync.e2e.test.ts`) against a real Git server. Add a scenario there for
any bug that involved more than one device.

The automated directory review does not allow `eslint-disable` comments for
Obsidian rules; fix the code instead.

## Releasing

```sh
npm version patch|minor|major   # updates manifest.json and versions.json, tags
git push --follow-tags          # GitHub Actions lints, tests, builds, releases
```

Never move or reuse a tag that has been released: BRAT and Nix users pin by
version and hash. If `minAppVersion` changes, update it in `manifest.json`
before running `npm version`.
