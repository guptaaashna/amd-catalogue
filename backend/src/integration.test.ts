import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./app";
import { prisma } from "./lib/prisma";

const testDatabaseName = "catalogue_test_db";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) !== testDatabaseName) {
  throw new Error("Integration tests require DATABASE_URL to point to catalogue_test_db");
}

const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const vendorSlug = `vitest-${runId}`;
let apiUrl: string;
let vendorId: string;
let fixtureProductId: string;
let server: ReturnType<typeof app.listen>;

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function createProduct(sku: string, overrides: Record<string, unknown> = {}) {
  return fetch(`${apiUrl}/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vendorId,
      sku,
      title: `Fixture ${runId}`,
      description: "vitest integration",
      category: `Integration-${runId}`,
      price: 18.25,
      currency: "USD",
      attributes: { suite: "vitest" },
      ...overrides,
    }),
  });
}

describe("PostgreSQL-backed catalogue API", () => {
  beforeAll(async () => {
    const database = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()::text AS current_database`;
    expect(database[0]?.current_database).toBe(testDatabaseName);

    server = app.listen(0);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    apiUrl = `http://127.0.0.1:${address.port}/api`;

    const liveHealthUrl = process.env.API_BASE_URL;
    expect(liveHealthUrl).toBe("http://localhost:4000/api");
    const liveHealth = await fetch(`${liveHealthUrl}/health`);
    expect(liveHealth.status).toBe(200);
    expect(await json<{ status: string }>(liveHealth)).toEqual({ status: "ok" });

    const vendorResponse = await fetch(`${apiUrl}/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vitest Fixture", slug: vendorSlug, email: "vitest@example.test" }),
    });
    expect(vendorResponse.status).toBe(201);
    const vendor = await json<{ id: string }>(vendorResponse);
    vendorId = vendor.id;

    const productResponse = await createProduct(`fixture-${runId}`);
    expect(productResponse.status).toBe(201);
    fixtureProductId = (await json<{ id: string }>(productResponse)).id;
  }, 30_000);

  afterAll(async () => {
    if (vendorId) {
      await prisma.$transaction(async (tx) => {
        await tx.auditLog.deleteMany({ where: { vendorId } });
        await tx.import.deleteMany({ where: { vendorId } });
        await tx.product.deleteMany({ where: { vendorId } });
        await tx.vendor.deleteMany({ where: { id: vendorId } });
      });
    }
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    await prisma.$disconnect();
  }, 30_000);

  it("performs vendor create, read, update, and delete", async () => {
    const read = await fetch(`${apiUrl}/vendors/${vendorId}`);
    expect(read.status).toBe(200);
    expect((await json<{ slug: string }>(read)).slug).toBe(vendorSlug);

    const updated = await fetch(`${apiUrl}/vendors/${vendorId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vitest Fixture Updated" }),
    });
    expect(updated.status).toBe(200);
    expect((await json<{ name: string }>(updated)).name).toBe("Vitest Fixture Updated");

    const disposableActor = `vitest-${runId}`;
    const disposableVendor = await fetch(`${apiUrl}/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-actor": disposableActor },
      body: JSON.stringify({ name: "Disposable", slug: `delete-${runId}` }),
    });
    const disposable = await json<{ id: string }>(disposableVendor);
    expect((await fetch(`${apiUrl}/vendors/${disposable.id}`, {
      method: "DELETE",
      headers: { "x-actor": disposableActor },
    })).status).toBe(204);
    expect((await fetch(`${apiUrl}/vendors/${disposable.id}`)).status).toBe(404);
    await prisma.auditLog.deleteMany({ where: { actor: disposableActor } });
  });

  it("performs product CRUD and persists updates", async () => {
    const created = await createProduct(`crud-${runId}`, { title: "Before update" });
    expect(created.status).toBe(201);
    const product = await json<{ id: string }>(created);

    const read = await fetch(`${apiUrl}/products/${product.id}`);
    expect((await json<{ title: string }>(read)).title).toBe("Before update");

    const updated = await fetch(`${apiUrl}/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "After update", price: 23.5 }),
    });
    expect(updated.status).toBe(200);
    const persisted = await fetch(`${apiUrl}/products/${product.id}`);
    const productData = await json<{ title: string; price: string }>(persisted);
    expect(productData.title).toBe("After update");
    expect(Number(productData.price)).toBe(23.5);

    expect((await fetch(`${apiUrl}/products/${product.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${apiUrl}/products/${product.id}`)).status).toBe(404);
  });

  it("filters, searches, paginates products, and validates query filters", async () => {
    const response = await fetch(
      `${apiUrl}/products?vendorId=${vendorId}&category=Integration-${runId}&search=fixture-${runId}&minPrice=10&maxPrice=20&page=1&pageSize=1`,
    );
    expect(response.status).toBe(200);
    const listing = await json<{ data: Array<{ id: string }>; pagination: { total: number; page: number; pageSize: number } }>(response);
    expect(listing.data.map((item) => item.id)).toContain(fixtureProductId);
    expect(listing.pagination).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect((await fetch(`${apiUrl}/products?minPrice=20&maxPrice=10`)).status).toBe(400);
    expect((await fetch(`${apiUrl}/products?vendorId=not-a-uuid`)).status).toBe(400);
  });

  it("rejects invalid vendor and product input", async () => {
    const badVendor = await fetch(`${apiUrl}/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Slug", slug: "bad slug" }),
    });
    expect(badVendor.status).toBe(400);

    const badProduct = await createProduct(`bad-${runId}`, { price: -1 });
    expect(badProduct.status).toBe(400);
    expect((await fetch(`${apiUrl}/products/not-a-uuid`)).status).toBe(400);
  });

  it("imports CSV rows without losing originals and exports products", async () => {
    const csv = [
      "sku,title,description,category,price,currency,attributes",
      `csv-${runId},Imported item,source description,CSV-${runId},12.5,USD,"{""color"":""blue""}"`,
      `invalid-${runId},Broken item,,CSV-${runId},not-a-price,USD,{}`,
      `fixture-${runId},Duplicate item,,CSV-${runId},12.5,USD,{}`,
    ].join("\n");
    const form = new FormData();
    form.append("vendorId", vendorId);
    form.append("file", new Blob([csv], { type: "text/csv" }), "products.csv");
    const response = await fetch(`${apiUrl}/imports`, { method: "POST", body: form });
    expect(response.status).toBe(201);
    const imported = await json<{ id: string; rowCount: number; errorCount: number; rowErrors: Array<unknown> }>(response);
    expect(imported).toMatchObject({ rowCount: 3, errorCount: 2 });
    expect(imported.rowErrors).toHaveLength(2);

    const originalRows = await fetch(`${apiUrl}/imports/${imported.id}/original-rows`);
    const originals = await json<{ data: Array<{ rawData: { sku: string }; error: string | null }>; pagination: { total: number } }>(originalRows);
    expect(originals.pagination.total).toBe(3);
    expect(originals.data[1].rawData.sku).toBe(`invalid-${runId}`);
    expect(originals.data[1].error).toContain("price");

    const exported = await fetch(`${apiUrl}/products/export.csv?vendorId=${vendorId}`);
    expect(exported.status).toBe(200);
    const exportCsv = await exported.text();
    expect(exportCsv).toContain(`csv-${runId}`);
    expect(exportCsv).toContain(`fixture-${runId}`);
  });

  it("approves suggestions transactionally and rejects suggestions without changing products", async () => {
    const approvedResponse = await fetch(`${apiUrl}/suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: fixtureProductId, field: "title", proposedValue: "Approved title" }),
    });
    expect(approvedResponse.status).toBe(201);
    const approvedSuggestion = await json<{ id: string }>(approvedResponse);
    const approval = await fetch(`${apiUrl}/suggestions/${approvedSuggestion.id}/approve`, { method: "POST" });
    expect(approval.status).toBe(200);
    expect((await json<{ product: { title: string }; suggestion: { status: string } }>(approval))).toMatchObject({
      product: { title: "Approved title" },
      suggestion: { status: "APPROVED" },
    });

    const rejectedResponse = await fetch(`${apiUrl}/suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: fixtureProductId, field: "title", proposedValue: "Rejected title" }),
    });
    const rejectedSuggestion = await json<{ id: string }>(rejectedResponse);
    const rejection = await fetch(`${apiUrl}/suggestions/${rejectedSuggestion.id}/reject`, { method: "POST" });
    expect(rejection.status).toBe(200);
    expect((await json<{ status: string }>(rejection)).status).toBe("REJECTED");
    const product = await fetch(`${apiUrl}/products/${fixtureProductId}`);
    expect((await json<{ title: string }>(product)).title).toBe("Approved title");

    const invalidSuggestion = await fetch(`${apiUrl}/suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: fixtureProductId, field: "price", proposedValue: -5 }),
    });
    expect(invalidSuggestion.status).toBe(400);
  });
});
