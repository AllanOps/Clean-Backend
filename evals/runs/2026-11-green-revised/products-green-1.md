# products — Sonnet 5.5 — revised skill 1

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
| **2. Kill switch** | Correct (skip) | No flag. Read-only path. The revised skip clause holds; scored separately as a definitional gain. |
| **3. Circuit breaker** | Correct | Wraps the inventory service only, and `isDependencyAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | `db.products.findAll` and each inventory call wrapped in `withTimeout`. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | Correct | `db.products.findAll({ where: { active: true, deletedAt: null } }),` |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';

// Assumed to exist and be imported, per the spec.
declare const db: {
  products: { findAll(opts?: unknown): Promise<ProductRow[]> };
};
declare const inventoryService: { getStock(productId: string): Promise<number> };
declare const metrics: {
  increment(name: string, tags?: Record<string, string>): void;
  timing(name: string, ms: number): void;
};
declare const log: {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
};

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  active: boolean;
  deletedAt: Date | null;
  // ...many internal fields (costCents, supplierId, warehouseNotes, ...) that must never leak
  [internal: string]: unknown;
}

// Public contract: only what the storefront renders.
interface ProductDto {
  id: string;
  name: string;
  slug: string;
  price: { amountCents: number; currency: string };
  imageUrl: string | null;
  stock: number | null;          // null = unknown (inventory degraded)
  stockStatus: 'in_stock' | 'out_of_stock' | 'unknown';
}

// ---------- config ----------
const DB_TIMEOUT_MS = 800;
const INVENTORY_TIMEOUT_MS = 250;      // per call; homepage budget is tight
const INVENTORY_CONCURRENCY = 20;      // never fan out 5k calls at once
const CATALOGUE_TTL_MS = 30_000;       // short cache, absorbs homepage bursts
const CATALOGUE_STALE_MS = 5 * 60_000; // serve stale on DB failure
const STOCK_TTL_MS = 10_000;

// ---------- helpers ----------
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Bounded-concurrency map: preserves order, never more than `limit` in flight.
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

// Minimal circuit breaker for the inventory dependency.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  constructor(
    private readonly threshold = 10,
    private readonly cooldownMs = 10_000,
  ) {}

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs && !this.probing) {
      this.probing = true; // half-open: let exactly one probe through
      return false;
    }
    return true;
  }
  recordSuccess() { this.failures = 0; this.probing = false; }
  recordFailure() {
    this.failures++;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

const inventoryBreaker = new CircuitBreaker();

// A not-found / 4xx is a healthy dependency saying no: it must not trip the breaker.
function isDependencyAnswer(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; code?: string };
  const status = e?.status ?? e?.statusCode;
  return (typeof status === 'number' && status >= 400 && status < 500) || e?.code === 'NOT_FOUND';
}

// Tiny in-process TTL cache (swap for Redis if multiple instances need coherence).
class TtlCache<V> {
  private store = new Map<string, { value: V; at: number }>();
  constructor(private readonly maxEntries = 10_000) {}
  get(key: string, maxAgeMs: number): V | undefined {
    const hit = this.store.get(key);
    return hit && Date.now() - hit.at <= maxAgeMs ? hit.value : undefined;
  }
  set(key: string, value: V) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, at: Date.now() });
  }
}

const stockCache = new TtlCache<number>();
const catalogueCache = new TtlCache<ProductDto[]>(1);
let inflightCatalogue: Promise<{ products: ProductDto[]; degraded: boolean }> | null = null;

// ---------- domain ----------
// Returns number | null. null means "unknown", never a fabricated 0.
async function getStockSafe(productId: string): Promise<number | null> {
  const cached = stockCache.get(productId, STOCK_TTL_MS);
  if (cached !== undefined) {
    metrics.increment('products.stock.cache_hit');
    return cached;
  }
  if (inventoryBreaker.isOpen()) {
    metrics.increment('products.stock.breaker_open');
    return null;
  }
  try {
    const stock = await withTimeout(inventoryService.getStock(productId), INVENTORY_TIMEOUT_MS, 'inventory.getStock');
    inventoryBreaker.recordSuccess();
    stockCache.set(productId, stock);
    return stock;
  } catch (err) {
    if (isDependencyAnswer(err)) inventoryBreaker.recordSuccess(); // it answered
    else inventoryBreaker.recordFailure();                        // timeout, reset, 5xx
    metrics.increment('products.stock.failed', { kind: (err as Error).name });
    return null;
  }
}

function toDto(row: ProductRow, stock: number | null): ProductDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    price: { amountCents: row.priceCents, currency: row.currency },
    imageUrl: row.imageUrl,
    stock,
    stockStatus: stock === null ? 'unknown' : stock > 0 ? 'in_stock' : 'out_of_stock',
  };
}

async function buildCatalogue(): Promise<{ products: ProductDto[]; degraded: boolean }> {
  const rows = await withTimeout(
    // Tombstones: only live, active rows reach the storefront.
    db.products.findAll({ where: { active: true, deletedAt: null } }),
    DB_TIMEOUT_MS,
    'db.products.findAll',
  );
  // Defensive second filter in case the data layer ignores the where clause.
  const live = rows.filter((r) => r.active && r.deletedAt == null);

  const stocks = await mapLimit(live, INVENTORY_CONCURRENCY, (r) => getStockSafe(r.id));
  const products = live.map((r, i) => toDto(r, stocks[i]));
  const degraded = stocks.some((s) => s === null);
  return { products, degraded };
}

// Single-flight: a cache expiry under load triggers one rebuild, not thousands.
function loadCatalogue() {
  if (!inflightCatalogue) {
    inflightCatalogue = buildCatalogue().finally(() => { inflightCatalogue = null; });
  }
  return inflightCatalogue;
}

// ---------- handler ----------
export async function listProducts(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  try {
    const fresh = catalogueCache.get('all', CATALOGUE_TTL_MS);
    if (fresh) {
      metrics.increment('products.list.cache_hit');
      res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
      res.status(200).json({ data: fresh, meta: { degraded: false, count: fresh.length } });
      return;
    }

    const { products, degraded } = await loadCatalogue();
    // Don't cache a stock-degraded catalogue for the full TTL; let it heal quickly.
    if (!degraded) catalogueCache.set('all', products);

    if (degraded) {
      metrics.increment('products.list.degraded');
      log.warn('products.list.degraded', { count: products.length });
    }
    res.set('Cache-Control', degraded ? 'no-store' : 'public, max-age=15, stale-while-revalidate=60');
    res.status(200).json({ data: products, meta: { degraded, count: products.length } });
    metrics.increment('products.list.ok');
  } catch (err) {
    // DB failure: serve a stale catalogue rather than a blank homepage.
    const stale = catalogueCache.get('all', CATALOGUE_STALE_MS);
    log.error('products.list.failed', { err, requestId: req.headers['x-request-id'] });
    metrics.increment('products.list.failed');
    if (stale) {
      metrics.increment('products.list.served_stale');
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ data: stale, meta: { degraded: true, stale: true, count: stale.length } });
      return;
    }
    // Generic message: never leak internals.
    res.status(503).set('Retry-After', '5').json({ error: 'catalogue_unavailable' });
  } finally {
    metrics.timing('products.list.latency_ms', Date.now() - started);
  }
}

// Versioned from day one.
export function registerProductRoutes(router: Router): void {
  router.get('/api/v1/products', listProducts);
}
```

