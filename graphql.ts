// Core Forge — GraphQL at /api/graphql. A small parser + executor for the
// exact documents the suite sends (gh / github-mcp-server shapes).
import { VIEWER } from './store.ts';
import { diffTrees, lookupPath, mergeBase, parseCommit } from './store.ts';
import {
  branchTip, createIssue, createPull, mergePull,
} from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (ch === '.' && input.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!@$&|='.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && /[0-9]/.test(input[i + 1] ?? '') || /[0-9]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j += 1;
      tokens.push({ kind: 'int', value: parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    i += 1; // unknown char: skip
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; type: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  op: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue?: Value }>;
  selections: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(): Token { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]; }
  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error('expected ' + value);
  }
  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }
  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        fragments.set(name, this.parseSelections());
      } else if (t.kind === 'punct' && t.value === '{') {
        operations.push({ op: 'query', name: null, variables: [], selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const op = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables: Operation['variables'] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            if (this.peek().kind === 'punct' && this.peek().value === '$') this.next();
            const varName = this.expectName();
            this.expectPunct(':');
            // type: a name, possibly wrapped in [] and !
            while (true) {
              const tt = this.peek();
              if (tt.kind === 'punct' && (tt.value === '[' || tt.value === ']' || tt.value === '!')) { this.next(); continue; }
              if (tt.kind === 'name') { this.next(); continue; }
              break;
            }
            let defaultValue: Value | undefined;
            if (this.peek().kind === 'punct' && this.peek().value === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            variables.push({ name: varName, defaultValue });
          }
          this.expectPunct(')');
        }
        operations.push({ op, name, variables, selections: this.parseSelections() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
  parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '...') {
        this.next();
        const nt = this.peek();
        if (nt.kind === 'name' && nt.value === 'on') {
          this.next();
          const type = this.expectName();
          out.push({ kind: 'inline', type, selections: this.parseSelections() });
        } else if (nt.kind === 'name') {
          out.push({ kind: 'spread', name: this.next().value as string });
        } else {
          out.push({ kind: 'inline', type: null, selections: this.parseSelections() });
        }
        continue;
      }
      if (t.kind === 'name') {
        let name = this.next().value as string;
        let alias: string | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === ':') {
          this.next();
          alias = name;
          name = this.expectName();
        }
        const args: FieldNode['args'] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            const argName = this.expectName();
            this.expectPunct(':');
            args.push({ name: argName, value: this.parseValue() });
          }
          this.expectPunct(')');
        }
        // directives: @name[(...)] — skip
        while (this.peek().kind === 'punct' && this.peek().value === '@') {
          this.next();
          this.expectName();
          if (this.peek().kind === 'punct' && this.peek().value === '(') {
            this.next();
            let depth = 1;
            while (depth > 0) {
              const dt = this.next();
              if (dt.kind === 'punct' && dt.value === '(') depth += 1;
              if (dt.kind === 'punct' && dt.value === ')') depth -= 1;
              if (dt.kind === 'eof') break;
            }
          }
        }
        let selections: SelectionNode[] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '{') {
          selections = this.parseSelections();
        }
        out.push({ kind: 'field', field: { alias, name, args, selections } });
        continue;
      }
      this.next();
    }
    this.expectPunct('}');
    return out;
  }
  parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value token');
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name] ?? null;
    case 'string': return value.value;
    case 'int': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(kind + ':' + parts.join(':'), 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

function prMergeable(repo: Repo, pull: Pull): string {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return 'UNKNOWN';
  if (headTip === baseTip) return 'MERGEABLE';
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  for (const change of diffTrees(repo, baseTree, headTree)) {
    const baseEntry = baseTree ? lookupPath(repo, baseTree, change.path) : null;
    const tipEntry = lookupPath(repo, baseTipTree, change.path);
    const baseOid = baseEntry ? baseEntry.oid : null;
    const tipOid = tipEntry ? tipEntry.oid : null;
    if (tipOid !== baseOid && tipOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

function fieldArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, ctx.variables);
  return out;
}

function unknownField(ctx: Ctx, type: string, name: string): void {
  ctx.errors.push({ message: 'Cannot query field "' + name + '" on type "' + type + '".' });
}

function select(
  ctx: Ctx,
  typeName: string,
  value: Record<string, unknown> | null,
  selections: SelectionNode[],
  resolvers: Record<string, (v: Record<string, unknown>, args: Record<string, unknown>) => unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null) return out;
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) Object.assign(out, select(ctx, typeName, value, frag, resolvers));
      continue;
    }
    if (sel.kind === 'inline') {
      Object.assign(out, select(ctx, typeName, value, sel.selections, resolvers));
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const resolver = resolvers[field.name];
    if (!resolver) {
      unknownField(ctx, typeName, field.name);
      out[key] = null;
      continue;
    }
    const args = fieldArgs(field, ctx);
    const raw = resolver(value, args);
    out[key] = resolveValue(ctx, field, raw);
  }
  return out;
}

