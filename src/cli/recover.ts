/**
 * Recovery tool: decrypts a checkout of the encrypted branch with Node.js,
 * no Obsidian needed. Your escape hatch if the plugin ever stops working.
 *
 *   git clone --branch encrypted-main https://github.com/you/vault-sync.git encrypted
 *   node dist/recover.mjs encrypted ./recovered-vault
 *
 * The passphrase is read from the EGS_PASSPHRASE environment variable, or
 * asked for interactively.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { blobPathFor, decryptBytes, parseRepoMeta, sha256Hex, unlockRepo } from "../core/crypto";
import { decryptManifest } from "../core/manifest";

async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s);
  };
  return new Promise((resolvePromise) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer);
    });
    muted = true;
  });
}

async function main(): Promise<number> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === "--help" || input === "-h") {
    console.log("Usage: node recover.mjs <checkout-of-encrypted-branch> <output-folder>");
    console.log("Passphrase: EGS_PASSPHRASE environment variable, or interactive prompt.");
    return input ? 0 : 1;
  }
  const repoDir = resolve(input);
  const outDir = resolve(output);
  const metaPath = join(repoDir, "meta.json");
  if (!existsSync(metaPath)) {
    console.error(`No meta.json in ${repoDir}. Clone the encrypted branch first (git clone --branch <branch> ...).`);
    return 1;
  }

  const meta = parseRepoMeta(readFileSync(metaPath, "utf8"));
  const passphrase = process.env.EGS_PASSPHRASE ?? (await askHidden("Passphrase: "));
  const keys = await unlockRepo(meta, passphrase);
  const manifest = await decryptManifest(keys, new Uint8Array(readFileSync(join(repoDir, "manifest.enc"))));

  let restored = 0;
  let failed = 0;
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.deleted) continue;
    const target = resolve(outDir, path);
    if (!target.startsWith(outDir + sep)) {
      console.error(`Skipping unsafe path: ${path}`);
      failed++;
      continue;
    }
    try {
      const blobPath = await blobPathFor(keys, path);
      const data = await decryptBytes(keys, new Uint8Array(readFileSync(join(repoDir, blobPath))), blobPath);
      if ((await sha256Hex(data)) !== entry.hash) throw new Error("hash mismatch");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      const t = new Date(entry.mtime);
      utimesSync(target, t, t);
      restored++;
    } catch (e) {
      console.error(`Failed: ${path} (${(e as Error).message})`);
      failed++;
    }
  }
  console.log(`Restored ${restored} file(s) to ${outDir}${failed ? `, ${failed} failed` : ""}.`);
  return failed ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
