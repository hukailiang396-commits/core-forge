// Core Forge — HTTP server: routing, auth, JSON plumbing.
// Every JSON reply carries X-GitHub-Request-Id; errors are JSON, never HTML.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Store, VIEWER } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';

function sendJson(res: ServerResponse, status: number, requestId: string, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, requestId: string, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function createApp(store: Store, token: string): Server {
  const server = createServer(async (req, res) => {
    const requestId = store.nextRequestId();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const pathname = url.pathname;
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => { query[key] = value; });

      if (pathname === '/healthz') {
        sendJson(res, 200, requestId, { ok: true });
        return;
      }

      // Auth: every other surface requires the trial bearer token when one
      // is configured. /healthz is the only unauthenticated route.
      if (token) {
        const auth = req.headers.authorization ?? '';
        if (auth !== 'Bearer ' + token) {
          sendJson(res, 401, requestId, { message: 'Unauthorized' });
          return;
        }
      }

      const segments = pathname.split('/').filter((s) => s.length > 0).map(decodeSegment);

      if (pathname === '/api/graphql' || pathname.startsWith('/api/graphql/')) {
        if (method !== 'POST') {
          sendJson(res, 404, requestId, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        let body: unknown = null;
        try {
          body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, requestId, { message: 'Malformed JSON body' });
          return;
        }
        const out = handleGraphql(store, body);
        sendJson(res, out.status, requestId, out.json);
        return;
      }

      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, requestId, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        let body: unknown = null;
        try {
          body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, requestId, {
            jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
          });
          return;
        }
        const out = handleMcp(store, body);
        if (out.json === null) {
          res.writeHead(out.status, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        sendJson(res, out.status, requestId, out.json);
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        // The root is GET /api/v3/ — segments is empty there; represent it
        // as [''] so handleRest sees the root.
        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        let body: unknown = null;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, requestId, { message: 'Malformed JSON body' });
            return;
          }
        }
        const out = handleRest(store, method, restSegments.length === 0 ? [''] : restSegments, query, body, raw, req.headers.host as string | undefined);
        if (out.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        sendJson(res, out.status, requestId, out.json ?? { message: 'Not Found' }, out.headers);
        return;
      }

      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch) {
        const owner = decodeSegment(gitMatch[1]);
        const repoName = decodeSegment(gitMatch[2]);
        const service = gitMatch[3];
        const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
        if (service === 'info/refs') {
          if (method !== 'GET') {
            sendJson(res, 404, requestId, { message: 'Not Found' });
            return;
          }
          const out = infoRefs(repo, query.service ?? '', req.headers['git-protocol'] as string | undefined);
          if (out.status === 404) sendJson(res, 404, requestId, { message: 'Not Found' });
          else sendRaw(res, 200, requestId, out.contentType, out.body);
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 404, requestId, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        if (service === 'git-upload-pack') {
          const out = uploadPack(repo, raw, req.headers['git-protocol'] as string | undefined);
          if (out.status === 404) sendJson(res, 404, requestId, { message: 'Not Found' });
          else sendRaw(res, 200, requestId, out.contentType, out.body);
          return;
        }
        const out = receivePack(repo, raw);
        if (out.status === 404) sendJson(res, 404, requestId, { message: 'Not Found' });
        else sendRaw(res, 200, requestId, out.contentType, out.body);
        return;
      }

      sendJson(res, 404, requestId, { message: 'Not Found' });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, requestId, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 31000;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}
