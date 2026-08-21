import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createBrokerMcpServer, type McpAdapterDependenciesV4 } from './broker-server.js';

const DEFAULT_PATH = '/mcp';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;

export interface McpHttpAdapterOptionsV4 {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly bearerToken: string;
  readonly maxBodyBytes?: number;
  readonly maxSessions?: number;
  readonly sessionIdleTimeoutMs?: number;
  readonly now?: () => number;
}

export interface McpHttpAdapterV4 {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  close(): Promise<void>;
}

interface SessionV4 {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: ReturnType<typeof createBrokerMcpServer>;
  lastAccessMs: number;
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: ${message}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function tokenMatches(request: IncomingMessage, expected: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length);
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) throw new Error('INVALID_CONTRACT: MCP request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_CONTRACT: MCP request body is not valid JSON'); }
}

function sessionId(request: IncomingMessage): string | null {
  const value = request.headers['mcp-session-id'];
  if (Array.isArray(value) || value === undefined || value.length === 0) return null;
  return value;
}

export async function createMcpHttpAdapter(deps: McpAdapterDependenciesV4, options: McpHttpAdapterOptionsV4): Promise<McpHttpAdapterV4> {
  if (typeof options.bearerToken !== 'string' || options.bearerToken.length < 16 || options.bearerToken.length > 4_096) invalid('MCP HTTP bearer token is invalid');
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const path = options.path ?? DEFAULT_PATH;
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,127}$/u.test(path) || path.endsWith('/')) invalid('MCP HTTP path is invalid');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) invalid('MCP HTTP port is invalid');
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 16 * 1024 * 1024) invalid('MCP HTTP body limit is invalid');
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1_024) invalid('MCP HTTP session limit is invalid');
  if (!Number.isSafeInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1_000 || sessionIdleTimeoutMs > 24 * 60 * 60 * 1_000) invalid('MCP HTTP session idle timeout is invalid');
  const now = options.now ?? Date.now;

  const sessions = new Map<string, SessionV4>();
  let pendingInitializations = 0;
  const closeSession = async (id: string, session: SessionV4): Promise<void> => {
    if (sessions.get(id) === session) sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };
  const pruneIdleSessions = async (): Promise<void> => {
    const cutoff = now() - sessionIdleTimeoutMs;
    await Promise.all([...sessions].filter(([, session]) => session.lastAccessMs <= cutoff).map(([id, session]) => closeSession(id, session)));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (requestPath !== path) { sendJson(response, 404, { error: 'not found' }); return; }
      if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
      if (!tokenMatches(request, options.bearerToken)) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      await pruneIdleSessions();

      const currentSessionId = sessionId(request);
      let body: unknown;
      if (request.method === 'POST') body = await readJsonBody(request, maxBodyBytes);
      let current = currentSessionId === null ? undefined : sessions.get(currentSessionId);
      if (current === undefined && request.method === 'POST' && currentSessionId === null && isInitializeRequest(body)) {
        if (sessions.size + pendingInitializations >= maxSessions) { sendJson(response, 429, { error: 'MCP session capacity reached' }); return; }
        pendingInitializations += 1;
        try {
          let createdSessionId: string | null = null;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (value) => { createdSessionId = value; },
          });
          const mcpServer = createBrokerMcpServer(deps);
          current = { transport, server: mcpServer, lastAccessMs: now() };
          transport.onclose = () => {
            if (createdSessionId !== null && sessions.get(createdSessionId)?.transport === transport) sessions.delete(createdSessionId);
            void mcpServer.close().catch(() => undefined);
          };
          await mcpServer.connect(transport);
          await transport.handleRequest(request, response, body);
          if (createdSessionId !== null) sessions.set(createdSessionId, current);
          return;
        } finally {
          pendingInitializations -= 1;
        }
      }
      if (current === undefined) {
        sendJson(response, 400, { error: 'missing or invalid MCP session' });
        return;
      }
      current.lastAccessMs = now();
      await current.transport.handleRequest(request, response, body);
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 400, { error: error instanceof Error ? error.message.split(':', 2)[0] : 'invalid request' });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    server,
    host,
    port: boundPort,
    path,
    close: () => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        await Promise.allSettled([...sessions.values()].map(async ({ transport, server: mcpServer }) => {
          await transport.close().catch(() => undefined);
          await mcpServer.close().catch(() => undefined);
        }));
        sessions.clear();
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        await deps.client.close();
      })();
      return closePromise;
    },
  });
}

export async function runMcpHttpAdapter(deps: McpAdapterDependenciesV4, options: McpHttpAdapterOptionsV4): Promise<McpHttpAdapterV4> {
  return createMcpHttpAdapter(deps, options);
}
