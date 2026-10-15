/**
 * Plaintext three-way merge for text notes, plus conflict-copy naming.
 */

import { diff3Merge } from "node-diff3";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "canvas", "csv", "json", "css", "js", "ts", "html", "svg"]);

export function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** Splits into lines while keeping line endings, so join("") is lossless. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/);
}

export type MergeOutcome = { clean: true; text: string } | { clean: false };

/**
 * Line-based diff3 merge. Returns clean=false if both sides changed the same
 * lines differently; the caller then keeps both versions as separate files.
 */
export function mergeText(base: string, local: string, remote: string): MergeOutcome {
  if (local === remote) return { clean: true, text: local };
  if (local === base) return { clean: true, text: remote };
  if (remote === base) return { clean: true, text: local };

  const regions = diff3Merge(splitLines(local), splitLines(base), splitLines(remote), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  for (const region of regions) {
    if (region.conflict) return { clean: false };
    if (region.ok) out.push(...region.ok);
  }
  return { clean: true, text: out.join("") };
}

/**
 * "Notes/Plan.md" -> "Notes/Plan (conflict 2026-10-15 0741 laptop).md"
 * Uses `exists` to avoid overwriting an earlier conflict copy.
 */
export function conflictCopyPath(path: string, when: Date, device: string, exists: (p: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";

  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(
    when.getMinutes(),
  )}`;
  const safeDevice = device.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
  const label = safeDevice ? `conflict ${stamp} ${safeDevice}` : `conflict ${stamp}`;

  let candidate = `${dir}${stem} (${label})${ext}`;
  for (let i = 2; exists(candidate); i++) candidate = `${dir}${stem} (${label} ${i})${ext}`;
  return candidate;
}
