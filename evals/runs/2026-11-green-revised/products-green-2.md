# products — Sonnet 5.5 — revised skill 2

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.get('/api/v1/products', listProducts);` |
| **2. Kill switch** | Correct (skip) | No flag. *"Read-only, so no kill switch needed."* The revised skip clause holds; scored separately as a definitional gain. |
| **3. Circuit breaker** | Correct | Wraps the inventory service only, and `isDependencyAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | `db.products.findAll` and each inventory call wrapped in `withTimeout`. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | Correct | `db.products.findAll({ where: { active: true, deletedAt: null } }) as Promise<ProductRow[]>,` |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';

// Assumed to exist and be imported: db, inventoryService, log, metrics.

// ---------- config ----------
const DB_TIMEOUT_MS = 800;
const STOCK_TIMEOUT_MS = 250;        // per-call deadline for the inventory service
const STOCK_CONCURRENCY = 20;        // bounded fan-out
const CATALOGUE_TTL_MS = 30_000;     // fresh window
const CATALOGUE_STALE_MS = 5 * 60_000; // serve stale on DB failure
const STOCK_TTL_MS = 10_000;

// ---------- public shape: only what the storefront renders ----------
interface ProductDto {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;      // null = unknown (inventory unavailable)
  stockKnown: boolean;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl?: string | null;
  // many internal fields (costCents, supplierId, ...) deliberately never mapped
  [k: string]: unknown;
}

// ---------- helpers ----------
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Circuit breaker: counts transport failures only (timeout, reset, 5xx).
// A 404 / 4xx means the dependency answered, so it counts as success.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(
    private readonly threshold = 8,
    private readonly cooldownMs = 10_000,
  ) {}
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.failures = this.threshold - 1; // half-open: allow one probe
      return false;
    }
    return true;
  }
  recordSuccess() { this.failures = 0; }
  recordFailure() {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

const inventoryBreaker = new CircuitBreaker();

function isDependencyAnswer(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// Run fn over items with bounded concurrency.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- tiny in-process caches (swap for Redis if multi-instance coherence matters) ----------
const stockCache = new Map<string, { value: number; at: number }>();
let catalogueCache: { rows: ProductRow[]; at: number } | null = null;
let catalogueInflight: Promise<ProductRow[]> | null = null; // single-flight

async function loadCatalogue(): Promise<ProductRow[]> {
  const fresh = catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS;
  if (fresh) return catalogueCache!.rows;

  if (!catalogueInflight) {
    catalogueInflight = withTimeout(
      // Respect soft-delete: tombstoned rows never reach the storefront.
      db.products.findAll({ where: { active: true, deletedAt: null } }) as Promise<ProductRow[]>,
      DB_TIMEOUT_MS,
      'db.products.findAll',
    )
      .then((rows) => {
        catalogueCache = { rows, at: Date.now() };
        return rows;
      })
      .finally(() => { catalogueInflight = null; });
  }

  try {
    return await catalogueInflight;
  } catch (err) {
    metrics.increment('products.db_failed');
    log.error('products.db_failed', { err });
    if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_STALE_MS) {
      metrics.increment('products.served_stale_catalogue');
      return catalogueCache.rows;
    }
    throw err;
  }
}

async function getStockSafe(productId: string): Promise<number | null> {
  const cached = stockCache.get(productId);
  if (cached && Date.now() - cached.at < STOCK_TTL_MS) return cached.value;

  if (inventoryBreaker.isOpen()) {
    metrics.increment('products.inventory_short_circuited');
    return cached ? cached.value : null; // stale beats nothing
  }

  try {
    const stock = await withTimeout(
      inventoryService.getStock(productId),
      STOCK_TIMEOUT_MS,
      'inventoryService.getStock',
    );
    inventoryBreaker.recordSuccess();
    if (typeof stock === 'number' && Number.isFinite(stock)) {
      const value = Math.max(0, Math.trunc(stock));
      stockCache.set(productId, { value, at: Date.now() });
      return value;
    }
    return null;
  } catch (err) {
    if (isDependencyAnswer(err)) inventoryBreaker.recordSuccess();
    else inventoryBreaker.recordFailure();
    metrics.increment('products.inventory_failed');
    log.warn('products.inventory_failed', { productId, err });
    return cached ? cached.value : null;
  }
}

function toDto(row: ProductRow, stock: number | null): ProductDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    currency: row.currency,
    imageUrl: row.imageUrl ?? null,
    stock,
    stockKnown: stock !== null,
  };
}

// ---------- handler ----------
export async function listProducts(_req: Request, res: Response): Promise<void> {
  const started = Date.now();
  try {
    const rows = await loadCatalogue();
    const stocks = await mapLimit(rows, STOCK_CONCURRENCY, (r) => getStockSafe(r.id));
    const products = rows.map((r, i) => toDto(r, stocks[i]));

    const degraded = stocks.some((s) => s === null);
    if (degraded) metrics.increment('products.degraded_response');

    metrics.increment('products.list.ok');
    metrics.timing('products.list.latency_ms', Date.now() - started);

    // Short CDN/browser caching absorbs homepage traffic.
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.status(200).json({ products, degraded });
  } catch (err) {
    metrics.increment('products.list.failed');
    log.error('products.list.failed', { err });
    res.status(503).set('Retry-After', '5').json({ error: 'catalogue temporarily unavailable' });
  }
}

// Versioned from day one. Read-only, so no kill switch needed.
export function registerProductRoutes(router: Router): void {
  router.get('/api/v1/products', listProducts);
}
```

**Production concerns I addressed**

- Versioned route (`/api/v1/products`) so the first breaking change is not a coordinated client migration.
- Field-limited response: an explicit DTO mapper, so internal columns (cost, supplier, etc.) can never leak.
- Deadlines on every I/O: 800ms on the DB read and 250ms per inventory call. A hung dependency cannot hang the homepage.
- Circuit breaker around the inventory service: it fails fast when the service is known-sick. Only transport failures (timeouts, resets, 5xx) count toward opening; 4xx answers count as healthy.
- No N+1 stampede: inventory calls run with bounded concurrency (20), not an unbounded `Promise.all`.
- Graceful degradation: when stock is slow or unavailable the product still renders, with `stock: null`, `stockKnown: false` and a top-level `degraded` flag. Stale cached stock is preferred over nothing.
- Caching: short-TTL per-product stock cache, a 30s catalogue cache with single-flight (no thundering herd on the DB), stale-catalogue fallback if the DB fails, and `Cache-Control` with `stale-while-revalidate` for CDN and browser absorption.
- Soft-delete respected: the read filters `deletedAt: null` as well as `active`.
- Counters, not just logs: `products.list.ok`, `products.list.failed`, `products.inventory_failed`, `products.inventory_short_circuited`, `products.degraded_response`, `products.served_stale_catalogue` and a latency timing, all alertable.
- Clean failure mode: a 503 with `Retry-After` and a generic message, with no internals leaked.
- Deliberately skipped: a kill switch (the endpoint only reads, so it would add flag debt), and a breaker around the primary DB (a timeout is enough; a breaker there would turn a slow query into an outage).
- Pagination is out of scope because the spec says homepage catalogue, but I would add a cursor and limit if the catalogue grows beyond a few hundred items.
````
