// isomorphic-git expects a global Buffer. Obsidian desktop (Electron) has one,
// Obsidian mobile does not. This module must be imported before anything else.
// "buffer/" (trailing slash) resolves to the npm package, bundled into main.js,
// never to Node's built-in module, so it works on mobile.
import { Buffer } from "buffer/";

if (typeof window !== "undefined") {
  const w = window as unknown as { Buffer?: typeof Buffer };
  if (typeof w.Buffer === "undefined") w.Buffer = Buffer;
}
