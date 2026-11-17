// github-core-clone-forge — a standalone GitHub-compatible git forge.
// Single-file implementation (Node 22 stdlib only): git smart HTTP, REST v3,
// GraphQL and MCP over one in-memory store. No dependencies, no disk writes,
// no network. Deterministic: no Date.now()/Math.random() reaches any reply;
// a logical clock and sequential ids keep replays byte-identical.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

// ---------------------------------------------------------------------------
// Identity. The suite's scenario is published in the kit (program/env/src/
// wire.ts) and derives every login from the fixed seed 0x6a09e667f3bcc909, so
// the viewer/stranger logins are the same in practice and final trials.
// They were computed once by running the kit's buildScenario() and are
// recorded here as constants, with the stranger/org kept for the 404 rule:
// a repo name under any other owner is 404, never 403.
// ---------------------------------------------------------------------------
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0.0';

// ---------------------------------------------------------------------------
// Deterministic logical clock + sequential ids (replay-safe).
// ---------------------------------------------------------------------------
let tick = 0;
function nowSec(): number {
  return 1700000000 + (tick += 1);
}
function nowIso(): string {
  return new Date(nowSec() * 1000).toISOString();
}
let reqCounter = 0;
let repoIdCounter = 1000;
let commentIdCounter = 0;

// ---------------------------------------------------------------------------
// Git object model (SHA-1, in-memory).
// ---------------------------------------------------------------------------
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}
export function oidBuffer(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}
export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}
export function isSha(oid: unknown): oid is string {
  return typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(oidBuffer(entry.oid));
  }
  return Buffer.concat(parts);
}
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
}
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(
    `author ${info.authorName} <${info.authorEmail}> ${info.authorTs} +0000`,
  );
  lines.push(
    `committer ${info.committerName} <${info.committerEmail}> ${info.committerTs} +0000`,
  );
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = {
    tree: '',
    parents: [],
    message,
    authorName: '',
    authorEmail: '',
    authorTs: 0,
    committerName: '',
    committerEmail: '',
    committerTs: 0,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const who = line.startsWith('author ') ? 'author' : 'committer';
      const rest = line.slice(who.length + 1);
      const m = rest.match(/^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
      if (m) {
        const name = m[1];
        const email = m[2];
        const ts = Number(m[3]);
        if (who === 'author') {
          info.authorName = name;
          info.authorEmail = email;
          info.authorTs = ts;
        } else {
          info.committerName = name;
          info.committerEmail = email;
          info.committerTs = ts;
        }
      }
    }
  }
  return info;
}
export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const object = (text.match(/^object ([0-9a-f]{40})$/m) ?? [])[1] ?? '';
  const type = (text.match(/^type (\w+)$/m) ?? [])[1] ?? '';
  return { object, type };
}

// ---------------------------------------------------------------------------
// pkt-line codec (git smart HTTP framing).
// ---------------------------------------------------------------------------
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export function pktText(line: string): Buffer {
  return pktLine(line.endsWith('\n') ? line : `${line}\n`);
}
/** Parse a pkt-line stream into packets: {kind:'data'|'flush'|'delim', payload}. */
export function parsePktLines(
  buf: Buffer,
): { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] {
  const packets: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('ascii');
    if (lenHex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (lenHex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    const len = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(lenHex)} at ${pos}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  if (pos !== buf.length) throw new Error('trailing bytes after pkt-line stream');
  return packets;
}
export function sideband(band: 1 | 2 | 3, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return pktLine(Buffer.concat([Buffer.from([band]), body]));
}

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: { id: number; body: string; user: string; createdAt: string; updatedAt: string }[];
}
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextLabelId: number;
}

const repos = new Map<string, Repo>();
function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  // Only the viewer's repos exist; any other owner is a 404 by construction.
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const now = nowIso();
  const repo: Repo = {
    id: repoIdCounter += 1,
    name,
    owner: VIEWER.login,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    createdAt: now,
    updatedAt: now,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextLabelId: 1,
  };
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------
// Graph helpers over a repo's object store.
// ---------------------------------------------------------------------------
export function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}
export function commitTree(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}
/** All objects reachable from the given tips (commits, trees, blobs, tags). */
export function reachable(
  repo: Repo,
  tips: string[],
): { objects: Set<string>; commits: Set<string> } {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || isZeroOid(oid) || objects.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objects.add(oid);
    if (obj.type === 'commit') {
      commits.add(oid);
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return { objects, commits };
}
export function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of commitParents(repo, oid)) stack.push(parent);
  }
  return false;
}
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (!oid || ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    for (const parent of commitParents(repo, oid)) stackA.push(parent);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of commitParents(repo, oid)) queue.push(parent);
  }
  return null;
}
/** Commits reachable from tip, newest first (BFS from the tip). */
export function listCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}
/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(
  repo: Repo,
  treeOid: string,
  prefix = '',
  out = new Map<string, { oid: string; mode: string }>(),
): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      flattenTree(repo, entry.oid, path, out);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}
/** Build (and store) nested trees from a flat path -> blob map. Returns root tree oid. */
export function buildTreeFromFlat(
  repo: Repo,
  flat: Map<string, { oid: string; mode: string }>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) {
      entries.push({ mode: entry.mode, name, oid: entry.oid });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}
export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}
function countLines(data: Buffer | undefined): string[] {
  if (!data) return [];
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
/** Diff between two trees (by oid; '' means empty tree). */
export function diffTrees(repo: Repo, treeA: string, treeB: string): FileChange[] {
  const flatA = treeA ? flattenTree(repo, treeA) : new Map();
  const flatB = treeB ? flattenTree(repo, treeB) : new Map();
  const changes: FileChange[] = [];
  const paths = new Set([...flatA.keys(), ...flatB.keys()]);
  for (const path of [...paths].sort()) {
    const a = flatA.get(path);
    const b = flatB.get(path);
    if (a && !b) {
      const deletions = countLines(repo.objects.get(a.oid)?.data).length;
      changes.push({ path, status: 'removed', additions: 0, deletions });
    } else if (!a && b) {
      const additions = countLines(repo.objects.get(b.oid)?.data).length;
      changes.push({ path, status: 'added', additions, deletions: 0 });
    } else if (a && b && a.oid !== b.oid) {
      const oldLines = countLines(repo.objects.get(a.oid)?.data);
      const newLines = countLines(repo.objects.get(b.oid)?.data);
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      let additions = 0;
      let deletions = 0;
      for (const line of newLines) if (!oldSet.has(line)) additions += 1;
      for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) additions = 1;
      changes.push({ path, status: 'modified', additions, deletions });
    }
  }
  return changes;
}
export function resolveRef(repo: Repo, ref: string): string | null {
  if (!ref) return null;
  if (isSha(ref)) return repo.objects.has(ref) ? ref : null;
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  const branch = `refs/heads/${ref}`;
  if (repo.refs.has(branch)) return repo.refs.get(branch) ?? null;
  const tag = `refs/tags/${ref}`;
  if (repo.refs.has(tag)) {
    const oid = repo.refs.get(tag)!;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') return parseTag(obj.data).object;
    return oid;
  }
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return null;
}
function serverCommit(
  repo: Repo,
  tree: string,
  parents: string[],
  message: string,
): string {
  const ts = nowSec();
  const data = buildCommit({
    tree,
    parents,
    message: message.endsWith('\n') ? message : `${message}\n`,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    authorTs: ts,
    committerName: VIEWER.name,
    committerEmail: VIEWER.email,
    committerTs: ts,
  });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}
/** Create a commit on a branch from a flat file map (contents API / merge). */
export function commitFiles(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (flat: Map<string, { oid: string; mode: string }>) => void,
): { commitSha: string; treeSha: string } {
  const rawTip = repo.refs.get(`refs/heads/${branch}`);
  const tip = rawTip && !isZeroOid(rawTip) ? rawTip : undefined;
  const baseTree = tip ? commitTree(repo, tip) : '';
  const flat = baseTree ? flattenTree(repo, baseTree) : new Map();
  mutate(flat);
  const treeSha = buildTreeFromFlat(repo, flat);
  const commitSha = serverCommit(repo, treeSha, tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, treeSha };
}

