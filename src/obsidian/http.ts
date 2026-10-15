/**
 * isomorphic-git HTTP client on top of Obsidian's requestUrl.
 *
 * requestUrl is not subject to CORS (unlike fetch in the renderer), so this
 * works against GitHub, GitLab, Gitea etc. on desktop and mobile without a
 * CORS proxy.
 */

import { requestUrl } from "obsidian";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

async function collect(body: GitHttpRequest["body"]): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

async function* single(data: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield data;
}

export const obsidianHttp: HttpClient = {
  async request({ url, method = "GET", headers = {}, body }: GitHttpRequest): Promise<GitHttpResponse> {
    const payload = await collect(body);
    const { "content-type": contentType, ...rest } = lowercaseHeaders(headers);
    const res = await requestUrl({
      url,
      method,
      headers: rest,
      contentType,
      body: payload,
      throw: false,
    });
    return {
      url,
      method,
      statusCode: res.status,
      statusMessage: String(res.status),
      headers: lowercaseHeaders(res.headers ?? {}),
      body: single(new Uint8Array(res.arrayBuffer)),
    };
  },
};
