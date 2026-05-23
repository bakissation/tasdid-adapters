import type { Checkout } from '@bakissation/tasdid';
import { createPaymentHandlers, type GenericResult, type PaymentHandlersOptions, type StartInput, type RefundInput } from './core.js';

/**
 * Handlers built on the Web Fetch API (`Request` → `Response`) — the substrate
 * under Next.js App Router route handlers, Hono, Remix, SvelteKit, Cloudflare
 * Workers, Bun and Deno. No framework import, so it survives framework majors.
 *
 * Wire each into your route, e.g. Next.js App Router:
 *   // app/api/pay/route.ts          → export const POST = pay.start
 *   // app/api/pay/return/route.ts   → export const GET  = pay.handleReturn
 *   // app/api/pay/reconcile/route.ts→ export const GET  = pay.reconcile
 *   // app/api/pay/refund/route.ts   → export const POST = pay.refund
 */
export interface FetchHandlers {
  start(request: Request): Promise<Response>;
  handleReturn(request: Request): Promise<Response>;
  reconcile(request: Request): Promise<Response>;
  refund(request: Request): Promise<Response>;
}

function toResponse(r: GenericResult): Response {
  if (r.redirect !== undefined) {
    return new Response(null, { status: r.status, headers: { Location: r.redirect, ...(r.headers ?? {}) } });
  }
  return Response.json(r.body ?? null, { status: r.status, headers: r.headers });
}

function queryOf(request: Request): Record<string, string | undefined> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

function headersOf(request: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function jsonOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function createFetchHandlers(checkout: Checkout, opts: PaymentHandlersOptions): FetchHandlers {
  const h = createPaymentHandlers(checkout, opts);
  return {
    start: async (request) => toResponse(await h.start((await jsonOf(request)) as StartInput)),
    handleReturn: async (request) => toResponse(await h.handleReturn(queryOf(request))),
    reconcile: async (request) => toResponse(await h.reconcile({ headers: headersOf(request) })),
    refund: async (request) => toResponse(await h.refund((await jsonOf(request)) as RefundInput, { headers: headersOf(request) })),
  };
}