function resolveValue(ctx: Ctx, field: FieldNode, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).__typename) {
    const typed = raw as Record<string, unknown> & { __typename: string };
    if (field.selections.length === 0) return typed;
    return select(ctx, typed.__typename, typed, field.selections, resolversFor(typed.__typename));
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => resolveValue(ctx, field, item));
  }
  return raw;
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    // GraphQL exposes the state as the IssueState enum, not the REST
    // lowercase string.
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: prMergeable(repo, pull),
    // GraphQL exposes the state as the PullRequestState enum.
    state: pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    _repo: repo,
    _pull: pull,
  };
}

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.owner + '/' + repo.name,
    owner: { __typename: 'User', login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

function cursorFor(n: number): string {
  return Buffer.from('cursor:' + n, 'utf8').toString('base64');
}

function cursorNum(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (text.startsWith('cursor:')) return parseInt(text.slice(7), 10);
  } catch {
    return null;
  }
  return null;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states);
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && orderBy.direction === 'DESC') list.sort((a, b) => b.number - a.number);
  else list.sort((a, b) => a.number - b.number);
  const after = cursorNum(args.after as string | null | undefined);
  if (after !== null) list = list.filter((i) => i.number > after);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      endCursor,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
    },
    edges: page.map((i) => ({ __typename: 'IssueEdge', node: issueNode(repo, i), cursor: cursorFor(i.number) })),
    totalCount: repo.issues.size,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  list.sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullNode(repo, p)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
    },
    edges: page.map((p) => ({ __typename: 'PullRequestEdge', node: pullNode(repo, p), cursor: cursorFor(p.number) })),
    totalCount: repo.pulls.size,
  };
}

