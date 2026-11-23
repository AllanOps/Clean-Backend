# delete-document — Haiku 5.5 — baseline 1

- **Scenario:** [`../../scenarios/delete-document.md`](../../scenarios/delete-document.md), baseline prompt used verbatim
- **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, smaller tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

> **Capture note.** This agent did not make the requested Write call and returned its answer as its final message instead. The verbatim block below was extracted programmatically from that message in the run transcript; its first line is the agent's own preface, kept unedited.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `app.delete("/documents/:id", authenticate, makeDeleteDocumentHandler(db));` |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | n/a | No external dependency. |
| **4. Deadline on every I/O** | Absent | `findById` and `softDelete` unbounded. |
| **5. Off the request path** | n/a | No deferrable side effect. |
| **6. Business counters** | Absent | `log({ event: "document.deleted", ... })` only. |
| **7. Tombstone-aware reads** | n/a | Write path. |
| *Soft delete* (cut) | Correct | `softDelete(documentId, new Date())`; already-deleted returns 204. |
| *Idempotency* (cut) | Present | Repeat DELETE returns 204, but find-then-update is not atomic. |

**Shipped habits reaching Present or better: 0 of 4 applicable. Reaching Correct: 0 of 4 applicable.**

## Verbatim output

````markdown
Write to the scratchpad path was not performed (no Write call was made). The full response follows.

```typescript
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

// Minimal shapes for what this handler needs from the data layer.
// The real db.documents interface may differ; adapt the calls below to it.
interface DocumentRecord {
  id: string;
  ownerId: string;
  deletedAt?: Date | null;
}

interface DocumentsRepo {
  findById(id: string): Promise<DocumentRecord | null>;
  softDelete(id: string, deletedAt: Date): Promise<void>;
  hardDelete?(id: string): Promise<void>;
}

interface Db {
  documents: DocumentsRepo;
}

interface AuthedRequest extends Request {
  userId?: string;
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDocumentId(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new ApiError(400, "invalid_document_id", "Document id must be a UUID.");
  }
  return raw;
}

function requireUserId(req: AuthedRequest): string {
  if (!req.userId) {
    throw new ApiError(401, "unauthenticated", "Authentication required.");
  }
  return req.userId;
}

/**
 * Deletes a document owned by the authenticated user.
 *
 * Behaviour:
 *  - 401 if unauthenticated.
 *  - 400 if the id is malformed.
 *  - 404 if the document does not exist OR is not owned by the caller.
 *    Returning 404 for both avoids leaking the existence of other users' ids.
 *  - 204 on success. Deleting an already-deleted document is also 204 so that
 *    client retries after a timeout are safe (idempotent).
 *
 * Deletion is soft by default (sets deletedAt) so an accidental delete is
 * recoverable and audit trails stay intact. Hard deletion is left to a
 * retention job.
 */
export function makeDeleteDocumentHandler(
  db: Db,
  log: (entry: Record<string, unknown>) => void = console.log,
) {
  return async function deleteDocument(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      const userId = requireUserId(req);
      const documentId = parseDocumentId(req.params.id);

      const doc = await db.documents.findById(documentId);

      // Not found and not owned are indistinguishable to the caller.
      if (!doc || doc.ownerId !== userId) {
        throw new ApiError(404, "document_not_found", "Document not found.");
      }

      // Already deleted: treat as success so retries are idempotent.
      if (doc.deletedAt) {
        res.status(204).end();
        return;
      }

      await db.documents.softDelete(documentId, new Date());

      log({
        event: "document.deleted",
        requestId,
        documentId,
        userId,
      });

      res.status(204).end();
    } catch (err) {
      if (err instanceof ApiError) {
        res.status(err.status).json({
          error: { code: err.code, message: err.message, requestId },
        });
        return;
      }

      log({
        event: "document.delete_failed",
        requestId,
        documentId: req.params.id,
        userId: req.userId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Do not forward internal errors to the client.
      res.status(500).json({
        error: { code: "internal_error", message: "Something went wrong.", requestId },
      });
    }
  };
}
```

Route registration (example):

```typescript
app.delete("/documents/:id", authenticate, makeDeleteDocumentHandler(db));
```

Production concerns I addressed

- **Authorization by ownership:** the query result is checked against `req.userId`, so users cannot delete each other's documents.
- **No existence oracle:** missing and foreign documents both return 404, so ids cannot be probed across accounts.
- **Input validation:** the id is checked as a UUID before any database call, which rejects junk early.
- **Idempotency:** repeating a delete on an already-deleted document returns 204, so client retries are safe.
- **Soft delete:** the row is marked with `deletedAt` rather than removed, which keeps deletion recoverable and preserves audit history. Hard deletion belongs in a retention job.
- **Error hygiene:** known errors return their status and code, and unexpected errors return a generic 500 without internal details.
- **Observability:** each deletion and each failure is logged with a request id, which is also returned in the `x-request-id` header for support tracing.
- **Auth dependency:** the handler fails closed with 401 if `req.userId` is missing, so a misconfigured route cannot delete anything anonymously.

Notes: the `next` parameter is unused in the handler body and could be dropped. The `x-request-id` header is taken from the client without validation, so a length cap or charset check would be worth adding before this ships.
````
