/**
 * Guards against code that loads on desktop but crashes on Obsidian mobile.
 * Builds main.js the same way the release does and inspects it.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

describe("mobile-safe bundle", () => {
  execFileSync("node", ["esbuild.config.mjs", "production"], { stdio: "pipe" });
  const code = readFileSync("main.js", "utf8");

  it("requires nothing but the obsidian module", () => {
    const requires = new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
    expect([...requires]).toEqual(["obsidian"]);
  });

  it("avoids APIs missing on older iOS WebViews", () => {
    expect(code).not.toMatch(/\(\?<[=!]/); // regex lookbehind, iOS < 16.4
    expect(code).not.toMatch(/\bstructuredClone\(/); // iOS < 15.4
  });

  it("loads without Node globals, like on a phone", () => {
    const stubObsidian = new Proxy(
      {},
      // Capitalised exports (Plugin, Modal, FuzzySuggestModal, …) are classes the bundle may extend.
      { get: (_t, key) => (typeof key === "string" && /^[A-Z]/.test(key) ? class {} : () => undefined) },
    );
    const module = { exports: {} as Record<string, unknown> };
    const sandbox = {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === "obsidian") return stubObsidian;
        throw new Error(`Cannot find module '${name}' (not available on mobile)`);
      },
      // Browser-like globals only: no process, no Buffer.
      TextEncoder,
      TextDecoder,
      crypto: globalThis.crypto,
      atob,
      btoa,
      console,
      setTimeout,
      clearTimeout,
    };
    (sandbox as Record<string, unknown>).globalThis = sandbox;
    (sandbox as Record<string, unknown>).window = sandbox;
    (sandbox as Record<string, unknown>).self = sandbox;
    runInNewContext(code, sandbox);
    expect(typeof module.exports.default).toBe("function");
    expect(typeof (sandbox as Record<string, unknown>).Buffer).toBe("function");
  });
});