function resolversFor(typeName: string): Record<string, (v: Record<string, unknown>, args: Record<string, unknown>) => unknown> {
  switch (typeName) {
    case 'Repository': return {
      id: (v) => v.id,
      databaseId: (v) => v.databaseId,
      name: (v) => v.name,
      nameWithOwner: (v) => v.nameWithOwner,
      owner: (v) => v.owner,
      defaultBranchRef: (v) => v.defaultBranchRef,
      viewerPermission: (v) => v.viewerPermission,
      hasIssuesEnabled: (v) => v.hasIssuesEnabled,
      issue: (v, args) => {
        const repo = v._repo as Repo;
        const issue = repo.issues.get(args.number as number);
        return issue ? issueNode(repo, issue) : null;
      },
      issues: (v, args) => issueConnection(v._repo as Repo, args),
      pullRequests: (v, args) => pullConnection(v._repo as Repo, args),
      pullRequest: (v, args) => {
        const repo = v._repo as Repo;
        const pull = repo.pulls.get(args.number as number);
        return pull ? pullNode(repo, pull) : null;
      },
    };
    case 'Issue': return {
      id: (v) => v.id,
      number: (v) => v.number,
      title: (v) => v.title,
      state: (v) => v.state,
      body: (v) => v.body,
    };
    case 'PullRequest': return {
      id: (v) => v.id,
      number: (v) => v.number,
      headRefName: (v) => v.headRefName,
      baseRefName: (v) => v.baseRefName,
      mergeable: (v) => v.mergeable,
      state: (v) => v.state,
      merged: (v) => v.merged,
      files: (v, args) => {
        const repo = v._repo as Repo;
        const pull = v._pull as Pull;
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        if (!baseTip || !headTip) return { __typename: 'PullRequestFileConnection', nodes: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } };
        const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const diffs = diffTrees(repo, baseTree, headTree);
        const first = typeof args.first === 'number' ? args.first : diffs.length;
        const nodes = diffs.slice(0, first).map((d) => ({ __typename: 'PullRequestFile', path: d.path }));
        return {
          __typename: 'PullRequestFileConnection',
          nodes,
          pageInfo: { __typename: 'PageInfo', hasNextPage: diffs.length > nodes.length, endCursor: null, hasPreviousPage: false, startCursor: null },
        };
      },
    };
    case 'User': return {
      login: (v) => v.login,
      id: (v) => v.id,
      name: (v) => v.name,
      email: (v) => v.email,
    };
    case 'Ref': return { name: (v) => v.name };
    case 'IssueConnection': return {
      nodes: (v) => v.nodes,
      pageInfo: (v) => v.pageInfo,
      edges: (v) => v.edges,
      totalCount: (v) => v.totalCount,
    };
    case 'PullRequestConnection': return {
      nodes: (v) => v.nodes,
      pageInfo: (v) => v.pageInfo,
      edges: (v) => v.edges,
      totalCount: (v) => v.totalCount,
    };
    case 'PullRequestFileConnection': return {
      nodes: (v) => v.nodes,
      pageInfo: (v) => v.pageInfo,
    };
    case 'PullRequestFile': return { path: (v) => v.path };
    case 'PageInfo': return {
      hasNextPage: (v) => v.hasNextPage,
      endCursor: (v) => v.endCursor,
      hasPreviousPage: (v) => v.hasPreviousPage,
      startCursor: (v) => v.startCursor,
    };
    case 'IssueComment': return {
      id: (v) => v.id,
      body: (v) => v.body,
    };
    case 'IssueCommentEdge': return {
      node: (v) => v.node,
      cursor: (v) => v.cursor,
    };
    case '__Type': return {
      name: (v) => v.name,
      kind: (v) => v.kind,
      fields: (v) => v.fields,
      enumValues: (v) => v.enumValues,
      description: () => null,
    };
    case '__Schema': return {
      queryType: (v) => v.queryType,
      mutationType: () => null,
    };
    default: return {};
  }
}

function typeFieldList(name: string): Array<{ name: string }> | null {
  const fields = TYPE_FIELDS[name];
  return fields ? fields.map((f) => ({ name: f })) : null;
}

