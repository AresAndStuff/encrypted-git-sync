# Encrypted Git Sync for Obsidian

End-to-end encrypted vault sync through any Git host (GitHub, GitLab, Gitea, a bare
repository on your server), on desktop **and** mobile. The Git host only ever stores
ciphertext: note contents, file names and folder structure are all encrypted.

Your vault stays plain Markdown on every device, so search, graph view and other
plugins keep working as usual.

> **Beta.** This plugin syncs your notes and can delete or overwrite files as part
> of syncing. Keep a separate backup of your vault while trying it.

## Network use

This plugin connects **only to the Git repository URL you enter in its settings**,
over HTTPS, to download and upload the encrypted repository. Everything it sends
is encrypted on your device first, apart from the repository's `README.md` and
`meta.json` (which contain no note data). It needs an access token for that
repository, which you create with your Git host (for example GitHub or GitLab);
that may require an account with that host.

There is no telemetry, no analytics and no other server. The plugin does not read
or write files outside your vault; its local Git data is kept in Obsidian's own
browser storage (IndexedDB).

## How it works

```
Vault (plaintext) ──scan & hash──► Sync engine ──encrypt──► shadow repo ──push──► Git host
        ▲                         (3-way plan)              (bare, objects only)       │
        └──────── write ◄──decrypt◄── merge ◄────────── fetch ◄────────────────────────┘
```

* **Shadow repository.** A bare Git repository stored in IndexedDB (via
  `lightning-fs`), separate from the vault. The plugin writes Git objects directly,
  so ciphertext is never duplicated as files. Git is used for transport and history.
* **Encrypted manifest.** `manifest.enc` maps real paths to content hashes. It is
  compressed and encrypted, so the host does not learn file names or structure.
* **Blob names.** Each file is stored at `blobs/xx/<HMAC(path)>`: stable across
  syncs and devices, but not reversible.
* **Three-way sync.** For every file, the plugin compares what this device last
  synced (*base*), the vault (*local*) and the manifest (*remote*):
  * changed on one side: take that side;
  * changed on both: line-based three-way merge in plaintext; if the same lines
    were changed differently, both versions are kept as
    `Note (conflict 2026-10-15 0741 phone).md`;
  * edited on one side, deleted on the other: the edit wins;
  * deleted files leave a tombstone (kept 90 days), so a device restored from an
    old backup does not resurrect them.
* **Only changed files are re-encrypted.** Unchanged notes keep their blob, so a
  sync without edits pushes nothing.

### Repository layout (what the Git host sees)

```
README.md        plaintext note that this repo is encrypted
meta.json        format version, KDF parameters, salt, wrapped key (no secrets)
manifest.enc     encrypted, compressed file list
blobs/3f/9a1c…   one encrypted blob per file
```

## Cryptography

| Purpose          | Algorithm                                                           |
|------------------|---------------------------------------------------------------------|
| Master key       | Random 256-bit key, created once per repository                      |
| Passphrase       | PBKDF2-HMAC-SHA256, 600,000 iterations, random 128-bit salt; the result encrypts (wraps) the master key with AES-256-GCM in `meta.json` |
| Key separation   | HKDF-SHA256 from the master key into an encryption key and a naming key |
| Content          | AES-256-GCM, random 96-bit nonce per blob                            |
| Blob binding     | Blob path is authenticated data, so blobs cannot be swapped          |
| Names            | HMAC-SHA256 of the vault path (Unicode-normalised)                   |
| Integrity        | SHA-256 of the plaintext is checked against the manifest on download |

Blob format: `[version: 1 byte][nonce: 12 bytes][ciphertext + 16-byte tag]`.
All crypto uses the Web Crypto API, available in Obsidian on every platform.

**What is still visible to the host:** the number of files, their approximate
sizes, and when syncs happen. Content, names and folders are not.

## Setup

1. Create an **empty private** repository on your Git host. (A repository with
   other branches works too; the plugin uses its own branch.)
2. Create a personal access token with read/write access to that repository
   (GitHub: fine-grained token, "Contents: read and write").
3. In Obsidian: Settings → Encrypted Git Sync
   * Repository URL: `https://github.com/you/vault-sync.git`
   * Username: your username (GitHub accepts any non-empty value with a token,
     GitLab accepts `oauth2`)
   * Access token: paste it
   * Device name: e.g. `laptop`, `phone`
   * Click **Test**.
