import { describe, it, expect } from 'vitest';
import { createCheckout, createMemoryStore, type PaymentStore } from '@bakissation/tasdid';
import { createMockSatim, type MockSatimOptions } from '@bakissation/satim-testing';
import { createFetchHandlers } from '../src/fetch.js';
import type { PaymentHandlersOptions } from '../src/core.js';

function setup(o: { satim?: MockSatimOptions; handlers?: Partial<PaymentHandlersOptions> } = {}) {
  const satim = createMockSatim(o.satim);
  const store: PaymentStore = createMemoryStore();
  const checkout = createCheckout({ satim, store });
  const pay = createFetchHandlers(checkout, { successUrl: '/ok', failUrl: '/no', store, ...o.handlers });
  return { satim, store, checkout, pay };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://shop.dz${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://shop.dz${path}`, { headers });

const order = { orderNumber: 'A1', amount: 5000, returnUrl: 'https://shop.dz/return' };

describe('start', () => {
  it('returns paymentId + redirectUrl', async () => {
    const { pay } = setup();
    const res = await pay.start(post('/api/pay', order));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paymentId).toBeTruthy();
    expect(body.redirectUrl).toContain('satim');
  });

  it('400 on missing orderNumber', async () => {
    const { pay } = setup();
    const res = await pay.start(post('/api/pay', { amount: 5000, returnUrl: 'x' }));
    expect(res.status).toBe(400);
  });
});

describe('handleReturn', () => {
  it('303 → successUrl when paid (never trusts the redirect — reconfirms)', async () => {
    const { pay } = setup();
    const started = await (await pay.start(post('/api/pay', order))).json();
    const res = await pay.handleReturn(get(`/return?paymentId=${started.paymentId}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/ok?payment=');
  });

  it('303 → failUrl when declined', async () => {
    const { pay } = setup({ satim: { scenario: 'declined' } });
    const started = await (await pay.start(post('/api/pay', { ...order, orderNumber: 'B1' }))).json();
    const res = await pay.handleReturn(get(`/return?paymentId=${started.paymentId}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/no?payment=');
  });
});

describe('reconcile', () => {
  it('returns operational counts, drops the heavy payload', async () => {
    const { pay } = setup();
    await pay.start(post('/api/pay', order));
    const res = await pay.reconcile(get('/reconcile'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paid).toBe(1);
    expect(body).not.toHaveProperty('results');
  });

  it('tags each failure with a safe code when a status query throws', async () => {
    const { pay, satim } = setup();
    await pay.start(post('/api/pay', order));
    satim.getOrderStatus = async () => {
      throw new Error('gateway unreachable');
    };
    const res = await pay.reconcile(get('/reconcile'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].paymentId).toBeTruthy();
    expect(body.failures[0].code).toBe('UNKNOWN');
  });

  it('401 when authorize rejects', async () => {
    const { pay } = setup({ handlers: { authorize: () => false } });
    expect((await pay.reconcile(get('/reconcile'))).status).toBe(401);
  });

  it('501 when no store is configured', async () => {
    const checkout = createCheckout({ satim: createMockSatim(), store: createMemoryStore() });
    const pay = createFetchHandlers(checkout, { successUrl: '/ok', failUrl: '/no' });
    expect((await pay.reconcile(get('/reconcile'))).status).toBe(501);
  });
});

describe('refund', () => {
  it('refunds a paid payment (Dinar serialized to centimes + string)', async () => {
    const { pay } = setup();
    const started = await (await pay.start(post('/api/pay', order))).json();
    await pay.handleReturn(get(`/return?paymentId=${started.paymentId}`)); // → paid
    const res = await pay.refund(post('/refund', { paymentId: started.paymentId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('refunded');
    expect(body.amountCentimes).toBe(500000);
    expect(typeof body.amount).toBe('string');
  });

  it('404 for an unknown payment', async () => {
    const { pay } = setup();
    expect((await pay.refund(post('/refund', { paymentId: 'nope' }))).status).toBe(404);
  });

  it('401 when authorize rejects', async () => {
    const { pay } = setup({ handlers: { authorize: () => false } });
    expect((await pay.refund(post('/refund', { paymentId: 'x' }))).status).toBe(401);
  });
});
