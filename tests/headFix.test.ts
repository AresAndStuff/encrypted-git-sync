/** Ref advertisement rewrite for remotes whose HEAD branch does not exist. */
import { describe, expect, it } from "vitest";
import { injectHead } from "../src/git/headFix";
import { utf8Decode, utf8Encode } from "../src/core/encoding";

function pkt(s: string): string {
  return (s.length + 4).toString(16).padStart(4, "0") + s;
}

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("injectHead", () => {
  it("adds HEAD for the sync branch when the server advertises none", () => {
    const adv =
      pkt("# service=git-upload-pack\n") +
      "0000" +
      pkt(`${A} refs/heads/encrypted-main\0multi_ack side-band-64k\n`) +
      pkt(`${B} refs/heads/other\n`) +
      "0000";
    const out = utf8Decode(injectHead(utf8Encode(adv), "encrypted-main"));
    expect(out).toBe(
      pkt("# service=git-upload-pack\n") +
        "0000" +
        pkt(`${A} HEAD\0multi_ack side-band-64k\n`) +
        pkt(`${A} refs/heads/encrypted-main\n`) +
        pkt(`${B} refs/heads/other\n`) +
        "0000",
    );
  });

  it("leaves advertisements with a HEAD, or without the branch, untouched", () => {
    const withHead = pkt("# service=git-upload-pack\n") + "0000" + pkt(`${A} HEAD\0caps\n`) + pkt(`${A} refs/heads/x\n`) + "0000";
    expect(utf8Decode(injectHead(utf8Encode(withHead), "x"))).toBe(withHead);
    const noBranch = pkt("# service=git-upload-pack\n") + "0000" + pkt(`${B} refs/heads/other\0caps\n`) + "0000";
    expect(utf8Decode(injectHead(utf8Encode(noBranch), "x"))).toBe(noBranch);
    const garbage = "not a pkt line";
    expect(utf8Decode(injectHead(utf8Encode(garbage), "x"))).toBe(garbage);
  });
});
