/**
 * Works around an isomorphic-git limitation: `fetch` fails with
 * "Could not find HEAD" when the server's HEAD points to a branch that does
 * not exist. That is the normal situation here, because the repository may
 * contain only the encrypted branch (e.g. a bare self-hosted repo whose HEAD
 * still says "main").
 *
 * This wraps the HTTP client and, only when the ref advertisement has no HEAD
 * entry, adds one pointing at the sync branch. Nothing else is changed.
 */

import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { concatBytes, utf8Decode, utf8Encode } from "../core/encoding";

async function collect(body: GitHttpResponse["body"]): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return concatBytes(...chunks);
}

async function* single(data: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield data;
}

interface Pkt {
  flush: boolean;
  payload: Uint8Array;
}

function parsePkts(data: Uint8Array): Pkt[] | null {
  const pkts: Pkt[] = [];
  let i = 0;
  while (i < data.length) {
    if (i + 4 > data.length) return null;
    const len = parseInt(utf8Decode(data.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) return null;
    if (len === 0) {
      pkts.push({ flush: true, payload: new Uint8Array(0) });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > data.length) return null;
    pkts.push({ flush: false, payload: data.subarray(i + 4, i + len) });
    i += len;
  }
  return pkts;
}

function encodePkt(pkt: Pkt): Uint8Array {
  if (pkt.flush) return utf8Encode("0000");
  const len = (pkt.payload.length + 4).toString(16).padStart(4, "0");
  return concatBytes(utf8Encode(len), pkt.payload);
}

/** Exported for tests. Returns the advertisement unchanged if no fix is needed. */
export function injectHead(advertisement: Uint8Array, branch: string): Uint8Array {
  const pkts = parsePkts(advertisement);
  if (!pkts) return advertisement;

  // Ref lines are the non-flush pkts that do not start with "#".
  const refIdx = pkts.findIndex((p) => !p.flush && p.payload[0] !== 0x23 /* # */);
  if (refIdx < 0) return advertisement;

  const lines = pkts.map((p) => (p.flush ? null : utf8Decode(p.payload)));
  const branchRef = `refs/heads/${branch}`;
  let branchOid: string | null = null;
  for (const line of lines) {
    if (line === null || line.startsWith("#")) continue;
    const [refPart] = line.replace(/\n$/, "").split("\0");
    const [oid, name] = refPart.split(" ");
    if (name === "HEAD") return advertisement;
    if (name === branchRef) branchOid = oid;
  }
  if (!branchOid) return advertisement;

  const first = lines[refIdx]!.replace(/\n$/, "");
  const nul = first.indexOf("\0");
  const caps = nul >= 0 ? first.slice(nul + 1) : "";
  const firstRef = nul >= 0 ? first.slice(0, nul) : first;

  const out: Pkt[] = [
    ...pkts.slice(0, refIdx),
    { flush: false, payload: utf8Encode(`${branchOid} HEAD\0${caps}\n`) },
    { flush: false, payload: utf8Encode(`${firstRef}\n`) },
    ...pkts.slice(refIdx + 1),
  ];
  return concatBytes(...out.map(encodePkt));
}

export function withHeadFallback(http: HttpClient, branch: string): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const res = await http.request(req);
      const isAdvertisement =
        (req.method ?? "GET") === "GET" && /\/info\/refs\?service=git-upload-pack/.test(req.url);
      if (!isAdvertisement || res.statusCode !== 200) return res;
      const body = await collect(res.body);
      return { ...res, body: single(injectHead(body, branch)) };
    },
  };
}
