# products — Sonnet 5.5 — baseline 1

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `// app.get("/products", getProducts);` |
| **2. Feature flags** | Absent | No flag on the inventory path. |
| **3. Circuit breaker** | Correct | Breaker around `inventoryService` only; the database is not wrapped. A stock read has no business-failure class, so malformed values counting as dependency faults does not breach criterion (b). |
| **4. Deadline on every I/O** | Present | `withTimeout(inventoryService.getStock(...), STOCK_TIMEOUT_MS)`; `await db.products.findAll()` unbounded. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Absent | No metrics call. |
| **7. Tombstone-aware reads** | Absent | `rows.filter((r) => r.isActive !== false && r.isPublished !== false)`, with no `deletedAt` check. |
| *Field-limiting* (cut) | Present | Explicit allow-list DTO. |
| *Degradation* (cut) | Correct | `stock: null`, `stockStatus: "unknown"`, plus `stockDegraded`. |

**Shipped habits reaching Present or better: 2 of 6 applicable. Reaching Correct: 1 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
// Assumed to exist and be imported: db, inventoryService, logger (optional)

// ---------- Config ----------
const STOCK_TIMEOUT_MS = 300;        // per-call budget for inventory service
const STOCK_CONCURRENCY = 20;        // cap in-flight calls to inventory service
const CATALOGUE_TTL_MS = 30_000;     // fresh window for the assembled response
const CATALOGUE_STALE_MS = 5 * 60_000; // serve-stale window if rebuild fails
const STOCK_CACHE_TTL_MS = 10_000;   // per-product stock cache
const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_OPEN_MS = 15_000;

// ---------- Types ----------
type StockStatus = "in_stock" | "low_stock" | "out_of_stock" | "unknown";

interface ProductDTO {
  id: string;
  name: string;
  slug: string;
  price: number;
  currency: string;
  imageUrl: string | null;
  stock: number | null;        // null when inventory is unavailable
  stockStatus: StockStatus;
}

interface CataloguePayload {
  products: ProductDTO[];
  stockDegraded: boolean;      // true if any stock value is unknown
  generatedAt: string;
}

// ---------- Helpers ----------
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Bounded-concurrency map so 1000 products don't become 1000 simultaneous calls.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
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

// Minimal circuit breaker: stop hammering a struggling inventory service.
const breaker = {
  failures: 0,
  openUntil: 0,
  isOpen(): boolean {
    return Date.now() < this.openUntil;
  },
  success(): void {
    this.failures = 0;
  },
  failure(): void {
    if (++this.failures >= BREAKER_FAILURE_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_OPEN_MS;
      this.failures = 0;
    }
  },
};

// Per-product stock cache (last known good, also used as fallback on failure).
const stockCache = new Map<string, { value: number; at: number }>();

async function getStockSafe(productId: string): Promise<number | null> {
  const cached = stockCache.get(productId);
  if (cached && Date.now() - cached.at < STOCK_CACHE_TTL_MS) return cached.value;

  if (breaker.isOpen()) return cached?.value ?? null;

  try {
    const raw = await withTimeout(inventoryService.getStock(productId), STOCK_TIMEOUT_MS);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error("invalid stock value");
    stockCache.set(productId, { value: n, at: Date.now() });
    breaker.success();
    return n;
  } catch (err) {
    breaker.failure();
    // Fall back to last known value (possibly stale) rather than failing the page.
    return cached?.value ?? null;
  }
}

function stockStatus(stock: number | null): StockStatus {
  if (stock === null) return "unknown";
  if (stock <= 0) return "out_of_stock";
  if (stock <= 5) return "low_stock";
  return "in_stock";
}

// Explicit allow-list mapping: never leak internal columns (cost, supplier, flags...).
function toDTO(row: any, stock: number | null): ProductDTO {
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    price: row.price,
    currency: row.currency ?? "USD",
    imageUrl: row.imageUrl ?? null,
    stock,
    stockStatus: stockStatus(stock),
  };
}

