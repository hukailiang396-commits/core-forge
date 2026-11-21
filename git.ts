// Core Forge — git smart HTTP: upload-pack v2 + v0, receive-pack v0.
// Speaks the protocol the suite's in-process client speaks. No git binary.
import {
  DELIM, FLUSH, ZERO_OID, parseCommit, parseTree, peelTag, pktLine, parsePktLines,
  putObject, reachable, readPack, splitPktAndRaw, writePack, isAncestor,
} from './store.ts';
import type { GitObject, Repo } from './store.ts';

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = 'refs/heads/' + repo.defaultBranch;
  const headOid = repo.refs.get(headRef);
  if (headOid) lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

const V0_UPLOAD_CAPS =
  'side-band-64k multi_ack multi_ack_detailed thin-pack ofs-delta shallow agent=core-forge/1.0';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=core-forge/1.0';

/** GET /{owner}/{repo}.git/info/refs?service=... — returns {status, contentType, body} */
export function infoRefs(
  repo: Repo | undefined,
  service: string,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}', 'utf8') };
  }
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const lines: Buffer[] = [];
    lines.push(pktLine('# service=git-upload-pack\n'));
    lines.push(FLUSH);
    lines.push(pktLine('version 2\n'));
    lines.push(pktLine('agent=core-forge/1.0\n'));
    lines.push(pktLine('ls-refs=unborn\n'));
    lines.push(pktLine('fetch=shallow wait-for-done filter\n'));
    lines.push(pktLine('object-format=sha1\n'));
    lines.push(FLUSH);
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: Buffer.concat(lines),
    };
  }
  if (service === 'git-upload-pack') {
    const caps = V0_UPLOAD_CAPS + ' symref=HEAD:refs/heads/' + repo.defaultBranch;
    const lines: Buffer[] = [];
    lines.push(pktLine('# service=git-upload-pack\n'));
    lines.push(FLUSH);
    const refs = refLines(repo);
    if (refs.length === 0) {
      lines.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
    } else {
      let first = true;
      for (const ref of refs) {
        let line = ref.oid + ' ' + ref.name;
        if (first) line += '\0' + caps;
        if (ref.peeled) lines.push(pktLine(line + '\n'));
        else lines.push(pktLine(line + '\n'));
        if (ref.peeled) lines.push(pktLine(ref.peeled + ' ' + ref.name + '^{}\n'));
        first = false;
      }
    }
    lines.push(FLUSH);
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: Buffer.concat(lines),
    };
  }
  if (service === 'git-receive-pack') {
    const lines: Buffer[] = [];
    lines.push(pktLine('# service=git-receive-pack\n'));
    lines.push(FLUSH);
    const refs = refLines(repo);
    if (refs.length === 0) {
      lines.push(pktLine(ZERO_OID + ' capabilities^{}\0' + V0_RECEIVE_CAPS + '\n'));
    } else {
      let first = true;
      for (const ref of refs) {
        let line = ref.oid + ' ' + ref.name;
        if (first) line += '\0' + V0_RECEIVE_CAPS;
        lines.push(pktLine(line + '\n'));
        if (ref.peeled) lines.push(pktLine(ref.peeled + ' ' + ref.name + '^{}\n'));
        first = false;
      }
    }
    lines.push(FLUSH);
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: Buffer.concat(lines),
    };
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}', 'utf8') };
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string | null;
  isLsRefs: boolean;
  refPrefixes: string[];
  peel: boolean;
  unborn: boolean;
  symrefs: boolean;
  done: boolean;
}