4. Run **Sync now** (ribbon icon or command palette). On the first sync you choose
   the encryption passphrase. **Use at least 12 characters and store it in a
   password manager. If you lose it, the synced data cannot be recovered.**
5. On every other device, install the plugin, enter the same repository and token,
   and sync. You will be asked for the passphrase.

The access token and (optionally) the passphrase are stored in Obsidian's secret
storage on each device (or the vault's local storage on older Obsidian versions),
never in `data.json`, which lives inside the vault folder.

## History and repository size

Encrypted files do not delta-compress, so every saved version of a file costs its
full size. Two features keep the repository small:

* **Debounced syncing** (`Sync after editing`) avoids storing every autosave.
* **Automatic squashing** thins out history with a retention policy (default):
  * the 5 newest versions of today
  * the last version of each of the last 7 days
  * the last version of each of the last 4 weeks
  * the last version of each of the last 12 months

  That is at most about 29 snapshots, however old the vault is. Squashing
  rewrites the branch and force-pushes, with a check that no other device pushed
  in the meantime. Other devices continue seamlessly. Some hosts (including
  GitHub) free the space of dropped versions only after their own garbage
  collection runs.

For local version history of individual notes, Obsidian's core File Recovery
plugin works alongside this plugin.

## What is synced

* Notes (`.md`) and canvases (`.canvas`) by default.
* Attachments when **Sync attachments** is on, up to the size limit (default 20 MB;
  most hosts reject files over 100 MB).
* Never: the `.obsidian` folder, dot-folders, and anything matching the ignore
  patterns (default: `.trash/**`, `.DS_Store`, `Thumbs.db`).

## Safety nets

* A wrong passphrase is detected before anything is touched.
* If a sync would delete more than half of the tracked files (and more than 10),
  the plugin asks first.
* If the remote repository was wiped or re-created, the device treats itself as
  new instead of deleting local files.
* Deleted files go to Obsidian's trash (respecting your trash setting).
* **Recovery without Obsidian:**

  ```sh
  git clone --branch encrypted-main https://github.com/you/vault-sync.git encrypted
  node dist/recover.mjs encrypted ./recovered-vault
  ```

  The passphrase is read from `EGS_PASSPHRASE` or asked for. Keep a copy of
  `dist/recover.mjs` somewhere safe.

## Going back to earlier versions

Every sync stores a full snapshot of the vault, so you can jump back:

* **One note:** right-click a file and choose **Version history**, or run
  **Show version history of current file**. Pick a version, look at the
  preview, then **Restore this version** or **Restore as copy**
  (creates `Note (version 2026-10-20 1403).md` next to it).
* **The whole vault:** run **Restore vault to an earlier version** and pick a
  point in time. You see how many files will be restored and how many moved to
  the trash before anything happens. Files excluded from sync are not touched.

A restore is an ordinary change: it is synced as a new version and reaches your
other devices. Nothing in the history is rewritten, so you can always jump back
to the state from before the restore. The plugin syncs before showing the
history, so your current state is always one of the versions.

Which versions exist depends on history squashing (default: 5 from today, one
per day for 7 days, one per week for 4 weeks, one per month for 12 months).
For finer-grained undo of a single note, Obsidian's core File Recovery plugin
works alongside this.

## Changing the passphrase

Run **Change encryption passphrase** (command palette, or the *Change* button in
settings). You enter the current passphrase and the new one twice.

Your notes are not re-encrypted: they are protected by a random master key, and
the passphrase only protects that key. Changing it rewrites `meta.json` and
nothing else, so it takes a second and the history does not grow. Other devices
keep their sync state; on their next sync they report a wrong passphrase and ask
for the new one.

**If the old passphrase leaked, this is not enough.** Older commits still contain
the previous `meta.json`, and the old passphrase opens it, which reveals the
master key. Use **Rotate encryption key** instead (below).

**Upgrading from 0.1.0:** update the plugin on **all** devices before changing
the passphrase. Repositories created with 0.1.0 use repository format 1, which
keeps working; changing the passphrase converts it to format 2, which 0.1.0
cannot read.

## Rotating the encryption key

Run **Rotate encryption key** (command palette, or *Rotate key* in settings) if
your passphrase or a device may be compromised. It:

* syncs first, then creates a new random master key protected by a new passphrase;
* re-encrypts every synced file (blob names change too);
* replaces the remote history with a single commit and force-pushes it, after
  checking that no other device pushed in the meantime.

Other devices ask for the new passphrase on their next sync and then continue
with their sync state intact; nothing is re-downloaded. Older versions in the
history are gone, so you lose the squash snapshots.

The Git host may keep the old, unreachable objects for some time (GitHub can
still serve a commit by its id). For a hard guarantee, move to a new repository
instead: create a new empty private repository, enter its URL on every device,
sync from the device with the most complete vault first (it asks for a new
passphrase), then sync the others, and delete the old repository. Do not
`git clone --mirror` the old one: a mirror can include old commits.

## Commands

* **Sync now**
* **Squash history now**
* **Show version history of current file** (also *Version history* in the file menu)
* **Restore vault to an earlier version**
* **Change encryption passphrase**
* **Rotate encryption key (re-encrypt everything)**
* **Forget passphrase on this device**
* **Reset this device's sync state**: forgets the local sync history and repository
  cache. Notes are not touched; the next sync compares everything afresh.

## Limitations

* HTTPS with a token only. `isomorphic-git` does not support SSH.
* Large vaults with many attachments are slow on mobile, especially the first sync.
* Renames are synced as delete plus add.
* Files are not padded, so approximate sizes are visible to the host.

## Releasing

```sh
npm version patch      # bumps package.json, manifest.json, versions.json; commits and tags
git push --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which lints, builds, tests
and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`.

## Development

See [MAINTAINING.md](MAINTAINING.md) for the architecture, invariants and how
to change the repository format safely.

```sh
npm install
npm run lint        # Obsidian's official plugin lint rules (eslint-plugin-obsidianmd)
npm test            # unit tests + end-to-end tests against a real Git HTTP server
npm run build       # typecheck, then main.js and dist/recover.mjs
npm run dev         # watch mode
```

To try it, copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/encrypted-git-sync/` and enable the plugin. **Use a test
vault first.**

The end-to-end tests run several simulated devices against `git http-backend`,
covering merges, conflicts, deletions, push races, wrong passphrases, a wiped
remote, squashing and the recovery tool. One test runs the exact mobile stack
(`lightning-fs` on IndexedDB plus the `requestUrl` HTTP adapter).

### Source layout

```
src/
  main.ts              plugin entry: commands, scheduling, status, key handling
  settings.ts          settings and settings tab
  polyfills.ts         Buffer for isomorphic-git on mobile
  core/                platform-neutral, fully tested
    crypto.ts          key derivation, AES-GCM, blob names, hashing
    manifest.ts        encrypted manifest and tombstones
    planner.ts         three-way sync planner (pure)
    merge.ts           diff3 text merge, conflict-copy names
    retention.ts       squash retention policy (pure)
    filters.ts         ignore globs, attachment and size rules
    state.ts           per-device sync state
    syncEngine.ts      fetch, plan, apply, push
  git/
    shadowRepo.ts      bare repo via isomorphic-git (objects, trees, push)
    squash.ts          history rewrite with lease check
    changePassphrase.ts  re-wraps the master key and pushes the new meta.json
    rotateKey.ts       new master key, re-encrypt everything, single-commit history
    history.ts         list versions, file history, restore a file or the whole vault
    headFix.ts         workaround for remotes whose HEAD branch does not exist
  obsidian/
    http.ts            isomorphic-git HTTP client on requestUrl (no CORS issues)
    vault.ts           vault access through Obsidian's API
    stateStore.ts      sync state file in the plugin folder
    secrets.ts         token and passphrase storage
    modals.ts          passphrase and confirmation dialogs
  cli/recover.ts       standalone recovery tool
```

## Third-party libraries

Bundled into `main.js`:

* [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) (MIT)
* [@isomorphic-git/lightning-fs](https://github.com/isomorphic-git/lightning-fs) (MIT)
* [node-diff3](https://github.com/bhousel/node-diff3) (MIT)
* [pako](https://github.com/nodeca/pako) (MIT and Zlib)
* [buffer](https://github.com/feross/buffer) (MIT)

## License

[MIT](LICENSE)
