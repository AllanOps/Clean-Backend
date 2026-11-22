# products — Haiku 5.5 — baseline 2

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, smaller tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | No versioned route. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None. |
| **4. Deadline on every I/O** | Present | Inventory bounded at 250 ms; `await db.products.findAll()` unbounded. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Absent | Degradation is tallied into a log line (`timeouts, errors, invalid`), not a metric. |
| **7. Tombstone-aware reads** | Absent | `isValidRow` checks field shapes only. |
| *Field-limiting* (cut) | Present | Explicit projection. |
| *Degradation* (cut) | Correct | `stock: null, stockStatus: "unknown"`, plus `stockDegraded`. |

**Shipped habits reaching Present or better: 1 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";

// Assumed in scope per the spec: `db` (with db.products.findAll()),
// `inventoryService` (with getStock(productId)), and a structured `logger`
// (pino-style: logger.warn(fields, message)).

const STOCK_TIMEOUT_MS = 250;
const CACHE_FRESH_MS = 30_000;
const CACHE_DEGRADED_MS = 5_000;
const MAX_PRODUCTS = 500;

export interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  price: { amountMinor: number; currency: string };
  imageUrl: string | null;
  stock: number | null;
  stockStatus: "in_stock" | "out_of_stock" | "unknown";
}

export interface CatalogueResponse {
  products: StorefrontProduct[];
  stockDegraded: boolean;
}

// Only the fields the storefront renders. Rows are typed narrowly and mapped
// through an explicit projection so internal columns cannot leak to the client.
interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
}

type StockLookup =
  | { ok: true; stock: number }
  | { ok: false; reason: "timeout" | "error" | "invalid" };

function isValidStock(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidRow(row: ProductRow | null | undefined): row is ProductRow {
  return (
    row != null &&
    typeof row.id === "string" && row.id.length > 0 &&
    typeof row.name === "string" && row.name.length > 0 &&
    typeof row.slug === "string" && row.slug.length > 0 &&
    Number.isSafeInteger(row.priceMinor) && row.priceMinor >= 0 &&
    typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)
  );
}

// Bounded lookup: a slow inventory service cannot hold up the homepage.
// Any failure, timeout, or malformed answer becomes "stock unknown" for that
// product rather than an error for the whole page.
async function lookupStock(productId: string): Promise<StockLookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StockLookup>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "timeout" }),
      STOCK_TIMEOUT_MS,
    );
  });
  const call = Promise.resolve()
    .then(() => inventoryService.getStock(productId))
    .then<StockLookup>(
      (value) =>
        isValidStock(value)
          ? { ok: true, stock: value }
          : { ok: false, reason: "invalid" },
      () => ({ ok: false, reason: "error" }),
    );
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function buildCatalogue(): Promise<CatalogueResponse> {
  const rows = await db.products.findAll();

  const valid = rows.filter((row) => {
    if (isValidRow(row)) return true;
    logger.warn(
      { productId: (row as Partial<ProductRow> | null)?.id },
      "products: skipping malformed row",
    );
    return false;
  });

  if (valid.length > MAX_PRODUCTS) {
    logger.error(
      { count: valid.length, cap: MAX_PRODUCTS },
      "products: catalogue exceeds homepage cap, truncating",
    );
  }
  const page = valid.slice(0, MAX_PRODUCTS);

  const lookups = await Promise.all(page.map((row) => lookupStock(row.id)));

  let timeouts = 0;
  let errors = 0;
  let invalid = 0;

  const products = page.map((row, i): StorefrontProduct => {
    const lookup = lookups[i];
    const base = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      price: { amountMinor: row.priceMinor, currency: row.currency },
      imageUrl: row.imageUrl ?? null,
    };

    if (!lookup.ok) {
      if (lookup.reason === "timeout") timeouts++;
      else if (lookup.reason === "error") errors++;
      else invalid++;
      return { ...base, stock: null, stockStatus: "unknown" };
    }

    return {
      ...base,
      stock: lookup.stock,
      stockStatus: lookup.stock > 0 ? "in_stock" : "out_of_stock",
    };
  });

  const degradedCount = timeouts + errors + invalid;
  if (degradedCount > 0) {
    logger.warn(
      { timeouts, errors, invalid, total: page.length },
      "products: stock degraded for part of catalogue",
    );
  }

  return { products, stockDegraded: degradedCount > 0 };
}

// Short-lived cache plus single-flight: on a miss, one rebuild runs and all
// concurrent requests share it, so a homepage spike does not fan out into
// one DB query and N inventory calls per request.
let cache: { value: CatalogueResponse; expiresAt: number } | null = null;
let inflight: Promise<CatalogueResponse> | null = null;

function getCatalogue(): Promise<CatalogueResponse> {
  if (cache && cache.expiresAt > Date.now()) {
    return Promise.resolve(cache.value);
  }

  if (!inflight) {
    inflight = buildCatalogue()
      .then((value) => {
        cache = {
          value,
          expiresAt:
            Date.now() +
            (value.stockDegraded ? CACHE_DEGRADED_MS : CACHE_FRESH_MS),
        };
        return value;
      })
      .catch((err: unknown) => {
        if (cache) {
          // Serve the last good catalogue and back off before retrying.
          cache.expiresAt = Date.now() + CACHE_DEGRADED_MS;
          logger.warn({ err }, "products: rebuild failed, serving stale catalogue");
          return cache.value;
        }
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
  }

  return inflight;
}

export async function getProducts(req: Request, res: Response): Promise<void> {
  try {
    const catalogue = await getCatalogue();
    const maxAge = catalogue.stockDegraded
      ? CACHE_DEGRADED_MS / 1000
      : CACHE_FRESH_MS / 1000;
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
    res.status(200).json(catalogue);
  } catch (err) {
    logger.error(
      { err, requestId: req.id },
      "products: catalogue unavailable",
    );
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error: "catalogue_unavailable" });
  }
}
```

Production concerns I addressed

- **Response allowlist:** rows go through an explicit projection, so internal DB fields never reach the client.
- **Bounded inventory calls:** each `getStock` call has a 250 ms timeout, so a slow inventory service cannot slow the homepage beyond that.
- **Graceful stock degradation:** a timeout, thrown error, or malformed stock value marks that product `stockStatus: "unknown"` with `stock: null`. It is never reported as out of stock, and the page still renders. `stockDegraded` tells the client when this happened.
- **Stock validation:** only non-negative safe integers are accepted as stock counts.
- **Row validation:** malformed DB rows are skipped and logged rather than failing the whole page. Currency must be an ISO-style three-letter code.
- **Stampede protection:** a 30 s TTL cache with single-flight means concurrent misses share one rebuild.
- **Stale-on-error:** if a rebuild fails, the last good catalogue is served, and retries back off for 5 s.
- **Faster recovery:** degraded snapshots get a 5 s TTL, so the page catches up quickly once inventory recovers.
- **Error hygiene:** failures return a generic 503 with `Retry-After`. Details go only to structured logs, tagged with the request id.
- **Edge caching:** `Cache-Control` lets CDNs absorb most homepage traffic.
- **Size guard:** the response is capped at 500 products, with an error log when the cap is hit.
- **Open items:** `findAll()` is unbounded and should become a paginated or featured query once the catalogue grows. The per-product fan-out should become one batch stock call if the inventory service offers one.
````