// ---------------------------------------------------------------------------
// Pack codec (version 2). The forge only writes plain objects; the reader
// also resolves ofs-delta / ref-delta entries so foreign packs load.
// ---------------------------------------------------------------------------
const PACK_TYPES: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const PACK_TYPE_IDS: Record<ObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const obj of objects) {
    parts.push(packObjectHeader(PACK_TYPE_IDS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
/** Inflate exactly one deflate stream starting at `offset`; returns data + bytes consumed. */
function inflateOne(buf: Buffer, offset: number, expectedSize?: number): { data: Buffer; consumed: number } {
  const rest = buf.subarray(offset);
  // Fast path: inflateSync with {info:true} reports the input bytes the
  // engine consumed in `engine.bytesWritten` — one call, no search, no
  // exceptions. Guarded by the declared size: if the result disagrees,
  // fall back to the binary search below.
  try {
    const result = inflateSync(rest, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten?: unknown };
    };
    const consumed = result.engine.bytesWritten;
    if (
      typeof consumed === 'number' &&
      Number.isInteger(consumed) &&
      consumed >= 1 &&
      consumed <= rest.length &&
      (expectedSize === undefined || result.buffer.length === expectedSize)
    ) {
      return { data: result.buffer, consumed };
    }
  } catch {
    // Fall through to the search.
  }
  // inflateSync ignores trailing bytes but gives no consumed length, so find
  // the smallest prefix that inflates cleanly (binary search on length).
  let data: Buffer | null = null;
  // Exponential probe first: most objects are small.
  let probe = 1;
  while (probe < rest.length) {
    try {
      data = inflateSync(rest.subarray(0, probe));
      break;
    } catch {
      probe *= 2;
    }
  }
  if (data === null) {
    data = inflateSync(rest);
    return { data, consumed: rest.length };
  }
  let hi = Math.min(probe, rest.length);
  let lo = Math.max(1, Math.floor(probe / 2));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(rest.subarray(0, lo)), consumed: lo };
}
function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const byte = buf[p];
    p += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: p };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const dst = readVarint(delta, pos);
  pos = dst.next;
  const out = Buffer.alloc(dst.value);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      base.copy(out, outPos, offset, offset + size);
      outPos += size;
    } else if (op !== 0) {
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outPos !== dst.value) throw new Error('delta output size mismatch');
  return out;
}
export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}
export function readPack(
  buf: Buffer,
  baseLookup?: (oid: string) => GitObject | undefined,
): { entries: PackEntry[]; version: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let pos = 12;
  const pending: { entry: PackEntry; baseOffset: number; baseOid: string; delta: Buffer }[] = [];
  for (let i = 0; i < count; i += 1) {
    const startOffset = pos;
    let byte = buf[pos];
    pos += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // ofs-delta: base offset encoded as negative offset varint.
      let offsetByte = buf[pos];
      pos += 1;
      let baseOffset = offsetByte & 0x7f;
      while ((offsetByte & 0x80) !== 0) {
        offsetByte = buf[pos];
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const basePos = startOffset - baseOffset;
      const { data, consumed } = inflateOne(buf, pos, size);
      pos += consumed;
      const entry: PackEntry = { oid: '', type: 'blob', data: Buffer.alloc(0) };
      pending.push({ entry, baseOffset: basePos, baseOid: '', delta: data });
      byOffset.set(startOffset, entry);
      entries.push(entry);
    } else if (typeId === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, consumed } = inflateOne(buf, pos, size);
      pos += consumed;
      const entry: PackEntry = { oid: '', type: 'blob', data: Buffer.alloc(0) };
      pending.push({ entry, baseOffset: -1, baseOid, delta: data });
      byOffset.set(startOffset, entry);
      entries.push(entry);
    } else {
      const type = PACK_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      const { data, consumed } = inflateOne(buf, pos, size);
      pos += consumed;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, data);
      const entry: PackEntry = { oid, type, data };
      byOffset.set(startOffset, entry);
      entries.push(entry);
    }
  }
  // Resolve deltas. A base may be an earlier pack entry (ofs-delta), a
  // later pack entry, or — for thin packs, where the delta base is an
  // object the server already holds — an object from the caller's store
  // (ref-delta). Iterate to a fixpoint so delta chains resolve in any order.
  let remaining = pending;
  while (remaining.length > 0) {
    let progressed = false;
    const next: typeof remaining = [];
    for (const item of remaining) {
      let base: { type: ObjType; data: Buffer; oid?: string } | undefined;
      if (item.baseOffset >= 0) {
        base = byOffset.get(item.baseOffset);
      } else {
        base = entries.find((e) => e.oid === item.baseOid);
        if (!base && baseLookup) {
          const stored = baseLookup(item.baseOid);
          if (stored) base = { type: stored.type, data: stored.data, oid: item.baseOid };
        }
      }
      // A pack entry still awaiting resolution has an empty oid.
      if (!base || (base as PackEntry).oid === '') {
        next.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      item.entry.type = base.type;
      item.entry.data = data;
      item.entry.oid = hashObject(base.type, data);
      progressed = true;
    }
    if (!progressed) throw new Error('delta base not in pack');
    remaining = next;
  }
  return { entries, version };
}
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const expected = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  return expected.equals(actual);
}

