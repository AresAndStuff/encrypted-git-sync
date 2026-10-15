/**
 * Decides which vault files take part in sync.
 */

export interface FilterOptions {
  /** Glob patterns relative to the vault root, one per entry. */
  ignorePatterns: string[];
  /** If false, only notes (.md) and canvases (.canvas) are synced. */
  syncAttachments: boolean;
  /** Files larger than this are skipped (0 = no limit). */
  maxFileSizeMB: number;
}

const NOTE_EXTENSIONS = new Set(["md", "canvas"]);

export const DEFAULT_IGNORE_PATTERNS = [".trash/**", "**/.DS_Store", "**/Thumbs.db"];

/**
 * Minimal glob matcher: `**` matches across folders, `*` within one segment,
 * `?` one character. A pattern without a slash matches the file name anywhere.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\.\//, "");
  if (p.endsWith("/")) p += "**";
  const anywhere = !p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const slashAfter = p[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(anywhere ? `(?:^|/)${re}$` : `^${re}$`);
}

export function createPathFilter(options: FilterOptions): (path: string, size: number) => boolean {
  const ignores = options.ignorePatterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"))
    .map(globToRegExp);
  const maxBytes = options.maxFileSizeMB > 0 ? options.maxFileSizeMB * 1024 * 1024 : Infinity;

  return (path: string, size: number) => {
    if (ignores.some((re) => re.test(path))) return false;
    if (size > maxBytes) return false;
    if (!options.syncAttachments) {
      const dot = path.lastIndexOf(".");
      const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
      if (!NOTE_EXTENSIONS.has(ext)) return false;
    }
    return true;
  };
}
