/**
 * A real Git smart-HTTP server for tests: Node's http module in front of
 * `git http-backend`, serving bare repositories from a temp directory.
 */

import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

export interface TestGitServer {
  root: string;
  url(repo: string): string;
  createBareRepo(name: string): string;
  close(): Promise<void>;
}

export async function startGitServer(): Promise<TestGitServer> {
  const root = mkdtempSync(join(tmpdir(), "egs-remote-"));

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "test",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
      },
    });
    req.pipe(child.stdin);

    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      headersDone = true;
      const lines = headerBuf.subarray(0, sep).toString("utf8").split("\r\n");
      let status = 200;
      for (const line of lines) {
        const idx = line.indexOf(":");
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === "status") status = parseInt(value, 10);
        else res.setHeader(key, value);
      }
      res.statusCode = status;
      res.write(headerBuf.subarray(sep + 4));
    });
    child.stdout.on("end", () => res.end());
    child.stderr.on("data", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    root,
    url: (repo) => `http://127.0.0.1:${port}/${repo}`,
    createBareRepo(name) {
      const dir = join(root, name);
      execFileSync("git", ["init", "--bare", "--quiet", "--initial-branch=main", dir]);
      execFileSync("git", ["-C", dir, "config", "http.receivepack", "true"]);
      return dir;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