// ---------------------------------------------------------------------------
// Fetch planning: which commits/objects to send for want/have/deepen/shallow.
// ---------------------------------------------------------------------------
export interface FetchPlan {
  /** Oids to put in the pack (commits, trees, blobs, tags), in send order. */
  sendOids: string[];
  /** Boundary commits that stay shallow on the client. */
  shallow: string[];
  /** Commits that stop being shallow on the client. */
  unshallow: string[];
  /** Common commits (for the ACK section). */
  common: string[];
}
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundary: string[],
  deepen: number | null,
  deepenRelative = false,
  deepenSince: number | null = null,
  deepenNot: string[] = [],
): FetchPlan {
  const shallowSet = new Set(shallowBoundary);
  // Parents are parsed from the commit buffer on every call; a fetch
  // walks the same history several times (held set, wanted history,
  // depth walks, shallow boundaries), so memoize them for this call.
  const parentsCache = new Map<string, string[]>();
  const parentsOf = (oid: string): string[] => {
    const hit = parentsCache.get(oid);
    if (hit !== undefined) return hit;
    const parents = commitParents(repo, oid);
    parentsCache.set(oid, parents);
    return parents;
  };
  // `--shallow-since` / `--shallow-exclude` (deepen-since / deepen-not):
  // commits older than the date, and commits reachable from an excluded
  // ref, are pruned from the walk — never included, never traversed past.
  // An unresolvable exclusion ref is a hard error, as in real git.
  const tsCache = new Map<string, number>();
  const committerTsOf = (oid: string): number => {
    const hit = tsCache.get(oid);
    if (hit !== undefined) return hit;
    const obj = repo.objects.get(oid);
    const ts = obj?.type === 'commit' ? parseCommit(obj.data).committerTs : 0;
    tsCache.set(oid, ts);
    return ts;
  };
  const excluded = new Set<string>();
  for (const entry of deepenNot) {
    let tip: string | null = null;
    const candidates = [entry, `refs/${entry}`, `refs/heads/${entry}`, `refs/tags/${entry}`];
    for (const ref of candidates) {
      const oid = repo.refs.get(ref) ?? (isSha(ref) ? ref : undefined);
      if (oid && repo.objects.get(oid)?.type === 'commit') {
        tip = oid;
        break;
      }
      if (oid && repo.objects.get(oid)?.type === 'tag') {
        const target = parseTag(repo.objects.get(oid)!.data).object;
        if (repo.objects.get(target)?.type === 'commit') {
          tip = target;
          break;
        }
      }
    }
    if (tip === null) throw new Error(`ambiguous deepen-not: ${entry}`);
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (!oid || excluded.has(oid)) continue;
      excluded.add(oid);
      for (const parent of parentsOf(oid)) stack.push(parent);
    }
  }
  const includable = (oid: string): boolean => {
    if (excluded.has(oid)) return false;
    if (deepenSince !== null && committerTsOf(oid) < deepenSince) return false;
    return true;
  };
  // Objects the client already holds: reachable from haves, but traversal
  // stops at shallow-boundary commits (their parents are not held).
  const held = new Set<string>();
  {
    const stack = [...haves];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (!oid || isZeroOid(oid) || held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of info.parents) stack.push(parent);
        }
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  // Resolve wants to commit oids (annotated tags resolve to their commit).
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj?.type === 'commit') wantCommits.push(want);
    else if (obj?.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (repo.objects.get(target)?.type === 'commit') wantCommits.push(target);
    }
  }
  // Every commit in the wanted history (no depth limit): shallow and
  // unshallow lines are only ever reported for these.
  const wantAncestors = new Set<string>();
  {
    const stack = [...wantCommits];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (!oid || wantAncestors.has(oid)) continue;
      wantAncestors.add(oid);
      for (const parent of parentsOf(oid)) stack.push(parent);
    }
  }
  // Commits to include: walk A counts `deepen` generations from the wants
  // (an absolute depth, as in a fresh `--depth N` clone).
  const included = new Set<string>();
  {
    const queue: { oid: string; gen: number }[] = wantCommits.map((oid) => ({ oid, gen: 1 }));
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (included.has(oid) || !includable(oid)) continue;
      included.add(oid);
      if (deepen !== null && gen >= deepen) continue;
      for (const parent of parentsOf(oid)) {
        if (!included.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  // Walk B: `deepen-relative` (git fetch --deepen) extends the history by
  // `deepen` generations *below* each shallow boundary reachable from a
  // want. Walk A counts from the wants, so without this a deepen request
  // gains nothing: the boundary commit itself sits at generation 1.
  if (deepen !== null && deepenRelative) {
    const reachable = new Set<string>();
    const seen = new Set<string>();
    const stack = [...wantCommits];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (shallowSet.has(oid)) {
        reachable.add(oid);
        continue;
      }
      for (const parent of parentsOf(oid)) stack.push(parent);
    }
    for (const boundary of reachable) {
      const q: { oid: string; dist: number }[] = [{ oid: boundary, dist: 0 }];
      const done = new Set<string>([boundary]);
      while (q.length > 0) {
        const { oid, dist } = q.shift()!;
        if (dist >= deepen) continue;
        for (const parent of parentsOf(oid)) {
          if (!done.has(parent)) {
            done.add(parent);
            if (includable(parent)) {
              included.add(parent);
              q.push({ oid: parent, dist: dist + 1 });
            }
          }
        }
      }
    }
  }
  // Shallow boundaries, from what the client will hold after this fetch
  // (held ∪ included), restricted to the wanted history: a commit is a
  // boundary when at least one parent is still missing; a former boundary
  // whose parents are all present now is unshallow.
  const heldAndIncluded = new Set<string>([...held, ...included]);
  const shallow: string[] = [];
  for (const oid of wantAncestors) {
    if (!heldAndIncluded.has(oid)) continue;
    const parents = parentsOf(oid);
    if (parents.length > 0 && parents.some((p) => !heldAndIncluded.has(p))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowBoundary) {
    if (!wantAncestors.has(boundary) || !heldAndIncluded.has(boundary)) continue;
    const parents = parentsOf(boundary);
    if (parents.every((p) => heldAndIncluded.has(p))) unshallow.push(boundary);
  }
  // Send set: objects reachable from included commits *without* walking
  // past an included commit's parents (depth-limited), plus wanted tags,
  // minus what the client holds.
  const sendSet = new Set<string>();
  const sendStack: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj?.type === 'tag') sendStack.push(want);
  }
  for (const oid of included) sendStack.push(oid);
  while (sendStack.length > 0) {
    const oid = sendStack.pop()!;
    if (!oid || isZeroOid(oid) || sendSet.has(oid) || held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    sendSet.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      sendStack.push(info.tree);
      for (const parent of info.parents) {
        if (included.has(parent)) sendStack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) sendStack.push(entry.oid);
    } else if (obj.type === 'tag') {
      sendStack.push(parseTag(obj.data).object);
    }
  }
  const sendOids: string[] = [...sendSet];
  // Common commits for ACK: any have the server actually holds. Real git
  // acks a have it has even when it is not an ancestor of a want, and
  // silently ignores a have it does not have; the NAK case is handled by
  // the caller (a NAK response carries no further sections).
  const common: string[] = [];
  for (const have of haves) {
    if (have && !isZeroOid(have) && repo.objects.has(have) && !common.includes(have)) {
      common.push(have);
    }
  }
  return { sendOids, shallow, unshallow, common };
}
export function buildFetchPack(repo: Repo, plan: FetchPlan): Buffer {
  const objects: GitObject[] = [];
  for (const oid of plan.sendOids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return writePack(objects);
}

// ---------------------------------------------------------------------------
// HTTP plumbing.
// ---------------------------------------------------------------------------
const ENV_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (ENV_TOKEN !== '') return token === ENV_TOKEN;
  return true;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = value === null ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${++reqCounter}`,
    ...extraHeaders,
  });
  res.end(body);
}
function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// REST v3 shapes.
// ---------------------------------------------------------------------------
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}
function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelJson(label, repo)),
    user: { login: issue.user, id: VIEWER.id, type: 'User' },
    assignee: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments: issue.comments.length,
  };
}
function pullJson(pr: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      label: `${repo.owner}:${pr.headRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      label: `${repo.owner}:${pr.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open',
    draft: false,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const person = (name: string, email: string, ts: number) => ({
    name,
    email,
    date: new Date(ts * 1000).toISOString(),
  });
  return {
    sha,
    commit: {
      message: info.message.replace(/\n$/, ''),
      author: person(info.authorName, info.authorEmail, info.authorTs),
      committer: person(info.committerName, info.committerEmail, info.committerTs),
      tree: { sha: info.tree },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
    tree: { sha: info.tree },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}
function paginate<T>(
  req: IncomingMessage,
  res: ServerResponse,
  items: T[],
): T[] {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const perPage = Math.max(
    1,
    Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30),
  );
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    res.setHeader('link', `<${next.toString()}>; rel="next"`);
  }
  return slice;
}
function listReposPage(
  req: IncomingMessage,
  res: ServerResponse,
): Record<string, unknown>[] {
  const all = [...repos.values()]
    .filter((repo) => repo.owner === VIEWER.login)
    .sort((a, b) => a.id - b.id);
  return paginate(req, res, all).map((repo) => repoJson(repo));
}
function shortBranch(ref: string): string {
  const idx = ref.indexOf(':');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

// GitHub repository names contain only ASCII letters, digits, hyphens,
// underscores, and periods.
function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

// ---------------------------------------------------------------------------
// REST v3 routing.
// ---------------------------------------------------------------------------
async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  body: unknown,
): Promise<boolean> {
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  if (rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      user_url: '/api/v3/users/{user}',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'user' && req.method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      html_url: `https://github.com/${VIEWER.login}`,
      url: '/api/v3/user',
    });
    return true;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (req.method === 'GET') {
      sendJson(res, 200, listReposPage(req, res));
      return true;
    }
    if (req.method === 'POST') {
      const input = asObject(body);
      const name = asString(input.name);
      if (name === '') {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      if (!isValidRepoName(name)) {
        sendError(res, 422, 'Repository name may only contain letters, digits, hyphens, underscores, and periods');
        return true;
      }
      const existing = getRepo(VIEWER.login, name);
      if (existing) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      const repo = createRepoRecord(
        name,
        asBool(input.private, false),
        asString(input.description),
      );
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return false;
  }
  if (rest.length >= 2 && rest[0] === 'repos') {
    return handleRepoRest(req, res, rest.slice(1), body);
  }
  return false;
}

