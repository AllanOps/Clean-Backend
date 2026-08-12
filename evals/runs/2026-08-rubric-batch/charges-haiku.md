# charges — Haiku-class — baseline

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), baseline prompt used verbatim
- **Model:** Claude Haiku-class, 2026-08-11
- **Condition:** baseline — no skill loaded
- **Record kind:** verbatim

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | Handler `createCharge`; no version. |
| **2. Feature flags** | Absent | No kill switch. |
| **3. Circuit breaker** | Absent | Timeout only. |
| **4. Deadline on every I/O** | **Present** | 30s `Promise.race` on the provider — but `db.charges.findByIdempotencyKey`, `db.charges.insert`, and `mailer.sendReceipt` are all unbounded. |
| **5. Off the request path** | **Present** | `mailer.sendReceipt(...).catch(...)` — a floating promise, lost on process restart. Not durable ⇒ not Correct. |
| **6. Business counters** | Absent | `console.error` / `console.info` only; nothing alertable. |
| **7. Tombstone-aware reads** | n/a | No visibility read. |
| *Idempotency* (cut) | **Present** | `idempotencyKey?: string` — **optional**, so a client that omits it gets no protection. Looked up but **not reserved before the charge**, leaving a TOCTOU window. Fails two rubric criteria. |
| *Validation* (cut) | Correct | Type checks, positive-integer amount, ISO 4217 regex, max-amount ceiling. |
| *Degradation* (cut) | Present | Charge-succeeded-but-persist-failed returns 500 *with* the `chargeId`, which is good, but a 500 still invites a client retry. |
| *Field-limiting* (cut) | Correct | Explicit `ChargeResponse` shape. |
| *Naming* (cut) | Correct | `createCharge`, `ChargeRequest`, `paymentResult`. |

**Reached Present or better: 3 of 6 applicable · Reached Correct: 0 of 6 applicable.**

## Notes

The tier gap, stated precisely. The frontier run on this same prompt scored idempotency **Correct** — mandatory key, reserved before the charge, fingerprinted, fails closed. This run scores it **Present**: optional and unreserved.

A reviewer reading only the model's own summary would see *"Idempotency: detects and returns cached result if same idempotency key is replayed, preventing double-charges"* and tick the box. The rubric is what separates that claim from the implementation.

Consistent with the two earlier Haiku charges runs (one Absent, one Present-and-fail-open). Across all three, Haiku idempotency has never reached Correct.

## Verbatim output

