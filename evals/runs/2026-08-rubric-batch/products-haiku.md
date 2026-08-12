# products — Haiku-class — baseline

- **Scenario:** [`../../scenarios/products.md`](../../scenarios/products.md), baseline prompt used verbatim
- **Model:** Claude Haiku-class, 2026-08-11
- **Condition:** baseline — no skill loaded
- **Record kind:** verbatim

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `getProducts` handler; no version. |
| **2. Feature flags** | Absent | No flag on the inventory fan-out. |
| **3. Circuit breaker** | Absent | Timeout only; a sustained inventory outage keeps generating doomed calls. |
| **4. Deadline on every I/O** | **Present** | `withTimeout(inventoryService.getStock(...), 2500)` — but `db.products.findAll()` and `db.products.count()` are unbounded. |
| **5. Off the request path** | n/a | Pure read. |
| **6. Business counters** | Absent | `console.warn` / `console.error` only. |
| **7. Tombstone-aware reads** | Absent | No `deleted_at` filter anywhere on the read. |
| *Degradation* (cut) | **Correct** | `stock: number \| null` with `stockStatus: 'unavailable'` — the degraded state stays distinguishable from `out_of_stock`. |
| *Field-limiting* (cut) | Correct | `attributes: ['id', 'name', 'description', 'price']` plus a `PublicProduct` mapper. |
| *Validation* (cut) | Correct | `page` / `pageSize` clamped to 1..100. |
| *Naming* (cut) | Correct | `withTimeout`, `PublicProduct`, `stockStatus`. |

**Reached Present or better: 1 of 6 applicable · Reached Correct: 0 of 6 applicable.**

## Notes

**Degradation scored Correct here — and Present-not-Correct on the earlier Haiku products run**, which collapsed a failed lookup into `stock: 0, inStock: false` and would have rendered the whole catalogue sold out during an inventory blip. Same model, same prompt, opposite correctness.

That variance is the single strongest argument for this directory existing. Presence-scoring reported "degradation: reflexive" for both runs and hid the difference entirely. It also means the smaller-model finding should be read as *unreliable*, not *absent*: Haiku sometimes gets degradation right, and you cannot tell which run you are getting.

## Verbatim output

````markdown
```typescript
import { Request, Response } from 'express';

// Types
interface ProductRow {
  id: string;
  name: string;
  description: string;
  price: number;
  // (internal fields like cost, supplierId not included in public response)
}

interface PublicProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number | null; // null if inventory service unavailable
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock' | 'unavailable';
}

interface GetProductsResponse {
  products: PublicProduct[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const INVENTORY_TIMEOUT_MS = 2500; // aggressive timeout; inventory service is slow
const LOW_STOCK_THRESHOLD = 5;

/**
 * Wraps a promise with a timeout. Returns null if timeout is exceeded.
 * Critical for preventing slow inventory service from blocking homepage.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

async function getProducts(req: Request, res: Response): Promise<void> {
  try {
    // Validate and parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    let pageSize = parseInt(req.query.pageSize as string, 10) || DEFAULT_PAGE_SIZE;
    pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));

    const offset = (page - 1) * pageSize;

    // Fetch products and count in parallel
    // Select only fields safe for public API, not internal fields like cost/supplier
    const [products, totalCount] = await Promise.all([
      db.products.findAll({
        limit: pageSize,
        offset,
        attributes: ['id', 'name', 'description', 'price'],
        order: [['createdAt', 'DESC']],
      }),
      db.products.count(),
    ]);

    // Early return for empty results
    if (products.length === 0) {
      res.json({
        products: [],
        pagination: { page, pageSize, total: totalCount, hasMore: false },
      } as GetProductsResponse);
      return;
    }

    // Fetch stock for all products in parallel with timeout
    // Do not wait for slow inventory service; degrade gracefully if it times out
    const stockResults = await Promise.all(
      products.map(product =>
        withTimeout(
          inventoryService.getStock(product.id)
            .catch(err => {
              // Inventory service threw; log but continue
              console.warn(`Stock fetch error for product ${product.id}:`, err);
              return null;
            }),
          INVENTORY_TIMEOUT_MS
        )
      )
    );

    // Map to public response format
    const publicProducts: PublicProduct[] = products.map((product, idx) => {
      const stock = stockResults[idx];

      // Determine display status based on stock availability
      let stockStatus: PublicProduct['stockStatus'];
      if (stock === null) {
        stockStatus = 'unavailable'; // inventory service failed or timed out
      } else if (stock <= 0) {
        stockStatus = 'out_of_stock';
      } else if (stock <= LOW_STOCK_THRESHOLD) {
        stockStatus = 'low_stock';
      } else {
        stockStatus = 'in_stock';
      }

      return {
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price,
        stock: stock === null ? null : stock,
        stockStatus,
      };
    });

    // Return paginated results
    res.json({
      products: publicProducts,
      pagination: {
        page,
        pageSize,
        total: totalCount,
        hasMore: offset + pageSize < totalCount,
      },
    } as GetProductsResponse);

  } catch (error) {
    // Log with context for production debugging
    console.error('GET /products failed:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });

    // Generic error response; do not expose internal details
    res.status(500).json({ error: 'Unable to fetch products' });
  }
}

export { getProducts };
```

## Production concerns I addressed

- **Graceful degradation**: If the inventory service times out or fails, the endpoint still returns products with `stock: null` and `stockStatus: unavailable`. Homepage stays up even when inventory is unreliable.
- **Parallelization with timeout**: Stock for all products fetches in parallel (no N+1 problem) with an aggressive 2.5s timeout per call, preventing one slow inventory call from blocking the entire response.
- **Field filtering**: Explicitly selects only public fields (`id`, `name`, `description`, `price`) from the database, preventing leakage of internal fields like cost or supplier IDs.
- **Input validation**: Page and pageSize are validated and clamped to safe ranges (1 minimum, 100 maximum) to prevent abuse.
- **Pagination**: Returns metadata (`hasMore`, `total`) to allow clients to implement pagination properly; prevents loading the entire catalogue in one request.
- **Error handling**: Catches errors at two levels (inventory service and request level) and logs context for debugging without exposing internals to clients.
- **Response consistency**: Structured response with a clear pagination envelope so clients know how to handle partial results and page size constraints.
- **Database efficiency**: Fetches product count and products in parallel; uses `attributes` to select only needed columns.
````
