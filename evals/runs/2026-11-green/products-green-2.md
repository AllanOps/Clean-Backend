# products — Sonnet 5.5 — with skill 2

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `productsRouter.get("/api/v1/products", async (req: Request, res: Response) => {` |
| **2. Feature flags** | Absent | Declined: no flag on the read path; no reason given in the output. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Correct | Windowed breaker with a half-open probe on inventory only. |
| **4. Deadline on every I/O** | Correct | DB, each inventory call, and a total stock budget are all bounded. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Correct | `products.list` by status, `inventory.failed`, `inventory.breaker.opened`, `products.served_stale`. |
| **7. Tombstone-aware reads** | Correct | `where: { active: true, deletedAt: null },` re-checked by `rows.filter((r) => r.active && r.deletedAt == null)`. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from "express";
import express from "express";

// Assumed to exist and be imported, per the spec:
//   db.products.findAll(opts?)       -> Promise<ProductRow[]>
//   inventoryService.getStock(id)    -> Promise<number>
//   log, metrics                     -> structured logger and counter client
declare const db: {
  products: { findAll(opts?: Record<string, unknown>): Promise<ProductRow[]> };
};
declare const inventoryService: { getStock(productId: string): Promise<number> };
declare const log: {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
};
declare const metrics: {
  increment(name: string, tags?: Record<string, string>): void;
  timing(name: string, ms: number): void;
};

// ---------- Types ----------

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  active: boolean;
  deletedAt: Date | null;
  // Internal fields (cost, supplier, margin, warehouse ids, ...) are never exposed.
  [internal: string]: unknown;
}

type StockStatus = "in_stock" | "out_of_stock" | "unknown";

interface ProductDto {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null; // null = could not be determined right now
  stockStatus: StockStatus;
}

// ---------- Config ----------

const CONFIG = {
  dbTimeoutMs: 800,
  inventoryTimeoutMs: 300, // per call; the homepage must not wait on a slow service
  inventoryBudgetMs: 1_200, // total budget for all stock lookups
  inventoryConcurrency: 25,
  catalogueCacheTtlMs: 15_000,
  maxProducts: 500,
  breaker: { failureThreshold: 10, windowMs: 10_000, cooldownMs: 15_000 },
};

// ---------- Helpers ----------

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Minimal circuit breaker. Opens after N failures inside a window, rejects
 * instantly while open, then lets a single probe through (half-open).
 */
class CircuitBreaker {
  private failures: number[] = [];
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly opts: { failureThreshold: number; windowMs: number; cooldownMs: number },
  ) {}

  isOpen(now = Date.now()): boolean {
    if (this.openedAt === 0) return false;
    if (now - this.openedAt < this.opts.cooldownMs) return true;
    if (this.probing) return true; // someone is already probing
    this.probing = true; // half-open: allow exactly one probe
    return false;
  }

  onSuccess(): void {
    this.failures = [];
    this.openedAt = 0;
    this.probing = false;
  }

  onFailure(now = Date.now()): void {
    this.probing = false;
    this.failures = this.failures.filter((t) => now - t < this.opts.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.opts.failureThreshold || this.openedAt !== 0) {
      if (this.openedAt === 0) metrics.increment("inventory.breaker.opened");
      this.openedAt = now;
    }
  }
}

const inventoryBreaker = new CircuitBreaker(CONFIG.breaker);

/** Run `fn` over items with bounded concurrency, preserving order. */
async function mapBounded<T, R>(
  items: readonly T[],
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

/** Stock lookup that never throws: returns null when unknown. */
async function safeGetStock(productId: string, deadlineAt: number): Promise<number | null> {
  if (Date.now() >= deadlineAt) {
    metrics.increment("inventory.skipped", { reason: "budget_exhausted" });
    return null;
  }
  if (inventoryBreaker.isOpen()) {
    metrics.increment("inventory.skipped", { reason: "breaker_open" });
    return null;
  }
  try {
    const remaining = Math.max(1, deadlineAt - Date.now());
    const stock = await withTimeout(
      inventoryService.getStock(productId),
      Math.min(CONFIG.inventoryTimeoutMs, remaining),
      "inventory.getStock",
    );
    inventoryBreaker.onSuccess();
    if (!Number.isFinite(stock) || stock < 0) {
      metrics.increment("inventory.invalid_value");
      return null;
    }
    return stock;
  } catch (err) {
    inventoryBreaker.onFailure();
    const timedOut = err instanceof TimeoutError;
    metrics.increment("inventory.failed", { reason: timedOut ? "timeout" : "error" });
    log.warn("inventory.getStock.failed", { productId, timedOut, err: String(err) });
    return null;
  }
}

function toDto(row: ProductRow, stock: number | null): ProductDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    currency: row.currency,
    imageUrl: row.imageUrl,
    stock,
    stockStatus: stock === null ? "unknown" : stock > 0 ? "in_stock" : "out_of_stock",
  };
}

// ---------- Short-lived catalogue cache (absorbs homepage burst traffic) ----------

interface CacheEntry {
  body: { products: ProductDto[]; stockDegraded: boolean };
  storedAt: number;
}
let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry["body"]> | null = null; // single-flight: no stampede