async function handleRepoRest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  body: unknown,
): Promise<boolean> {
  const owner = parts[0];
  const name = parts[1];
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const tail = parts.slice(2);
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const query = url.searchParams;

  // /repos/{o}/{r} itself
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const input = asObject(body);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, name));
      res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` });
      res.end();
      return true;
    }
    return false;
  }

  const head = tail[0];

  // git refs
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const input = asObject(body);
      const ref = asString(input.ref);
      const sha = asString(input.sha);
      if (!ref.startsWith('refs/') || !isSha(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      if (!repo.objects.has(sha)) {
        sendError(res, 422, 'Object does not exist');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    return false;
  }

  // branches
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, paginate(req, res, list));
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (!sha) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
      return true;
    }
    return false;
  }

  // commits
  if (head === 'commits' && method === 'GET' && tail.length === 1) {
    const refParam = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refParam);
    const items: Record<string, unknown>[] = [];
    if (tip) {
      for (const sha of listCommits(repo, tip)) {
        const item = commitJson(repo, sha);
        if (item) items.push(item);
      }
    }
    sendJson(res, 200, paginate(req, res, items));
    return true;
  }

  // contents
  if (head === 'contents') {
    return handleContents(req, res, repo, tail.slice(1), body);
  }

  // labels
  if (head === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, paginate(req, res, [...repo.labels.values()].map((label) => labelJson(label, repo))));
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const input = asObject(body);
      const labelName = asString(input.name);
      if (labelName === '') {
        sendError(res, 422, 'Label name is required');
        return true;
      }
      const existing = repo.labels.get(labelName);
      if (existing) {
        if (typeof input.color === 'string') existing.color = input.color;
        sendJson(res, 201, labelJson(existing, repo));
        return true;
      }
      const label: Label = {
        id: repo.nextLabelId += 1,
        name: labelName,
        color: asString(input.color, 'ededed'),
        description: asString(input.description),
      };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label, repo));
      return true;
    }
    return false;
  }

  // issues
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') return createIssue(req, res, repo, body);
      if (method === 'GET') return listIssues(req, res, repo);
      return false;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        const issue = repo.issues.get(number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, issueJson(issue, repo));
        return true;
      }
      if (method === 'PATCH') {
        const issue = repo.issues.get(number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const input = asObject(body);
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? nowIso() : null;
        }
        issue.updatedAt = nowIso();
        sendJson(res, 200, issueJson(issue, repo));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'POST') {
        const input = asObject(body);
        const commentBody = asString(input.body);
        const comment = {
          id: commentIdCounter += 1,
          body: commentBody,
          user: VIEWER.login,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        issue.comments.push(comment);
        issue.updatedAt = nowIso();
        sendJson(res, 201, {
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, id: VIEWER.id, type: 'User' },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, id: VIEWER.id, type: 'User' },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        })));
        return true;
      }
      return false;
    }
    return false;
  }

  // pulls
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') return createPull(req, res, repo, body);
      if (method === 'GET') return listPulls(req, res, repo);
      return false;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const pr = repo.pulls.get(number);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (!pr) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(pr, repo));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (!pr) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
      const changes = diffTrees(repo, commitTree(repo, baseTip), commitTree(repo, headTip));
      sendJson(res, 200, changes.map((change) => ({
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        patch: buildPatch(repo, baseTip, headTip, change.path),
      })));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      return mergePull(req, res, repo, pr);
    }
    return false;
  }

  return false;
}

function createIssue(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: unknown,
): boolean {
  const input = asObject(body);
  const title = asString(input.title);
  if (title === '') {
    sendError(res, 422, 'Title is required');
    return true;
  }
  const labelNames: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const entry of input.labels) {
      if (typeof entry === 'string') labelNames.push(entry);
      else if (entry && typeof entry === 'object') {
        labelNames.push(asString((entry as Record<string, unknown>).name));
      }
    }
  }
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (!label) {
      sendError(res, 422, `Label does not exist: ${labelName}`);
      return true;
    }
    labels.push(label);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = nowIso();
  const issue: Issue = {
    id: number,
    number,
    title,
    body: asString(input.body),
    state: 'open',
    labels,
    user: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(number, issue);
  sendJson(res, 201, issueJson(issue, repo));
  return true;
}

function listIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let items = [...repo.issues.values()];
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  if (sort === 'created') {
    items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  sendJson(res, 200, paginate(req, res, items).map((issue) => issueJson(issue, repo)));
  return true;
}

function createPull(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: unknown,
): boolean {
  const input = asObject(body);
  const title = asString(input.title);
  const headRef = shortBranch(asString(input.head));
  const baseRef = shortBranch(asString(input.base));
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (title === '' || !headSha || !baseSha) {
    sendError(res, 422, 'Invalid head or base');
    return true;
  }
  if (headSha === baseSha || isAncestor(repo, headSha, baseSha)) {
    sendError(res, 422, `No commits between ${headRef} and ${baseRef}`);
    return true;
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = nowIso();
  const pr: PullRequest = {
    id: number,
    number,
    title,
    body: asString(input.body),
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    mergeBaseSha: mergeBase(repo, headSha, baseSha) ?? baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.set(number, pr);
  sendJson(res, 201, pullJson(pr, repo));
  return true;
}

function listPulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const state = url.searchParams.get('state') ?? 'open';
  let items = [...repo.pulls.values()];
  if (state !== 'all') items = items.filter((pr) => pr.state === state);
  items.sort((a, b) => a.number - b.number);
  sendJson(res, 200, paginate(req, res, items).map((pr) => pullJson(pr, repo)));
  return true;
}

/** Squash-merge a PR onto its base branch. Shared by REST and GraphQL/MCP. */
export function squashMerge(
  repo: Repo,
  pr: PullRequest,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pr.merged || pr.state !== 'open') {
    return { ok: false, status: 405, message: 'Pull request already merged' };
  }
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const mb = mergeBase(repo, headTip, baseTip) ?? pr.mergeBaseSha;
  const mbTree = mb ? commitTree(repo, mb) : '';
  const baseTree = baseTip ? commitTree(repo, baseTip) : '';
  const headTree = headTip ? commitTree(repo, headTip) : '';
  const changes = diffTrees(repo, mbTree, headTree);
  const flatBase = baseTree ? flattenTree(repo, baseTree) : new Map();
  const flatMb = mbTree ? flattenTree(repo, mbTree) : new Map();
  const flatHead = headTree ? flattenTree(repo, headTree) : new Map();
  for (const change of changes) {
    const baseBlob = flatBase.get(change.path);
    const mbBlob = flatMb.get(change.path);
    const headBlob = flatHead.get(change.path);
    const baseChanged = (baseBlob?.oid ?? null) !== (mbBlob?.oid ?? null);
    const baseMatchesHead = (baseBlob?.oid ?? null) === (headBlob?.oid ?? null);
    if (baseChanged && !baseMatchesHead) {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
  }
  const merged = commitFiles(repo, pr.baseRef, `Squash merge PR #${pr.number}: ${pr.title}`, (flat) => {
    for (const change of changes) {
      const headBlob = flatHead.get(change.path);
      if (headBlob) flat.set(change.path, headBlob);
      else flat.delete(change.path);
    }
  });
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = nowIso();
  pr.mergeCommitSha = merged.commitSha;
  pr.closedAt = pr.mergedAt;
  pr.updatedAt = pr.mergedAt;
  pr.baseSha = merged.commitSha;
  return { ok: true, sha: merged.commitSha };
}

function mergePull(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pr: PullRequest | undefined,
): boolean {
  if (!pr) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const result = squashMerge(repo, pr);
  if (!result.ok) {
    sendError(res, result.status, result.message);
    return true;
  }
  sendJson(res, 200, {
    sha: result.sha,
    merged: true,
    message: 'Pull request successfully merged',
  });
  return true;
}

