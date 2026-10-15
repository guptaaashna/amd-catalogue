# Product Catalogue Fixer API

REST API built with Node.js, Express, TypeScript, Prisma 6, and PostgreSQL. AI suggestions are stored and reviewed locally; there is no external AI integration.

## Requirements and setup

- Node.js 20+
- PostgreSQL 14+ with a database named `catalogue_db`

From this directory:

```powershell
npm install
Copy-Item .env.example .env
```

Set `DATABASE_URL` in `.env` to the PostgreSQL connection string for `catalogue_db`. The default example assumes a local `postgres` account; replace `YOUR_PASSWORD` locally. Do not commit `.env`.

```powershell
npm run db:deploy
npm run db:seed
npm run dev
```

The API defaults to `http://localhost:4000`. Configure `PORT` and comma-separated `CORS_ORIGINS` in `.env`; the defaults allow React development servers on ports 5173 and 3000. Requests may include `x-actor` to identify an audit-log actor. There is no authentication layer.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the TypeScript server with reload |
| `npm run build` | Generate Prisma Client and compile TypeScript |
| `npm start` | Run the compiled server |
| `npm test` | Create/reuse isolated `catalogue_test_db`, apply pending migrations, then run Vitest unit and PostgreSQL integration tests |
| `npm run db:migrate` | Create/apply a development migration |
| `npm run db:deploy` | Apply checked-in migrations |
| `npm run db:seed` | Insert idempotent sample vendor/products |
| `npm run db:studio` | Open Prisma Studio |

## API

All endpoints are under `/api`. JSON validation errors return `400`, conflicts return `409`, and responses use JSON except CSV export.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Service status (`/api/health`) |
| `GET, POST /vendors` | Paginated vendor list; create vendor |
| `GET, PATCH, DELETE /vendors/:id` | Read/update/delete vendor |
| `GET, POST /products` | Paginated product list/create |
| `GET, PATCH, DELETE /products/:id` | Read/update/delete product |
| `GET /products/export.csv` | Export products using list filters |
| `POST /imports` | Multipart CSV import (`vendorId`, `file`); duplicates/invalid rows are reported, never overwrite products |
| `GET /imports` | Paginated imports; optional `vendorId` |
| `GET /imports/:id/original-rows` | Paginated, immutable original import rows and row errors |
| `GET /products/:id/translations` | List product translations |
| `PUT /products/:id/translations/:locale` | Upsert a translation |
| `DELETE /products/:id/translations/:locale` | Delete a translation |
| `GET /suggestions` | Paginated suggestions; optional `status=PENDING\|APPROVED\|REJECTED` |
| `POST /suggestions` | Record a proposed product-field change (no AI call) |
| `POST /suggestions/:id/approve` | Apply the validated proposal and audit it in one transaction |
| `POST /suggestions/:id/reject` | Reject and audit in one transaction |
| `GET /audit-logs` | Paginated audit history; optional `vendorId` and `productId` |

Product list filters: `search` (SKU/title/description/category), `vendorId`, `category`, `minPrice`, and `maxPrice`. Pagination uses `page` (default 1) and `pageSize` (default 20, max 100); list responses contain `data` and `pagination`. Product SKUs are unique within a vendor. Vendor deletion is blocked while dependent catalogue/import data exists; product deletion retains original import rows and audit history.

CSV imports require `sku,title,category,price`; optional columns are `description,currency,attributes` (`attributes` is a JSON object). Each source row is saved, including invalid rows, so import originals are retained for review. The CSV export includes `vendorId` and is accepted by the importer.

## Postman and tests

Import `postman/Product-Catalogue-Fixer.postman_collection.json` into Postman. Set its IDs after creating sample records. `npm test` uses the PostgreSQL credentials in `.env` to create `catalogue_test_db` if missing and applies pending migrations without resetting either database. The configured account needs permission to create databases when the test database is first provisioned. Integration tests verify the live port-4000 health endpoint and run all CRUD/import/export/suggestion checks against the separate test database; they clean up their uniquely scoped records afterward.
