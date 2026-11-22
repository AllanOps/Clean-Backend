# delete-document — Sonnet 5.5 — with skill 1

- **Scenario:** [`../../scenarios/delete-document.md`](../../scenarios/delete-document.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `'/api/v1/documents/:id'` |
| **2. Feature flags** | Absent | Declined: per the agent's hand-back, a plain delete has no risky new behavior to roll back. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Correct | Declined; the run notes the primary DB is not a downstream service, so the skip condition holds. |
| **4. Deadline on every I/O** | Correct | `softDeleteOwned` and `queue.enqueue` both wrapped in `withTimeout`. |
| **5. Off the request path** | Correct (not counted) | `queue.enqueue('document.cleanup', { documentId: id, ownerId: userId, requestId })` is durable. Scored n/a in the baseline, so excluded from the comparison. |
| **6. Business counters** | Correct | `metrics.increment('document.delete.succeeded')` plus `not_found`, `failed`, `timeout`, `enqueue_failed`. |
| **7. Tombstone-aware reads** | n/a | Write path; the conditional update itself filters `deleted_at IS NULL`. |

## Verbatim output

````markdown
```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { queue } from '../queue';
import { log } from '../log';
import { metrics } from '../metrics';

// Assumed shapes (already exist in the codebase):
//   db.documents.softDeleteOwned({ id, ownerId, deletedAt }): Promise<{ id: string } | null>
//     -> single atomic statement:
//        UPDATE documents SET deleted_at = $3
//        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
//        RETURNING id
//     Every document read elsewhere must also filter `deleted_at IS NULL`.

interface AuthedRequest extends Request {
  userId?: string;
}

const DB_TIMEOUT_MS = 800;
const ENQUEUE_TIMEOUT_MS = 500;

const paramsSchema = z.object({ id: z.string().uuid() });

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

// Every I/O call crosses a process boundary, including the database, so it gets a deadline.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const documentsRouter = Router();

// Versioned from day one: mobile clients outlive refactors.
documentsRouter.delete(
  '/api/v1/documents/:id',
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined;

    try {
      // Defense in depth: auth middleware should already have rejected this.
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: 'unauthenticated' });
      }

      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_document_id' });
      }
      const { id } = parsed.data;

      // Ownership check and delete in ONE atomic statement: no check-then-act race
      // (TOCTOU), and no extra round trip. Soft delete (tombstone) so the delete is
      // recoverable and auditable; the row is purged later by a retention job.
      const deleted = await withTimeout(
        db.documents.softDeleteOwned({ id, ownerId: userId, deletedAt: new Date() }),
        DB_TIMEOUT_MS,
        'db.documents.softDeleteOwned',
      );

      if (!deleted) {
        // Not found, already deleted, OR owned by someone else: indistinguishable on
        // purpose, so callers cannot probe which document ids exist (no IDOR oracle).
        metrics.increment('document.delete.not_found');
        return res.status(404).json({ error: 'document_not_found' });
      }

      // Blob storage, search index, and share-link cleanup are not something the caller
      // waits on. Hand off to a worker; the endpoint's job is the authoritative delete.
      // A failed enqueue must not turn a successful delete into a 500 -- a periodic
      // sweeper reconciles tombstones that never got cleaned up.
      try {
        await withTimeout(
          queue.enqueue('document.cleanup', { documentId: id, ownerId: userId, requestId }),
          ENQUEUE_TIMEOUT_MS,
          'queue.enqueue',
        );
      } catch (err) {
        log.error('document.delete.enqueue_failed', { documentId: id, userId, requestId, err });
        metrics.increment('document.delete.enqueue_failed');
      }

      log.info('document.deleted', { documentId: id, userId, requestId });
      metrics.increment('document.delete.succeeded');
      return res.status(204).send();
    } catch (err) {
      // Counter next to the log: logs are forensics, counters are what pages someone.
      const isTimeout = err instanceof TimeoutError;
      log.error('document.delete.failed', {
        documentId: req.params.id,
        userId: req.userId,
        requestId,
        timeout: isTimeout,
        err,
      });
      metrics.increment('document.delete.failed');
      if (isTimeout) {
        metrics.increment('document.delete.timeout');
        res.setHeader('Retry-After', '1');
        return res.status(503).json({ error: 'temporarily_unavailable' });
      }
      return next(err); // central error handler returns a generic 500, no internals leaked
    }
  },
);
```

**Production concerns I addressed**

- Authorization without leaking existence: ownership is enforced inside the delete's WHERE clause, and "missing", "already deleted" and "someone else's" all return the same 404, so ids can't be probed.
- Atomicity: one conditional UPDATE ... RETURNING replaces read-then-delete, removing the check-then-act race and a round trip.
- Input validation at the boundary: the id must be a UUID (400 otherwise), and a defensive 401 covers missing auth middleware.
- Soft delete (tombstone) for recoverability and audit, with `deleted_at IS NULL` in the delete itself so it is idempotent-safe. Every read path must also filter tombstones, and a retention job should purge them.
- Deadline on the database call (800ms) and on the queue call (500ms), so a hung dependency can't pin request workers. Timeouts return 503 with Retry-After.
- Slow work (blob, search index, share-link cleanup) is enqueued to a worker instead of running in the request. An enqueue failure is logged and counted but doesn't fail a delete that already committed, and a sweeper reconciles orphaned tombstones.
- Observability: structured logs with request id plus counters (`succeeded`, `not_found`, `failed`, `timeout`, `enqueue_failed`) that can be alerted on, not just log lines.
- Versioned route (`/api/v1/...`) so a future breaking change isn't a coordinated client migration.
- Errors: clean status codes (204, 400, 401, 404, 503) with no stack traces or internals in responses; unexpected errors go to the central handler.
- Deliberately not added: a circuit breaker (the primary DB is not a downstream service, and a breaker there turns slow queries into outages) and a feature flag (a plain delete has no risky new behavior to roll back).
````
