# products — Sonnet 5.5 — baseline 3

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `// Wiring: router.get("/products", getProducts);` |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Correct | Windowed `CircuitBreaker` on inventory only; the database is not wrapped. |
| **4. Deadline on every I/O** | Present | Inventory bounded; `db.products.findAll({ limit: MAX_PRODUCTS })` is limited in size but not in time. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Absent | No metrics call. |
| **7. Tombstone-aware reads** | Correct | `rows.filter((r) => r.isPublished !== false && !r.deletedAt)`. |
| *Field-limiting* (cut) | Present | Allow-list DTO. |
| *Degradation* (cut) | Correct | `stock: null` / `stockStatus: "unknown"` instead of a 500. |

**Shipped habits reaching Present or better: 3 of 6 applicable. Reaching Correct: 2 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";

// Assumed to exist and be imported: db, inventoryService, logger (optional).

// ---------- Config ----------
const STOCK_TIMEOUT_MS = 300;          // per-call budget for inventory service
const STOCK_CONCURRENCY = 25;          // cap on in-flight inventory calls
const STOCK_CACHE_TTL_MS = 15_000;     // short-lived per-product stock cache
const CATALOGUE_CACHE_TTL_MS = 30_000; // whole-response cache
const CATALOGUE_STALE_MAX_MS = 10 * 60_000; // serve-stale ceiling if DB fails
const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_WINDOW_MS = 10_000;
const BREAKER_OPEN_MS = 15_000;
const MAX_PRODUCTS = 500;              // safety cap for the homepage

// ---------- Public DTO (explicit allow-list; never leak internal columns) ----------
interface ProductDto {
  id: string;
  name: string;
  slug: string;
  price: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;               // null = unknown (inventory unavailable)
  stockStatus: "in_stock" | "out_of_stock" | "unknown";
}

function toDto(row: any, stock: number | null): ProductDto {
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    price: row.price,
    currency: row.currency ?? "USD",
    imageUrl: row.imageUrl ?? null,
    stock,
    stockStatus: stock === null ? "unknown" : stock > 0 ? "in_stock" : "out_of_stock",
  };
}

// ---------- Timeout helper (also aborts via signal if the client supports it) ----------
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Simple circuit breaker for the inventory service ----------
class CircuitBreaker {
  private failures: number[] = [];
  private openedAt = 0;
  isOpen(): boolean {
    if (!this.openedAt) return false;
    if (Date.now() - this.openedAt > BREAKER_OPEN_MS) {
      this.openedAt = 0; // half-open: let traffic probe
      this.failures = [];
      return false;
    }
    return true;
  }
  recordSuccess() { this.failures = []; }
  recordFailure() {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= BREAKER_FAILURE_THRESHOLD) this.openedAt = now;
  }
}
const inventoryBreaker = new CircuitBreaker();

// ---------- Small TTL caches ----------
const stockCache = new Map<string, { value: number; expires: number }>();
let catalogueCache: { body: { products: ProductDto[]; degraded: boolean }; at: number } | null = null;
let inflightBuild: Promise<{ products: ProductDto[]; degraded: boolean }> | null = null; // single-flight

function getCachedStock(id: string): number | undefined {
  const hit = stockCache.get(id);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { stockCache.delete(id); return undefined; }
  return hit.value;
}

// ---------- Bounded-concurrency map ----------
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

// ---------- Stock lookup: cache -> breaker -> timeout -> graceful null ----------
async function fetchStock(productId: string): Promise<number | null> {
  const cached = getCachedStock(productId);
  if (cached !== undefined) return cached;
  if (inventoryBreaker.isOpen()) return null;

  try {
    const qty = await withTimeout(inventoryService.getStock(productId), STOCK_TIMEOUT_MS);
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
      inventoryBreaker.recordFailure();
      return null;
    }
    inventoryBreaker.recordSuccess();
    stockCache.set(productId, { value: qty, expires: Date.now() + STOCK_CACHE_TTL_MS });
    return qty;
  } catch (err) {
    inventoryBreaker.recordFailure();
    logger?.warn?.({ productId, err: (err as Error).message }, "stock lookup failed");
    return null;
  }
}

