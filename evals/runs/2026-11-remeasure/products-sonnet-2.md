# products — Sonnet 5.5 — baseline 2

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `// app.get("/products", getProducts);` |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Correct | Consecutive-failure breaker around inventory only; the database is not wrapped. |
| **4. Deadline on every I/O** | Present | Inventory bounded; `await db.products.findAll()` unbounded. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Absent | No metrics call. |
| **7. Tombstone-aware reads** | Correct | `.filter((r) => r && r.id != null && r.isPublished !== false && !r.deletedAt)`. |
| *Field-limiting* (cut) | Present | Allow-list DTO. |
| *Degradation* (cut) | Correct | Stale value or unknown; never collapsed to 0. |

**Shipped habits reaching Present or better: 3 of 6 applicable. Reaching Correct: 2 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response, NextFunction } from "express";
// db, inventoryService, and logger are assumed to exist and be imported.

// ---------- Config ----------
const STOCK_TIMEOUT_MS = 300;          // per-call budget for the inventory service
const STOCK_CONCURRENCY = 20;          // cap on in-flight inventory calls per process
const STOCK_CACHE_TTL_MS = 15_000;     // fresh stock window
const STOCK_STALE_TTL_MS = 5 * 60_000; // serve-stale window when inventory is failing
const CATALOGUE_CACHE_TTL_MS = 30_000; // whole-response cache
const MAX_PRODUCTS = 200;              // hard cap on homepage payload
const BREAKER_FAILURES = 5;            // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 10_000;

// ---------- Public DTO: whitelist, never spread the DB row ----------
interface ProductDto {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;                       // null = unknown
  stockStatus: "in_stock" | "out_of_stock" | "unknown";
}

function toDto(row: any, stock: number | null): ProductDto {
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    currency: row.currency ?? "USD",
    imageUrl: row.imageUrl ?? null,
    stock,
    stockStatus: stock === null ? "unknown" : stock > 0 ? "in_stock" : "out_of_stock",
  };
}

// ---------- Helpers ----------
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Run fn over items with bounded concurrency (shared limiter across requests).
class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
const limiter = new Limiter(STOCK_CONCURRENCY);

// Minimal circuit breaker so a sick inventory service is not hammered.
const breaker = { failures: 0, openUntil: 0 };
const breakerOpen = () => Date.now() < breaker.openUntil;
function recordSuccess() { breaker.failures = 0; }
function recordFailure() {
  if (++breaker.failures >= BREAKER_FAILURES) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    breaker.failures = 0;
  }
}

// Per-product stock cache with stale fallback.
const stockCache = new Map<string, { value: number; at: number }>();
const stockInflight = new Map<string, Promise<number | null>>(); // single-flight

async function getStockSafe(productId: string): Promise<number | null> {
  const cached = stockCache.get(productId);
  const now = Date.now();
  if (cached && now - cached.at < STOCK_CACHE_TTL_MS) return cached.value;

  const stale = cached && now - cached.at < STOCK_STALE_TTL_MS ? cached.value : null;
  if (breakerOpen()) return stale;

  const existing = stockInflight.get(productId);
  if (existing) return existing;

  const p = limiter
    .run(() => withTimeout(inventoryService.getStock(productId), STOCK_TIMEOUT_MS))
    .then((raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error("invalid stock value");
      stockCache.set(productId, { value: n, at: Date.now() });
      recordSuccess();
      return n as number | null;
    })
    .catch((err) => {
      recordFailure();
      logger.warn({ err: String(err), productId }, "inventory getStock failed; degrading");
      return stale; // stale value if we have one, else unknown
    })
    .finally(() => stockInflight.delete(productId));

  stockInflight.set(productId, p);
  return p;
}

// ---------- Whole-response cache (single-flight, stale-on-error) ----------
let catalogueCache: { body: { products: ProductDto[]; degraded: boolean }; at: number } | null = null;
let catalogueInflight: Promise<{ products: ProductDto[]; degraded: boolean }> | null = null;