**Production concerns I addressed**

- Versioned route (`/api/v1/products`) so a later breaking change to the response does not force a coordinated client migration.
- Explicit response DTO (`toDto`): internal fields (cost, supplier, warehouse notes) are never serialized.
- Inventory N+1 fan-out is bounded (`mapLimit`, 20 in flight) instead of one unbounded `Promise.all` over the whole catalogue.
- Per-call 250ms deadline on the inventory service, and an 800ms deadline on the database call too; nothing on the request path can hang.
- Circuit breaker around inventory: when it is known-sick, calls fail fast instead of piling up. Only transport failures (timeout, reset, 5xx) count toward opening it; 4xx/not-found counts as a healthy answer.
- Graceful degradation: a slow or down inventory service yields `stock: null` / `stockStatus: 'unknown'` (never a fake 0) plus `meta.degraded`, so the homepage still renders.
- Short in-process caching (catalogue 30s, per-product stock 10s) with single-flight rebuilds so a cache expiry under high traffic does not stampede the DB or inventory service. Degraded results are not cached and are `no-store`.
- Stale-on-error: if the DB fails, serve the last good catalogue (up to 5 min) rather than a blank homepage; otherwise a clean 503 with `Retry-After` and no internal error details.
- Soft-delete discipline: reads filter `active` and `deletedAt`, with a defensive in-code filter as a second layer.
- Observability: structured logs plus counters (`products.list.ok/failed/degraded/served_stale`, `products.stock.failed/breaker_open/cache_hit`) and a latency timer, so you can alert on failure rate rather than CPU.
- Not added on purpose: no kill switch (read-only path, would only create flag debt), no queue/outbox (nothing leaves the request path), no breaker around the primary DB (it would turn slow queries into outages). Cache and breaker are per-instance; use Redis if cross-instance coherence matters. Pagination or a batch `getStock` endpoint would be the next step as the catalogue grows.
````