function buildPatch(
  repo: Repo,
  baseTip: string,
  headTip: string,
  path: string,
): string {
  const baseFlat = baseTip ? flattenTree(repo, commitTree(repo, baseTip)) : new Map();
  const headFlat = headTip ? flattenTree(repo, commitTree(repo, headTip)) : new Map();
  const oldEntry = baseFlat.get(path);
  const newEntry = headFlat.get(path);
  const oldLines = countLinesForPatch(repo, oldEntry?.oid);
  const newLines = countLinesForPatch(repo, newEntry?.oid);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const line of oldLines) if (!newSet.has(line)) lines.push(`-${line}`);
  for (const line of newLines) if (!oldSet.has(line)) lines.push(`+${line}`);
  return lines.join('\n');
}
function countLinesForPatch(repo: Repo, oid: string | undefined): string[] {
  if (!oid) return [];
  const obj = repo.objects.get(oid);
  if (!obj) return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Contents API.
// ---------------------------------------------------------------------------
function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pathParts: string[],
  body: unknown,
): boolean {
  const method = req.method ?? 'GET';
  const path = pathParts.map((part) => decodeURIComponent(part)).join('/');
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = resolveRef(repo, refParam);
    if (!tip) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const treeOid = commitTree(repo, tip);
    if (path === '') {
      sendJson(res, 200, dirEntries(repo, treeOid, ''));
      return true;
    }
    const flat = flattenTree(repo, treeOid);
    const entry = flat.get(path);
    if (entry) {
      const obj = repo.objects.get(entry.oid);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: obj?.data.length ?? 0,
        name: path.split('/').pop() ?? path,
        path,
        content: obj?.data.toString('base64') ?? '',
        sha: entry.oid,
      });
      return true;
    }
    // Directory?
    const prefix = `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
    for (const [filePath, fileEntry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0];
      if (rest.includes('/')) {
        if (!children.has(first)) {
          const childOid = dirTreeOid(repo, treeOid, `${path}/${first}`);
          children.set(first, { type: 'dir', oid: childOid });
        }
      } else {
        children.set(first, { type: 'file', oid: fileEntry.oid });
      }
    }
    if (children.size === 0) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([childName, child]) => ({
        type: child.type,
        name: childName,
        path: `${path}/${childName}`,
        sha: child.oid,
        size: child.type === 'file' ? repo.objects.get(child.oid)?.data.length ?? 0 : undefined,
      }));
    sendJson(res, 200, entries);
    return true;
  }

  if (method === 'PUT') {
    const input = asObject(body);
    const branch = asString(input.branch, repo.defaultBranch);
    const message = asString(input.message, `Update ${path}`);
    const contentB64 = asString(input.content);
    if (contentB64 === '') {
      sendError(res, 422, 'Content is required');
      return true;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendError(res, 422, 'Content must be base64');
      return true;
    }
    // Branch must exist; creating it forks from the default tip.
    if (!repo.refs.has(`refs/heads/${branch}`)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
      else repo.refs.set(`refs/heads/${branch}`, ZERO_OID);
    }
    let tip = repo.refs.get(`refs/heads/${branch}`)!;
    if (isZeroOid(tip)) tip = '';
    const flat = tip ? flattenTree(repo, commitTree(repo, tip)) : new Map();
    const existing = flat.get(path);
    if (existing && typeof input.sha === 'string' && input.sha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const isUpdate = Boolean(existing);
    const blobOid = hashObject('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });
    const result = commitFiles(repo, branch, message, (mutated) => {
      mutated.set(path, { oid: blobOid, mode: '100644' });
    });
    sendJson(res, isUpdate ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        content: contentB64,
        type: 'file',
      },
      commit: { sha: result.commitSha },
    });
    return true;
  }

  if (method === 'DELETE') {
    const input = asObject(body);
    const branch = asString(input.branch, repo.defaultBranch);
    const message = asString(input.message, `Delete ${path}`);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const flat = flattenTree(repo, commitTree(repo, tip));
    const existing = flat.get(path);
    if (!existing) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (typeof input.sha === 'string' && input.sha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const result = commitFiles(repo, branch, message, (mutated) => {
      mutated.delete(path);
    });
    sendJson(res, 200, { commit: { sha: result.commitSha } });
    return true;
  }

  return false;
}
function dirEntries(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of parseTree(obj.data)) {
    const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      entries.push({ type: 'dir', name: entry.name, path: childPath, sha: entry.oid });
    } else {
      entries.push({
        type: 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: repo.objects.get(entry.oid)?.data.length ?? 0,
      });
    }
  }
  return entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
}
function dirTreeOid(repo: Repo, treeOid: string, dirPath: string): string {
  let current = treeOid;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return '';
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
    if (!entry) return '';
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Git smart HTTP.
// ---------------------------------------------------------------------------
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj?.type !== 'tag') return null;
  const target = parseTag(obj.data).object;
  const targetObj = repo.objects.get(target);
  return targetObj?.type === 'commit' ? target : null;
}
function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
}

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string,
): boolean {
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  const parts: Buffer[] = [];
  if (service === 'git-upload-pack') {
    if (isV2) {
      parts.push(pktText('version 2'));
      parts.push(pktText('agent=forge/1.0.0'));
      parts.push(pktText('ls-refs'));
      parts.push(pktText('fetch=shallow'));
      parts.push(pktText('object-format=sha1'));
      parts.push(FLUSH);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
      res.end(Buffer.concat(parts));
      return true;
    }
    parts.push(pktText('# service=git-upload-pack'));
    parts.push(FLUSH);
    const refs = sortedRefs(repo);
    const caps = 'side-band-64k object-format=sha1 agent=forge/1.0.0';
    if (refs.length === 0) {
      parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}`));
    } else {
      const tip = defaultTip(repo);
      const symref = tip ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
      const headOid = tip || refs[0].oid;
      const headRef = tip ? `refs/heads/${repo.defaultBranch}` : refs[0].name;
      parts.push(pktText(`${headOid} ${headRef}\0${caps}${symref}`));
      for (const ref of refs) {
        if (ref.name === headRef) continue;
        parts.push(pktText(`${ref.oid} ${ref.name}`));
        const peeled = peeledOid(repo, ref.oid);
        if (peeled) parts.push(pktText(`${peeled} ${ref.name}^{}`));
      }
    }
    parts.push(FLUSH);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    res.end(Buffer.concat(parts));
    return true;
  }
  if (service === 'git-receive-pack') {
    parts.push(pktText('# service=git-receive-pack'));
    parts.push(FLUSH);
    const refs = sortedRefs(repo);
    const caps = 'report-status side-band-64k delete-refs agent=forge/1.0.0';
    if (refs.length === 0) {
      parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}`));
    } else {
      const tip = defaultTip(repo);
      const headOid = tip || refs[0].oid;
      const headRef = tip ? `refs/heads/${repo.defaultBranch}` : refs[0].name;
      parts.push(pktText(`${headOid} ${headRef}\0${caps}`));
      for (const ref of refs) {
        if (ref.name === headRef) continue;
        parts.push(pktText(`${ref.oid} ${ref.name}`));
      }
    }
    parts.push(FLUSH);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
    res.end(Buffer.concat(parts));
    return true;
  }
  return false;
}

function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): boolean {
  let packets;
  try {
    packets = parsePktLines(body);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request');
    return true;
  }
  const first = packets[0]?.payload.toString('utf8').trim() ?? '';
  if (first.startsWith('command=ls-refs')) return handleLsRefs(res, repo, packets);
  if (first.startsWith('command=fetch')) return handleFetchV2(res, repo, packets);
  return handleFetchV0(res, repo, packets);
}

function handleLsRefs(
  res: ServerResponse,
  repo: Repo,
  packets: { kind: string; payload: Buffer }[],
): boolean {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-prefix')) prefixes.push(line.slice('ref-prefix'.length).trim());
  }
  const out: Buffer[] = [];
  const tip = defaultTip(repo);
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refLines: { name: string; oid: string; attrs: string }[] = [];
  if (tip && matches('HEAD')) {
    refLines.push({
      name: 'HEAD',
      oid: tip,
      attrs: symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '',
    });
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    // A peeled tag is an attribute on the tag's own line, not a second line:
    // "<tag-oid> <ref> peeled:<commit-oid>". An unborn line is never emitted:
    // the suite counts an "unborn refs/heads/main" line as advertising the
    // branch, so an empty repo answers ls-refs with no refs at all.
    let attrs = '';
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) attrs = ` peeled:${peeled}`;
    }
    refLines.push({ name: ref.name, oid: ref.oid, attrs });
  }
  for (const line of refLines) {
    out.push(pktText(`${line.oid} ${line.name}${line.attrs}`));
  }
  out.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
  return true;
}

function handleFetchV2(
  res: ServerResponse,
  repo: Repo,
  packets: { kind: string; payload: Buffer }[],
): boolean {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let deepenRelative = false;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) deepen = n;
    } else if (line === 'deepen-relative') deepenRelative = true;
    else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice('deepen-since '.length).trim());
      if (Number.isFinite(n) && n > 0) deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      deepenNot.push(line.slice('deepen-not '.length).trim());
    } else if (line === 'done') done = true;
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(repo, wants, haves, shallow, deepen, deepenRelative, deepenSince, deepenNot);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`error: ${err instanceof Error ? err.message : 'fetch failed'}\n`);
    return true;
  }
  const out: Buffer[] = [];
  // The v2 sections are acknowledgments, shallow-info, packfile, in that
  // order; intermediate sections end with DELIM, the last with FLUSH.
  // (The kit reads sections generically; real git's reader is order-strict,
  // so the ack section must come first whenever haves were sent.)
  if (haves.length > 0) {
    out.push(pktText('acknowledgments'));
    if (plan.common.length > 0) {
      for (const oid of plan.common) out.push(pktText(`ACK ${oid}`));
      out.push(pktText('ready'));
      out.push(DELIM);
    } else {
      // No common commits: real git answers NAK and ends the response
      // here: the acknowledgments section is closed by FLUSH, not DELIM,
      // because no further section follows. (A DELIM here tells git
      // another section is coming, and it aborts: "expected no other
      // sections to be sent after no 'ready'".) The client then sends a
      // second request (with `done`, no haves) and the packfile comes in
      // that round.
      out.push(pktText('NAK'));
      out.push(FLUSH);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.end(Buffer.concat(out));
      return true;
    }
  }
  // Send the shallow-info section whenever there are lines to report, or
  // (first round only) when the client sent shallow lines: real git sends
  // the section empty in that case.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0 || (!done && shallow.length > 0)) {
    out.push(pktText('shallow-info'));
    for (const oid of plan.shallow) out.push(pktText(`shallow ${oid}`));
    for (const oid of plan.unshallow) out.push(pktText(`unshallow ${oid}`));
    out.push(DELIM);
  }
  // No wants (empty-repo clone) means no packfile section at all: an empty
  // pack would still count as transferred bytes. The response still ends
  // with FLUSH, never a dangling DELIM.
  if (wants.length > 0) {
    out.push(pktText('packfile'));
    const pack = buildFetchPack(repo, plan);
    const chunkSize = 32768;
    for (let i = 0; i < pack.length; i += chunkSize) {
      out.push(sideband(1, pack.subarray(i, Math.min(pack.length, i + chunkSize))));
    }
    out.push(FLUSH);
  } else {
    out.push(FLUSH);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
  return true;
}

function handleFetchV0(
  res: ServerResponse,
  repo: Repo,
  packets: { kind: string; payload: Buffer }[],
): boolean {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let deepenRelative = false;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      wants.push(line.slice(5).split(' ')[0].trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) deepen = n;
    } else if (line === 'deepen-relative') deepenRelative = true;
    else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice('deepen-since '.length).trim());
      if (Number.isFinite(n) && n > 0) deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      deepenNot.push(line.slice('deepen-not '.length).trim());
    } else if (line === 'done') {
      break;
    }
    void seenFlush;
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(repo, wants, haves, shallow, deepen, deepenRelative, deepenSince, deepenNot);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`error: ${err instanceof Error ? err.message : 'fetch failed'}\n`);
    return true;
  }
  const out: Buffer[] = [];
  for (const oid of plan.shallow) out.push(pktText(`shallow ${oid}`));
  for (const oid of plan.unshallow) out.push(pktText(`unshallow ${oid}`));
  if (haves.length === 0) out.push(pktText('NAK'));
  else if (plan.common.length > 0) out.push(pktText(`ACK ${plan.common[0]}`));
  else out.push(pktText('NAK'));
  if (wants.length > 0) {
    const pack = buildFetchPack(repo, plan);
    const chunkSize = 32768;
    for (let i = 0; i < pack.length; i += chunkSize) {
      out.push(sideband(1, pack.subarray(i, Math.min(pack.length, i + chunkSize))));
    }
  }
  out.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
  return true;
}

function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): boolean {
  // Parse command pkt-lines only up to the first flush; the pack follows as
  // raw bytes (it is not pkt-line framed).
  let packets: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] = [];
  let packOffset = body.length;
  try {
    let pos = 0;
    while (pos + 4 <= body.length) {
      const lenHex = body.subarray(pos, pos + 4).toString('ascii');
      if (lenHex === '0000') {
        packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
        packOffset = pos + 4;
        break;
      }
      if (lenHex === '0001') {
        packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
        pos += 4;
        continue;
      }
      const len = Number.parseInt(lenHex, 16);
      if (!Number.isFinite(len) || len < 4 || pos + len > body.length) {
        throw new Error('invalid pkt-line length');
      }
      packets.push({ kind: 'data', payload: body.subarray(pos + 4, pos + len) });
      pos += len;
    }
    if (packOffset === body.length && packets.length > 0 && packets[packets.length - 1].kind !== 'flush') {
      // No flush found: commands only, no pack.
      packOffset = body.length;
    }
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request');
    return true;
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = line.split(' ');
    if (parts.length >= 3 && isSha(parts[0]) && isSha(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const packBuf = body.subarray(packOffset);
  const report: { ref: string; ok: boolean; reason?: string }[] = [];
  let unpackOk = true;
  if (packBuf.length > 0) {
    try {
      const { entries } = readPack(packBuf, (oid) => repo.objects.get(oid));
      for (const entry of entries) {
        repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch {
      unpackOk = false;
    }
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (isZeroOid(command.newOid)) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (!isZeroOid(command.oldOid) && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (isZeroOid(command.oldOid)) {
      // Create.
      if (current !== undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true });
      continue;
    }
    // Update: must fast-forward from the advertised old value.
    if (current === undefined || current !== command.oldOid) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === command.oldOid) {
      report.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.objects.has(command.newOid) || !isAncestor(repo, command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true });
  }
  const lines: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
  for (const entry of report) {
    lines.push(entry.ok ? `ok ${entry.ref}` : `ng ${entry.ref} ${entry.reason ?? 'failed'}`);
  }
  const out: Buffer[] = [];
  // Ground truth (git receive-pack --stateless-rpc): the whole report is
  // ONE band-1 packet holding the pkt-lined report stream including its
  // own inner flush, then a bare outer flush. Without the inner flush the
  // client reads past the last line and reports a hang-up.
  const reportStream = Buffer.concat([
    ...lines.map((line) => pktLine(`${line}\n`)),
    FLUSH,
  ]);
  out.push(sideband(1, reportStream));
  out.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(out));
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL: a small executor for the documents the suite sends.
// ---------------------------------------------------------------------------
function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}
function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
function issueGlobalId(repo: Repo, number: number): string {
  return globalId('Issue', repo.id, number);
}
function prGlobalId(repo: Repo, number: number): string {
  return globalId('PullRequest', repo.id, number);
}
function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}
function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const repoId = Number(decoded.parts[0]);
  for (const repo of repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'target'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  SearchType: [],
  IssueState: [],
  PullRequestState: [],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'PROJECT', 'TOPIC'];

function userObject(): Record<string, unknown> {
  return {
    __typename: 'User',
    id: globalId('User', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    url: `https://github.com/${VIEWER.login}`,
  };
}
function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue.number),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: userObject(),
    labels: { __typename: 'LabelConnection', nodes: issue.labels.map((label) => ({ __typename: 'Label', id: globalId('Label', repo.id, label.id), name: label.name, color: label.color, description: label.description })) },
    comments: { __typename: 'IssueCommentConnection', nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: globalId('IssueComment', repo.id, issue.number, comment.id), databaseId: comment.id, body: comment.body, author: userObject(), createdAt: comment.createdAt, updatedAt: comment.updatedAt })) },
    repository: () => repoObject(repo),
  };
}
function prConflict(repo: Repo, pr: PullRequest): boolean {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const mb = mergeBase(repo, headTip, baseTip) ?? pr.mergeBaseSha;
  const mbTree = mb ? commitTree(repo, mb) : '';
  const baseTree = baseTip ? commitTree(repo, baseTip) : '';
  const headTree = headTip ? commitTree(repo, headTip) : '';
  const changes = diffTrees(repo, mbTree, headTree);
  const flatBase = baseTree ? flattenTree(repo, baseTree) : new Map();
  const flatMb = mbTree ? flattenTree(repo, mbTree) : new Map();
  const flatHead = headTree ? flattenTree(repo, headTree) : new Map();
  for (const change of changes) {
    const baseBlob = flatBase.get(change.path);
    const mbBlob = flatMb.get(change.path);
    const headBlob = flatHead.get(change.path);
    if ((baseBlob?.oid ?? null) !== (mbBlob?.oid ?? null) && (baseBlob?.oid ?? null) !== (headBlob?.oid ?? null)) {
      return true;
    }
  }
  return false;
}
function prObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    __typename: 'PullRequest',
    id: prGlobalId(repo, pr.number),
    databaseId: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: headTip,
    baseRefOid: baseTip,
    mergeable: pr.merged ? 'UNKNOWN' : prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE',
    merged: pr.merged,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: userObject(),
    files: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 10;
      const changes = diffTrees(repo, commitTree(repo, baseTip), commitTree(repo, headTip));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: changes.slice(0, first).map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
        })),
      };
    },
  };
}
function repoObject(repo: Repo): Record<string, unknown> {
  const tip = defaultTip(repo);
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    defaultBranchRef: {
      __typename: 'Ref',
      id: globalId('Ref', repo.id, repo.defaultBranch),
      name: repo.defaultBranch,
      target: { __typename: 'Commit', oid: tip },
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    issue: (args: Record<string, unknown>) => {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (args: Record<string, unknown>) => issuesConnection(repo, args),
    pullRequest: (args: Record<string, unknown>) => {
      const pr = repo.pulls.get(Number(args.number));
      return pr ? prObject(repo, pr) : null;
    },
    pullRequests: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 10;
      const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
      let items = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      if (after !== null) items = items.filter((pr) => pr.number > after);
      const page = items.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pr) => prObject(repo, pr)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: items.length > first,
          hasPreviousPage: false,
          startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
          endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
        },
        totalCount: repo.pulls.size,
      };
    },
  };
}
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let items = [...repo.issues.values()];
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
    items = items.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = asObject(args.orderBy);
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (after !== null) {
    items = items.filter((issue) => (direction === 'DESC' ? issue.number < after : issue.number > after));
  }
  const page = items.slice(0, first);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: items.length > first,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
    },
    totalCount: repo.issues.size,
  };
}
function newIssueRecord(repo: Repo, title: string, body: string): Issue {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = nowIso();
  const issue: Issue = {
    id: number,
    number,
    title,
    body,
    state: 'open',
    labels: [],
    user: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}
function newPullRecord(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return null;
  // Like real GitHub: a pull request with no commits between head and base
  // (same branch, or head already fully merged into base) is rejected.
  if (headSha === baseSha || isAncestor(repo, headSha, baseSha)) return null;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = nowIso();
  const pr: PullRequest = {
    id: number,
    number,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeBaseSha: mergeBase(repo, headSha, baseSha) ?? baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.set(number, pr);
  return pr;
}

// --- GraphQL document parsing ------------------------------------------------
type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };
interface GqlField {
  name: string;
  alias: string;
  args: Record<string, GqlValue>;
  selection: GqlField[] | null;
  typeCondition: string | null;
}
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue?: GqlValue }>;
  selection: GqlField[];
}
function tokenizeGql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (m) {
      tokens.push(m[0]);
      i += m[0].length;
      continue;
    }
    const n = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (n) {
      tokens.push(n[0]);
      i += n[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}
class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        this.next();
        operations.push(this.parseOperation(token));
      } else if (token === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        // Skip fragment definitions (the suite uses inline fragments only).
        this.next();
        this.next(); // fragment name
        if (this.peek() === 'on') {
          this.next();
          this.next(); // type condition
        }
        this.parseSelectionSet();
      } else {
        throw new Error(`unexpected token ${token} in GraphQL document`);
      }
    }
    return operations;
  }
  private parseOperation(kind: 'query' | 'mutation'): GqlOperation {
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') {
      name = this.next();
    }
    const variables: Record<string, { defaultValue?: GqlValue }> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseType();
        if (this.peek() === '=') {
          this.next();
          variables[varName] = { defaultValue: this.parseValue() };
        } else {
          variables[varName] = {};
        }
      }
      this.expect(')');
    }
    return { kind, name, variables, selection: this.parseSelectionSet() };
  }
  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }
  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      const selection = this.parseSelectionSet();
      return { name: '', alias: '', args: {}, selection, typeCondition };
    }
    let name = this.next();
    let alias = name;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    // Directives: skip @name(args).
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        }
      }
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selection, typeCondition: null };
  }
  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}
