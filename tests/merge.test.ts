import { describe, expect, it } from "vitest";
import { conflictCopyPath, isTextPath, mergeText } from "../src/core/merge";

describe("mergeText", () => {
  const base = "# Title\n\nline one\nline two\nline three\n";

  it("combines edits to different lines", () => {
    const local = "# Title\n\nline ONE\nline two\nline three\n";
    const remote = "# Title\n\nline one\nline two\nline three\nline four\n";
    expect(mergeText(base, local, remote)).toEqual({
      clean: true,
      text: "# Title\n\nline ONE\nline two\nline three\nline four\n",
    });
  });

  it("reports a conflict for competing edits of the same line", () => {
    const local = "# Title\n\nline A\nline two\nline three\n";
    const remote = "# Title\n\nline B\nline two\nline three\n";
    expect(mergeText(base, local, remote)).toEqual({ clean: false });
  });

  it("accepts the same edit made on both sides", () => {
    const both = "# Title\n\nsame\nline two\nline three\n";
    expect(mergeText(base, both, both)).toEqual({ clean: true, text: both });
  });

  it("handles a file without trailing newline", () => {
    const b = "a\nb\nc";
    expect(mergeText(b, "A\nb\nc", "a\nb\nC")).toEqual({ clean: true, text: "A\nb\nC" });
  });
});

describe("conflictCopyPath", () => {
  const when = new Date(2026, 9, 15, 7, 41);
  it("puts the label before the extension and avoids collisions", () => {
    const taken = new Set(["Notes/Plan (conflict 2026-10-15 0741 laptop).md"]);
    expect(conflictCopyPath("Notes/Plan.md", when, "laptop", () => false)).toBe(
      "Notes/Plan (conflict 2026-10-15 0741 laptop).md",
    );
    expect(conflictCopyPath("Notes/Plan.md", when, "laptop", (p) => taken.has(p))).toBe(
      "Notes/Plan (conflict 2026-10-15 0741 laptop 2).md",
    );
    expect(conflictCopyPath("README", when, "", () => false)).toBe("README (conflict 2026-10-15 0741)");
  });

  it("knows which files are text", () => {
    expect(isTextPath("a/b.md")).toBe(true);
    expect(isTextPath("x.canvas")).toBe(true);
    expect(isTextPath("img.png")).toBe(false);
  });
});