function parseV2Args(items: ReturnType<typeof parsePktLines>): FetchRequest {
  const req: FetchRequest = {
    wants: [], haves: [], shallow: [], depth: null, deepenSince: null,
    deepenNot: null, isLsRefs: false, refPrefixes: [], peel: false,
    unborn: false, symrefs: false, done: false,
  };
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') { inArgs = true; continue; }
    if (item.kind !== 'data') continue;
    const line = item.data.toString('utf8').trimEnd();
    if (!inArgs) {
      if (line.startsWith('command=ls-refs')) req.isLsRefs = true;
      continue;
    }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim().split(/\s+/)[0] ?? '');
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim().split(/\s+/)[0] ?? '');
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim().split(/\s+/)[0] ?? '');
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) req.deepenSince = parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) req.deepenNot = line.slice(11).trim();
    else if (line.startsWith('ref-prefix ')) req.refPrefixes.push(line.slice(11).trim());
    else if (line === 'peel') req.peel = true;
    else if (line === 'unborn') req.unborn = true;
    else if (line === 'symrefs') req.symrefs = true;
    else if (line === 'done') req.done = true;
  }
  return req;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte length header,
  // and the sideband band byte takes one more: at most 65515 data bytes.
  const maxData = 65515;
  for (let i = 0; i < pack.length; i += maxData) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + maxData));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  let items: ReturnType<typeof parsePktLines>;
  try {
    items = parsePktLines(body);
  } catch {
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH]);
  }
  const req = parseV2Args(items);
  if (req.isLsRefs) {
    const out: Buffer[] = [];
    const refs = refLines(repo);
    const headRef = 'refs/heads/' + repo.defaultBranch;
    const headOid = repo.refs.get(headRef);
    if (refs.length === 0) {
      if (req.unborn) {
        out.push(pktLine('unborn HEAD symref-target:' + headRef + '\n'));
      }
    } else {
      for (const ref of refs) {
        if (req.refPrefixes.length > 0 && !req.refPrefixes.some((p) => ref.name.startsWith(p))) continue;
        let line = ref.oid + ' ' + ref.name;
        if (ref.symrefTarget && (req.symrefs || ref.name === 'HEAD')) line += ' symref-target:' + ref.symrefTarget;
        if (req.peel && ref.peeled) line += ' peeled:' + ref.peeled;
        out.push(pktLine(line + '\n'));
      }
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  // fetch
  const out: Buffer[] = [];
  // Multi-round negotiation: a request without `done` (git sends one when
  // it has haves to negotiate, e.g. a shallow fetch) gets ONLY the
  // acknowledgments section — no other section may follow a section
  // without `ready`. The client then sends a follow-up request with `done`.
  if (!req.done && req.haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of req.haves) {
      const obj = repo.objects.get(have);
      if (obj && obj.type === 'commit') {
        out.push(pktLine('ACK ' + have + '\n'));
        acked = true;
      }
    }
    if (!acked) out.push(pktLine('NAK\n'));
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  // A fetch that sent no haves gets no acknowledgments section: git's v2
  // client goes straight to the packfile section in that case. The same
  // holds for a request that sent `done`: git has finished negotiating and
  // its packfile reader rejects any further acknowledgments section.
  // Only a request without `done` (an intermediate negotiation round)
  // receives an acknowledgments section, and that response holds nothing
  // else — see the branch above.
  // Compute the object set: reachable from wants within depth, minus haves.
  const haveSet = new Set<string>(req.haves);
  // Objects the client already holds: everything reachable from haves.
  // The walk stops at shallow boundaries: the client holds a boundary's
  // snapshot but none of its ancestors.
  const held = new Set<string>();
  const shallowSet = new Set<string>(req.shallow);
  if (req.haves.length > 0) {
    const heldReach = reachable(repo, req.haves, { stopAt: shallowSet });
    for (const oid of heldReach.objects.keys()) held.add(oid);
    for (const h of req.haves) held.add(h);
  }
  // Shallow boundaries the client already has count as held together with
  // their own snapshots (their trees and blobs). Depth 1 on purpose —
  // reachable() without a depth limit would also swallow the boundary's
  // parents, which the client does NOT have.
  for (const s of req.shallow) {
    held.add(s);
    const sReach = reachable(repo, [s], { depth: 1 });
    for (const oid of sReach.objects.keys()) held.add(oid);
  }
  const depth = req.depth ?? 0;
  const result = reachable(repo, req.wants, { depth, exclude: held });
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (depth > 0) {
    // New boundary: commits at the depth limit.
    for (const b of result.boundary) shallowLines.push(b);
    // Old boundaries that are now fully included (their parents are in the
    // delivered set or already held) are unshallowed. The old tip itself
    // is held, so it need not appear in the pack.
    for (const old of req.shallow) {
      const obj = repo.objects.get(old);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const allIncluded = parents.every((p) => result.objects.has(p) || held.has(p));
      if (allIncluded) unshallowLines.push(old);
    }
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const s of shallowLines) out.push(pktLine('shallow ' + s + '\n'));
    for (const u of unshallowLines) out.push(pktLine('unshallow ' + u + '\n'));
    out.push(DELIM);
  }
  // The packfile section is always sent, even for an empty set of objects
  // (a 0-object pack): both git and the suite accept it, and git requires
  // the section to be present.
  out.push(pktLine('packfile\n'));
  out.push(...sidebandPackets(writePack(result.objects)));
  out.push(FLUSH);
  return Buffer.concat(out);
}

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  // Parse wants section (up to first flush), then haves + done.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  try {
    const { items, rest } = splitPktAndRaw(body);
    let section = 0;
    // In v0 the first want line carries the client's capabilities after a
    // space (want <oid> SP <caps>); take only the first token as the oid.
    const firstToken = (s: string): string => s.trim().split(/\s+/)[0] ?? '';
    for (const item of items) {
      if (item.kind === 'flush') { section = 1; continue; }
      if (item.kind !== 'data') continue;
      const line = item.data.toString('utf8');
      const clean = line.split('\0')[0].trim();
      if (section === 0) {
        if (clean.startsWith('want ')) wants.push(firstToken(clean.slice(5)));
        else if (clean.startsWith('shallow ')) shallow.push(firstToken(clean.slice(8)));
        else if (clean.startsWith('deepen ')) depth = parseInt(clean.slice(7), 10);
        else if (clean === 'done') done = true;
      }
    }
    // The haves live after the first flush, as pkt-lines in `rest`.
    const restItems = parsePktLines(rest);
    for (const item of restItems) {
      if (item.kind !== 'data') continue;
      const clean = item.data.toString('utf8').trim();
      if (clean.startsWith('have ')) haves.push(firstToken(clean.slice(5)));
      else if (clean.startsWith('shallow ')) shallow.push(firstToken(clean.slice(8)));
      else if (clean.startsWith('deepen ')) depth = parseInt(clean.slice(7), 10);
      else if (clean === 'done') done = true;
    }
  } catch {
    // Malformed input: answer NAK and stay alive.
    return Buffer.concat([pktLine('NAK\n'), FLUSH]);
  }
  const out: Buffer[] = [];
  const held = new Set<string>();
  const shallowSet = new Set<string>(shallow);
  if (haves.length > 0) {
    // The walk from haves stops at shallow boundaries: the client holds
    // a boundary's snapshot but none of its ancestors.
    const heldReach = reachable(repo, haves, { stopAt: shallowSet });
    for (const oid of heldReach.objects.keys()) held.add(oid);
    for (const h of haves) held.add(h);
  }
  // A held shallow boundary counts as held together with its own snapshot
  // (its tree and blobs): the client already has those. Depth 1 on
  // purpose — reachable() without a depth limit would also swallow the
  // boundary's parents, which the client does NOT have.
  for (const s of shallow) {
    held.add(s);
    const sReach = reachable(repo, [s], { depth: 1 });
    for (const oid of sReach.objects.keys()) held.add(oid);
  }
  const result = reachable(repo, wants, { depth: depth ?? 0, exclude: held });
  // Shallow/unshallow lines, computed once for both response shapes.
  const shallowOut: Buffer[] = [];
  if (depth !== null && depth > 0) {
    for (const b of result.boundary) shallowOut.push(pktLine('shallow ' + b + '\n'));
    for (const old of shallow) {
      const obj = repo.objects.get(old);
      if (!obj || obj.type !== 'commit') continue;
      // Unshallow when every parent is now present: delivered in this
      // pack or already held. The old tip itself is held, so it need not
      // appear in the pack.
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => result.objects.has(p) || held.has(p))) {
        shallowOut.push(pktLine('unshallow ' + old + '\n'));
      }
    }
  }
  if (!done) {
    // Negotiation round (real git's shape, verified against
    // git upload-pack --stateless-rpc): no pack is sent yet.
    if (depth !== null && depth > 0) {
      // Shallow list only, terminated by a flush.
      out.push(...shallowOut, FLUSH);
    } else {
      // ACK round: one common line per have the server holds as a commit,
      // a ready line for the last of them, then NAK.
      const common = haves.filter((h) => {
        const obj = repo.objects.get(h);
        return obj !== undefined && obj.type === 'commit';
      });
      for (const h of common) out.push(pktLine('ACK ' + h + ' common\n'));
      if (common.length > 0) out.push(pktLine('ACK ' + common[common.length - 1] + ' ready\n'));
      out.push(pktLine('NAK\n'));
    }
    return Buffer.concat(out);
  }
  // Full response: shallow lines first (section ends with a flush), then
  // NAK, then the pack, then a flush. Always send the pack, even with
  // 0 objects.
  if (shallowOut.length > 0) out.push(...shallowOut, FLUSH);
  out.push(pktLine('NAK\n'));
  out.push(...sidebandPackets(writePack(result.objects)));
  out.push(FLUSH);
  return Buffer.concat(out);
}

