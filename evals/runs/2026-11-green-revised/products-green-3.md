# products — Sonnet 5.5 — revised skill 3

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.get('/api/v1/products', async (req: Request, res: Response) => {` |
| **2. Kill switch** | Correct (skip) | No flag. *"Read-only path, so no kill switch needed."* The revised skip clause holds; scored separately as a definitional gain. |
| **3. Circuit breaker** | Correct | Wraps the inventory service only, and `isDependencyAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | `db.products.findAll` and each inventory call wrapped in `withTimeout`. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | Correct | `db.products.findAll({ where: { active: true, deletedAt: null } }),` |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';

// Assumed to exist and be imported: db, inventoryService, metrics, log, Router factory.
declare const db: {
  products: { findAll(opts?: { where?: Record<string, unknown> }): Promise<ProductRow[]> };
};
declare const inventoryService: { getStock(productId: string): Promise<number> };
declare const metrics: { increment(name: string, tags?: Record<string, string>): void; timing(name: string, ms: number): void };
declare const log: { warn(msg: string, ctx?: object): void; error(msg: string, ctx?: object): void };

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  active: boolean;
  deletedAt: Date | null;
  // many internal fields (costCents, supplierId, margin, internalNotes, ...) are never exposed
  [internal: string]: unknown;
}

interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;        // null = unknown (inventory degraded)
  stockKnown: boolean;
}

const DB_TIMEOUT_MS = 800;
const INVENTORY_TIMEOUT_MS = 250;   // per call, well under homepage budget
const INVENTORY_CONCURRENCY = 20;   // bounded fan-out
const INVENTORY_BUDGET_MS = 1200;   // total budget for enrichment
const CACHE_TTL_MS = 15_000;
const STALE_TTL_MS = 5 * 60_000;
const MAX_PRODUCTS = 200;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new TimeoutError(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Minimal circuit breaker. Only transport failures (timeout, reset, 5xx) count;
// a not-found or 4xx means the dependency answered and is healthy.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private threshold = 10, private cooldownMs = 10_000) {}
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) { // half-open: let a probe through
      this.openedAt = Date.now();
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
  const status = (err as { status?: number })?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

async function getStockSafe(productId: string): Promise<number | null> {
  if (inventoryBreaker.isOpen()) {
    metrics.increment('products.inventory.short_circuited');
    return null;
  }
  try {
    const stock = await withTimeout(inventoryService.getStock(productId), INVENTORY_TIMEOUT_MS);
    inventoryBreaker.recordSuccess();
    return Number.isFinite(stock) ? Math.max(0, stock) : null;
  } catch (err) {
    if (isDependencyAnswer(err)) inventoryBreaker.recordSuccess();
    else inventoryBreaker.recordFailure();
    metrics.increment('products.inventory.failed', { kind: err instanceof TimeoutError ? 'timeout' : 'error' });
    return null;
  }
}

// Bounded concurrency; stops starting new work once the overall budget is spent.
async function mapLimit<T, R>(items: T[], limit: number, deadline: number, fn: (i: T) => Promise<R>, fallback: R): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = Date.now() > deadline ? fallback : await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Explicit allowlist mapping: internal columns can never leak by accident.
function toStorefront(row: ProductRow, stock: number | null): StorefrontProduct {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    currency: row.currency,
    imageUrl: row.imageUrl,
    stock,
    stockKnown: stock !== null,
  };
}

// Short-TTL cache + in-flight coalescing: a homepage stampede becomes one build.
let cache: { at: number; body: { products: StorefrontProduct[]; degraded: boolean } } | null = null;
let inflight: Promise<{ products: StorefrontProduct[]; degraded: boolean }> | null = null;

async function buildCatalogue() {
  // Tombstones filtered in the query and again defensively on the result.
  const rows = await withTimeout(
    db.products.findAll({ where: { active: true, deletedAt: null } }),
    DB_TIMEOUT_MS,
  );
  const visible = rows.filter((r) => r.active && !r.deletedAt).slice(0, MAX_PRODUCTS);

  const deadline = Date.now() + INVENTORY_BUDGET_MS;
  const stocks = await mapLimit(visible, INVENTORY_CONCURRENCY, deadline, (r) => getStockSafe(r.id), null as number | null);

  const products = visible.map((r, i) => toStorefront(r, stocks[i]));
  const degraded = stocks.some((s) => s === null);
  return { products, degraded };
}

async function getCatalogue() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS && !cache.body.degraded) return cache.body;
  if (!inflight) {
    inflight = buildCatalogue()
      .then((body) => { cache = { at: Date.now(), body }; return body; })
      .finally(() => { inflight = null; });
  }
  try {
    return await inflight;
  } catch (err) {
    if (cache && Date.now() - cache.at < STALE_TTL_MS) { // serve stale rather than a blank homepage
      metrics.increment('products.served_stale');
      return cache.body;
    }
    throw err;
  }
}

export function registerProductRoutes(router: Router) {
  // Versioned from day one. Read-only path, so no kill switch needed.
  router.get('/api/v1/products', async (req: Request, res: Response) => {
    const started = Date.now();
    try {
      const { products, degraded } = await getCatalogue();
      metrics.increment('products.list.ok', { degraded: String(degraded) });
      metrics.timing('products.list.latency_ms', Date.now() - started);
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30')
        .json({ products, degraded });
    } catch (err) {
      log.error('products.list.failed', { err, path: req.path });
      metrics.increment('products.list.failed');
      res.status(503).set('Retry-After', '5').json({ error: 'catalogue_unavailable' });
    }
  });
}
```

**Production concerns I addressed**

- Versioned route (`/api/v1/products`) so the first breaking change is not a coordinated client migration.
- Field-limited response through an explicit allowlist mapper; internal columns (cost, supplier, notes) cannot leak.
- Deadlines on every I/O: an 800ms timeout on the DB read, a 250ms timeout per inventory call, and a 1.2s total enrichment budget.
- Bounded concurrency (20) on inventory calls instead of N unbounded parallel requests or a serial N+1 loop.
- Circuit breaker on the inventory service. It fails fast when the service is sick, probes after a cooldown, and counts only transport failures (timeouts, resets, 5xx). A 4xx or not-found counts as the dependency answering.
- Graceful degradation: if stock is unavailable, the product still renders with `stock: null` and `stockKnown: false`, and the response is flagged `degraded`. A slow inventory service never blanks the homepage.
- Short-TTL cache with in-flight coalescing, so a traffic spike causes one DB/inventory build rather than thousands. Stale data is served on total failure, and degraded results are not cached as fresh.
- CDN-friendly `Cache-Control` with stale-while-revalidate.
- Soft-delete discipline: the query filters `active` and `deletedAt`, with a defensive re-filter on the result.
- Result cap (`MAX_PRODUCTS`) so the response and fan-out stay bounded.
- Metrics, not just logs: counters for ok, failed, degraded, stale-served, inventory failures (by kind) and short-circuits, plus a latency timing, so an alert can page on them.
- A clean 503 with `Retry-After` when neither fresh nor stale data exists, instead of leaking stack traces.
- No kill switch: this path only reads, so a flag would only add flag debt.
````