````markdown
```typescript
import { Request, Response } from 'express';

interface ChargeRequest {
  customerId: string;
  amountCents: number;
  currency: string;
  idempotencyKey?: string;
}

interface ChargeResponse {
  chargeId: string;
  status: 'success';
  amountCents: number;
  currency: string;
  timestamp: string;
}

// POST /charges
export async function createCharge(req: Request, res: Response): Promise<void> {
  const { customerId, amountCents, currency, idempotencyKey } = req.body as ChargeRequest;
  const requestId = req.id || Math.random().toString(36).substring(7);

  try {
    // 1. Validate input
    if (!customerId || typeof customerId !== 'string' || customerId.trim().length === 0) {
      res.status(400).json({ error: 'Invalid or missing customerId' });
      return;
    }

    if (typeof amountCents !== 'number' || amountCents <= 0 || !Number.isInteger(amountCents)) {
      res.status(400).json({ error: 'amountCents must be a positive integer' });
      return;
    }

    if (!currency || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      res.status(400).json({ error: 'Invalid currency code (must be 3-letter ISO 4217)' });
      return;
    }

    // Sanity check: reject obviously fraudulent or erroneous amounts
    if (amountCents > 99999999) {
      res.status(400).json({ error: 'Amount exceeds maximum allowed charge' });
      return;
    }

    // 2. Check idempotency - return cached result if already processed
    if (idempotencyKey) {
      const existingCharge = await db.charges.findByIdempotencyKey(idempotencyKey);
      if (existingCharge) {
        res.status(200).json({
          chargeId: existingCharge.chargeId,
          status: 'success',
          amountCents: existingCharge.amountCents,
          currency: existingCharge.currency,
          timestamp: existingCharge.createdAt.toISOString(),
        } as ChargeResponse);
        return;
      }
    }

    // 3. Call payment provider with timeout
    let paymentResult;
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Payment provider timeout after 30s')), 30000)
      );

      paymentResult = await Promise.race([
        paymentProvider.charge({ customerId, amountCents, currency }),
        timeoutPromise,
      ]);
    } catch (paymentError) {
      const errorMsg = paymentError instanceof Error ? paymentError.message : 'Unknown error';

      console.error(`[${requestId}] Payment failed for customer ${customerId}:`, errorMsg);

      if (errorMsg.includes('timeout')) {
        res.status(504).json({ error: 'Payment provider unavailable, please retry' });
        return;
      }

      if (errorMsg.includes('insufficient funds') || errorMsg.includes('declined')) {
        res.status(402).json({ error: 'Payment declined' });
        return;
      }

      if (errorMsg.includes('invalid card') || errorMsg.includes('expired')) {
        res.status(400).json({ error: 'Invalid payment method' });
        return;
      }

      res.status(402).json({ error: 'Payment processing failed' });
      return;
    }

    if (!paymentResult?.chargeId) {
      console.error(`[${requestId}] Payment provider returned invalid response:`, paymentResult);
      res.status(502).json({ error: 'Invalid payment provider response' });
      return;
    }

    // 4. Persist charge to database
    let dbCharge;
    try {
      dbCharge = await db.charges.insert({
        chargeId: paymentResult.chargeId,
        customerId,
        amountCents,
        currency,
        status: 'completed',
        idempotencyKey: idempotencyKey || null,
        createdAt: new Date(),
        paymentProviderRef: paymentResult.chargeId,
      });
    } catch (dbError) {
      // Database insert failed - charge succeeded at provider but failed to record
      const errorMsg = dbError instanceof Error ? dbError.message : 'Unknown error';
      console.error(
        `[${requestId}] CRITICAL: Charge succeeded but DB insert failed. ` +
          `chargeId=${paymentResult.chargeId}, customerId=${customerId}, error=${errorMsg}`
      );

      // Still send receipt for the charge that succeeded (fire-and-forget)
      mailer
        .sendReceipt(customerId, paymentResult.chargeId)
        .catch((mailError) =>
          console.error(`[${requestId}] Failed to send receipt after DB error:`, mailError)
        );

      res.status(500).json({
        error: 'Charge succeeded but confirmation failed. Support has been notified.',
        chargeId: paymentResult.chargeId,
      });
      return;
    }

    // 5. Send receipt asynchronously (non-blocking)
    mailer.sendReceipt(customerId, paymentResult.chargeId).catch((mailError) => {
      console.warn(
        `[${requestId}] Receipt email failed for customer ${customerId}, chargeId=${paymentResult.chargeId}:`,
        mailError instanceof Error ? mailError.message : mailError
      );
    });

    // 6. Success response
    res.status(201).json({
      chargeId: paymentResult.chargeId,
      status: 'success',
      amountCents,
      currency,
      timestamp: dbCharge.createdAt.toISOString(),
    } as ChargeResponse);

    console.info(
      `[${requestId}] Charge created: chargeId=${paymentResult.chargeId}, ` +
        `customerId=${customerId}, amount=${amountCents} ${currency}`
    );
  } catch (unknownError) {
    const requestId = (req as any).id || 'unknown';
    console.error(`[${requestId}] Unexpected error in createCharge:`, unknownError);

    res.status(500).json({ error: 'Internal server error', requestId });
  }
}
```

## Production concerns I addressed

- **Input validation**: Type checks, required fields, sanitization (currency code format, amount sanity checks)
- **Idempotency**: Detects and returns cached result if same idempotency key is replayed, preventing double-charges
- **Timeout handling**: Payment provider calls have a 30-second timeout to fail fast instead of hanging
- **Error categorization**: Different HTTP status codes (402, 400, 504) based on error type so clients retry intelligently
- **Critical failure logging**: If charge succeeds at provider but DB insert fails, this is flagged as CRITICAL with full context for ops investigation
- **Email resilience**: Receipt delivery is fire-and-forget; email failures don't block the charge response or cause rollbacks
- **Observability**: Request IDs threaded through logs for tracing; all critical paths logged with context
- **Response semantics**: Uses 201 Created for success, appropriate 4xx/5xx for errors with actionable messages
- **Database atomic write**: Single insert operation keeps charge record transactional
- **Error recovery**: Avoids zombie states (e.g., charge succeeded but not recorded) by accepting the inconsistency but alerting ops
````