async function buildCatalogue(): Promise<CacheEntry["body"]> {
  // Filter at the database, and defensively again below: soft-deleted or inactive
  // rows must never reach the storefront.
  const rows = await withTimeout(
    db.products.findAll({
      where: { active: true, deletedAt: null },
      limit: CONFIG.maxProducts,
    }),
    CONFIG.dbTimeoutMs,
    "db.products.findAll",
  );
  const live = rows.filter((r) => r.active && r.deletedAt == null);

  const deadlineAt = Date.now() + CONFIG.inventoryBudgetMs;
  const stocks = await mapBounded(live, CONFIG.inventoryConcurrency, (r) =>
    safeGetStock(r.id, deadlineAt),
  );

  const products = live.map((r, i) => toDto(r, stocks[i]));
  return { products, stockDegraded: stocks.some((s) => s === null) };
}

async function getCatalogue(): Promise<{ body: CacheEntry["body"]; stale: boolean }> {
  const now = Date.now();
  if (cache && now - cache.storedAt < CONFIG.catalogueCacheTtlMs) {
    metrics.increment("products.cache", { result: "hit" });
    return { body: cache.body, stale: false };
  }
  metrics.increment("products.cache", { result: "miss" });

  inFlight ??= buildCatalogue().finally(() => {
    inFlight = null;
  });

  try {
    const body = await inFlight;
    // Do not cache a degraded result for the full TTL: let it recover sooner.
    cache = { body, storedAt: body.stockDegraded ? now - CONFIG.catalogueCacheTtlMs + 2_000 : now };
    return { body, stale: false };
  } catch (err) {
    // Database failed or timed out. Serve last-known-good rather than a blank homepage.
    if (cache) {
      metrics.increment("products.served_stale");
      log.warn("products.serving_stale", { err: String(err) });
      return { body: cache.body, stale: true };
    }
    throw err;
  }
}

// ---------- Route ----------

export const productsRouter: Router = express.Router();

// Versioned from day one: mount under /api/v1 so a breaking change becomes /api/v2.
productsRouter.get("/api/v1/products", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const { body, stale } = await getCatalogue();

    res.set("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    if (stale) res.set("Warning", '110 - "Response is stale"');
    res.status(200).json({
      data: body.products,
      meta: { count: body.products.length, stockDegraded: body.stockDegraded || stale },
    });

    metrics.increment("products.list", { status: "200" });
  } catch (err) {
    metrics.increment("products.list", { status: "500" });
    metrics.increment("products.list.failed");
    log.error("products.list.failed", { err: err instanceof Error ? err.stack : String(err) });
    res.status(503).set("Retry-After", "5").json({
      error: { code: "catalogue_unavailable", message: "Catalogue temporarily unavailable" },
    });
  } finally {
    metrics.timing("products.list.latency_ms", Date.now() - startedAt);
  }
});
```

**Production concerns I addressed**

- Field-limited response: rows are mapped to an explicit `ProductDto`, so internal columns (cost, supplier, margin and so on) cannot leak, and there is a contract the frontend can rely on.
- Versioned route: `/api/v1/products`, so the first breaking change does not become a coordinated client migration.
- Deadlines on every I/O: the database call (800 ms) and each inventory call (300 ms) have timeouts, plus a total 1.2 s budget across all stock lookups so a slow service cannot stretch the homepage latency.
- Circuit breaker on the inventory service: after repeated failures it fails fast and sends a single half-open probe, so a sick dependency is not hammered and does not tie up request capacity.
- Bounded concurrency: stock lookups run through a worker pool (25 at a time) instead of an unbounded `Promise.all` over the whole catalogue, which would flood the inventory service.
- Graceful degradation: if stock cannot be fetched, the product still renders with `stock: null` and `stockStatus: "unknown"`, and `meta.stockDegraded` tells the client. A slow inventory service does not take down the homepage.
- Soft-delete and active filtering: the query filters `active` and `deletedAt IS NULL`, and the code re-checks as a defence in depth.
- Burst protection: a 15 s in-process cache with single-flight, so a traffic spike causes one database and inventory fan-out rather than thousands. Degraded results get a much shorter effective TTL so they recover quickly.
- Stale-on-error: if the database fails, the last good catalogue is served, marked stale, rather than a blank homepage. If there is nothing cached, it returns a 503 with `Retry-After`.
- HTTP caching: `Cache-Control` with `stale-while-revalidate` lets the CDN and browser absorb most homepage traffic.
- Data sanity: negative or non-finite stock values from the inventory service are treated as unknown rather than shown to customers.
- Alertable counters as well as logs: metrics for `products.list` by status, `products.list.failed`, `inventory.failed` by reason, `inventory.skipped`, breaker opened, cache hit and miss, stale served, and latency. These can be alerted on directly (for example, a spike in inventory failures or the breaker opening), not just searched in logs afterwards.
- Safe error responses: clients get a generic error code and message, and the stack trace goes only to the logs.
- Result-size cap: `maxProducts` bounds the response size and memory use, and is the point where pagination would be added if the catalogue grows.
````
