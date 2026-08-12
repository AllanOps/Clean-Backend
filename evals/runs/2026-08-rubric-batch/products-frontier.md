# products — frontier — baseline

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude frontier (Sonnet-class), 2026-08-11
- **Condition:** baseline — no skill loaded
- **Record kind:** verbatim

> **This is the run that weakened four published claims.** See *Notes*.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `productsRouter.get('/products', listProducts)` — unversioned. |
| **2. Feature flags** | Absent | No flag on the inventory fan-out or anywhere else. |
| **3. Circuit breaker** | **Correct** | Full `CircuitBreaker` with single half-open probe on inventory; deliberately absent on the DB. Invalid stock values are explicitly excluded from tripping it: *"not a transport failure, so it does not count toward the breaker."* Satisfies both rubric criteria. |
| **4. Deadline on every I/O** | **Correct** | `withTimeout(db.products.findAll(), DB_TIMEOUT_MS)` **and** `withTimeout(inventoryService.getStock(...), timeoutMs)`, plus a whole-stage `STOCK_TOTAL_BUDGET_MS`. The database is bounded. |
| **5. Off the request path** | n/a | Pure read; nothing enqueueable. |
| **6. Business counters** | **Correct** | `products.list.ok`, `products.list.degraded`, `inventory.failure`, `circuit_breaker.opened/closed`, `catalogue.stale_served`, plus timing. Alertable on user-visible degradation. |
| **7. Tombstone-aware reads** | **Correct** | `isStorefrontVisible` requires `row.deletedAt === null`. |
| *Field-limiting* (cut) | Correct | Explicit allowlist mapper; comment: *"Never `...row`."* |
| *Validation* (cut) | Correct | Integer-only parsing, duplicate params rejected, hard `MAX_LIMIT`. |
| *Degradation* (cut) | Correct | `stock.status = 'unknown'` stays distinguishable from `out_of_stock`, plus `meta.stockDataComplete` so the client can soften copy "instead of rendering 'out of stock' and losing the sale." |
| *Naming* (cut) | Correct | `isStorefrontVisible`, `resolveStock`, `STOCK_TOTAL_BUDGET_MS`. |

**Reached Present or better: 6 of 6 applicable · Reached Correct: 6 of 6 applicable.**

## Notes

This baseline applied **four of the seven shipped habits at Correct, unprompted** — habits 3, 4, 6, and 7. Three of those are claims the published tables record as gaps:

- Habit 3 is listed as **absent in 0/7** baselines. Here it is not only present but correct on the subtle criterion (business failures must not trip the breaker).
- Habit 4's canonical published failure is *"the external call is bounded and the database is not."* Here the database is bounded.
- Habit 7's published failure is *"the delete path tombstones, then a read forgets."* Here the read filters.

Only habits 1 and 2 — versioning and feature flags — were absent, consistent with every prior baseline.

The run also went well beyond the skill: single-flight request coalescing, stale-if-error on the catalogue, deterministic pagination ordering, a client-disconnect check before the inventory fan-out, and correct CDN cache headers that shorten TTL on degraded responses.