async function buildCatalogue() {
  const rows = (await db.products.findAll()) as any[];
  const visible = rows
    .filter((r) => r && r.id != null && r.isPublished !== false && !r.deletedAt)
    .slice(0, MAX_PRODUCTS);

  const stocks = await Promise.all(visible.map((r) => getStockSafe(String(r.id))));
  const products = visible.map((r, i) => toDto(r, stocks[i]));
  return { products, degraded: stocks.some((s) => s === null) };
}

async function getCatalogue() {
  const now = Date.now();
  if (catalogueCache && now - catalogueCache.at < CATALOGUE_CACHE_TTL_MS) {
    return catalogueCache.body;
  }
  if (!catalogueInflight) {
    catalogueInflight = buildCatalogue()
      .then((body) => {
        // Don't pin a degraded response for the full TTL.
        catalogueCache = { body, at: body.degraded ? now - CATALOGUE_CACHE_TTL_MS + 3_000 : Date.now() };
        return body;
      })
      .finally(() => { catalogueInflight = null; });
  }
  try {
    return await catalogueInflight;
  } catch (err) {
    // DB failure: serve last good catalogue if we have one.
    if (catalogueCache) {
      logger.error({ err }, "catalogue rebuild failed; serving stale");
      return { ...catalogueCache.body, degraded: true };
    }
    throw err;
  }
}

// ---------- Route handler ----------
export async function getProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const { products, degraded } = await getCatalogue();

    // Let the CDN/browser absorb homepage traffic; shorter when degraded.
    res.set(
      "Cache-Control",
      degraded
        ? "public, max-age=5, stale-while-revalidate=15"
        : "public, max-age=30, stale-while-revalidate=60"
    );
    res.status(200).json({ data: products, meta: { count: products.length, degraded } });
  } catch (err) {
    logger.error({ err, path: req.path }, "GET /products failed");
    // Do not leak internals.
    res.status(503).set("Retry-After", "5").json({
      error: { code: "CATALOGUE_UNAVAILABLE", message: "Catalogue temporarily unavailable" },
    });
  }
}

// app.get("/products", getProducts);
```

**Production concerns I addressed**
- **N+1 against a slow service:** stock lookups run in parallel (not sequentially), with a shared concurrency cap so one homepage request can't flood the inventory service.
- **Per-call timeout (300ms):** a slow inventory call can't hold the homepage hostage.
- **Graceful degradation:** if stock fails or times out, the product is still returned with `stock: null` / `stockStatus: "unknown"` (or a stale value if one exists), and `meta.degraded` signals it. Partial data beats a 500 on the homepage.
- **Circuit breaker:** after repeated failures, inventory calls are skipped for a cooldown so we don't pile load on a struggling dependency.
- **Caching in layers:** short-TTL per-product stock cache with a longer stale window, plus a whole-catalogue cache, plus `Cache-Control` / `stale-while-revalidate` for CDN and browser absorption of high traffic.
- **Single-flight / stampede protection:** concurrent cache misses share one in-flight DB/inventory fetch per key instead of multiplying load.
- **Stale-on-error:** if the DB read fails, the last good catalogue is served rather than an error.
- **No internal field leakage:** an explicit DTO whitelist; the DB row is never spread into the response.
- **Input sanity:** skips unpublished/deleted/malformed rows and validates stock is a finite non-negative number.
- **Bounded payload:** hard cap (`MAX_PRODUCTS`) on response size. A real implementation should push filtering and limits into the query or add pagination.
- **Safe errors:** failures are logged with context, and clients get a generic 503 with `Retry-After` and a stable error code.
- **Known limits:** caches and the breaker are per-process in-memory. For a fleet I'd move them to Redis or rely on the CDN, add a batch inventory endpoint to remove the N+1 entirely, and emit metrics (latency, cache hit rate, breaker state, degraded rate).
````
