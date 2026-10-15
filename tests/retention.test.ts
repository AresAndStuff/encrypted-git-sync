import { describe, expect, it } from "vitest";
import { selectCommitsToKeep, type CommitInfo } from "../src/core/retention";

const H = 3_600_000;
const D = 24 * H;
const utc = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min);

function commits(times: number[]): CommitInfo[] {
  return times.map((timestamp, i) => ({ oid: `c${i}`, timestamp }));
}

// Thursday 2026-10-15, 18:00 UTC
const NOW = utc(2026, 10, 15, 18);

describe("selectCommitsToKeep", () => {
  it("keeps everything when there is little history", () => {
    const list = commits([NOW - 3 * H, NOW - 2 * H, NOW - H]);
    expect(selectCommitsToKeep(list, NOW, undefined, "utc").size).toBe(3);
  });

  it("keeps the 5 newest commits of today", () => {
    const list = commits(Array.from({ length: 12 }, (_, i) => utc(2026, 10, 15, 6 + i)));
    const keep = selectCommitsToKeep(list, NOW, undefined, "utc");
    expect([...keep].sort()).toEqual(["c10", "c11", "c7", "c8", "c9"]);
  });

  it("keeps the last commit of each of the last 7 days", () => {
    // Three commits per day for 10 days, at 09:00, 13:00 and 17:00.
    const times: number[] = [];
    for (let day = 0; day < 10; day++) for (const h of [9, 13, 17]) times.push(utc(2026, 10, 15 - day, h));
    const list = commits(times);
    const keep = selectCommitsToKeep(list, NOW, { keepToday: 0, keepDaily: 7, keepWeekly: 0, keepMonthly: 0 }, "utc");
    const keptTimes = list.filter((c) => keep.has(c.oid)).map((c) => new Date(c.timestamp).toISOString());
    expect(keptTimes).toEqual([
      "2026-10-15T17:00:00.000Z",
      "2026-10-14T17:00:00.000Z",
      "2026-10-13T17:00:00.000Z",
      "2026-10-12T17:00:00.000Z",
      "2026-10-11T17:00:00.000Z",
      "2026-10-10T17:00:00.000Z",
      "2026-10-09T17:00:00.000Z",
    ]);
  });

  it("uses Monday-based weeks", () => {
    // Sunday 11 Oct and Monday 12 Oct are in different weeks.
    const list = commits([utc(2026, 10, 11, 20), utc(2026, 10, 12, 8), utc(2026, 10, 12, 9)]);
    const keep = selectCommitsToKeep(list, NOW, { keepToday: 0, keepDaily: 0, keepWeekly: 4, keepMonthly: 0 }, "utc");
    expect([...keep].sort()).toEqual(["c0", "c2"]);
  });

  it("keeps one commit per month for 12 months and drops older ones", () => {
    const times: number[] = [];
    for (let m = 0; m < 18; m++) {
      const d = new Date(Date.UTC(2026, 9 - m, 1, 12));
      times.push(d.getTime(), d.getTime() + 5 * D);
    }
    const list = commits(times);
    const keep = selectCommitsToKeep(list, NOW, { keepToday: 0, keepDaily: 0, keepWeekly: 0, keepMonthly: 12 }, "utc");
    const months = list
      .filter((c) => keep.has(c.oid))
      .map((c) => new Date(c.timestamp).toISOString().slice(0, 10));
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-10-06");
    expect(months[11]).toBe("2025-11-06");
  });

  it("bounds the history with the default policy", () => {
    // A commit every 2 hours for two years.
    const times: number[] = [];
    for (let t = NOW - 730 * D; t <= NOW; t += 2 * H) times.push(t);
    const keep = selectCommitsToKeep(commits(times), NOW, undefined, "utc");
    expect(keep.size).toBeLessThanOrEqual(1 + 5 + 7 + 4 + 12);
    expect(keep.size).toBeGreaterThanOrEqual(20);
  });

  it("always keeps the newest commit, even with clock skew", () => {
    const list = commits([NOW - 400 * D, NOW + 2 * D]);
    expect(selectCommitsToKeep(list, NOW, undefined, "utc").has("c1")).toBe(true);
  });
});