export function uploadPack(
  repo: Repo | undefined,
  body: Buffer,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}', 'utf8') };
  }
  try {
    const out = gitProtocol === 'version=2' ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
  } catch {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([pktLine('NAK\n'), FLUSH]) };
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(
  repo: Repo | undefined,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}', 'utf8') };
  }
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  try {
    const { items, rest } = splitPktAndRaw(body);
    const commands: PushCommand[] = [];
    for (const item of items) {
      if (item.kind !== 'data') continue;
      let line = item.data.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.trim().split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
    }
    // Parse and store the pack (if any) before applying refs.
    let incoming = new Map<string, GitObject>();
    if (rest.length > 0) {
      try {
        incoming = readPack(rest, repo.objects);
      } catch {
        unpackOk = false;
      }
    }
    if (unpackOk) {
      for (const [oid, obj] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
      for (const cmd of commands) {
        if (cmd.newOid === ZERO_OID) {
          // delete
          if (repo.refs.has(cmd.ref)) repo.refs.delete(cmd.ref);
          report.push({ ref: cmd.ref, ok: true, reason: '' });
          continue;
        }
        const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
        if (current !== ZERO_OID && cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          // The client sent a stale old value: treat as non-fast-forward.
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (current !== ZERO_OID && !isAncestor(repo, current, cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        const target = repo.objects.get(cmd.newOid);
        if (!target) {
          report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
      }
    } else {
      for (const cmd of commands) report.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
    }
  } catch {
    unpackOk = false;
  }
  // Build the report-status stream, wrapped in sideband band 1. The inner
  // report is itself pkt-lined and ends with its own flush; the outer
  // stream then ends with a flush too.
  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : 'unpack failed\n'));
  for (const r of report) {
    inner.push(pktLine(r.ok ? 'ok ' + r.ref + '\n' : 'ng ' + r.ref + ' ' + r.reason + '\n'));
  }
  inner.push(FLUSH);
  const innerBuf = Buffer.concat(inner);
  const out: Buffer[] = [];
  const maxData = 65516;
  for (let i = 0; i < innerBuf.length; i += maxData) {
    const chunk = innerBuf.subarray(i, Math.min(innerBuf.length, i + maxData));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(out) };
}
