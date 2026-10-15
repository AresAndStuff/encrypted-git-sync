// isomorphic-git expects a global Buffer. Obsidian desktop (Electron) has one,
// Obsidian mobile does not. This module must be imported before anything else.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