async function buildCatalogue(): Promise<CataloguePayload> {
  const rows = (await db.products.findAll()) as any[];
  // Only list products meant to be shown on the storefront.
  const visible = rows.filter((r) => r.isActive !== false && r.isPublished !== false);

  const stocks = await mapLimit(visible, STOCK_CONCURRENCY, (r) =>
    getStockSafe(String(r.id))
  );

  const products = visible.map((r, i) => toDTO(r, stocks[i]));
  return {
    products,
    stockDegraded: stocks.some((s) => s === null),
    generatedAt: new Date().toISOString(),
  };
}

// ---------- Response cache with single-flight + stale-on-error ----------
let cache: { payload: CataloguePayload; at: number } | null = null;
let inflight: Promise<CataloguePayload> | null = null;

async function getCatalogue(): Promise<CataloguePayload> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < CATALOGUE_TTL_MS) return cache.payload;

  // Single-flight: concurrent requests share one rebuild (no stampede on DB/inventory).
  if (!inflight) {
    inflight = buildCatalogue()
      .then((payload) => {
        // Don't cache a heavily degraded result for the full TTL.
        cache = { payload, at: payload.stockDegraded ? Date.now() - CATALOGUE_TTL_MS + 3_000 : Date.now() };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }

  try {
    return await inflight;
  } catch (err) {
    // DB failure etc: serve stale copy if we have a reasonably recent one.
    if (cache && Date.now() - cache.at < CATALOGUE_STALE_MS) return cache.payload;
    throw err;
  }
}

// ---------- Handler ----------
export async function getProducts(req: Request, res: Response): Promise<void> {
  try {
    const payload = await getCatalogue();
    res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
    res.status(200).json(payload);
  } catch (err) {
    logger?.error?.({ err, route: "GET /products" }, "failed to build catalogue");
    // Generic message: never leak internals to clients.
    res.status(503).set("Retry-After", "5").json({
      error: "catalogue_unavailable",
      message: "Products are temporarily unavailable. Please try again shortly.",
    });
  }
}

// app.get("/products", getProducts);
```

**Production concerns I addressed**

- Inventory slowness: per-call timeout (300ms), so one slow service call cannot hang the homepage.
- Graceful degradation: if stock cannot be fetched, the product is still returned with `stock: null`, `stockStatus: "unknown"`, and a `stockDegraded` flag, rather than failing the whole request. The last known stock value is used as a fallback when available.
- N+1 fan-out: stock lookups run in parallel with a concurrency cap (20), so there is neither a sequential waterfall nor an unbounded burst against the inventory service.
- Circuit breaker: after repeated failures, calls to inventory are skipped for 15s so a struggling service is not hammered and latency stays low.
- High traffic: assembled catalogue cached in-process (30s) with single-flight rebuilds, so a cache expiry under load triggers one DB and inventory pass, not thousands. Per-product stock cache (10s) cuts repeat calls.
- Stale-on-error: if the DB or rebuild fails, a recent cached catalogue (up to 5 min old) is served instead of an error.
- Degraded results are cached only briefly so recovery is quick.
- Data exposure: explicit allow-list DTO mapping, so internal fields (costs, supplier data, flags) never reach the client; unpublished/inactive products are filtered out.
- Input validation of upstream data: stock values are checked as finite non-negative numbers; malformed values are treated as unavailable.
- HTTP caching: `Cache-Control` with `stale-while-revalidate` so CDN and browsers absorb most homepage traffic.
- Error handling: failures are logged with context server-side; clients get a generic 503 with `Retry-After`, no stack traces or internals.
- Known limits and next steps: the in-process caches are per-instance (move to Redis for shared state if instance counts are large); a batch `getStocks(ids)` endpoint on the inventory service would be better than per-product calls; pagination should be added if the catalogue grows beyond a few hundred items; add metrics for breaker state, cache hit rate, and degraded-response rate.
````
