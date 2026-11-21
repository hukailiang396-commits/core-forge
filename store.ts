// Core Forge — in-memory store, git object model, pack codec.
// Node standard library only. No wall clock, no randomness: every id and
// timestamp is sequential or fixed, so a replay leaves identical state.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const FIXED_EPOCH = 1700000000; // git author/committer timestamp
export const FIXED_DATE = '2026-01-01T00:00:00Z'; // JSON created_at/updated_at
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;
export const STRANGER_LOGIN = 'olgabauer';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  nextComment: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextSeq = 1;
  reqSeq = 1;

  key(owner: string, name: string): string {
    return owner + '/' + name;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      nextComment: 1,
      objects: new Map(),
      refs: new Map(),
      seq: this.nextSeq,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  nextRequestId(): string {
    const id = 'req-' + this.reqSeq;
    this.reqSeq += 1;
    return id;
  }
}

// ---------------------------------------------------------------- git objects

export function oidOf(type: ObjType, data: Buffer): string {
  const head = Buffer.from(type + ' ' + data.length + '\0', 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  let out = 'tree ' + tree + '\n';
  for (const p of parents) out += 'parent ' + p + '\n';
  out += 'author ' + author + '\n';
  out += 'committer ' + committer + '\n';
  out += '\n' + message;
  return Buffer.from(out, 'utf8');
}

export function ident(name: string, email: string): string {
  return name + ' <' + email + '> ' + FIXED_EPOCH + ' +0000';
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.toString('ascii', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Walk a tree path; returns the oid of the final entry, or null. */
export function lookupPath(repo: Repo, rootTree: string, path: string): { oid: string; type: ObjType } | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  let oid = rootTree;
  let type: ObjType = 'tree';
  for (const seg of segments) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry) return null;
    oid = entry.oid;
    type = entry.mode === '40000' ? 'tree' : 'blob';
  }
  return { oid, type };
}

/** List the entries of the tree at `path` ('' = root). Null when not a tree. */
export function listTree(repo: Repo, rootTree: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') {
    const obj = repo.objects.get(rootTree);
    return obj && obj.type === 'tree' ? parseTree(obj.data) : null;
  }
  const found = lookupPath(repo, rootTree, path);
  if (!found || found.type !== 'tree') return null;
  const obj = repo.objects.get(found.oid);
  return obj ? parseTree(obj.data) : null;
}

/** Apply file changes onto a tree, returning the new root tree oid. */
export function updateTree(
  repo: Repo,
  treeOid: string | null,
  segments: string[],
  content: Buffer | null,
): string {
  const entries = new Map<string, TreeEntry>();
  if (treeOid) {
    const obj = repo.objects.get(treeOid);
    if (obj && obj.type === 'tree') {
      for (const e of parseTree(obj.data)) entries.set(e.name, e);
    }
  }
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (content === null) entries.delete(head);
    else entries.set(head, { mode: '100644', name: head, oid: putObject(repo, 'blob', content) });
  } else {
    const child = entries.get(head);
    const childTree = child && child.mode === '40000' ? child.oid : null;
    if (content === null && !child) return treeOid ?? putObject(repo, 'tree', buildTree([]));
    const newChild = updateTree(repo, childTree, rest, content);
    const childObj = repo.objects.get(newChild);
    if (childObj && childObj.type === 'tree' && parseTree(childObj.data).length === 0) {
      entries.delete(head);
    } else {
      entries.set(head, { mode: '40000', name: head, oid: newChild });
    }
  }
  return putObject(repo, 'tree', buildTree([...entries.values()]));
}

/** Create a commit on top of `parent` (null for root) applying file changes. */
export function commitFiles(
  repo: Repo,
  parent: string | null,
  changes: Array<{ path: string; content: Buffer | null }>,
  message: string,
  authorName: string,
  authorEmail: string,
): string {
  let rootTree: string | null = null;
  if (parent) {
    const obj = repo.objects.get(parent);
    if (obj && obj.type === 'commit') rootTree = parseCommit(obj.data).tree;
  }
  for (const change of changes) {
    rootTree = updateTree(repo, rootTree, change.path.split('/').filter((s) => s.length > 0), change.content);
  }
  const author = ident(authorName, authorEmail);
  const data = buildCommit(rootTree ?? putObject(repo, 'tree', buildTree([])), parent ? [parent] : [], author, author, message);
  return putObject(repo, 'commit', data);
}

// ---------------------------------------------------------------- reachability

export interface ReachResult {
  objects: Map<string, GitObject>;
  boundary: string[];
}

/** All objects reachable from `tips`, optionally limited to `depth` commit generations
 *  (depth 1 = the tips only). `exclude` oids (already held by the client) are not
 *  returned, but traversal still passes through them for ancestry. */
