import { describe, expect, it } from "vitest";
import { createPathFilter, DEFAULT_IGNORE_PATTERNS, globToRegExp } from "../src/core/filters";

describe("globToRegExp", () => {
  it("matches common patterns", () => {
    expect(globToRegExp("Private/**").test("Private/a/b.md")).toBe(true);
    expect(globToRegExp("Private/**").test("NotPrivate/a.md")).toBe(false);
    expect(globToRegExp("Private/").test("Private/x.md")).toBe(true);
    expect(globToRegExp("*.pdf").test("docs/deep/file.pdf")).toBe(true);
    expect(globToRegExp("docs/*.pdf").test("docs/deep/file.pdf")).toBe(false);
    expect(globToRegExp("**/draft-?.md").test("a/b/draft-1.md")).toBe(true);
    expect(globToRegExp("**/draft-?.md").test("draft-1.md")).toBe(true);
  });
});

describe("createPathFilter", () => {
  it("syncs only notes by default and honours ignores and size", () => {
    const filter = createPathFilter({
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, "Private/**", "# a comment"],
      syncAttachments: false,
      maxFileSizeMB: 1,
    });
    expect(filter("Notes/a.md", 10)).toBe(true);
    expect(filter("Board.canvas", 10)).toBe(true);
    expect(filter("img.png", 10)).toBe(false);
    expect(filter("Private/secret.md", 10)).toBe(false);
    expect(filter(".trash/old.md", 10)).toBe(false);
    expect(filter("Big.md", 2 * 1024 * 1024)).toBe(false);
  });

  it("includes attachments when enabled", () => {
    const filter = createPathFilter({ ignorePatterns: [], syncAttachments: true, maxFileSizeMB: 0 });
    expect(filter("img.png", 50 * 1024 * 1024)).toBe(true);
  });
});