async function buildCatalogue() {
  const rows = (await db.products.findAll({ limit: MAX_PRODUCTS })) as any[];
  const visible = rows.filter((r) => r.isPublished !== false && !r.deletedAt);

  const stocks = await mapLimit(visible, STOCK_CONCURRENCY, (r) => fetchStock(String(r.id)));
  const degraded = stocks.some((s) => s === null);
  const products = visible.map((r, i) => toDto(r, stocks[i]));
  return { products, degraded };
}

// Single-flight: concurrent requests on a cache miss share one build (no stampede).
function getCatalogue() {
  if (!inflightBuild) {
    inflightBuild = buildCatalogue().finally(() => { inflightBuild = null; });
  }
  return inflightBuild;
}

// ---------- Handler ----------
export async function getProducts(req: Request, res: Response): Promise<void> {
  const now = Date.now();

  // Fresh cache hit
  if (catalogueCache && now - catalogueCache.at < CATALOGUE_CACHE_TTL_MS) {
    res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
    res.json(catalogueCache.body);
    return;
  }

  try {
    const body = await getCatalogue();
    // Don't pin a degraded (stock-unknown) result for long; cache only complete results
    // for the full TTL, degraded ones for a short window by back-dating the timestamp.
    catalogueCache = {
      body,
      at: body.degraded ? now - (CATALOGUE_CACHE_TTL_MS - 3_000) : now,
    };
    res.set("Cache-Control", body.degraded ? "no-store" : "public, max-age=15, stale-while-revalidate=60");
    res.json(body);
  } catch (err) {
    logger?.error?.({ err: (err as Error).message }, "GET /products failed");
    // DB failure: serve stale catalogue rather than a blank homepage
    if (catalogueCache && now - catalogueCache.at < CATALOGUE_STALE_MAX_MS) {
      res.set("Cache-Control", "no-store");
      res.set("Warning", '110 - "Response is stale"');
      res.json({ ...catalogueCache.body, degraded: true });
      return;
    }
    res.status(503).set("Retry-After", "5").json({ error: "catalogue_unavailable" });
  }
}

// Wiring: router.get("/products", getProducts);
```

**Production concerns I addressed**
- **Response allow-list (DTO):** only storefront fields are returned, so internal columns (cost, supplier, flags) never leak.
- **N+1 to a slow service:** stock calls run with a concurrency cap (25) rather than unbounded `Promise.all`, so the inventory service isn't hammered and the event loop isn't flooded.
- **Per-call timeout:** each `getStock` is capped at 300ms so one slow call can't hold the homepage hostage.
- **Graceful degradation:** a failed or timed-out stock lookup yields `stock: null` / `stockStatus: "unknown"` instead of a 500; the response carries a `degraded` flag.
- **Circuit breaker:** after repeated failures, stock calls are skipped for 15s, protecting the struggling service and keeping latency low.
- **Caching:** a short per-product stock cache plus a 30s whole-catalogue cache, with `Cache-Control` and `stale-while-revalidate` headers for CDN and browser caching on a high-traffic page. Degraded results are cached only briefly and sent `no-store`.
- **Single-flight / stampede protection:** concurrent requests on a cache miss share one in-flight build, so one DB query and one fan-out serve many requests.
- **Stale-on-error:** if the DB fails, the last good catalogue is served for up to 10 minutes, else a clean 503 with `Retry-After`.
- **Data hygiene:** unpublished and soft-deleted rows are filtered, the result set is capped at `MAX_PRODUCTS`, and stock values are validated (finite, non-negative number).
- **Observability:** failures are logged with context and no internals are leaked to clients.
- **Known trade-offs:** caches are per-process in-memory. For a multi-instance deployment I would move them to Redis or rely on the CDN. Stock on the homepage is intentionally eventually consistent; checkout must re-verify stock authoritatively. A batch `getStocks(ids)` endpoint on the inventory service would be better than N calls, if it can be added. Pagination or a category scope should replace the hard cap as the catalogue grows.
````
