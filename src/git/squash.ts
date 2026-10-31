/**
 * Periodic history squashing with a retention policy.
 *
 * Each commit is a full snapshot, so dropping commits loses nothing about the
 * commits that are kept. The kept commits are re-chained (same trees, same
 * timestamps, new parents) and force-pushed, after checking that nobody
 * pushed in the meantime (a hand-rolled "force-with-lease").
 *
 * Needs the full history, so it deepens the local store first. That costs
 * memory, which is why phones do not squash automatically (see main.ts).
 */

import { selectCommitsToKeep, type CalendarZone, type RetentionPolicy } from "../core/retention";
import type { ShadowRepo } from "./shadowRepo";

export interface SquashOptions {
  policy: RetentionPolicy;
  zone: CalendarZone;
  now: number;
  /** Do nothing while the history is shorter than this. */
  minCommits: number;
}

export type SquashResult =
  | { status: "empty" }
  | { status: "skipped"; commits: number }
  | { status: "raced" }
  | { status: "squashed"; before: number; after: number; head: string };

export async function squashHistory(repo: ShadowRepo, options: SquashOptions): Promise<SquashResult> {
  const head = await repo.fetch();
  if (!head) return { status: "empty" };
  // Syncs fetch shallowly; rewriting needs every commit, or older ones would be lost.
  await repo.deepen();
  if ((await repo.shallowCommits()).size > 0) {
    // Never rewrite a partial history: the missing older commits would be dropped.
    throw new Error("Could not download the full history; squash skipped, nothing was changed.");
  }

  const commits = await repo.log(head);
  if (commits.length < options.minCommits) return { status: "skipped", commits: commits.length };

  const keep = selectCommitsToKeep(
    commits.map((c) => ({ oid: c.oid, timestamp: c.timestamp })),
    options.now,
    options.policy,
    options.zone,
  );
  if (keep.size >= commits.length) return { status: "skipped", commits: commits.length };

  // Oldest first, so each kept commit gets the previously kept one as parent.
  const kept = commits.filter((c) => keep.has(c.oid)).reverse();
  let parent: string | null = null;
  for (const c of kept) {
    parent = await repo.writeCommit(c.tree, parent, c.message, c.timestamp);
  }
  const newHead = parent!;

  // Lease check: abort if another device pushed while we were rewriting.
  if ((await repo.peekRemoteHead()) !== head) return { status: "raced" };

  await repo.push(newHead, true);
  return { status: "squashed", before: commits.length, after: kept.length, head: newHead };
}
