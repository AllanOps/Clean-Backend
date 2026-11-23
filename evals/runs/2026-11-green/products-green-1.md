# products — Sonnet 5.5 — with skill 1

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `// app.get('/api/v1/products', getProducts);` |
| **2. Feature flags** | Absent | Declined: no flag on the inventory path; no reason given. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Correct | Inventory only; the DB is not wrapped. A stock read has no business-failure class. |
| **4. Deadline on every I/O** | Correct | `withTimeout` on `db.products.findAll` and on each `inventoryService.getStock`, with a shared budget. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Correct | `products.list.ok`, `products.list.failed`, `products.inventory.failed`, `products.list.served_stale`. |
| **7. Tombstone-aware reads** | Correct | `where: { active: true, deletedAt: null },` |

## Verbatim output

````markdown
```typescript
import type { Request, Response } from 'express';

// Assumed to exist and be imported: db, inventoryService, log, metrics.

const DB_TIMEOUT_MS = 800;
const INVENTORY_TIMEOUT_MS = 250;     // per-call deadline
const INVENTORY_BUDGET_MS = 600;      // total budget for the whole stock fan-out
const INVENTORY_CONCURRENCY = 20;
const CACHE_TTL_MS = 15_000;
const STALE_TTL_MS = 5 * 60_000;
const MAX_PRODUCTS = 200;

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

// Minimal circuit breaker: opens after N consecutive failures, half-opens after a cooldown.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 10_000,
  ) {}

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs && !this.probing) {
      this.probing = true; // let exactly one probe through
      return false;
    }
    return true;
  }
  success() { this.failures = 0; this.probing = false; }
  failure() {
    this.failures++;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

const inventoryBreaker = new CircuitBreaker();

// Bounded-concurrency map so 200 products never means 200 simultaneous calls.
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
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

// ---------- response shape (explicit allow-list, no internal fields leak) ----------

type StockStatus = 'in_stock' | 'out_of_stock' | 'unknown';

interface ProductDTO {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;       // null = unknown (inventory degraded)
  stockStatus: StockStatus;
}

function toDTO(row: any, stock: number | null): ProductDTO {
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    currency: row.currency,
    imageUrl: row.imageUrl ?? null,
    stock,
    stockStatus: stock === null ? 'unknown' : stock > 0 ? 'in_stock' : 'out_of_stock',
  };
}

// ---------- tiny in-process cache with stale fallback ----------

let cache: { body: { products: ProductDTO[]; stockDegraded: boolean }; at: number } | null = null;
let inflight: Promise<{ products: ProductDTO[]; stockDegraded: boolean }> | null = null;

async function loadCatalogue() {
  // Reads must respect soft deletes and unpublished rows.
  const rows = await withTimeout(
    db.products.findAll({
      where: { active: true, deletedAt: null },
      limit: MAX_PRODUCTS,
      order: [['sortOrder', 'ASC'], ['id', 'ASC']],
    }),
    DB_TIMEOUT_MS,
    'db.products.findAll',
  );

  const deadline = Date.now() + INVENTORY_BUDGET_MS;
  let degraded = false;

  const stocks = await mapLimit(rows, INVENTORY_CONCURRENCY, async (row: any) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || inventoryBreaker.isOpen()) {
      degraded = true;
      metrics.increment('products.inventory.skipped');
      return null;
    }
    try {
      const qty = await withTimeout(
        inventoryService.getStock(row.id),
        Math.min(INVENTORY_TIMEOUT_MS, remaining),
        'inventoryService.getStock',
      );
      inventoryBreaker.success();
      return typeof qty === 'number' && Number.isFinite(qty) ? Math.max(0, qty) : null;
    } catch (err) {
      inventoryBreaker.failure();
      degraded = true;
      metrics.increment('products.inventory.failed');
      log.warn('products.inventory.failed', { productId: row.id, err: (err as Error).message });
      return null; // one bad lookup must not 500 the homepage
    }
  });

  return { products: rows.map((r: any, i: number) => toDTO(r, stocks[i])), stockDegraded: degraded };
}

// ---------- route ----------

// Versioned from day one: mobile/older clients outlive refactors.
// app.get('/api/v1/products', getProducts);
export async function getProducts(req: Request, res: Response) {
  const started = Date.now();
  try {
    const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
    if (!fresh) {
      // Single-flight: a thundering herd on expiry triggers one load, not thousands.
      inflight ??= loadCatalogue().finally(() => { inflight = null; });
      const result = await inflight;
      // Don't cache degraded results for the full TTL; keep them short-lived.
      if (!result.stockDegraded) cache = { body: result, at: Date.now() };
      else cache = cache ?? { body: result, at: Date.now() - (CACHE_TTL_MS - 2_000) };
      metrics.increment('products.list.ok');
      return send(res, result, started);
    }
    metrics.increment('products.list.cache_hit');
    return send(res, cache!.body, started);
  } catch (err) {
    // Catalogue (DB) failed. Serve stale rather than a blank homepage.
    metrics.increment('products.list.failed');
    log.error('products.list.failed', { err: (err as Error).message });
    if (cache && Date.now() - cache.at < STALE_TTL_MS) {
      metrics.increment('products.list.served_stale');
      res.set('Warning', '110 - "Response is stale"');
      return send(res, cache.body, started);
    }
    return res.status(503).set('Retry-After', '5').json({
      error: { code: 'catalogue_unavailable', message: 'Catalogue temporarily unavailable' },
    });
  }
}

function send(res: Response, body: { products: ProductDTO[]; stockDegraded: boolean }, started: number) {
  metrics.timing('products.list.latency_ms', Date.now() - started);
  // CDN/browser caching: the homepage should rarely reach origin.
  res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30, stale-if-error=300');
  return res.status(200).json(body);
}
```

**Production concerns I addressed**

- Versioned route (`/api/v1/products`) so the first breaking change to the storefront contract is not a coordinated migration.
- Field-limited response: an explicit DTO allow-list, so internal columns never leak to the storefront.
- Soft-delete and active filtering on the read (`active: true, deletedAt: null`), plus a hard row cap and stable ordering.
- No N+1 blowup: inventory lookups run with bounded concurrency (20), not one unbounded fan-out.
- Deadlines on every I/O: 800ms on the DB query, 250ms per inventory call, and a 600ms total budget for the whole stock fan-out.
- Circuit breaker around the inventory service: after repeated failures it fails fast and half-opens with a single probe, so a slow service does not drag the homepage down with it. No retries into a struggling dependency. There is deliberately no breaker around our own DB.
- Graceful degradation: when stock is slow or down, products still render with `stock: null` / `stockStatus: 'unknown'` and a `stockDegraded` flag, instead of a 500.
- Caching for high traffic: 15s in-process cache, single-flight to prevent a thundering herd on expiry, degraded results not cached long, and CDN headers (`stale-while-revalidate`, `stale-if-error`).
- Stale-on-error: if the DB fails, serve the last good catalogue (up to 5 minutes, with a `Warning` header). Otherwise return a clean 503 with `Retry-After`.
- Observability: counters (`products.list.failed`, `products.inventory.failed`, `products.inventory.skipped`, `served_stale`) you can alert on, a latency timing, and structured logs without PII.
- Input sanity: stock values are validated and clamped (non-finite or negative becomes unknown or 0). The endpoint takes no user input, so there is no injection surface.
- Deliberately not done: no feature flag (no risky new behavior to gate) and no queue (nothing deferred from the request path).
````