export function reachable(
  repo: Repo,
  tips: string[],
  opts: { depth?: number; exclude?: Set<string>; stopAt?: Set<string> } = {},
): ReachResult {
  const objects = new Map<string, GitObject>();
  const boundary: string[] = [];
  const depth = opts.depth ?? 0;
  const exclude = opts.exclude ?? new Set<string>();
  const stopAt = opts.stopAt ?? new Set<string>();
  const visitedCommits = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const tip of tips) {
    const obj = repo.objects.get(tip);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const peeled = peelTag(repo, tip);
      if (peeled) queue.push({ oid: peeled, d: 1 });
      collectObject(repo, objects, tip, exclude);
    } else if (obj.type === 'commit') {
      queue.push({ oid: tip, d: 1 });
    } else {
      collectObject(repo, objects, tip, exclude);
    }
  }
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visitedCommits.has(item.oid)) continue;
    visitedCommits.add(item.oid);
    const obj = repo.objects.get(item.oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    collectObject(repo, objects, item.oid, exclude);
    collectTree(repo, objects, commit.tree, exclude);
    const atLimit = depth > 0 && item.d >= depth;
    if (atLimit) {
      boundary.push(item.oid);
      continue;
    }
    // A shallow boundary contributes only its own snapshot (the commit
    // plus its tree): the client holds the boundary but none of its
    // ancestors, so the walk must not continue past it.
    if (stopAt.has(item.oid)) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, d: item.d + 1 });
  }
  return { objects, boundary };
}

function collectObject(repo: Repo, out: Map<string, GitObject>, oid: string, exclude: Set<string>): void {
  if (exclude.has(oid) || out.has(oid)) return;
  const obj = repo.objects.get(oid);
  if (obj) out.set(oid, obj);
}

function collectTree(repo: Repo, out: Map<string, GitObject>, treeOid: string, exclude: Set<string>): void {
  if (exclude.has(treeOid) || out.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  out.set(treeOid, obj);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') collectTree(repo, out, entry.oid, exclude);
    else collectObject(repo, out, entry.oid, exclude);
  }
}

/** Peel an annotated tag object to its target commit oid (following tag chains). */
export function peelTag(repo: Repo, tagOid: string): string | null {
  let oid = tagOid;
  for (let i = 0; i < 8; i++) {
    const obj = repo.objects.get(oid);
    if (!obj) return null;
    if (obj.type === 'commit') return oid;
    if (obj.type !== 'tag') return null;
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    if (!m) return null;
    oid = m[1];
  }
  return null;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') queueA.push(...parseCommit(obj.data).parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') queueB.push(...parseCommit(obj.data).parents);
  }
  return null;
}

