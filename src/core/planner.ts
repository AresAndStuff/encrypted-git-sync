/**
 * Three-way sync planner. Pure logic, no I/O.
 *
 * For every path it compares three hashes:
 *   base   - what this device last synced (local state store)
 *   local  - what is in the vault now
 *   remote - what the encrypted manifest on the remote says
 *
 * Rules:
 *   - Changed on one side only: take that side.
 *   - Changed on both sides to different content: merge (or conflict copy).
 *   - Edited on one side, deleted on the other: the edit wins.
 *   - A file a fresh device still has, but the remote deleted (tombstone
 *     with the same content hash): delete locally instead of resurrecting it.
 */

import type { ManifestEntry } from "./manifest";

export type SyncAction =
  | { type: "upload"; path: string }
  | { type: "download"; path: string }
  | { type: "deleteLocal"; path: string }
  | { type: "deleteRemote"; path: string }
  /** Both sides changed. The engine tries a text merge, else writes a conflict copy. */
  | { type: "merge"; path: string }
  /** Local and remote already agree; only the base state needs updating. */
  | { type: "adopt"; path: string; hash: string }
  /** Gone on both sides; drop it from the base state. */
  | { type: "forget"; path: string };

export interface PlanInput {
  base: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
  remote: ReadonlyMap<string, ManifestEntry>;
}

export function planSync({ base, local, remote }: PlanInput): SyncAction[] {
  const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);
  const actions: SyncAction[] = [];

  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const l = local.get(path);
    const remoteEntry = remote.get(path);
    const r = remoteEntry && !remoteEntry.deleted ? remoteEntry.hash : undefined;

    if (l === r) {
      if (l === undefined) {
        if (b !== undefined) actions.push({ type: "forget", path });
      } else if (b !== l) {
        actions.push({ type: "adopt", path, hash: l });
      }
      continue;
    }

    // A device without history holds a file the remote deliberately deleted.
    if (b === undefined && r === undefined && l !== undefined && remoteEntry?.deleted && remoteEntry.hash === l) {
      actions.push({ type: "deleteLocal", path });
      continue;
    }

    if (l === b) {
      // Only the remote changed.
      actions.push(r === undefined ? { type: "deleteLocal", path } : { type: "download", path });
      continue;
    }

    if (r === b) {
      // Only the local side changed.
      actions.push(l === undefined ? { type: "deleteRemote", path } : { type: "upload", path });
      continue;
    }

    // Both sides changed, to different results.
    if (l !== undefined && r !== undefined) actions.push({ type: "merge", path });
    else if (l !== undefined) actions.push({ type: "upload", path });
    else actions.push({ type: "download", path });
  }

  return actions;
}

export function summarizePlan(actions: SyncAction[]): Record<SyncAction["type"], number> {
  const summary = { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, merge: 0, adopt: 0, forget: 0 };
  for (const a of actions) summary[a.type]++;
  return summary;
}
