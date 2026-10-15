/**
 * History retention ("grandfather-father-son") for periodic squashing.
 *
 * Default policy:
 *   - the 5 newest commits of the current day
 *   - the last commit of each of the last 7 calendar days (today included)
 *   - the last commit of each of the last 4 ISO weeks (Monday start, this week included)
 *   - the last commit of each of the last 12 calendar months (this month included)
 *   - always the newest commit overall (the branch head)
 *
 * A commit may satisfy several rules at once; the result is the union, so at
 * most 1 + 5 + 7 + 4 + 12 commits survive no matter how old the vault is.
 */

export interface RetentionPolicy {
  keepToday: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepToday: 5,
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12,
};

export interface CommitInfo {
  oid: string;
  /** Commit time in milliseconds since the epoch. */
  timestamp: number;
}

/** "local" uses the device's time zone for day/week/month boundaries. */
export type CalendarZone = "local" | "utc";

interface CalendarParts {
  day: number;
  week: number;
  month: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function calendarParts(ms: number, zone: CalendarZone): CalendarParts {
  const d = new Date(ms);
  const year = zone === "utc" ? d.getUTCFullYear() : d.getFullYear();
  const month = zone === "utc" ? d.getUTCMonth() : d.getMonth();
  const date = zone === "utc" ? d.getUTCDate() : d.getDate();
  // Day number since 1970-01-01 in the chosen zone, independent of DST.
  const day = Math.floor(Date.UTC(year, month, date) / MS_PER_DAY);
  // 1970-01-01 was a Thursday; +3 makes weeks start on Monday.
  const week = Math.floor((day + 3) / 7);
  return { day, week, month: year * 12 + month };
}

/** Newest commit per bucket, for buckets within `count` periods of `current`. */
function newestPerBucket(
  sorted: CommitInfo[],
  bucketOf: (c: CommitInfo) => number,
  current: number,
  count: number,
): string[] {
  if (count <= 0) return [];
  const seen = new Set<number>();
  const keep: string[] = [];
  for (const c of sorted) {
    const bucket = bucketOf(c);
    if (bucket > current || bucket <= current - count) continue;
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    keep.push(c.oid);
  }
  return keep;
}

export function selectCommitsToKeep(
  commits: CommitInfo[],
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  zone: CalendarZone = "local",
): Set<string> {
  const keep = new Set<string>();
  if (commits.length === 0) return keep;

  // Newest first; ties broken by input order (stable sort).
  const sorted = [...commits].sort((a, b) => b.timestamp - a.timestamp);
  const parts = new Map(sorted.map((c) => [c.oid, calendarParts(c.timestamp, zone)]));
  const nowParts = calendarParts(now, zone);

  keep.add(sorted[0].oid);

  sorted
    .filter((c) => parts.get(c.oid)!.day === nowParts.day)
    .slice(0, Math.max(0, policy.keepToday))
    .forEach((c) => keep.add(c.oid));

  for (const oid of newestPerBucket(sorted, (c) => parts.get(c.oid)!.day, nowParts.day, policy.keepDaily)) keep.add(oid);
  for (const oid of newestPerBucket(sorted, (c) => parts.get(c.oid)!.week, nowParts.week, policy.keepWeekly))
    keep.add(oid);
  for (const oid of newestPerBucket(sorted, (c) => parts.get(c.oid)!.month, nowParts.month, policy.keepMonthly))
    keep.add(oid);

  return keep;
}
