import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Checkout } from '@bakissation/tasdid';
import {
  createPaymentHandlers,
  type GenericResult,
  type PaymentHandlersOptions,
  type StartInput,
  type RefundInput,
} from './core.js';

/** Optional pre-parsed body. Fastify drains `request.raw`, so pass `request.body` here. */
export interface NodeExtra {
  body?: unknown;
}

/**
 * Handlers on Node's `http` substrate (`IncomingMessage` → `ServerResponse`) — the
 * layer under Express, Connect and Fastify. No framework import, so it survives their
 * majors (Express 4→5, Fastify 3→4→5).
 *
 * Express / Connect (req/res ARE Node's objects — mount directly):
 *   app.use(express.json());
 *   app.post('/api/pay',           pay.start);
 *   app.get ('/api/pay/return',    pay.handleReturn);
 *   app.get ('/api/pay/reconcile', pay.reconcile);
 *   app.post('/api/pay/refund',    pay.refund);
 *
 * Fastify (pass the parsed body, hijack the reply):
 *   fastify.post('/api/pay', (req, reply) => {
 *     reply.hijack();
 *     return pay.start(req.raw, reply.raw, { body: req.body });
 *   });
 */
export interface NodeHandlers {
  start(req: IncomingMessage, res: ServerResponse, extra?: NodeExtra): Promise<void>;
  handleReturn(req: IncomingMessage, res: ServerResponse, extra?: NodeExtra): Promise<void>;
  reconcile(req: IncomingMessage, res: ServerResponse, extra?: NodeExtra): Promise<void>;
  refund(req: IncomingMessage, res: ServerResponse, extra?: NodeExtra): Promise<void>;
}

function toNode(res: ServerResponse, r: GenericResult): void {
  if (r.redirect !== undefined) {
    res.writeHead(r.status, { Location: r.redirect, ...(r.headers ?? {}) });
    res.end();
    return;
  }
  res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
  res.end(JSON.stringify(r.body ?? null));
}

function queryOf(req: IncomingMessage): Record<string, string | undefined> {
  return Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams);
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function readStream(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', reject);
  });
}

/** Express puts the parsed body on `req.body`; Fastify passes it via `extra.body`; otherwise read the raw stream. */
async function bodyOf(req: IncomingMessage, extra?: NodeExtra): Promise<unknown> {
  if (extra?.body !== undefined) return extra.body;
  const parsed = (req as { body?: unknown }).body;
  if (parsed !== undefined) return parsed;
  try {
    const raw = await readStream(req);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function createNodeHandlers(checkout: Checkout, opts: PaymentHandlersOptions): NodeHandlers {
  const h = createPaymentHandlers(checkout, opts);
  return {
    start: async (req, res, extra) => {
      toNode(res, await h.start((await bodyOf(req, extra)) as StartInput));
    },
    handleReturn: async (req, res) => {
      toNode(res, await h.handleReturn(queryOf(req)));
    },
    reconcile: async (req, res) => {
      toNode(res, await h.reconcile({ headers: headersOf(req) }));
    },
    refund: async (req, res, extra) => {
      toNode(res, await h.refund((await bodyOf(req, extra)) as RefundInput, { headers: headersOf(req) }));
    },
  };
}
