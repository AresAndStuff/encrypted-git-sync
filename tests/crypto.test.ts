import { describe, expect, it } from "vitest";
import {
  blobPathFor,
  createRepoMeta,
  decryptBytes,
  DecryptionError,
  deriveKeys,
  encryptBytes,
  parseRepoMeta,
  sha256Hex,
  unlockRepo,
  WrongPassphraseError,
} from "../src/core/crypto";
import { utf8Decode, utf8Encode } from "../src/core/encoding";
import { decryptManifest, emptyManifest, encryptManifest, pruneTombstones } from "../src/core/manifest";

const ITER = 1_000; // fast for tests; production uses 600k

describe("crypto", () => {
  it("round-trips content", async () => {
    const { keys } = await createRepoMeta("correct horse", ITER);
    const ct = await encryptBytes(keys, utf8Encode("hello ünïcode 🔐"), "blobs/aa/bb");
    expect(ct[0]).toBe(1);
    expect(ct.length).toBe(1 + 12 + utf8Encode("hello ünïcode 🔐").length + 16);
    expect(utf8Decode(await decryptBytes(keys, ct, "blobs/aa/bb"))).toBe("hello ünïcode 🔐");
  });

  it("uses a fresh nonce each time", async () => {
    const { keys } = await createRepoMeta("pw", ITER);
    const a = await encryptBytes(keys, utf8Encode("same"), "x");
    const b = await encryptBytes(keys, utf8Encode("same"), "x");
    expect(a).not.toEqual(b);
  });

  it("rejects tampered data, wrong AAD and unknown versions", async () => {
    const { keys } = await createRepoMeta("pw", ITER);
    const ct = await encryptBytes(keys, utf8Encode("secret"), "path-a");
    const tampered = new Uint8Array(ct);
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptBytes(keys, tampered, "path-a")).rejects.toBeInstanceOf(DecryptionError);
    await expect(decryptBytes(keys, ct, "path-b")).rejects.toBeInstanceOf(DecryptionError);
    const badVersion = new Uint8Array(ct);
    badVersion[0] = 9;
    await expect(decryptBytes(keys, badVersion, "path-a")).rejects.toThrow(/version 9/);
  });

  it("unlocks with the right passphrase only", async () => {
    const { meta } = await createRepoMeta("right", ITER);
    const parsed = parseRepoMeta(JSON.stringify(meta));
    await expect(unlockRepo(parsed, "wrong")).rejects.toBeInstanceOf(WrongPassphraseError);
    const keys = await unlockRepo(parsed, "right");
    expect(keys.salt).toBe(meta.kdf.salt);
  });

  it("derives the same keys on every device", async () => {
    const { meta, keys } = await createRepoMeta("pw", ITER);
    const other = await deriveKeys("pw", meta.kdf);
    const ct = await encryptBytes(keys, utf8Encode("x"), "aad");
    expect(utf8Decode(await decryptBytes(other, ct, "aad"))).toBe("x");
    expect(await blobPathFor(keys, "Notes/a.md")).toBe(await blobPathFor(other, "Notes/a.md"));
  });

  it("produces stable, opaque blob paths", async () => {
    const { keys } = await createRepoMeta("pw", ITER);
    const p = await blobPathFor(keys, "Therapie/Termin.md");
    expect(p).toMatch(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{62}$/);
    expect(p).not.toContain("Therapie");
    expect(await blobPathFor(keys, "Therapie/Termin.md")).toBe(p);
    expect(await blobPathFor(keys, "Therapie/Termin2.md")).not.toBe(p);
    // Unicode normalisation: macOS (NFD) and others (NFC) map to the same blob.
    expect(await blobPathFor(keys, "Ü.md".normalize("NFD"))).toBe(await blobPathFor(keys, "Ü.md".normalize("NFC")));
  });

  it("hashes with SHA-256", async () => {
    expect(await sha256Hex(utf8Encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("manifest", () => {
  it("round-trips encrypted and compressed", async () => {
    const { keys } = await createRepoMeta("pw", ITER);
    const m = emptyManifest();
    m.files["b.md"] = { hash: "h2", size: 2, mtime: 2 };
    m.files["a.md"] = { hash: "h1", size: 1, mtime: 1 };
    m.files["gone.md"] = { deleted: true, hash: "h3", deletedAt: 5 };
    const enc = await encryptManifest(keys, m);
    expect(utf8Decode(enc)).not.toContain("a.md");
    const dec = await decryptManifest(keys, enc);
    expect(dec.files).toEqual(m.files);
    expect(Object.keys(dec.files)).toEqual(["a.md", "b.md", "gone.md"]);
  });

  it("prunes old tombstones only", () => {
    const day = 86_400_000;
    const m = emptyManifest();
    m.files["old.md"] = { deleted: true, hash: "x", deletedAt: 0 };
    m.files["new.md"] = { deleted: true, hash: "y", deletedAt: 95 * day };
    m.files["live.md"] = { hash: "z", size: 1, mtime: 0 };
    expect(pruneTombstones(m, 100 * day, 90)).toBe(1);
    expect(Object.keys(m.files).sort()).toEqual(["live.md", "new.md"]);
  });
});
