# products — Sonnet 5.5 — with skill 3

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.get('/api/v1/products', async (req: Request, res: Response) => {` |
| **2. Feature flags** | Absent | Declined: no flag; no reason given. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Correct | Consecutive-failure breaker on inventory only. |
| **4. Deadline on every I/O** | Correct | `withTimeout(db.products.findAll(), DB_TIMEOUT_MS, 'db.products.findAll')`, plus inventory. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Correct | `products.list.success`, `products.list.failed`, `products.list.degraded`, `products.inventory.failed`. |
| **7. Tombstone-aware reads** | Correct | `rows.filter((r: any) => !r.deletedAt && r.active !== false)`. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';
// Assumed already imported: db, inventoryService, log (structured logger), metrics (counter/timer client)

// ---------- config ----------
const DB_TIMEOUT_MS = 800;
const STOCK_TIMEOUT_MS = 300;          // per-product inventory deadline
const STOCK_CONCURRENCY = 20;          // bounded fan-out to inventory
const CACHE_TTL_MS = 15_000;           // fresh window for the assembled catalogue
const STALE_MAX_MS = 5 * 60_000;       // serve stale on DB failure up to this age
const BREAKER_FAILURE_THRESHOLD = 5;   // consecutive failures to open
const BREAKER_COOLDOWN_MS = 10_000;

// ---------- types ----------
type StockStatus = 'ok' | 'unknown';

interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;      // null => unknown (inventory degraded)
  stockStatus: StockStatus;
}

// ---------- helpers ----------
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

// Minimal circuit breaker: closed -> open after N consecutive failures,
// half-open after cooldown lets a single probe through.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(private threshold: number, private cooldownMs: number) {}

  canRequest(): boolean {
    if (this.failures < this.threshold) return true;
    if (Date.now() - this.openedAt >= this.cooldownMs && !this.probing) {
      this.probing = true; // half-open: exactly one probe
      return true;
    }
    return false;
  }
  onSuccess() { this.failures = 0; this.probing = false; }
  onFailure() {
    this.failures++;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
  get isOpen() { return this.failures >= this.threshold; }
}

const inventoryBreaker = new CircuitBreaker(BREAKER_FAILURE_THRESHOLD, BREAKER_COOLDOWN_MS);

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Explicit allow-list mapper: internal columns (cost, supplier, margin, etc.) never leave the service.
function toStorefrontProduct(row: any, stock: number | null): StorefrontProduct {
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    currency: row.currency ?? 'USD',
    imageUrl: row.imageUrl ?? null,
    stock,
    stockStatus: stock === null ? 'unknown' : 'ok',
  };
}

// Never let one product's inventory failure fail the page.
async function getStockSafe(productId: string): Promise<number | null> {
  if (!inventoryBreaker.canRequest()) {
    metrics.increment('products.inventory.short_circuited');
    return null;
  }
  try {
    const stock = await withTimeout(
      inventoryService.getStock(productId),
      STOCK_TIMEOUT_MS,
      'inventory.getStock',
    );
    if (typeof stock !== 'number' || !Number.isFinite(stock) || stock < 0) {
      throw new Error(`invalid stock value for ${productId}`);
    }
    inventoryBreaker.onSuccess();
    return stock;
  } catch (err) {
    inventoryBreaker.onFailure();
    metrics.increment('products.inventory.failed');
    if (err instanceof TimeoutError) metrics.increment('products.inventory.timeout');
    log.warn('products.inventory.failed', { productId, err: String(err) });
    return null;
  }
}

// ---------- catalogue assembly + cache ----------
let cache: { value: StorefrontProduct[]; at: number; degraded: boolean } | null = null;
let inFlight: Promise<{ value: StorefrontProduct[]; degraded: boolean }> | null = null;

async function buildCatalogue(): Promise<{ value: StorefrontProduct[]; degraded: boolean }> {
  const rows = await withTimeout(db.products.findAll(), DB_TIMEOUT_MS, 'db.products.findAll');

  // Defensive read-side filter: only live, visible products (tombstones and inactive rows).
  const live = rows.filter((r: any) => !r.deletedAt && r.active !== false);

  const stocks = await mapWithConcurrency(live, STOCK_CONCURRENCY, (r: any) =>
    getStockSafe(String(r.id)),
  );

  const degraded = stocks.some((s) => s === null);
  const value = live.map((r: any, i: number) => toStorefrontProduct(r, stocks[i]));
  return { value, degraded };
}

// Single-flight: a cache expiry under heavy traffic triggers one rebuild, not thousands.
async function getCatalogue(): Promise<{ value: StorefrontProduct[]; degraded: boolean; stale: boolean }> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS && !cache.degraded) {
    metrics.increment('products.cache.hit');
    return { value: cache.value, degraded: false, stale: false };
  }

  inFlight ??= buildCatalogue().finally(() => { inFlight = null; });

  try {
    const fresh = await inFlight;
    cache = { ...fresh, at: Date.now() };
    metrics.increment('products.cache.miss');
    return { ...fresh, stale: false };
  } catch (err) {
    // DB down/slow: serve last known good catalogue rather than a blank homepage.
    if (cache && now - cache.at < STALE_MAX_MS) {
      metrics.increment('products.served_stale');
      log.warn('products.serving_stale', { ageMs: now - cache.at, err: String(err) });
      return { value: cache.value, degraded: true, stale: true };
    }
    throw err;
  }
}

// ---------- route ----------
export function registerProductRoutes(router: Router) {
  // Versioned from day one so the storefront contract can evolve without breaking old clients.
  router.get('/api/v1/products', async (req: Request, res: Response) => {
    const started = Date.now();
    try {
      const { value, degraded, stale } = await getCatalogue();

      metrics.increment('products.list.success');
      metrics.timing('products.list.latency_ms', Date.now() - started);
      if (degraded) metrics.increment('products.list.degraded');

      // Let the CDN absorb homepage traffic; shorter when degraded so recovery is quick.
      res.set(
        'Cache-Control',
        degraded
          ? 'public, max-age=5, stale-while-revalidate=30'
          : 'public, max-age=15, stale-while-revalidate=60, stale-if-error=300',
      );
      if (stale) res.set('Warning', '110 - "Response is stale"');

      res.status(200).json({
        data: value,
        meta: { count: value.length, stockDegraded: degraded },
      });
    } catch (err) {
      metrics.increment('products.list.failed');
      log.error('products.list.failed', { err: String(err), durationMs: Date.now() - started });
      // No internals leaked to the client.
      res.status(503).set('Retry-After', '5').json({
        error: { code: 'CATALOGUE_UNAVAILABLE', message: 'Catalogue temporarily unavailable' },
      });
    }
  });
}
```

Production concerns I addressed
- Versioned route (`/api/v1/products`) so the storefront contract can change without breaking older clients.
- Field-limited response through an explicit allow-list mapper; internal columns never reach the storefront.
- Deadlines on every I/O: 800ms on the database read and 300ms per inventory call, so a hung dependency cannot hold requests open.
- Circuit breaker on the inventory service: after 5 consecutive failures it fails fast for 10s, then lets a single probe through, so a sick dependency is not hammered.
- Graceful degradation: a failed or slow stock lookup returns `stock: null` / `stockStatus: 'unknown'` for that product and the homepage still renders, with `meta.stockDegraded` set.
- Bounded concurrency (20) for the N inventory calls, so one request cannot flood the inventory service or fan out unboundedly.
- In-process cache (15s TTL) with single-flight rebuild, so a cache expiry under heavy traffic triggers one rebuild instead of a stampede; the degraded-aware cache is not treated as fresh until inventory recovers.
- Stale-on-error: if the database fails, the last good catalogue (up to 5 minutes old) is served instead of a blank homepage, flagged with a `Warning` header.
- CDN-friendly `Cache-Control` (`stale-while-revalidate`, `stale-if-error`), with a shorter TTL while degraded.
- Defensive read-side filtering of tombstoned (`deletedAt`) and inactive rows. Ideally this is pushed into the query itself, but `findAll`'s filter options are not specified.
- Validation of inventory responses: non-numeric, negative or non-finite stock counts as a failure rather than being shown to shoppers.
- Alertable counters alongside logs: `products.list.failed`, `products.list.degraded`, `products.inventory.failed`, `products.inventory.timeout`, `products.inventory.short_circuited`, `products.served_stale`, cache hit/miss, plus a latency timing.
- Safe failure mode: 503 with `Retry-After` and a generic error body, with no internal error details leaked.
- Not added, because they do not fit: a feature flag (there is no risky behavioural change to gate) and a queue (nothing here is work to move off the request path).
- Known limits: the cache and breaker are per-process, so move them to shared storage such as Redis if you need fleet-wide consistency. A bulk `inventoryService.getStock([...ids])` endpoint would remove the N+1 entirely if the inventory service can offer one.
````
