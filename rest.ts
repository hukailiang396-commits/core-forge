// Core Forge — REST v3 under /api/v3. Shares the Store with git/GraphQL/MCP.
import {
  FIXED_DATE, VIEWER, buildCommit, commitFiles, diffTrees, isAncestor, listTree, lookupPath,
  mergeBase, parseCommit, parseTree, peelTag, putObject, updateTree,
} from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface ApiResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export function ok(json: unknown, status = 200, headers?: Record<string, string>): ApiResult {
  return { status, json, headers };
}

export function err(status: number, message: string): ApiResult {
  return { status, json: { message } };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: '',
    url: '',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label ? label.color : 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    comments: issue.comments.length,
    html_url: '',
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: repo.owner + ':' + pull.headRef,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: repo.owner + ':' + pull.baseRef,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: '',
  };
}

function ownerRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get('refs/heads/' + branch);
}

function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has('refs/heads/' + ref)) return repo.refs.get('refs/heads/' + ref);
  if (repo.refs.has('refs/tags/' + ref)) return repo.refs.get('refs/tags/' + ref);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

export function resolveCommit(repo: Repo, ref: string): string | undefined {
  const oid = resolveRef(repo, ref);
  if (!oid) return undefined;
  const obj = repo.objects.get(oid);
  if (!obj) return undefined;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') return peelTag(repo, oid) ?? undefined;
  return undefined;
}

export function createIssue(
  store: Store, repo: Repo, title: string, body: string, labels: string[],
): { issue: Issue } | { error: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: 'Label does not exist: ' + name };
  }
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    id: repo.id * 100000 + number,
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq,
  };
  store.nextSeq += 1;
  repo.issues.set(number, issue);
  return { issue };
}

export function createPull(
  store: Store, repo: Repo, title: string, body: string, headRef: string, baseRef: string,
): { pull: Pull } | { error: string } {
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (!headSha || !baseSha) return { error: 'head or base branch not found' };
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pull: Pull = {
    id: repo.id * 100000 + number,
    number,
    title,
    body: body ?? '',
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    seq: store.nextSeq,
  };
  store.nextSeq += 1;
  repo.pulls.set(number, pull);
  return { pull };
}