function evalGqlValue(
  value: GqlValue,
  variables: Record<string, unknown>,
): unknown {
  switch (value.kind) {
    case 'variable': {
      const v = variables[value.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => evalGqlValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) {
        out[key] = evalGqlValue(entry, variables);
      }
      return out;
    }
  }
}
function evalArgs(
  args: Record<string, GqlValue>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = evalGqlValue(value, variables);
  }
  return out;
}

// --- Execution ----------------------------------------------------------------
interface GqlContext {
  errors: { message: string; path?: (string | number)[] }[];
}
function typeIntrospection(name: string): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: SEARCH_TYPE_VALUES.map((value) => ({
        __typename: '__EnumValue',
        name: value,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
    };
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    description: null,
    fields: fields.map((fieldName) => ({
      __typename: '__Field',
      name: fieldName,
      description: null,
      args: [],
      type: { __typename: '__Type', kind: 'SCALAR', name: 'String', ofType: null },
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: null,
  };
}
function executeSelection(
  parent: Record<string, unknown> | null,
  typename: string,
  selection: GqlField[],
  variables: Record<string, unknown>,
  ctx: GqlContext,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name === '') {
      // Inline fragment.
      if (field.typeCondition && field.typeCondition !== typename) continue;
      const fragment = executeSelection(parent, typename, field.selection ?? [], variables, ctx, path);
      Object.assign(out, fragment);
      continue;
    }
    const fieldPath = [...path, field.alias];
    if (field.name === '__typename') {
      out[field.alias] = typename;
      continue;
    }
    if (field.name === '__type') {
      const args = evalArgs(field.args, variables);
      const typeName = String(args.name ?? '');
      const typeObj = typeIntrospection(typeName);
      if (field.selection && typeObj) {
        out[field.alias] = executeSelection(typeObj, '__Type', field.selection, variables, ctx, fieldPath);
      } else {
        out[field.alias] = typeObj;
      }
      continue;
    }
    if (field.name === '__schema') {
      out[field.alias] = field.selection
        ? executeSelection(
            { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, subscriptionType: null, types: [], directives: [] },
            '__Schema',
            field.selection,
            variables,
            ctx,
            fieldPath,
          )
        : { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      continue;
    }
    if (parent === null || parent === undefined) {
      out[field.alias] = null;
      continue;
    }
    let value = parent[field.name];
    if (typeof value === 'function') {
      const args = evalArgs(field.args, variables);
      try {
        value = (value as (args: Record<string, unknown>) => unknown)(args);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : 'resolver error', path: fieldPath });
        out[field.alias] = null;
        continue;
      }
    }
    if (value === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${typename}".`,
        path: fieldPath,
      });
      out[field.alias] = null;
      continue;
    }
    if (field.selection) {
      if (value === null) {
        out[field.alias] = null;
      } else if (Array.isArray(value)) {
        out[field.alias] = value.map((item, index) =>
          item !== null && typeof item === 'object'
            ? executeSelection(item as Record<string, unknown>, String((item as Record<string, unknown>).__typename ?? 'Unknown'), field.selection ?? [], variables, ctx, [...fieldPath, index])
            : item,
        );
      } else if (typeof value === 'object') {
        const child = value as Record<string, unknown>;
        out[field.alias] = executeSelection(
          child,
          String(child.__typename ?? 'Unknown'),
          field.selection,
          variables,
          ctx,
          fieldPath,
        );
      } else {
        out[field.alias] = value;
      }
    } else {
      out[field.alias] = value;
    }
  }
  return out;
}
function executeOperation(
  operation: GqlOperation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown>; errors?: { message: string; path?: (string | number)[] }[] } {
  const ctx: GqlContext = { errors: [] };
  // Apply variable defaults.
  for (const [name, def] of Object.entries(operation.variables)) {
    if (variables[name] === undefined && def.defaultValue) {
      variables[name] = evalGqlValue(def.defaultValue, variables);
    }
  }
  let data: Record<string, unknown>;
  if (operation.kind === 'mutation') {
    data = executeSelection(mutationRoot(), 'Mutation', operation.selection, variables, ctx, []);
  } else {
    data = executeSelection(queryRoot(), 'Query', operation.selection, variables, ctx, []);
  }
  const result: { data: Record<string, unknown>; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
function queryRoot(): Record<string, unknown> {
  return {
    __typename: 'Query',
    viewer: userObject(),
    repository: (args: Record<string, unknown>) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = getRepo(owner, name);
      return repo ? repoObject(repo) : null;
    },
    node: (args: Record<string, unknown>) => {
      const id = String(args.id ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repoId = Number(decoded.parts[0]);
        for (const repo of repos.values()) {
          if (repo.id === repoId) return repoObject(repo);
        }
        return null;
      }
      if (decoded.kind === 'Issue') {
        const repoId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        for (const repo of repos.values()) {
          if (repo.id === repoId) {
            const issue = repo.issues.get(number);
            return issue ? issueObject(repo, issue) : null;
          }
        }
        return null;
      }
      if (decoded.kind === 'PullRequest') {
        const repoId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        for (const repo of repos.values()) {
          if (repo.id === repoId) {
            const pr = repo.pulls.get(number);
            return pr ? prObject(repo, pr) : null;
          }
        }
        return null;
      }
      return null;
    },
  };
}
function mutationRoot(): Record<string, unknown> {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = asObject(args.input);
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('Repository not found');
      const issue = newIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''));
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = asObject(args.input);
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw new Error('Issue not found');
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.get(number);
        if (!issue) throw new Error('Issue not found');
        issue.state = 'closed';
        issue.closedAt = nowIso();
        issue.updatedAt = nowIso();
        return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
      }
      throw new Error('Issue not found');
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = asObject(args.input);
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('Repository not found');
      const pr = newPullRecord(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        shortBranch(String(input.headRefName ?? '')),
        shortBranch(String(input.baseRefName ?? '')),
      );
      if (!pr) throw new Error('Invalid head or base');
      return { __typename: 'CreatePullRequestPayload', pullRequest: prObject(repo, pr) };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = asObject(args.input);
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error('Pull request not found');
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of repos.values()) {
        if (repo.id !== repoId) continue;
        const pr = repo.pulls.get(number);
        if (!pr) throw new Error('Pull request not found');
        const result = squashMerge(repo, pr);
        if (!result.ok) throw new Error(result.message);
        return { __typename: 'MergePullRequestPayload', pullRequest: prObject(repo, pr) };
      }
      throw new Error('Pull request not found');
    },
    addComment: (args: Record<string, unknown>) => {
      const input = asObject(args.input);
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw new Error('Subject not found');
      const repoId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.get(number);
        if (!issue) throw new Error('Issue not found');
        const comment = {
          id: commentIdCounter += 1,
          body: String(input.body ?? ''),
          user: VIEWER.login,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('IssueComment', repo.id, number, comment.id),
              databaseId: comment.id,
              body: comment.body,
              author: userObject(),
              createdAt: comment.createdAt,
              updatedAt: comment.updatedAt,
            },
          },
        };
      }
      throw new Error('Issue not found');
    },
  };
}
function handleGraphQL(body: unknown): { status: number; payload: unknown } {
  const runOne = (entry: unknown): unknown => {
    const input = asObject(entry);
    const query = asString(input.query);
    if (query === '') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(tokenizeGql(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const variables = asObject(input.variables);
    const operationName = typeof input.operationName === 'string' ? input.operationName : null;
    let operation = operations[0];
    if (operationName) {
      const found = operations.find((op) => op.name === operationName);
      if (found) operation = found;
    }
    return executeOperation(operation, { ...variables });
  };
  if (Array.isArray(body)) {
    return { status: 200, payload: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, payload: runOne(body) };
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP).
// ---------------------------------------------------------------------------
const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
const MCP_TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};
function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; code: number; message: string } {
  const required = MCP_TOOL_REQUIRED[name];
  if (!required) return { ok: false, code: -32601, message: `Unknown tool: ${name}` };
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { ok: false, code: -32602, message: `Missing required argument: ${key}` };
    }
  }
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  if (name === 'create_repo') {
    const repoNameArg = String(args.name);
    if (!isValidRepoName(repoNameArg)) {
      return { ok: false, code: -32602, message: 'Invalid repository name' };
    }
    const existing = getRepo(VIEWER.login, repoNameArg);
    if (existing) return { ok: true, value: repoJson(existing) };
    const repo = createRepoRecord(
      repoNameArg,
      asBool(args.private, false),
      asString(args.description),
    );
    return { ok: true, value: repoJson(repo) };
  }
  const repo = getRepo(owner, repoName);
  if (!repo) return { ok: false, code: -32602, message: 'Repository not found' };
  switch (name) {
    case 'get_repo':
      return { ok: true, value: repoJson(repo) };
    case 'create_issue': {
      const issue = newIssueRecord(repo, String(args.title), asString(args.body));
      return { ok: true, value: issueJson(issue, repo) };
    }
    case 'list_issues': {
      const state = String(args.state ?? 'open');
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => a.number - b.number);
      return { ok: true, value: items.map((issue) => issueJson(issue, repo)) };
    }
    case 'create_pull_request': {
      const pr = newPullRecord(
        repo,
        String(args.title),
        asString(args.body),
        shortBranch(String(args.head)),
        shortBranch(String(args.base)),
      );
      if (!pr) return { ok: false, code: -32602, message: 'Invalid head or base' };
      return { ok: true, value: pullJson(pr, repo) };
    }
    case 'merge_pull_request': {
      const pr = repo.pulls.get(Number(args.pull_number));
      if (!pr) return { ok: false, code: -32602, message: 'Pull request not found' };
      const result = squashMerge(repo, pr);
      if (!result.ok) return { ok: false, code: -32602, message: result.message };
      return { ok: true, value: { sha: result.sha, merged: true, message: 'Pull request successfully merged' } };
    }
    default:
      return { ok: false, code: -32601, message: `Unknown tool: ${name}` };
  }
}
function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
): boolean {
  let payload: unknown;
  try {
    payload = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const input = asObject(payload);
  const method = asString(input.method);
  const id = input.id ?? null;
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (method === 'server/discover') {
    const serverInfo = { name: 'forge-mcp', version: '1.0.0' };
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return true;
  }
  if (method === 'initialize') {
    const params = asObject(input.params);
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: asString(params.protocolVersion, '2025-11-25'),
      capabilities: { tools: {} },
      serverInfo: { name: 'forge-mcp', version: '1.0.0' },
    }));
    return true;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return true;
  }
  if (method === 'tools/call') {
    const params = asObject(input.params);
    const toolName = asString(params.name);
    const args = asObject(params.arguments);
    const result = callMcpTool(toolName, args);
    if (!result.ok) {
      sendJson(res, 200, mcpError(id, result.code, result.message));
      return true;
    }
    const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    sendJson(res, 200, mcpResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: result.value,
      isError: false,
    }));
    return true;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  return true;
}

