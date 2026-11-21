// Core Forge — MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks revision 2026-07-28 (server/discover) and the legacy handshake
// (initialize / notifications/initialized). Tools share the Store with REST.
import { VIEWER } from './store.ts';
import {
  createIssue, createPull, issueJson, mergePull, pullJson, repoJson,
} from './rest.ts';
import type { Store } from './store.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
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
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
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
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

function resolveToolName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (lower === tool.name) return tool.name;
    if (lower.endsWith('__' + tool.name) || lower.endsWith('_' + tool.name)) return tool.name;
  }
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower];
  return null;
}

function textResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = args.owner as string | undefined;
  let repo = args.repo as string | undefined;
  const full = args.full_name as string | undefined;
  if ((!owner || !repo) && full && full.includes('/')) {
    const [o, r] = full.split('/');
    owner = owner ?? o;
    repo = repo ?? r;
  }
  return { owner: owner ?? '', repo: repo ?? '' };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = resolveToolName(name);
  if (!tool) return { __jsonRpcError: -32601, __message: 'Unknown tool: ' + name };
  const def = TOOLS.find((t) => t.name === tool)!;
  for (const req of def.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      // full_name can stand in for owner+repo
      if ((req === 'owner' || req === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
      return { __jsonRpcError: -32602, __message: 'Missing required argument: ' + req };
    }
  }
  if (tool === 'create_repo') {
    const repoName = args.name as string;
    const owner = (args.owner as string) || VIEWER.login;
    if (owner !== VIEWER.login) return errorResult('owner not found: ' + owner);
    let repo = store.getRepo(owner, repoName);
    if (!repo) {
      repo = store.createRepo(owner, repoName, (args.description as string) ?? '', args.private === true);
    }
    return textResult(repoJson(repo));
  }
  const { owner, repo: repoName } = splitFullName(args);
  if (owner !== VIEWER.login) return errorResult('Repository not found: ' + owner + '/' + repoName);
  const repo = store.getRepo(owner, repoName);
  if (tool === 'get_repo') {
    if (!repo) return errorResult('Repository not found: ' + owner + '/' + repoName);
    return textResult(repoJson(repo));
  }
  if (!repo) return errorResult('Repository not found: ' + owner + '/' + repoName);
  if (tool === 'create_issue') {
    const created = createIssue(store, repo, args.title as string, (args.body as string) ?? '', []);
    if ('error' in created) return errorResult(created.error);
    return textResult(issueJson(repo, created.issue));
  }
  if (tool === 'list_issues') {
    const state = (args.state as string) ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    return textResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (tool === 'create_pull_request') {
    const created = createPull(
      store, repo,
      args.title as string, (args.body as string) ?? '',
      args.head as string, args.base as string,
    );
    if ('error' in created) return errorResult(created.error);
    return textResult(pullJson(repo, created.pull));
  }
  if (tool === 'merge_pull_request') {
    const pull = repo.pulls.get(args.pull_number as number);
    if (!pull) return errorResult('Pull request not found: ' + String(args.pull_number));
    const result = mergePull(repo, pull);
    if (result.status !== 200) return errorResult(result.message ?? 'Merge failed');
    return textResult({ ...pullJson(repo, pull), sha: result.sha, merged: true });
  }
  return errorResult('Unknown tool: ' + name);
}

export interface McpResult {
  status: number;
  json: unknown;
}

export function handleMcp(store: Store, body: unknown): McpResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? undefined : req.id;
  const method = req.method as string | undefined;
  if (typeof method !== 'string') {
    return { status: 400, json: { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, json: null };
  }
  const ok = (result: unknown): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } });
  const fail = (code: number, message: string): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } });
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    return ok({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28'],
      serverInfo: { name: 'core-forge', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const protocolVersion = (params.protocolVersion as string) || '2026-07-28';
    return ok({
      protocolVersion,
      serverInfo: { name: 'core-forge', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) return fail(-32602, 'Missing tool name');
    const out = callTool(store, name, args);
    if ('__jsonRpcError' in out) {
      return fail(out.__jsonRpcError as number, (out.__message as string) ?? 'Tool call failed');
    }
    return ok(out);
  }
  return fail(-32601, 'Method not found: ' + method);
}
