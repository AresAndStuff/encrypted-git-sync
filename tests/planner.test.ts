/** Three-way sync planner: one case per rule in src/core/planner.ts. */
import { describe, expect, it } from "vitest";
import { planSync, type SyncAction } from "../src/core/planner";
import type { ManifestEntry } from "../src/core/manifest";

function live(hash: string): ManifestEntry {
  return { hash, size: 1, mtime: 0 };
}
function tomb(hash: string): ManifestEntry {
  return { deleted: true, hash, deletedAt: 0 };
}

function plan(
  base: Record<string, string>,
  local: Record<string, string>,
  remote: Record<string, ManifestEntry>,
): SyncAction[] {
  return planSync({
    base: new Map(Object.entries(base)),
    local: new Map(Object.entries(local)),
    remote: new Map(Object.entries(remote)),
  });
}

describe("planSync", () => {
  it("does nothing when everything agrees", () => {
    expect(plan({ a: "1" }, { a: "1" }, { a: live("1") })).toEqual([]);
  });

  it("uploads new and locally changed files", () => {
    expect(plan({}, { a: "1" }, {})).toEqual([{ type: "upload", path: "a" }]);
    expect(plan({ a: "1" }, { a: "2" }, { a: live("1") })).toEqual([{ type: "upload", path: "a" }]);
  });

  it("downloads new and remotely changed files", () => {
    expect(plan({}, {}, { a: live("1") })).toEqual([{ type: "download", path: "a" }]);
    expect(plan({ a: "1" }, { a: "1" }, { a: live("2") })).toEqual([{ type: "download", path: "a" }]);
  });

  it("propagates deletions both ways", () => {
    expect(plan({ a: "1" }, {}, { a: live("1") })).toEqual([{ type: "deleteRemote", path: "a" }]);
    expect(plan({ a: "1" }, { a: "1" }, { a: tomb("1") })).toEqual([{ type: "deleteLocal", path: "a" }]);
    expect(plan({ a: "1" }, { a: "1" }, {})).toEqual([{ type: "deleteLocal", path: "a" }]);
  });

  it("merges when both sides changed", () => {
    expect(plan({ a: "1" }, { a: "2" }, { a: live("3") })).toEqual([{ type: "merge", path: "a" }]);
    // Added independently on both devices with different content.
    expect(plan({}, { a: "2" }, { a: live("3") })).toEqual([{ type: "merge", path: "a" }]);
  });

  it("lets an edit win over a deletion", () => {
    expect(plan({ a: "1" }, { a: "2" }, { a: tomb("1") })).toEqual([{ type: "upload", path: "a" }]);
    expect(plan({ a: "1" }, {}, { a: live("2") })).toEqual([{ type: "download", path: "a" }]);
  });

  it("adopts identical changes without transferring", () => {
    expect(plan({ a: "1" }, { a: "2" }, { a: live("2") })).toEqual([{ type: "adopt", path: "a", hash: "2" }]);
    expect(plan({}, { a: "2" }, { a: live("2") })).toEqual([{ type: "adopt", path: "a", hash: "2" }]);
  });

  it("forgets files deleted on both sides", () => {
    expect(plan({ a: "1" }, {}, { a: tomb("1") })).toEqual([{ type: "forget", path: "a" }]);
  });

  it("does not resurrect deleted files on a fresh device", () => {
    expect(plan({}, { a: "1" }, { a: tomb("1") })).toEqual([{ type: "deleteLocal", path: "a" }]);
    // Different content than what was deleted: it's real data, keep it.
    expect(plan({}, { a: "9" }, { a: tomb("1") })).toEqual([{ type: "upload", path: "a" }]);
  });
});