/** Squash-merge a pull request. Returns {status, sha?, message?}. */
export function mergePull(
  repo: Repo, pull: Pull,
): { status: number; sha?: string; message?: string } {
  if (pull.state === 'closed') {
    if (pull.merged && pull.mergeSha) return { status: 200, sha: pull.mergeSha, message: 'Pull request already merged' };
    return { status: 405, message: 'Pull request is closed' };
  }
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return { status: 404, message: 'head or base branch not found' };
  if (headTip === baseTip) {
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_DATE;
    pull.mergeSha = baseTip;
    return { status: 200, sha: baseTip, message: 'Pull request successfully merged' };
  }
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headChanges = diffTrees(repo, baseTree, headTree);
  // Conflict: a path changed on both sides relative to the merge base, with
  // different results.
  for (const change of headChanges) {
    const baseEntry = baseTree ? lookupPath(repo, baseTree, change.path) : null;
    const tipEntry = lookupPath(repo, baseTipTree, change.path);
    const baseOid = baseEntry ? baseEntry.oid : null;
    const tipOid = tipEntry ? tipEntry.oid : null;
    const tipChanged = tipOid !== baseOid;
    const headOid = change.newOid;
    if (tipChanged && tipOid !== headOid) {
      return { status: 405, message: 'Merge conflict' };
    }
  }
  // Apply the head's changes onto the base tip's tree.
  let tree = baseTipTree;
  for (const change of headChanges) {
    const content = change.newOid ? repo.objects.get(change.newOid)!.data : null;
    tree = updateTree(repo, tree, change.path.split('/').filter((s) => s.length > 0), content);
  }
  const message = 'Merge pull request #' + pull.number + ' from ' + pull.headRef + '\n\n' + pull.title;
  const author = VIEWER.name + ' <' + VIEWER.email + '> ' + 1700000000 + ' +0000';
  const commitData = buildCommit(tree, [baseTip], author, author, message);
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set('refs/heads/' + pull.baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_DATE;
  pull.mergeSha = sha;
  return { status: 200, sha, message: 'Pull request successfully merged' };
}

function parseAuthorLine(line: string): { name: string; email: string } {
  const m = /^(.*) <([^>]*)>/.exec(line);
  if (m) return { name: m[1], email: m[2] };
  return { name: line, email: '' };
}

function linkHeader(base: string, query: Record<string, string>, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const q = new URLSearchParams(query);
  q.set('page', String(page + 1));
  q.set('per_page', String(perPage));
  return '<' + base + '?' + q.toString() + '>; rel="next"';
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: Record<string, string>,
  body: unknown,
  rawBody: Buffer,
  host = '',
): ApiResult {
  // segments are the path parts after /api/v3 ([''] for the root).
  const b = (body ?? {}) as Record<string, unknown>;
  if (segments.length === 1 && segments[0] === '') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({}, 200, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    return ok({ installed_version: '1.0.0' });
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok({
        login: VIEWER.login, id: VIEWER.id, name: VIEWER.name,
        email: VIEWER.email, type: 'User', created_at: FIXED_DATE,
      });
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listRepos(VIEWER.login).map(repoJson);
        const perPage = Math.max(1, Math.min(100, parseInt(query.per_page ?? '30', 10) || 30));
        const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
        const start = (page - 1) * perPage;
        const slice = repos.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        // The Link header must be an absolute URL on the entry's origin:
        // the suite rejects a relative next link.
        const base = host ? 'http://' + host + '/api/v3/user/repos' : '/api/v3/user/repos';
        const link = linkHeader(base, query, page, perPage, repos.length);
        if (link) headers.link = link;
        return ok(slice, 200, headers);
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) return err(422, 'name is required');
        const existing = store.getRepo(VIEWER.login, name);
        if (existing) return err(422, 'Repository already exists');
        const repo = store.createRepo(
          VIEWER.login, name,
          typeof b.description === 'string' ? b.description : '',
          b.private === true,
        );
        if (typeof b.default_branch === 'string' && b.default_branch) {
          repo.defaultBranch = b.default_branch;
        }
        return ok(repoJson(repo), 201);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'repos') {
    const owner = segments[1] ?? '';
    const name = segments[2] ?? '';
    const repo = ownerRepo(store, owner, name);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204 };
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const out = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
        return ok(out);
      }
      const branch = decodeURIComponent(rest.slice(1).join('/'));
      const tip = branchTip(repo, branch);
      if (!tip) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha: tip } });
    }
    if (rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      const ref = query.sha ?? repo.defaultBranch;
      const tip = resolveCommit(repo, ref);
      if (!tip) return err(404, 'Not Found');
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        const author = parseAuthorLine(c.author);
        const committer = parseAuthorLine(c.committer);
        out.push({
          sha: oid,
          commit: {
            message: c.message,
            author: { name: author.name, email: author.email, date: FIXED_DATE },
            committer: { name: committer.name, email: committer.email, date: FIXED_DATE },
          },
          parents: c.parents.map((p) => ({ sha: p })),
        });
        queue.push(...c.parents);
      }
      return ok(out);
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref || !sha) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const obj = repo.objects.get(sha);
        if (!obj) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok({ ref, object: { sha, type: obj.type } }, 201);
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).join('/');
        const full = ref.startsWith('refs/') ? ref : 'refs/' + ref;
        const sha = repo.refs.get(full);
        if (!sha) return err(404, 'Not Found');
        return ok({ ref: full, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'contents') {
      const path = decodeURIComponent(rest.slice(1).join('/'));
      if (method === 'PUT') {
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        if (!contentB64) return err(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        let tip = branchTip(repo, branch);
        let existed = false;
        let currentBlob: string | null = null;
        if (tip) {
          const obj = repo.objects.get(tip);
          if (obj && obj.type === 'commit') {
            const root = parseCommit(obj.data).tree;
            const found = lookupPath(repo, root, path);
            if (found) {
              existed = true;
              currentBlob = found.oid;
            }
          }
        } else {
          // New branch: start from the default branch tip when there is one.
          const defTip = branchTip(repo, repo.defaultBranch);
          if (defTip) tip = defTip;
        }
        if (existed && typeof b.sha === 'string' && b.sha && b.sha !== currentBlob) {
          return err(409, 'sha does not match');
        }
        const message = typeof b.message === 'string' && b.message ? b.message : (existed ? 'Update ' + path : 'Create ' + path);
        const newCommit = commitFiles(repo, tip ?? null, [{ path, content }], message, VIEWER.name, VIEWER.email);
        repo.refs.set('refs/heads/' + branch, newCommit);
        const blobOid = lookupPath(repo, parseCommit(repo.objects.get(newCommit)!.data).tree, path)!.oid;
        return ok({
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobOid,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            content: contentB64,
          },
          commit: { sha: newCommit, message },
        }, existed ? 200 : 201);
      }
      if (method === 'GET') {
        const ref = query.ref ?? repo.defaultBranch;
        const tip = resolveCommit(repo, ref);
        if (!tip) return err(404, 'Not Found');
        const root = parseCommit(repo.objects.get(tip)!.data).tree;
        if (path === '') {
          const entries = listTree(repo, root, '') ?? [];
          return ok(entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          })));
        }
        const found = lookupPath(repo, root, path);
        if (!found) return err(404, 'Not Found');
        const obj = repo.objects.get(found.oid)!;
        if (found.type === 'tree') {
          const entries = parseTree(obj.data);
          return ok(entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: path + '/' + e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          })));
        }
        return ok({
          type: 'file',
          encoding: 'base64',
          content: obj.data.toString('base64'),
          sha: found.oid,
          size: obj.data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      if (method === 'DELETE') {
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (!tip) return err(404, 'Not Found');
        const root = parseCommit(repo.objects.get(tip)!.data).tree;
        const found = lookupPath(repo, root, path);
        if (!found) return err(404, 'Not Found');
        if (typeof b.sha === 'string' && b.sha && b.sha !== found.oid) {
          return err(409, 'sha does not match');
        }
        const message = typeof b.message === 'string' && b.message ? b.message : 'Delete ' + path;
        const newCommit = commitFiles(repo, tip, [{ path, content: null }], message, VIEWER.name, VIEWER.email);
        repo.refs.set('refs/heads/' + branch, newCommit);
        return ok({ commit: { sha: newCommit, message } });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) return err(422, 'name is required');
        const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
        repo.labels.set(name, { name, color });
        return ok({ name, color }, 201);
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'title is required');
          const labels: string[] = Array.isArray(b.labels)
            ? b.labels.map((l: unknown) => typeof l === 'string' ? l : (l as Record<string, unknown>).name as string).filter(Boolean)
            : [];
          const created = createIssue(store, repo, title, typeof b.body === 'string' ? b.body : '', labels);
          if ('error' in created) return err(422, created.error);
          return ok(issueJson(repo, created.issue), 201);
        }
        if (method === 'GET') {
          const state = query.state ?? 'open';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const direction = query.direction ?? 'desc';
          list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          const perPage = Math.max(1, Math.min(100, parseInt(query.per_page ?? '30', 10) || 30));
          const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
          const start = (page - 1) * perPage;
          return ok(list.slice(start, start + perPage).map((i) => issueJson(repo, i)));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      const issue = repo.issues.get(num);
      if (!issue) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return ok(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id } })));
        }
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          if (!bodyText) return err(422, 'body is required');
          const comment: { id: number; body: string } = { id: repo.nextComment, body: bodyText };
          repo.nextComment += 1;
          issue.comments.push(comment);
          return ok({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } }, 201);
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          const title = typeof b.title === 'string' ? b.title : '';
          if (!head || !title) return err(422, 'head and title are required');
          const created = createPull(store, repo, title, typeof b.body === 'string' ? b.body : '', head, base);
          if ('error' in created) return err(422, created.error);
          return ok(pullJson(repo, created.pull), 201);
        }
        if (method === 'GET') {
          const state = query.state ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          return ok(list.map((p) => pullJson(repo, p)));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      const pull = repo.pulls.get(num);
      if (!pull) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && method === 'GET') {
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        if (!baseTip || !headTip) return err(404, 'Not Found');
        const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const diffs = diffTrees(repo, baseTree, headTree);
        const files = diffs.map((d) => {
          let additions = 0;
          let deletions = 0;
          if (d.status === 'added' && d.newOid) {
            additions = countLines(repo.objects.get(d.newOid)?.data ?? Buffer.alloc(0));
          } else if (d.status === 'removed' && d.oldOid) {
            deletions = countLines(repo.objects.get(d.oldOid)?.data ?? Buffer.alloc(0));
          } else if (d.status === 'modified' && d.newOid && d.oldOid) {
            additions = Math.max(1, countLines(repo.objects.get(d.newOid)?.data ?? Buffer.alloc(0)));
            deletions = countLines(repo.objects.get(d.oldOid)?.data ?? Buffer.alloc(0));
          }
          return {
            filename: d.path,
            status: d.status === 'modified' ? 'modified' : d.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        return ok(files);
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        const result = mergePull(repo, pull);
        if (result.status === 200) {
          return ok({ sha: result.sha, merged: true, message: result.message ?? 'Pull request successfully merged' });
        }
        return err(result.status, result.message ?? 'Merge failed');
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}
