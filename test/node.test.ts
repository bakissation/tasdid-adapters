import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCheckout, createMemoryStore, type PaymentStore } from '@bakissation/tasdid';
import { createMockSatim, type MockSatimOptions } from '@bakissation/satim-testing';
import { createNodeHandlers } from '../src/node.js';
import type { PaymentHandlersOptions } from '../src/core.js';

function setup(o: { satim?: MockSatimOptions; handlers?: Partial<PaymentHandlersOptions> } = {}) {
  const satim = createMockSatim(o.satim);
  const store: PaymentStore = createMemoryStore();
  const checkout = createCheckout({ satim, store });
  const pay = createNodeHandlers(checkout, { successUrl: '/ok', failUrl: '/no', store, ...o.handlers });
  return { satim, store, checkout, pay };
}

class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers[k.toLowerCase()] = String(v);
    return this;
  }
  setHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = String(v);
  }
  end(data?: string): void {
    if (data) this.body = data;
  }
}

function mockReq(
  method: string,
  url: string,
  opts: { rawBody?: unknown; body?: unknown; headers?: Record<string, string> } = {},
): IncomingMessage {
  const payload = opts.rawBody !== undefined ? JSON.stringify(opts.rawBody) : '';
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage & { body?: unknown };
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json', ...opts.headers };
  if (opts.body !== undefined) req.body = opts.body;
  return req;
}

type Handler = (req: IncomingMessage, res: ServerResponse, extra?: { body?: unknown }) => Promise<void>;

async function call(handler: Handler, req: IncomingMessage): Promise<MockRes> {
  const res = new MockRes();
  await handler(req, res as unknown as ServerResponse);
  return res;
}

const order = { orderNumber: 'A1', amount: 5000, returnUrl: 'https://shop.dz/return' };

describe('start', () => {
  it('reads the raw stream → paymentId + redirectUrl', async () => {
    const { pay } = setup();
    const res = await call(pay.start, mockReq('POST', '/api/pay', { rawBody: order }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.paymentId).toBeTruthy();
    expect(body.redirectUrl).toContain('satim');
  });

  it('accepts a pre-parsed body (Express req.body and Fastify extra.body)', async () => {
    const { pay } = setup();
    const express = await call(pay.start, mockReq('POST', '/api/pay', { body: order }));
    expect(express.statusCode).toBe(200);
    const res = new MockRes();
    await pay.start(mockReq('POST', '/api/pay'), res as unknown as ServerResponse, {
      body: { ...order, orderNumber: 'A2' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('400 on missing orderNumber', async () => {
    const { pay } = setup();
    const res = await call(pay.start, mockReq('POST', '/api/pay', { rawBody: { amount: 5000, returnUrl: 'x' } }));
    expect(res.statusCode).toBe(400);
  });
});

describe('handleReturn', () => {
  it('303 → successUrl when paid (reconfirms, never trusts the redirect)', async () => {
    const { pay } = setup();
    const started = JSON.parse((await call(pay.start, mockReq('POST', '/api/pay', { rawBody: order }))).body);
    const res = await call(pay.handleReturn, mockReq('GET', `/return?paymentId=${started.paymentId}`));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('/ok?payment=');
  });

  it('303 → failUrl when declined', async () => {
    const { pay } = setup({ satim: { scenario: 'declined' } });
    const started = JSON.parse(
      (await call(pay.start, mockReq('POST', '/api/pay', { rawBody: { ...order, orderNumber: 'B1' } }))).body,
    );
    const res = await call(pay.handleReturn, mockReq('GET', `/return?paymentId=${started.paymentId}`));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('/no?payment=');
  });
});

describe('reconcile', () => {
  it('returns operational counts, drops the heavy payload', async () => {
    const { pay } = setup();
    await call(pay.start, mockReq('POST', '/api/pay', { rawBody: order }));
    const res = await call(pay.reconcile, mockReq('GET', '/reconcile'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.paid).toBe(1);
    expect(body).not.toHaveProperty('results');
  });

  it('401 when authorize rejects', async () => {
    const { pay } = setup({ handlers: { authorize: () => false } });
    expect((await call(pay.reconcile, mockReq('GET', '/reconcile'))).statusCode).toBe(401);
  });

  it('501 when no store is configured', async () => {
    const checkout = createCheckout({ satim: createMockSatim(), store: createMemoryStore() });
    const pay = createNodeHandlers(checkout, { successUrl: '/ok', failUrl: '/no' });
    expect((await call(pay.reconcile, mockReq('GET', '/reconcile'))).statusCode).toBe(501);
  });
});

describe('refund', () => {
  it('refunds a paid payment (Dinar serialized to centimes + string)', async () => {
    const { pay } = setup();
    const started = JSON.parse((await call(pay.start, mockReq('POST', '/api/pay', { rawBody: order }))).body);
    await call(pay.handleReturn, mockReq('GET', `/return?paymentId=${started.paymentId}`)); // → paid
    const res = await call(pay.refund, mockReq('POST', '/refund', { rawBody: { paymentId: started.paymentId } }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('refunded');
    expect(body.amountCentimes).toBe(500000);
    expect(typeof body.amount).toBe('string');
  });

  it('404 for an unknown payment', async () => {
    const { pay } = setup();
    expect((await call(pay.refund, mockReq('POST', '/refund', { rawBody: { paymentId: 'nope' } }))).statusCode).toBe(404);
  });

  it('401 when authorize rejects', async () => {
    const { pay } = setup({ handlers: { authorize: () => false } });
    expect((await call(pay.refund, mockReq('POST', '/refund', { rawBody: { paymentId: 'x' } }))).statusCode).toBe(401);
  });
});