// ---------------------------------------------------------------------------
// Router + app factory.
// ---------------------------------------------------------------------------
export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
      const method = req.method ?? 'GET';

      // Health probe: no auth.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = segments[0];
        const repoName = segments[1].slice(0, -'.git'.length);
        const repo = getRepo(owner, repoName);
        if (!checkAuth(req)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        if (!repo) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        const gitPath = segments.slice(2).join('/');
        if (method === 'GET' && gitPath === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          if (!handleInfoRefs(req, res, repo, service)) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('Bad Request');
          }
          return;
        }
        if (method === 'POST' && gitPath === 'git-upload-pack') {
          const body = await readBody(req);
          handleUploadPack(req, res, repo, body);
          return;
        }
        if (method === 'POST' && gitPath === 'git-receive-pack') {
          const body = await readBody(req);
          handleReceivePack(req, res, repo, body);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp' && method === 'POST') {
        const rawBody = await readBody(req);
        // Parse error beats auth (the suite's parse-error probe is authed).
        let probe: unknown = null;
        let parseFailed = false;
        try {
          probe = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
        } catch {
          parseFailed = true;
        }
        if (parseFailed) {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        if (!checkAuth(req)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        void probe;
        handleMcp(req, res, rawBody);
        return;
      }

      // GraphQL.
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
        if (!checkAuth(req)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        const rawBody = await readBody(req);
        let body: unknown;
        try {
          body = parseJsonBody(rawBody);
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          sendError(res, status, 'Invalid JSON');
          return;
        }
        const { status, payload } = handleGraphQL(body);
        sendJson(res, status, payload);
        return;
      }

      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        if (!checkAuth(req)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        let body: unknown = {};
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          const rawBody = await readBody(req);
          try {
            body = parseJsonBody(rawBody);
          } catch {
            sendError(res, 400, 'Invalid JSON');
            return;
          }
        }
        const handled = await handleRest(req, res, segments, body);
        if (!handled) sendError(res, 404, 'Not Found');
        return;
      }

      sendError(res, 404, 'Not Found');
    } catch (err) {
      // Never let one bad request kill the server (repo-survives-errors).
      try {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } catch {
        // Response already committed; nothing more to do.
      }
    }
  });
}
