# @bakissation/tasdid-adapters

**Lightweight, vendor-agnostic framework bindings for [`@bakissation/tasdid`](https://github.com/bakissation/tasdid).** Mount the SATIM (CIB/Edahabia) payment lifecycle — `start` / `return` / `reconcile` / `refund` — as routes, in a few lines, on the **Web Fetch API**: Next.js App Router, Hono, Remix, SvelteKit, Cloudflare Workers, Bun, Deno.

[![npm](https://img.shields.io/npm/v/@bakissation/tasdid-adapters?label=npm&color=cb3837)](https://www.npmjs.com/package/@bakissation/tasdid-adapters)
[![CI](https://github.com/bakissation/tasdid-adapters/actions/workflows/ci.yml/badge.svg)](https://github.com/bakissation/tasdid-adapters/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npm i @bakissation/tasdid-adapters
```

## Why

Wiring the payment lifecycle into a route is the same boring glue every time: validate the body, call tasdid, map errors to HTTP, redirect the buyer. This does it once — and **binds to the Web Fetch standard, not a framework**, so it survives framework majors (Next 14→15→16…) untouched and runs on any Fetch runtime. **No framework dependency, no vendor lock-in.** Orchestration stays in [tasdid](https://github.com/bakissation/tasdid); this is thin.

## Quick start (Next.js App Router)

```ts
// lib/pay.ts
import { createCheckout, createPostgresStore } from '@bakissation/tasdid';
import { createSatimClient } from '@bakissation/satim';
import { createFetchHandlers } from '@bakissation/tasdid-adapters/fetch';

const store = createPostgresStore(pgPool);
const checkout = createCheckout({ satim: createSatimClient(satimConfig), store });

export const pay = createFetchHandlers(checkout, {
  successUrl: '/thanks',
  failUrl: '/payment-failed',
  store,                                   // enables the reconcile sweep
  authorize: ({ headers }) =>              // guards refund + reconcile (you pick the scheme)
    headers.authorization === `Bearer ${process.env.PAY_ADMIN_TOKEN}`,
});
```

```ts
// app/api/pay/route.ts
import { pay } from '@/lib/pay';
export const dynamic = 'force-dynamic';
export const POST = pay.start;
```

Each remaining route file is the same one line:

```ts
// app/api/pay/return/route.ts     → export const GET  = pay.handleReturn   // SATIM redirects buyer here
// app/api/pay/reconcile/route.ts  → export const GET  = pay.reconcile      // scheduled sweep (guarded)
// app/api/pay/refund/route.ts     → export const POST = pay.refund         // admin (guarded)
```

The browser navigates to the returned `redirectUrl` (full page — SATIM's hosted page, an independent context = PCI **SAQ-A**). On return, `handleReturn` **reconfirms against the gateway** (never trusts the redirect) and 303s the buyer to `successUrl`/`failUrl` with `?payment=<id>`.

## The reconcile sweep — schedule it with anything

SATIM has **no webhooks**, so a periodic sweep is how abandoned/expired orders settle. `pay.reconcile` is just a **guarded GET** — hit it from *any* scheduler (system `cron`, a CI schedule, a worker/queue, your platform's cron). Vendor-agnostic by design; auth is your `authorize` hook:

```bash
curl -H "Authorization: Bearer $PAY_ADMIN_TOKEN" https://yourapp/api/pay/reconcile
```

## Other runtimes (same handlers)

```ts
// Hono / Workers / Bun / Deno
app.post('/api/pay', (c) => pay.start(c.req.raw));
app.get('/api/pay/return', (c) => pay.handleReturn(c.req.raw));
```

## Options

| Option | |
|---|---|
| `successUrl` / `failUrl` | path/URL, or `(result) => string`, for the return redirect |
| `store` | the same `PaymentStore` your checkout uses — required for `reconcile` |
| `authorize` | guard for `refund` + `reconcile`; you choose the scheme (bearer, session, IP…) |
| `sweepLimit` | max payments per reconcile run |
| `onError` | override the `TasdidError → HTTP` mapping |

Errors map by code: `INVALID_INPUT → 400`, `NOT_FOUND → 404`, refund/transition conflicts → 409, gateway failures → 502, else 500. Bodies are generic (`{ error, code }`) — no gateway internals, no card data.

## Footprint

Zero framework dependency. Peers: `@bakissation/tasdid` + `@bakissation/dinar` (you already have them). One package, subpath entries — `/fetch` now; `/node` (Express/Connect/Fastify) later, same headless core (the `.` export, `createPaymentHandlers`).

## License

MIT © Abdelbaki Berkati

## Credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation).
