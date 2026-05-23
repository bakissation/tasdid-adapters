import { Dinar } from '@bakissation/dinar';
import {
  TasdidError,
  type TasdidErrorCode,
  reconcilePending,
  type Checkout,
  type PaymentResult,
  type PaymentStore,
  type SatimLanguage,
} from '@bakissation/tasdid';

/** A framework-agnostic result. Bindings turn this into their runtime's response. */
export interface GenericResult {
  status: number;
  body?: unknown;
  redirect?: string;
  headers?: Record<string, string>;
}

export interface RequestContext {
  /** Lower-cased request headers (for the `authorize` hook). */
  headers: Record<string, string | undefined>;
}

export interface StartInput {
  orderNumber: string;
  /** Amount in DZD (e.g. `5000` = 5000 DA). Number or numeric string. */
  amount: number | string;
  returnUrl: string;
  failUrl?: string;
  description?: string;
  language?: SatimLanguage;
  metadata?: Record<string, unknown>;
}

export interface RefundInput {
  paymentId: string;
  /** Amount in DZD to refund; omit for a full refund. */
  amount?: number | string;
  idempotencyKey?: string;
}

type UrlResolver = string | ((result: PaymentResult) => string);

export interface PaymentHandlersOptions {
  /** Where `handleReturn` sends a paid buyer (a path/URL, or a fn of the result). */
  successUrl: UrlResolver;
  /** Where `handleReturn` sends a non-paid buyer. */
  failUrl: UrlResolver;
  /** The same `PaymentStore` the checkout uses — required for the `reconcile` sweep. */
  store?: PaymentStore;
  /**
   * Guard for `refund` and `reconcile`. Vendor-agnostic: you decide how to
   * authenticate (a bearer token, a session, an IP allow-list…). Return `false`
   * (or throw) to reject with 401.
   */
  authorize?: (ctx: RequestContext & { action: 'refund' | 'reconcile' }) => boolean | Promise<boolean>;
  /** Max payments per reconcile sweep. */
  sweepLimit?: number;
  /** Override the default `TasdidError`→HTTP mapping. */
  onError?: (err: unknown) => GenericResult;
}

export interface PaymentHandlers {
  start(input: StartInput): Promise<GenericResult>;
  handleReturn(query: Record<string, string | undefined>): Promise<GenericResult>;
  reconcile(ctx?: RequestContext): Promise<GenericResult>;
  refund(input: RefundInput, ctx?: RequestContext): Promise<GenericResult>;
}

// Partial + default: a new tasdid error code can never break the mapping.
const HTTP_BY_CODE: Partial<Record<TasdidErrorCode, number>> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  NOT_REFUNDABLE: 409,
  REFUND_EXCEEDS_DEPOSIT: 409,
  INVALID_TRANSITION: 409,
  REGISTER_FAILED: 502,
  REFUND_FAILED: 502,
};

function mapError(err: unknown, onError?: PaymentHandlersOptions['onError']): GenericResult {
  if (onError) return onError(err);
  if (err instanceof TasdidError) {
    return { status: HTTP_BY_CODE[err.code] ?? 500, body: { error: err.message, code: err.code } };
  }
  return { status: 500, body: { error: 'Internal error' } };
}

/** A safe, enumerable reason for a sweep failure — our error taxonomy, never gateway internals. */
function failureCode(err: unknown): TasdidErrorCode | 'UNKNOWN' {
  return err instanceof TasdidError ? err.code : 'UNKNOWN';
}

/** JSON-safe view of a PaymentResult (Dinar → exact centimes + a formatted string). */
function serialize(r: PaymentResult): Record<string, unknown> {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    orderId: r.orderId,
    status: r.status,
    paid: r.paid,
    amountCentimes: r.amount.toCentimes(),
    amount: r.amount.format(),
    refundedCentimes: r.refundedAmount.toCentimes(),
    refundedAmount: r.refundedAmount.format(),
    redirectUrl: r.redirectUrl,
    expiresAt: r.expiresAt,
    history: r.history,
    refunds: r.refunds,
    satim: r.satim,
  };
}

function resolveUrl(resolver: UrlResolver, result: PaymentResult): string {
  const url = typeof resolver === 'function' ? resolver(result) : resolver;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}payment=${encodeURIComponent(result.id)}`;
}

function toDinar(amount: number | string): Dinar {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) throw new TasdidError('amount must be a finite number of DZD', 'INVALID_INPUT');
  return Dinar.fromDinars(n);
}

/** Build the framework-agnostic payment handlers around a tasdid checkout. */
export function createPaymentHandlers(checkout: Checkout, opts: PaymentHandlersOptions): PaymentHandlers {
  async function guard(action: 'refund' | 'reconcile', ctx?: RequestContext): Promise<boolean> {
    if (!opts.authorize) return true;
    try {
      return await opts.authorize({ action, headers: ctx?.headers ?? {} });
    } catch {
      return false;
    }
  }

  return {
    async start(input) {
      try {
        if (!input || typeof input.orderNumber !== 'string' || !input.orderNumber) {
          throw new TasdidError('orderNumber is required', 'INVALID_INPUT');
        }
        if (typeof input.returnUrl !== 'string' || !input.returnUrl) {
          throw new TasdidError('returnUrl is required', 'INVALID_INPUT');
        }
        const { paymentId, redirectUrl } = await checkout.start({
          orderNumber: input.orderNumber,
          amount: toDinar(input.amount),
          returnUrl: input.returnUrl,
          failUrl: input.failUrl,
          description: input.description,
          language: input.language,
          metadata: input.metadata,
        });
        return { status: 200, body: { paymentId, redirectUrl } };
      } catch (err) {
        return mapError(err, opts.onError);
      }
    },

    async handleReturn(query) {
      try {
        const result = await checkout.handleReturn({ orderId: query.orderId, paymentId: query.paymentId });
        const target = result.paid ? opts.successUrl : opts.failUrl;
        return { status: 303, redirect: resolveUrl(target, result) };
      } catch (err) {
        return mapError(err, opts.onError);
      }
    },

    async reconcile(ctx) {
      if (!(await guard('reconcile', ctx))) return { status: 401, body: { error: 'unauthorized' } };
      if (!opts.store) return { status: 501, body: { error: 'reconcile is not configured (pass `store`)' } };
      try {
        const summary = await reconcilePending(checkout, opts.store, { limit: opts.sweepLimit });
        // drop the heavy `results`/Dinar payloads — return the operational counts only
        const { results: _results, failures, ...counts } = summary;
        return {
          status: 200,
          body: { ...counts, failures: failures.map((f) => ({ paymentId: f.paymentId, code: failureCode(f.error) })) },
        };
      } catch (err) {
        return mapError(err, opts.onError);
      }
    },

    async refund(input, ctx) {
      if (!(await guard('refund', ctx))) return { status: 401, body: { error: 'unauthorized' } };
      try {
        if (!input || typeof input.paymentId !== 'string' || !input.paymentId) {
          throw new TasdidError('paymentId is required', 'INVALID_INPUT');
        }
        const result = await checkout.refund(
          input.paymentId,
          input.amount != null ? toDinar(input.amount) : undefined,
          { idempotencyKey: input.idempotencyKey },
        );
        return { status: 200, body: serialize(result) };
      } catch (err) {
        return mapError(err, opts.onError);
      }
    },
  };
}