export interface TreeDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null, prefix = ''): TreeDiff[] {
  const out: TreeDiff[] = [];
  const oldEntries = new Map<string, TreeEntry>();
  const newEntries = new Map<string, TreeEntry>();
  if (oldTree) {
    const obj = repo.objects.get(oldTree);
    if (obj && obj.type === 'tree') for (const e of parseTree(obj.data)) oldEntries.set(e.name, e);
  }
  if (newTree) {
    const obj = repo.objects.get(newTree);
    if (obj && obj.type === 'tree') for (const e of parseTree(obj.data)) newEntries.set(e.name, e);
  }
  const names = new Set([...oldEntries.keys(), ...newEntries.keys()]);
  for (const name of names) {
    const oldE = oldEntries.get(name);
    const newE = newEntries.get(name);
    const path = prefix ? prefix + '/' + name : name;
    if (oldE && newE && oldE.mode === '40000' && newE.mode === '40000') {
      out.push(...diffTrees(repo, oldE.oid, newE.oid, path));
    } else if (oldE && newE) {
      if (oldE.oid !== newE.oid) out.push({ path, status: 'modified', oldOid: oldE.oid, newOid: newE.oid });
    } else if (newE) {
      if (newE.mode === '40000') out.push(...diffTrees(repo, null, newE.oid, path));
      else out.push({ path, status: 'added', oldOid: null, newOid: newE.oid });
    } else if (oldE) {
      if (oldE.mode === '40000') out.push(...diffTrees(repo, oldE.oid, null, path));
      else out.push({ path, status: 'removed', oldOid: oldE.oid, newOid: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack codec

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: Map<string, GitObject> | GitObject[]): Buffer {
  const list = Array.isArray(objects)
    ? objects.map((o) => ({ oid: oidOf(o.type, o.data), obj: o }))
    : [...objects.entries()].map(([oid, obj]) => ({ oid, obj }));
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  chunks.push(header);
  for (const { obj } of list) {
    const deflated = deflateSync(obj.data);
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.data.length;
    const headBytes: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headBytes.push(b);
    }
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflated);
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/** Parse a pack, resolving OFS_DELTA and REF_DELTA against the pack itself
 *  and, for thin packs, against `base` objects (the repo store). */
export function readPack(buf: Buffer, base?: Map<string, GitObject>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const count = buf.readUInt32BE(8);
  let offset = 12;
  interface Raw { oid: string; type: ObjType; data: Buffer; baseOid?: string; baseOffset?: number; delta?: Buffer; }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  for (let i = 0; i < count; i++) {
    const start = offset;
    let byte = buf[offset++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: variable-length offset
      let b = buf[offset++];
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset++];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = start - baseOff;
      const inflated = inflateSync(buf.subarray(offset));
      offset += inflatedLength(buf, offset);
      raws.push({ oid: '', type: 'blob', data: Buffer.alloc(0), baseOffset, delta: inflated });
      byOffset.set(start, raws[raws.length - 1]);
    } else if (typeNum === 7) {
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(buf.subarray(offset));
      offset += inflatedLength(buf, offset);
      raws.push({ oid: '', type: 'blob', data: Buffer.alloc(0), baseOid, delta: inflated });
      byOffset.set(start, raws[raws.length - 1]);
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error('unknown pack object type ' + typeNum);
      const inflated = inflateSync(buf.subarray(offset));
      offset += inflatedLength(buf, offset);
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const oid = oidOf(type, inflated);
      const raw: Raw = { oid, type, data: inflated };
      raws.push(raw);
      byOffset.set(start, raw);
    }
  }
  const resolve = (raw: Raw, seen: Set<Raw>): { type: ObjType; data: Buffer } => {
    if (!raw.delta) return { type: raw.type, data: raw.data };
    if (seen.has(raw)) throw new Error('delta cycle');
    seen.add(raw);
    let baseObj: { type: ObjType; data: Buffer } | undefined;
    if (raw.baseOid) {
      baseObj = out.get(raw.baseOid) ?? base?.get(raw.baseOid);
      if (!baseObj) {
        const found = raws.find((r) => r.oid === raw.baseOid);
        if (found) baseObj = resolve(found, seen);
      }
    } else if (raw.baseOffset !== undefined) {
      const found = byOffset.get(raw.baseOffset);
      if (found) baseObj = resolve(found, seen);
      else if (base) {
        // offset into a thin pack whose base is only in the repo store: cannot
        // resolve by offset; fall back to scanning the store is impossible, so
        // treat as an error the caller surfaces as a refused unpack.
        throw new Error('thin pack base not in pack');
      }
    }
    if (!baseObj) throw new Error('delta base missing');
    const data = applyDelta(baseObj.data, raw.delta);
    return { type: baseObj.type, data };
  };
  for (const raw of raws) {
    const resolved = resolve(raw, new Set());
    const oid = oidOf(resolved.type, resolved.data);
    out.set(oid, { type: resolved.type, data: resolved.data });
  }
  return out;
}

/** Bytes consumed by the zlib stream starting at `offset` (inflateSync gives
 *  the output; re-encode length by finding the stream end via a fresh
 *  incremental inflate is costly, so instead use zlib's unused_data trick
 *  through a manual approach: deflate boundaries are found by trying
 *  inflateSync on progressively... — simpler: use node:zlib inflate with
 *  `info` via `zlib.inflateSync` on a slice is not possible; we instead
 *  locate the end by scanning with `inflate` in a worker-free way:
 *  zlib streams end with an adler32; the reliable approach is to use
 *  `require('node:zlib').inflateSync` on the remainder and compute the
 *  consumed length by re-deflating? No — use the `zlib` `Inflate` class
 *  with `write` chunks is overkill. Practical approach: the pack writer
 *  (our client) emits streams whose end we find by binary search on
 *  inflateSync success. */
function inflatedLength(buf: Buffer, offset: number): number {
  // Binary-search the smallest end such that inflateSync(buf[offset:end])
  // succeeds. Pack objects are small; this is fast enough.
  let lo = offset + 1;
  let hi = buf.length;
  // First find any end that works by exponential probe.
  let probe = Math.min(buf.length, offset + 64);
  while (probe <= buf.length) {
    try {
      inflateSync(buf.subarray(offset, probe));
      hi = probe;
      break;
    } catch {
      if (probe === buf.length) throw new Error('corrupt deflate stream');
      probe = Math.min(buf.length, probe * 2);
    }
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo - offset;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    while (true) {
      const b = delta[p++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(off, off + size));
      total += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktItem {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse a pkt-line stream. Stops at the first flush (inclusive) or end. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      items.push({ kind: 'flush', data: Buffer.alloc(0) });
      i += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: 'delim', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'data', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return items;
}

/** Split a receive-pack/upload-pack request body into the pkt-line command
 *  section (up to the first flush) and the trailing raw bytes (the pack). */
export function splitPktAndRaw(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  let i = 0;
  const items: PktItem[] = [];
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      items.push({ kind: 'flush', data: Buffer.alloc(0) });
      i += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: 'delim', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { items, rest: buf.subarray(i) };
}