function executeOperation(ctx: Ctx, op: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const root: Record<string, unknown> = {};
  if (op.op === 'query') {
    const resolvers: Record<string, (v: Record<string, unknown>, args: Record<string, unknown>) => unknown> = {
      viewer: () => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
      repository: (_v, args) => {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER.login) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo ? repoNode(repo) : null;
      },
      node: (_v, args) => {
        const parsed = ungid(args.id as string);
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
          return repo ? repoNode(repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
          const issue = repo?.issues.get(parseInt(parsed.parts[1], 10));
          return repo && issue ? issueNode(repo, issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
          const pull = repo?.pulls.get(parseInt(parsed.parts[1], 10));
          return repo && pull ? pullNode(repo, pull) : null;
        }
        return null;
      },
      __type: (_v, args) => {
        const name = args.name as string;
        const fields = typeFieldList(name);
        const enums = TYPE_ENUMS[name];
        if (!fields && !enums) return null;
        return {
          __typename: '__Type',
          name,
          kind: enums ? 'ENUM' : 'OBJECT',
          fields,
          enumValues: enums ? enums.map((e) => ({ name: e })) : null,
        };
      },
      __schema: () => ({
        __typename: '__Schema',
        queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', fields: null, enumValues: null },
      }),
    };
    for (const sel of op.selections) {
      if (sel.kind !== 'field') continue;
      const field = sel.field;
      const key = field.alias ?? field.name;
      const resolver = resolvers[field.name];
      if (!resolver) {
        unknownField(ctx, 'Query', field.name);
        data[key] = null;
        continue;
      }
      const raw = resolver(root, fieldArgs(field, ctx));
      data[key] = resolveValue(ctx, field, raw);
    }
    return data;
  }
  // mutation
  const resolvers: Record<string, (v: Record<string, unknown>, args: Record<string, unknown>) => unknown> = {
    createIssue: (_v, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = ungid(input.repositoryId as string);
      if (!parsed || parsed.kind !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null };
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
      if (!repo) return { __typename: 'CreateIssuePayload', issue: null };
      const created = createIssue(ctx.store, repo, input.title as string, (input.body as string) ?? '', []);
      if ('error' in created) return { __typename: 'CreateIssuePayload', issue: null };
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created.issue) };
    },
    closeIssue: (_v, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = ungid(input.issueId as string);
      if (!parsed || parsed.kind !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
      const issue = repo?.issues.get(parseInt(parsed.parts[1], 10));
      if (!issue || !repo) return { __typename: 'CloseIssuePayload', issue: null };
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    },
    createPullRequest: (_v, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = ungid(input.repositoryId as string);
      if (!parsed || parsed.kind !== 'Repository') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
      if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const created = createPull(
        ctx.store, repo,
        input.title as string, (input.body as string) ?? '',
        input.headRefName as string, input.baseRefName as string,
      );
      if ('error' in created) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created.pull) };
    },
    mergePullRequest: (_v, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = ungid(input.pullRequestId as string);
      if (!parsed || parsed.kind !== 'PullRequest') return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
      const pull = repo?.pulls.get(parseInt(parsed.parts[1], 10));
      if (!pull || !repo) return { __typename: 'MergePullRequestPayload', pullRequest: null };
      mergePull(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    addComment: (_v, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = ungid(input.subjectId as string);
      if (!parsed || parsed.kind !== 'Issue') return { __typename: 'AddCommentPayload', commentEdge: null };
      const repo = [...ctx.store.repos.values()].find((r) => r.id === parseInt(parsed.parts[0], 10));
      const issue = repo?.issues.get(parseInt(parsed.parts[1], 10));
      if (!issue || !repo) return { __typename: 'AddCommentPayload', commentEdge: null };
      const comment = { id: repo.nextComment, body: input.body as string };
      repo.nextComment += 1;
      issue.comments.push(comment);
      const node = {
        __typename: 'IssueComment',
        id: gid('IssueComment', repo.id, comment.id),
        body: comment.body,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) },
      };
    },
  };
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const field = sel.field;
    const key = field.alias ?? field.name;
    const resolver = resolvers[field.name];
    if (!resolver) {
      unknownField(ctx, 'Mutation', field.name);
      data[key] = null;
      continue;
    }
    const raw = resolver(root, fieldArgs(field, ctx));
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).__typename && field.selections.length > 0) {
      const typed = raw as Record<string, unknown> & { __typename: string };
      const payloadResolvers: Record<string, (v: Record<string, unknown>, args: Record<string, unknown>) => unknown> = {
        issue: (v) => v.issue,
        pullRequest: (v) => v.pullRequest,
        commentEdge: (v) => v.commentEdge,
      };
      data[key] = select(ctx, typed.__typename, typed, field.selections, payloadResolvers);
    } else {
      data[key] = raw;
    }
  }
  return data;
}

export function handleGraphql(store: Store, body: unknown): { status: number; json: unknown } {
  const runOne = (doc: Record<string, unknown>): Record<string, unknown> => {
    const query = doc.query as string;
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    let parsed: { operations: Operation[]; fragments: Map<string, SelectionNode[]> };
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: 'GraphQL parse error: ' + (e as Error).message }] };
    }
    if (parsed.operations.length === 0) {
      return { data: null, errors: [{ message: 'no operation' }] };
    }
    const opName = doc.operationName as string | undefined;
    const op = opName
      ? parsed.operations.find((o) => o.name === opName) ?? parsed.operations[0]
      : parsed.operations[0];
    const ctx: Ctx = { store, variables, errors: [], fragments: parsed.fragments };
    const data = executeOperation(ctx, op);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((doc) => runOne(doc as Record<string, unknown>)) };
  }
  if (body && typeof body === 'object') {
    return { status: 200, json: runOne(body as Record<string, unknown>) };
  }
  return { status: 400, json: { message: 'Invalid GraphQL request body' } };
}
