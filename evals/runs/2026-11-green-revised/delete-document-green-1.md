# delete-document — Sonnet 5.5 — revised skill 1

- **Scenario:** [`../../scenarios/delete-document.md`](../../scenarios/delete-document.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.delete('/api/v1/documents/:id', deleteDocument);` |
| **2. Kill switch** | Correct (skip) | No flag. The run gives the reason: it only writes its own database. The revised skip clause holds; scored separately as a definitional gain. |
| **3. Circuit breaker** | Correct (skip) | No external dependency; the run declines a breaker on its own database. |
| **4. Deadline on every I/O** | Correct | The whole `db.transaction` is wrapped in `withTimeout`. |
| **5. Off the request path** | Correct (not counted) | Cleanup goes through `tx.outbox.insert` in the same transaction. Scored n/a in the baseline, so excluded from the comparison. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | n/a | Write path; the update itself filters `deleted_at IS NULL`. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, NextFunction, Router } from 'express';

// ---- Assumed existing infrastructure ---------------------------------------
declare const db: {
  documents: {
    // Must filter `deleted_at IS NULL` by default.
    findById(id: string, tx?: Tx): Promise<DocumentRow | null>;
    // UPDATE ... SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
    // Returns number of rows changed.
    softDelete(id: string, ownerId: string, tx: Tx): Promise<number>;
  };
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};
declare const log: {
  info(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
};
declare const metrics: { increment(name: string, tags?: Record<string, string>): void };

interface Tx {
  outbox: { insert(row: { type: string; payload: object }): Promise<void> };
  auditLog: { insert(row: object): Promise<void> };
}
interface DocumentRow {
  id: string;
  ownerId: string;
  deletedAt: Date | null;
}
type AuthedRequest = Request & { userId?: string };

// ---- Helpers ----------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DB_DEADLINE_MS = 800;

class DeadlineExceeded extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
  }
}

// Every database call crosses a process boundary, so every one gets a deadline.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---- Handler ----------------------------------------------------------------
export async function deleteDocument(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'unauthenticated' });
  }

  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'invalid document id' });
  }

  try {
    const outcome = await withTimeout(
      db.transaction(async (tx) => {
        // The read filters tombstones: an already-deleted document is "not found".
        const doc = await db.documents.findById(id, tx);

        // Same 404 for "missing" and "someone else's" so ids can't be probed.
        if (!doc || doc.ownerId !== userId) return 'not_found' as const;

        // Ownership is re-asserted in the WHERE clause, and deleted_at IS NULL
        // makes a concurrent double-delete a no-op instead of a double side effect.
        const changed = await db.documents.softDelete(id, userId, tx);
        if (changed === 0) return 'not_found' as const;

        // Storage blob purge, search de-indexing, and share-link revocation do not
        // belong on the request path. The outbox row commits atomically with the
        // tombstone, so a crash can never leave one without the other.
        await tx.outbox.insert({
          type: 'document.deleted',
          payload: { documentId: id, ownerId: userId },
        });
        await tx.auditLog.insert({
          action: 'document.delete',
          actorId: userId,
          documentId: id,
          requestId: req.get('x-request-id') ?? null,
        });
        return 'deleted' as const;
      }),
      DB_DEADLINE_MS * 3,
      'documents.delete.tx',
    );

    if (outcome === 'not_found') {
      metrics.increment('document.delete.not_found');
      return res.status(404).json({ error: 'document not found' });
    }

    metrics.increment('document.delete.ok');
    log.info('document.deleted', { documentId: id, userId });
    return res.status(204).end();
  } catch (err) {
    // A log is forensics; the counter is what pages someone.
    metrics.increment('document.delete.failed', {
      reason: err instanceof DeadlineExceeded ? 'timeout' : 'error',
    });
    log.error('document.delete.failed', { documentId: id, userId, err });
    if (err instanceof DeadlineExceeded) {
      return res.status(503).set('Retry-After', '5').json({ error: 'temporarily unavailable' });
    }
    return next(err); // central error handler returns a generic 500, no internals leaked
  }
}

// Versioned from day one.
export function registerDocumentRoutes(router: Router) {
  router.delete('/api/v1/documents/:id', deleteDocument);
}
```

**Production concerns I addressed**

- Authentication and authorization: reject a missing `req.userId` with 401, and check ownership in the handler and again in the `UPDATE ... WHERE owner_id` clause, so a race can't delete someone else's document.
- No existence leak: a missing document, a document owned by someone else, and an already-deleted document all return the same 404.
- Input validation: the id is checked as a UUID before any query runs, which returns a cheap 400 and avoids odd values reaching the database.
- Soft delete and tombstone-aware reads: the document is stamped `deleted_at` rather than removed, so it can be recovered and audited. The lookup excludes tombstones, and the update only matches `deleted_at IS NULL`.
- Idempotent and race-safe: a concurrent or retried delete changes zero rows, produces no second outbox event, and returns 404 instead of failing.
- Atomicity: the tombstone, outbox row, and audit entry commit in a single transaction.
- Slow work kept off the request path: blob deletion, search de-indexing, and share-link revocation go through a transactional outbox row that a worker drains. Nothing is awaited inline and nothing is lost on a restart.
- Deadline on the database: the transaction is wrapped in a timeout, and a timeout returns 503 with `Retry-After` instead of hanging the request.
- Observability: structured logs plus counters (`document.delete.ok`, `.not_found`, `.failed` tagged by reason) that can drive alerts. A request id is recorded in the audit trail.
- Versioned route: mounted at `/api/v1/documents/:id`.
- Errors: unexpected errors go to the central error handler, so no internals reach the client.
- Deliberately skipped: a kill switch (this only writes our own database, so a flag would just be flag debt) and a circuit breaker (there is no downstream service in the request path).
````