**Consequence.** By the policy in [*When to re-measure*](../../README.md#when-to-re-measure), a habit that scores Correct unprompted **across repeated runs** gets cut. Two runs is not "repeated runs," so nothing is cut on this evidence. It does make habit 6 the leading cut candidate (Correct in both fresh frontier runs), with 3, 4, and 7 behind it, and it means the published aggregates understate run-to-run variance. Tracking issue: re-measure habits 3, 4, 6, 7 at n ≥ 5 before deciding.

## Verbatim output

````markdown
```ts
/**
 * GET /products — product catalogue for the storefront homepage.
 *
 * Traffic profile: this is the highest-RPS read path in the store, and the
 * inventory service is a separate, occasionally-slow dependency. The design
 * rules that follow from that:
 *
 *   1. The catalogue read is cached and single-flighted, so a traffic spike
 *      turns into one DB query, not N.
 *   2. Stock is fetched only for the products actually on the requested page,
 *      with bounded concurrency, a per-call timeout AND a whole-request budget.
 *   3. Inventory is a *degradable* dependency. If it is slow, broken, or
 *      circuit-broken, we serve the catalogue with stock = "unknown". The
 *      homepage never 500s because inventory is having a bad day.
 *   4. The response is an explicit allowlist mapping. Product rows carry
 *      internal columns (cost, supplier, margin, moderation notes); none of
 *      that is ever spread into the payload.
 */

import { Router, type Request, type RequestHandler } from 'express';

import { db } from '../db';
import { inventoryService } from '../services/inventory-service';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const CATALOGUE_TTL_MS = 30_000;
const CATALOGUE_STALE_MAX_MS = 10 * 60_000; // stale-if-error ceiling
const DB_TIMEOUT_MS = 2_000;

const STOCK_TTL_MS = 3_000;
const STOCK_CACHE_MAX_ENTRIES = 10_000;
const STOCK_CALL_TIMEOUT_MS = 250;
const STOCK_TOTAL_BUDGET_MS = 700;
const STOCK_CONCURRENCY = 8;

const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_OPEN_MS = 5_000;

const LOW_STOCK_THRESHOLD = 5;

/**
 * The subset of the product row this endpoint is allowed to depend on.
 * The real row is much wider (cost_cents, supplier_id, margin_bps, internal
 * notes, moderation state, ...). Structural typing keeps this honest.
 */
interface ProductRow {
  id: string;
  sku: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  priceCents: number;
  currency: string;
  primaryImageUrl: string | null;
  categorySlug: string | null;
  status: string;
  publishedAt: Date | null;
  deletedAt: Date | null;
  sortOrder: number | null;
}

/** Catalogue-shaped product, cached across requests. Contains no stock. */
interface StorefrontProduct {
  id: string;
  sku: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  categorySlug: string | null;
  sortOrder: number;
}

type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';

interface ProductDto {
  id: string;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  price: { amountCents: number; currency: string };
  imageUrl: string | null;
  categorySlug: string | null;
  stock: {
    status: StockStatus;
    quantity: number | null;
  };
}

class TimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * NOTE: this bounds how long *we* wait, not how long the callee runs. When
 * inventoryService gains an AbortSignal parameter, pass one through here.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Fixed-size worker pool. `task` must never reject. */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

/** TTL cache with request coalescing. Failures are never cached. */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() >= hit.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next(); // insertion-ordered => FIFO eviction
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  fetch(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return pending;
  }
}

/** Consecutive-failure circuit breaker with a single half-open probe. */
class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number,
    private readonly openMs: number,
  ) {}

  /** @returns true when the call should be skipped outright. */
  shouldSkip(): boolean {
    if (this.openedAt === null) return false;

    if (Date.now() - this.openedAt < this.openMs) return true;

    // Cooldown elapsed: let exactly one request through to probe recovery.
    if (this.probeInFlight) return true;
    this.probeInFlight = true;
    return false;
  }

  recordSuccess(): void {
    if (this.openedAt !== null) {
      logger.info({ breaker: this.name }, 'circuit breaker closed');
      metrics.increment('circuit_breaker.closed', { breaker: this.name });
    }
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.probeInFlight = false;

    if (this.openedAt !== null) {
      this.openedAt = Date.now(); // failed probe => restart the cooldown
      return;
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = Date.now();
      logger.warn(
        { breaker: this.name, consecutiveFailures: this.consecutiveFailures },
        'circuit breaker opened',
      );
      metrics.increment('circuit_breaker.opened', { breaker: this.name });
    }
  }
}

let catalogueCache: { products: StorefrontProduct[]; fetchedAt: number; expiresAt: number } | null = null;
let catalogueInFlight: Promise<StorefrontProduct[]> | null = null;

function isStorefrontVisible(row: ProductRow): boolean {
  return row.status === 'active' && row.publishedAt !== null && row.deletedAt === null;
}

/**
 * Explicit allowlist. Never `...row` — internal columns must not leak, and a
 * malformed row should drop out of the catalogue rather than break rendering.
 */
function toStorefrontProduct(row: ProductRow): StorefrontProduct | null {
  if (
    typeof row?.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.priceCents !== 'number' ||
    !Number.isFinite(row.priceCents) ||
    row.priceCents < 0
  ) {
    logger.warn({ productId: row?.id ?? null }, 'skipping malformed product row');
    metrics.increment('catalogue.malformed_row');
    return null;
  }

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    shortDescription: row.shortDescription ?? null,
    priceCents: Math.round(row.priceCents),
    currency: row.currency ?? 'USD',
    imageUrl: row.primaryImageUrl ?? null,
    categorySlug: row.categorySlug ?? null,
    sortOrder: row.sortOrder ?? Number.MAX_SAFE_INTEGER,
  };
}

async function loadCatalogue(): Promise<{ products: StorefrontProduct[]; servedStale: boolean }> {
  const cached = catalogueCache;
  if (cached && Date.now() < cached.expiresAt) {
    metrics.increment('catalogue.cache_hit');
    return { products: cached.products, servedStale: false };
  }

  if (!catalogueInFlight) {
    metrics.increment('catalogue.cache_miss');
    catalogueInFlight = withTimeout(
      db.products.findAll() as Promise<ProductRow[]>,
      DB_TIMEOUT_MS,
      'db.products.findAll',
    )
      .then((rows) => {
        const products = rows
          .filter(isStorefrontVisible)
          .map(toStorefrontProduct)
          .filter((p): p is StorefrontProduct => p !== null)
          // Deterministic total order — otherwise pagination can drop or
          // duplicate items between pages.
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

        const now = Date.now();
        catalogueCache = { products, fetchedAt: now, expiresAt: now + CATALOGUE_TTL_MS };
        return products;
      })
      .finally(() => {
        catalogueInFlight = null;
      });
  }

  try {
    return { products: await catalogueInFlight, servedStale: false };
  } catch (error) {
    // stale-if-error: a slightly out-of-date homepage beats an error page.
    if (catalogueCache && Date.now() - catalogueCache.fetchedAt <= CATALOGUE_STALE_MAX_MS) {
      logger.error({ err: error }, 'catalogue refresh failed; serving stale catalogue');
      metrics.increment('catalogue.stale_served');
      return { products: catalogueCache.products, servedStale: true };
    }
    throw error;
  }
}

const stockCache = new TtlCache<number>(STOCK_TTL_MS, STOCK_CACHE_MAX_ENTRIES);
const inventoryBreaker = new CircuitBreaker('inventory', BREAKER_FAILURE_THRESHOLD, BREAKER_OPEN_MS);

function normalizeStock(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number((raw as { quantity?: unknown })?.quantity);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Best-effort. Never throws: an unresolved product simply has no entry in the
 * returned map and is rendered as `unknown`.
 */
async function resolveStock(
  productIds: readonly string[],
  deadlineAt: number,
): Promise<{ stock: Map<string, number>; complete: boolean }> {
  const stock = new Map<string, number>();
  let complete = true;

  const misses: string[] = [];
  for (const id of productIds) {
    const cached = stockCache.get(id);
    if (cached !== undefined) stock.set(id, cached);
    else misses.push(id);
  }

  metrics.increment('inventory.cache_hit', { count: productIds.length - misses.length });
  if (misses.length === 0) return { stock, complete };

  await forEachWithConcurrency(misses, STOCK_CONCURRENCY, async (productId) => {
    const remainingBudget = deadlineAt - Date.now();
    if (remainingBudget <= 0) {
      complete = false;
      metrics.increment('inventory.skipped_budget_exhausted');
      return;
    }
    if (inventoryBreaker.shouldSkip()) {
      complete = false;
      metrics.increment('inventory.skipped_breaker_open');
      return;
    }

    const timeoutMs = Math.min(STOCK_CALL_TIMEOUT_MS, remainingBudget);
    try {
      const raw = await stockCache.fetch(productId, () =>
        withTimeout(
          Promise.resolve(inventoryService.getStock(productId)),
          timeoutMs,
          `inventoryService.getStock(${productId})`,
        ),
      );

      const quantity = normalizeStock(raw);
      if (quantity === null) {
        // Upstream answered, but with something we cannot trust. Not a
        // transport failure, so it does not count toward the breaker.
        logger.warn({ productId, raw }, 'inventory returned an unusable stock value');
        metrics.increment('inventory.invalid_response');
        complete = false;
        return;
      }

      inventoryBreaker.recordSuccess();
      stock.set(productId, quantity);
    } catch (error) {
      inventoryBreaker.recordFailure();
      complete = false;
      metrics.increment('inventory.failure', {
        reason: error instanceof TimeoutError ? 'timeout' : 'error',
      });
      logger.warn(
        { productId, err: error instanceof Error ? error.message : String(error) },
        'stock lookup failed; degrading to unknown',
      );
    }
  });

  return { stock, complete };
}

function toStockView(quantity: number | null): ProductDto['stock'] {
  if (quantity === null) return { status: 'unknown', quantity: null };
  if (quantity <= 0) return { status: 'out_of_stock', quantity: 0 };
  if (quantity <= LOW_STOCK_THRESHOLD) return { status: 'low_stock', quantity };
  return { status: 'in_stock', quantity: null };
}

function toDto(product: StorefrontProduct, quantity: number | null): ProductDto {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    description: product.shortDescription,
    price: { amountCents: product.priceCents, currency: product.currency },
    imageUrl: product.imageUrl,
    categorySlug: product.categorySlug,
    stock: toStockView(quantity),
  };
}

interface Pagination {
  limit: number;
  offset: number;
}

function parseNonNegativeInt(raw: unknown, field: string, errors: string[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`${field} must be provided at most once`);
    return undefined;
  }
  if (!/^\d{1,9}$/.test(raw.trim())) {
    errors.push(`${field} must be a non-negative integer`);
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

function parsePagination(
  query: Request['query'],
): { ok: true; value: Pagination } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const limit = parseNonNegativeInt(query.limit, 'limit', errors);
  const offset = parseNonNegativeInt(query.offset, 'offset', errors);

  if (limit !== undefined && limit < 1) errors.push('limit must be at least 1');
  if (limit !== undefined && limit > MAX_LIMIT) errors.push(`limit must not exceed ${MAX_LIMIT}`);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0 } };
}

export const listProducts: RequestHandler = async (req, res) => {
  const startedAt = Date.now();

  try {
    const parsed = parsePagination(req.query);
    if (!parsed.ok) {
      metrics.increment('products.list.invalid_request');
      res.status(400).json({
        error: {
          code: 'INVALID_QUERY_PARAMETERS',
          message: 'One or more query parameters are invalid.',
          details: parsed.errors,
        },
      });
      return;
    }

    const { limit, offset } = parsed.value;
    const { products, servedStale } = await loadCatalogue();

    // The client may have walked away while we were waiting on the DB; do not
    // spend an inventory fan-out on a dead socket.
    if (req.socket.destroyed || res.writableEnded) {
      metrics.increment('products.list.client_disconnected');
      return;
    }

    const page = products.slice(offset, offset + limit);
    const { stock, complete } = await resolveStock(
      page.map((p) => p.id),
      Date.now() + STOCK_TOTAL_BUDGET_MS,
    );

    const data = page.map((product) => toDto(product, stock.get(product.id) ?? null));
    const degraded = !complete || servedStale;

    // Do not let a CDN pin a degraded response for long.
    res.setHeader(
      'Cache-Control',
      degraded ? 'public, max-age=5' : 'public, max-age=30, stale-while-revalidate=120',
    );

    metrics.increment(degraded ? 'products.list.degraded' : 'products.list.ok');

    res.status(200).json({
      data,
      pagination: {
        limit,
        offset,
        total: products.length,
        hasMore: offset + page.length < products.length,
      },
      meta: {
        // Lets the client soften copy ("stock unavailable") instead of
        // rendering "out of stock" and losing the sale.
        stockDataComplete: complete,
        catalogueStale: servedStale,
      },
    });
  } catch (error) {
    // Only reachable when the catalogue itself is unavailable and there is no
    // usable stale copy. Inventory problems never land here.
    logger.error(
      { err: error, path: req.originalUrl, requestId: req.header('x-request-id') ?? null },
      'GET /products failed',
    );
    metrics.increment('products.list.error');

    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '5');
    res.status(503).json({
      error: {
        code: 'CATALOGUE_UNAVAILABLE',
        message: 'The product catalogue is temporarily unavailable. Please try again shortly.',
      },
    });
  } finally {
    metrics.timing('products.list.duration_ms', Date.now() - startedAt);
  }
};

export const productsRouter = Router();
productsRouter.get('/products', listProducts);
```

**Production concerns I addressed**

- **No field leakage:** the response is built by an explicit allowlist mapper, never a spread of the DB row.
- **N+1 fan-out control:** stock is fetched only for the products on the requested page, through a fixed worker pool (concurrency 8) rather than an unbounded `Promise.all`.
- **Timeouts at two levels:** a per-call timeout on `getStock` plus a whole-request stock budget.
- **Graceful degradation:** inventory failure/timeout/breaker-open yields `stock.status = "unknown"` and a `meta.stockDataComplete` flag. The endpoint only 503s if the catalogue itself is unavailable.
- **Circuit breaker** on the inventory service with a single half-open probe.
- **Caching and stampede protection:** catalogue and per-product stock are TTL-cached with request coalescing (single-flight).
- **Stale-if-error:** if the DB read fails and a recent catalogue is cached, it is served stale (bounded to 10 minutes) with a flag.
- **Input validation:** `limit`/`offset` strictly parsed, clamped by a hard `MAX_LIMIT`, rejected with a structured 400.
- **Deterministic pagination:** a total order (`sortOrder`, then `id`) so items are not duplicated or skipped across pages.
- **Defensive upstream handling:** malformed product rows are dropped and counted, non-numeric/negative stock values are treated as unknown and do not trip the breaker.
- **Correct cache headers:** normal responses are CDN-cacheable; degraded or stale responses get a much shorter TTL, and errors get `no-store` + `Retry-After`.
- **Observability:** counters for cache hits/misses, degradation, breaker transitions, and invalid upstream responses, plus request timing.
- **Sanitized errors:** internal error details are logged with request context, never returned.
- **Client-disconnect check** before the inventory fan-out.
- **Known trade-off, flagged in code:** `findAll()` loads the whole catalogue, which is why it is cached rather than per-request.
````
