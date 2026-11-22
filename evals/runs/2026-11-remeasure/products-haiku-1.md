# products — Haiku 5.5 — baseline 1

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, smaller tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | No route registration with a version. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | Bounded concurrency only (`STOCK_CONCURRENCY = 20`). |
| **4. Deadline on every I/O** | Present | Inventory bounded; `await db.products.findAll()` unbounded. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | Absent | `isStorefrontEligible` checks `isPublished` and field shapes; no `deletedAt`. |
| *Field-limiting* (cut) | Present | `toStorefrontProduct` allow-list. |
| *Degradation* (cut) | Correct | `{ quantity: null, available: null }`; the comment says it must never report out of stock when the truth is unknown. |

**Shipped habits reaching Present or better: 1 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
// Assumes `db`, `inventoryService`, and a structured `logger` (pino-style: logger.warn(obj, msg))
// are already imported in this module. Express 4 style handler.
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a row returned by db.products.findAll(). Internal fields exist but are never exposed. */
interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  isPublished: boolean;
  // Internal fields (cost, supplierId, internalNotes, margin, ...) are intentionally not mapped.
  [internal: string]: unknown;
}

interface StockInfo {
  quantity: number | null;
  available: boolean | null;
}

/** The only shape the storefront receives. An explicit whitelist, not a spread of the row. */
export interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  price: { amountCents: number; currency: string };
  imageUrl: string | null;
  stock: StockInfo;
}

interface CatalogueCacheEntry {
  body: StorefrontProduct[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const STOCK_TIMEOUT_MS = 300;          // per inventory call; the homepage must not wait on a slow dependency
const STOCK_CONCURRENCY = 20;          // bounded fan-out to the inventory service
const MAX_PRODUCTS = 200;              // hard ceiling on how many products one page build will look up
const CACHE_TTL_MS = 15_000;           // short-lived in-process cache absorbs traffic spikes
const CACHE_CONTROL = "public, max-age=15, stale-while-revalidate=60";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Rejects if `promise` does not settle within `ms`. The timer is always cleared. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Maps `items` with at most `limit` calls in flight. `fn` must not reject. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Validation and mapping
// ---------------------------------------------------------------------------

function isStorefrontEligible(row: ProductRow): boolean {
  return (
    row.isPublished === true &&
    typeof row.id === "string" && row.id.length > 0 &&
    typeof row.name === "string" && row.name.length > 0 &&
    typeof row.slug === "string" && row.slug.length > 0 &&
    Number.isInteger(row.priceCents) && row.priceCents >= 0 &&
    typeof row.currency === "string" && row.currency.length === 3
  );
}

function toStorefrontProduct(row: ProductRow, stock: StockInfo): StorefrontProduct {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    price: { amountCents: row.priceCents, currency: row.currency },
    imageUrl: row.imageUrl,
    stock,
  };
}

// ---------------------------------------------------------------------------
// Inventory lookup (degrades instead of failing the page)
// ---------------------------------------------------------------------------

const UNKNOWN_STOCK: StockInfo = { quantity: null, available: null };

/**
 * Returns stock for one product. Any timeout, error, or malformed value yields
 * UNKNOWN_STOCK so the storefront can still render the product. It must never
 * report "out of stock" when the truth is simply unknown.
 */
async function lookupStock(productId: string): Promise<StockInfo> {
  try {
    const quantity: unknown = await withTimeout(
      inventoryService.getStock(productId),
      STOCK_TIMEOUT_MS,
    );
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) {
      logger.warn({ productId, quantity }, "inventory returned an invalid stock value");
      return UNKNOWN_STOCK;
    }
    return { quantity, available: quantity > 0 };
  } catch (err) {
    logger.warn({ productId, err }, "inventory lookup failed; serving product without stock");
    return UNKNOWN_STOCK;
  }
}

// ---------------------------------------------------------------------------
// Catalogue build, cache, and request coalescing
// ---------------------------------------------------------------------------

async function buildCatalogue(): Promise<StorefrontProduct[]> {
  const rows = await db.products.findAll();

  const eligible = rows.filter(isStorefrontEligible);
  if (eligible.length !== rows.length) {
    logger.warn(
      { skipped: rows.length - eligible.length },
      "skipped products that are unpublished or malformed",
    );
  }

  let products = eligible;
  if (products.length > MAX_PRODUCTS) {
    logger.warn(
      { total: products.length, max: MAX_PRODUCTS },
      "catalogue exceeds stock lookup ceiling; truncating",
    );
    products = products.slice(0, MAX_PRODUCTS);
  }

  const stocks = await mapWithConcurrency(products, STOCK_CONCURRENCY, (p) =>
    lookupStock(p.id),
  );

  return products.map((p, i) => toStorefrontProduct(p, stocks[i]));
}

let cache: CatalogueCacheEntry | null = null;
let inFlight: Promise<StorefrontProduct[]> | null = null;

/**
 * Serves from cache when fresh. Otherwise exactly one rebuild runs at a time, and
 * concurrent requests await it (single-flight). If a rebuild fails, the last good
 * catalogue is served rather than an error.
 */
async function loadCatalogue(): Promise<StorefrontProduct[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.body;
  }

  if (!inFlight) {
    inFlight = buildCatalogue()
      .then((body) => {
        cache = { body, expiresAt: Date.now() + CACHE_TTL_MS };
        return body;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  try {
    return await inFlight;
  } catch (err) {
    if (cache) {
      logger.warn({ err }, "catalogue rebuild failed; serving last good copy");
      return cache.body;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function getProducts(req: Request, res: Response): Promise<void> {
  const requestId = req.header("x-request-id") ?? randomUUID();

  try {
    const products = await loadCatalogue();

    // Response contains no per-user data, so it is safe for shared caches.
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.status(200).json({
      products,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Express 4 does not catch rejected promises from handlers, so handle here.
    logger.error({ err, requestId }, "failed to load product catalogue");
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: {
        code: "CATALOGUE_UNAVAILABLE",
        message: "Products are temporarily unavailable. Please try again shortly.",
        requestId,
      },
    });
  }
}
```

Production concerns I addressed

- **No internal data leaks:** the response is built from an explicit whitelist (`toStorefrontProduct`), so internal row fields never reach the client.
- **Bad data is filtered:** unpublished or malformed rows (bad id, price, or currency) are skipped and counted in a log line, not served.
- **Slow inventory cannot stall the homepage:** each `getStock` call has a 300 ms timeout and fan-out is capped at 20 concurrent calls.
- **Inventory failures degrade gracefully:** a timeout, error, or invalid value returns `stock: { quantity: null, available: null }`, so the product still renders and is never falsely shown as out of stock.
- **Unbounded fan-out is capped:** at most 200 products trigger stock lookups per rebuild, and truncation is logged.
- **Stampede protection:** a 15 s in-process cache plus single-flight rebuilds means concurrent requests share one catalogue build instead of each calling the database and inventory service.
- **Stale fallback:** if a rebuild fails, the last good catalogue is served.
- **Clean error path:** failures return 503 with `Retry-After` and a request ID for correlation, and no stack traces or internals leak. The handler catches its own async errors, since Express 4 does not.
- **HTTP caching:** `Cache-Control: public, max-age=15, stale-while-revalidate=60` lets the CDN and browsers absorb homepage traffic, which is safe because the payload is not user-specific.
- **Known limits:** the cache is per process, so stock can be up to about 15 s stale and each instance keeps its own copy. `findAll()` loads every row. Paginating or filtering in the database query is the real long-term fix.
````
