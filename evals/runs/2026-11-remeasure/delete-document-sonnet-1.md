# delete-document — Sonnet 5.5 — baseline 1

- **Scenario:** [`../../scenarios/delete-document.md`](../../scenarios/delete-document.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `router.delete("/documents/:id", requireAuth, rateLimit(...), deleteDocument)`. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | n/a | No external dependency. |
| **4. Deadline on every I/O** | Absent | `await db.documents.softDeleteByIdAndOwner(...)`, with no timeout anywhere. |
| **5. Off the request path** | n/a | No deferrable side effect beyond the audit write. |
| **6. Business counters** | Absent | `auditLog.record(...)` is an audit event, not a metric. |
| **7. Tombstone-aware reads** | n/a | Write path. The notes flag that all other document reads must filter `deleted_at IS NULL`. |
| *Soft delete* (cut) | Correct | Conditional `SET deleted_at` scoped to the owner, with a legal-hold guard. |
| *Idempotency* (cut) | Present | Repeat DELETE returns 204. |

**Shipped habits reaching Present or better: 0 of 4 applicable. Reaching Correct: 0 of 4 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { logger } from "../logger";
import { auditLog } from "../audit";

// IDs are UUIDs. Reject anything else before it touches the database.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AuthedRequest extends Request {
  userId?: string;
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  requestId: string,
) {
  return res.status(status).json({ error: { code, message, requestId } });
}

/**
 * DELETE /documents/:id
 *
 * Soft-deletes a document owned by the authenticated user.
 * - 204 on success, and on repeat calls for an already-deleted doc (idempotent)
 * - 400 malformed id
 * - 401 unauthenticated
 * - 404 not found OR not owned by caller (indistinguishable, prevents enumeration)
 * - 409 document is locked (legal hold) and cannot be deleted
 * - 500 unexpected error (details logged, never returned)
 */
export async function deleteDocument(
  req: AuthedRequest,
  res: Response,
  _next: NextFunction,
) {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  res.setHeader("x-request-id", requestId);

  const userId = req.userId;
  if (!userId) {
    return sendError(res, 401, "UNAUTHENTICATED", "Authentication required", requestId);
  }

  const { id } = req.params;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid document id", requestId);
  }

  try {
    // Ownership is enforced inside the write itself (WHERE id = $1 AND owner_id = $2),
    // not via read-then-check. This closes the TOCTOU window and saves a round trip.
    // Soft delete: recoverable, keeps audit trail, and a background job purges
    // blobs/derived data after the retention window.
    const result = await db.documents.softDeleteByIdAndOwner({
      id,
      ownerId: userId,
      deletedAt: new Date(),
    });

    if (result.status === "deleted") {
      auditLog.record({
        action: "document.delete",
        actorId: userId,
        resourceType: "document",
        resourceId: id,
        requestId,
        ip: req.ip,
      });
      logger.info({ requestId, userId, documentId: id }, "document deleted");
      return res.status(204).end();
    }

    if (result.status === "locked") {
      return sendError(
        res,
        409,
        "DOCUMENT_LOCKED",
        "Document is under a hold and cannot be deleted",
        requestId,
      );
    }

    if (result.status === "already_deleted") {
      // Idempotent: the end state the client asked for already holds.
      return res.status(204).end();
    }

    // "not_found" covers both nonexistent and not-owned. Same response either way,
    // so callers cannot probe for other users' document ids.
    return sendError(res, 404, "NOT_FOUND", "Document not found", requestId);
  } catch (err) {
    logger.error(
      { requestId, userId, documentId: id, err },
      "failed to delete document",
    );
    return sendError(res, 500, "INTERNAL", "Something went wrong", requestId);
  }
}

// Wiring (router-level):
//   router.delete("/documents/:id", requireAuth, rateLimit({ windowMs: 60_000, max: 60 }), deleteDocument);
//
// Expected repository contract (single atomic statement):
//   UPDATE documents
//      SET deleted_at = $3
//    WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND legal_hold = false
//   RETURNING id;
//   -- when 0 rows: a follow-up SELECT scoped by id AND owner_id distinguishes
//   -- locked / already_deleted / not_found. It is also owner-scoped, so it leaks nothing.
//   -- All reads elsewhere must filter deleted_at IS NULL.
```

Production concerns I addressed
- Authorization (IDOR): ownership is enforced in the write's WHERE clause (id and owner_id), not a separate read-then-check, so there is no TOCTOU race and no path to delete someone else's document.
- No existence leak: nonexistent and not-owned documents both return the same 404, so users cannot enumerate other tenants' ids.
- Authentication guard: returns 401 if req.userId is missing, as defense in depth behind the auth middleware.
- Input validation: the id must be a UUID. Malformed input gets a 400 and never reaches the database.
- Soft delete: recoverable after accidental or malicious deletion, preserves the audit trail, and leaves hard purge of blobs and derived data to a retention job.
- Idempotency: repeat DELETEs on an already-deleted document return 204, so client retries and network flakiness are safe.
- Legal hold: locked documents return 409 instead of being deleted.
- Error handling: a try/catch returns a generic 500 with a request id. Internals and stack traces are logged server-side only.
- Observability: a request id is generated or propagated and returned in a header and in error bodies. Structured logs carry user and document ids.
- Audit trail: successful deletes emit an audit event with actor, resource, request id and IP.
- Abuse protection: the router wiring includes a rate limiter on the endpoint.
- Consistent error contract: a single `{ error: { code, message, requestId } }` shape across all failures.
- Out of scope but flagged: all other document reads must filter `deleted_at IS NULL`, and a purge job plus a restore path are needed.
````
