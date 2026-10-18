import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler, type Request } from "express";
import multer from "multer";
import Papa from "papaparse";
import { Prisma, SuggestionStatus } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { actorFrom, HttpError, parseOrThrow, toJson, toJsonObject } from "./lib/http";
import { csvProductSchema, parseProductCsv } from "./lib/csv";
import {
  idSchema,
  paginationSchema,
  productSchema,
  productUpdateSchema,
  suggestionSchema,
  translationSchema,
  vendorSchema,
} from "./lib/validation";

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new HttpError(403, "Origin is not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_request, file, callback) {
    const isCsv = file.mimetype === "text/csv" || file.originalname.toLowerCase().endsWith(".csv");
    if (!isCsv) {
      callback(new HttpError(400, "Upload a CSV file"));
      return;
    }
    callback(null, true);
  },
});

function pageParameters(request: Request) {
  return parseOrThrow(paginationSchema, request.query);
}

function auditDetails(value: Record<string, unknown>): Prisma.InputJsonObject {
  return toJsonObject(value);
}

function productFilters(request: Request): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = {};
  if (typeof request.query.vendorId === "string") {
    where.vendorId = parseOrThrow(idSchema, request.query.vendorId);
  }
  if (typeof request.query.category === "string" && request.query.category.trim()) {
    where.category = { equals: request.query.category.trim(), mode: "insensitive" };
  }
  if (typeof request.query.search === "string" && request.query.search.trim()) {
    const search = request.query.search.trim();
    where.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
      { category: { contains: search, mode: "insensitive" } },
    ];
  }
  const minimum = request.query.minPrice === undefined ? undefined : Number(request.query.minPrice);
  const maximum = request.query.maxPrice === undefined ? undefined : Number(request.query.maxPrice);
  if ((minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0))
    || (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0))
    || (minimum !== undefined && maximum !== undefined && minimum > maximum)) {
    throw new HttpError(400, "Invalid price range");
  }
  if (minimum !== undefined || maximum !== undefined) {
    where.price = {
      ...(minimum !== undefined ? { gte: minimum } : {}),
      ...(maximum !== undefined ? { lte: maximum } : {}),
    };
  }
  return where;
}

function getProductId(request: Request): string {
  return parseOrThrow(idSchema, request.params.id);
}

function validateSuggestionValue(field: string, value: unknown): unknown {
  switch (field) {
    case "title": return parseOrThrow(productSchema.shape.title, value);
    case "description": return parseOrThrow(productSchema.shape.description, value);
    case "category": return parseOrThrow(productSchema.shape.category, value);
    case "price": return parseOrThrow(productSchema.shape.price, value);
    case "currency": return parseOrThrow(productSchema.shape.currency, value);
    case "attributes": return toJsonObject(value);
    default: throw new HttpError(400, "Suggestion field cannot be applied");
  }
}

function notFound(message: string): never {
  throw new HttpError(404, message);
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/vendors", async (request, response) => {
  const { page, pageSize } = pageParameters(request);
  const [items, total] = await Promise.all([
    prisma.vendor.findMany({ skip: (page - 1) * pageSize, take: pageSize, orderBy: { name: "asc" } }),
    prisma.vendor.count(),
  ]);
  response.json({ data: items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

app.post("/api/vendors", async (request, response) => {
  const input = parseOrThrow(vendorSchema, request.body);
  const vendor = await prisma.$transaction(async (tx) => {
    const created = await tx.vendor.create({ data: input });
    await tx.auditLog.create({
      data: { vendorId: created.id, action: "vendor.created", actor: actorFrom(request), details: auditDetails({ name: created.name, slug: created.slug }) },
    });
    return created;
  });
  response.status(201).json(vendor);
});

app.get("/api/vendors/:id", async (request, response) => {
  const vendor = await prisma.vendor.findUnique({ where: { id: getProductId(request) } });
  response.json(vendor ?? notFound("Vendor not found"));
});

app.patch("/api/vendors/:id", async (request, response) => {
  const id = getProductId(request);
  const input = parseOrThrow(vendorSchema.partial().strict(), request.body);
  if (Object.keys(input).length === 0) throw new HttpError(400, "At least one field is required");
  const vendor = await prisma.$transaction(async (tx) => {
    const updated = await tx.vendor.update({ where: { id }, data: input });
    await tx.auditLog.create({ data: { vendorId: id, action: "vendor.updated", actor: actorFrom(request), details: auditDetails(input) } });
    return updated;
  });
  response.json(vendor);
});

app.delete("/api/vendors/:id", async (request, response) => {
  const id = getProductId(request);
  await prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.findUnique({ where: { id } });
    if (!vendor) notFound("Vendor not found");
    await tx.auditLog.create({ data: { vendorId: id, action: "vendor.deleted", actor: actorFrom(request), details: auditDetails({ slug: vendor.slug }) } });
    await tx.vendor.delete({ where: { id } });
  });
  response.status(204).end();
});

app.get("/api/products", async (request, response) => {
  const { page, pageSize } = pageParameters(request);
  const where = productFilters(request);
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where, skip: (page - 1) * pageSize, take: pageSize,
      orderBy: { createdAt: "desc" }, include: { vendor: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.product.count({ where }),
  ]);
  response.json({ data: items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

app.post("/api/products", async (request, response) => {
  const input = parseOrThrow(productSchema, request.body);
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({ data: { ...input, attributes: toJsonObject(input.attributes) } });
    await tx.auditLog.create({
      data: { vendorId: created.vendorId, productId: created.id, action: "product.created", actor: actorFrom(request), details: auditDetails({ sku: created.sku }) },
    });
    return created;
  });
  response.status(201).json(product);
});

app.get("/api/products/export.csv", async (request, response) => {
  const products = await prisma.product.findMany({ where: productFilters(request), orderBy: { sku: "asc" } });
  const csv = Papa.unparse(products.map((product) => ({
    vendorId: product.vendorId, sku: product.sku, title: product.title, description: product.description,
    category: product.category, price: product.price.toString(), currency: product.currency,
    attributes: JSON.stringify(product.attributes),
  })));
  response.type("text/csv").attachment("products.csv").send(csv);
});

app.get("/api/products/:id", async (request, response) => {
  const product = await prisma.product.findUnique({
    where: { id: getProductId(request) }, include: { vendor: true, translations: true },
  });
  response.json(product ?? notFound("Product not found"));
});

app.patch("/api/products/:id", async (request, response) => {
  const id = getProductId(request);
  const input = parseOrThrow(productUpdateSchema, request.body);
  if (Object.keys(input).length === 0) throw new HttpError(400, "At least one field is required");
  const product = await prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } });
    if (!current) notFound("Product not found");
    const { attributes, ...scalarFields } = input;
    const updated = await tx.product.update({
      where: { id },
      data: { ...scalarFields, ...(attributes !== undefined ? { attributes: toJsonObject(attributes) } : {}) },
    });
    await tx.auditLog.create({
      data: {
        vendorId: current.vendorId, productId: id, action: "product.updated", actor: actorFrom(request),
        details: auditDetails({ before: { ...current, price: current.price.toString() }, after: input }),
      },
    });
    return updated;
  });
  response.json(product);
});

app.delete("/api/products/:id", async (request, response) => {
  const id = getProductId(request);
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id } });
    if (!product) notFound("Product not found");
    await tx.auditLog.create({
      data: { vendorId: product.vendorId, productId: id, action: "product.deleted", actor: actorFrom(request), details: auditDetails({ sku: product.sku, title: product.title }) },
    });
    await tx.product.delete({ where: { id } });
  });
  response.status(204).end();
});

app.post("/api/imports", upload.single("file"), async (request, response) => {
  if (!request.file) throw new HttpError(400, "A CSV file is required in the file field");
  const vendorId = parseOrThrow(idSchema, request.body.vendorId);
  const csv = parseProductCsv(request.file.buffer.toString("utf8"));
  if (csv.errors.some((error) => error.includes("CSV must include a header row"))) {
    throw new HttpError(400, "CSV must include a header row");
  }
  if (!csv.rows.length && !csv.errors.length) throw new HttpError(400, "CSV contains no product rows");

  const existing = await prisma.product.findMany({ where: { vendorId }, select: { sku: true } });
  const seenSkus = new Set(existing.map((product) => product.sku.toLowerCase()));
  const parsedRows = csv.rows.map((rawData, index) => {
    let product: ReturnType<typeof csvProductSchema.parse> | undefined;
    let error: string | undefined;
    const result = csvProductSchema.safeParse(rawData);
    if (!result.success) {
      error = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    } else {
      const normalizedSku = result.data.sku.toLowerCase();
      if (seenSkus.has(normalizedSku)) {
        error = `SKU ${result.data.sku} already exists for this vendor`;
      } else {
        product = result.data;
        seenSkus.add(normalizedSku);
      }
    }
    return { rawData: auditDetails(rawData), rowNumber: index + 2, product, error };
  });

  const importRecord = await prisma.$transaction(async (tx) => {
    const record = await tx.import.create({
      data: {
        vendorId, filename: request.file!.originalname, rowCount: csv.rows.length,
        errorCount: parsedRows.filter((row) => row.error).length + csv.errors.length,
        status: parsedRows.some((row) => row.error) || csv.errors.length ? "PARTIAL" : "COMPLETED",
      },
    });
    for (const row of parsedRows) {
      const product = row.product ? await tx.product.create({
        data: { vendorId, ...row.product, attributes: toJsonObject(row.product.attributes) },
      }) : undefined;
      await tx.importOriginalRow.create({
        data: { importId: record.id, rowNumber: row.rowNumber, rawData: row.rawData, error: row.error, productId: product?.id },
      });
      if (product) {
        await tx.auditLog.create({
          data: { vendorId, productId: product.id, importId: record.id, action: "product.imported", actor: actorFrom(request), details: auditDetails({ sku: product.sku }) },
        });
      }
    }
    await tx.auditLog.create({
      data: { vendorId, importId: record.id, action: "import.completed", actor: actorFrom(request), details: auditDetails({ rows: csv.rows.length, parseErrors: csv.errors }) },
    });
    return record;
  });
  response.status(201).json({ ...importRecord, parseErrors: csv.errors, rowErrors: parsedRows.filter((row) => row.error).map(({ rowNumber, error }) => ({ rowNumber, error })) });
});

app.get("/api/imports", async (request, response) => {
  const { page, pageSize } = pageParameters(request);
  const vendorId = request.query.vendorId === undefined ? undefined : parseOrThrow(idSchema, request.query.vendorId);
  const where: Prisma.ImportWhereInput = vendorId ? { vendorId } : {};
  const [data, total] = await Promise.all([
    prisma.import.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: "desc" } }),
    prisma.import.count({ where }),
  ]);
  response.json({ data, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

app.get("/api/imports/:id/original-rows", async (request, response) => {
  const importId = getProductId(request);
  const { page, pageSize } = pageParameters(request);
  const [data, total] = await Promise.all([
    prisma.importOriginalRow.findMany({ where: { importId }, skip: (page - 1) * pageSize, take: pageSize, orderBy: { rowNumber: "asc" } }),
    prisma.importOriginalRow.count({ where: { importId } }),
  ]);
  response.json({ data, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

app.get("/api/products/:id/translations", async (request, response) => {
  const productId = getProductId(request);
  response.json(await prisma.productTranslation.findMany({ where: { productId }, orderBy: { locale: "asc" } }));
});

app.put("/api/products/:id/translations/:locale", async (request, response) => {
  const productId = getProductId(request);
  const locale = parseOrThrow(translationSchema.shape.locale, request.params.locale);
  const input = parseOrThrow(translationSchema.omit({ locale: true }), request.body);
  const result = await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) notFound("Product not found");
    const translation = await tx.productTranslation.upsert({
      where: { productId_locale: { productId, locale } },
      create: { productId, locale, ...input },
      update: input,
    });
    await tx.auditLog.create({
      data: { vendorId: product.vendorId, productId, action: "translation.upserted", actor: actorFrom(request), details: auditDetails({ locale }) },
    });
    return translation;
  });
  response.json(result);
});

app.delete("/api/products/:id/translations/:locale", async (request, response) => {
  const productId = getProductId(request);
  const locale = parseOrThrow(translationSchema.shape.locale, request.params.locale);
  await prisma.$transaction(async (tx) => {
    const translation = await tx.productTranslation.findUnique({ where: { productId_locale: { productId, locale } }, include: { product: true } });
    if (!translation) notFound("Translation not found");
    await tx.productTranslation.delete({ where: { id: translation.id } });
    await tx.auditLog.create({
      data: { vendorId: translation.product.vendorId, productId, action: "translation.deleted", actor: actorFrom(request), details: auditDetails({ locale }) },
    });
  });
  response.status(204).end();
});

app.get("/api/suggestions", async (request, response) => {
  const { page, pageSize } = pageParameters(request);
  const status = request.query.status;
  if (status !== undefined && !Object.values(SuggestionStatus).includes(String(status) as SuggestionStatus)) {
    throw new HttpError(400, "status must be PENDING, APPROVED, or REJECTED");
  }
  const where: Prisma.AiSuggestionWhereInput = status ? { status: status as SuggestionStatus } : {};
  const [data, total] = await Promise.all([
    prisma.aiSuggestion.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: "desc" }, include: { product: true } }),
    prisma.aiSuggestion.count({ where }),
  ]);
  response.json({ data, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

app.post("/api/suggestions", async (request, response) => {
  const input = parseOrThrow(suggestionSchema, request.body);
  const proposedValue = validateSuggestionValue(input.field, input.proposedValue);
  const suggestion = await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) notFound("Product not found");
    const created = await tx.aiSuggestion.create({
      data: {
        productId: product.id, field: input.field,
        ...(input.originalValue !== undefined
          ? { originalValue: input.originalValue === null ? Prisma.JsonNull : toJson(input.originalValue) }
          : {}),
        proposedValue: toJson(proposedValue),
        rationale: input.rationale,
      },
    });
    await tx.auditLog.create({
      data: { vendorId: product.vendorId, productId: product.id, suggestionId: created.id, action: "suggestion.created", actor: actorFrom(request), details: auditDetails({ field: input.field }) },
    });
    return created;
  });
  response.status(201).json(suggestion);
});

app.post("/api/suggestions/:id/approve", async (request, response) => {
  const id = getProductId(request);
  const suggestion = await prisma.$transaction(async (tx) => {
    const pending = await tx.aiSuggestion.findUnique({ where: { id }, include: { product: true } });
    if (!pending) notFound("Suggestion not found");
    if (pending.status !== SuggestionStatus.PENDING) throw new HttpError(409, "Suggestion has already been reviewed");
    if (!pending.product) throw new HttpError(409, "Suggestion product no longer exists");
    const value: unknown = pending.proposedValue;
    const validatedValue = validateSuggestionValue(pending.field, value);
    const update: Prisma.ProductUpdateInput = { [pending.field]: validatedValue };
    const updatedProduct = await tx.product.update({ where: { id: pending.product.id }, data: update });
    const reviewed = await tx.aiSuggestion.update({
      where: { id }, data: { status: SuggestionStatus.APPROVED, reviewedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        vendorId: pending.product.vendorId, productId: pending.product.id, suggestionId: id,
        action: "suggestion.approved", actor: actorFrom(request),
        details: auditDetails({ field: pending.field, previousValue: pending.product[pending.field as keyof typeof pending.product], proposedValue: value }),
      },
    });
    return { suggestion: reviewed, product: updatedProduct };
  });
  response.json(suggestion);
});

app.post("/api/suggestions/:id/reject", async (request, response) => {
  const id = getProductId(request);
  const result = await prisma.$transaction(async (tx) => {
    const suggestion = await tx.aiSuggestion.findUnique({ where: { id }, include: { product: true } });
    if (!suggestion) notFound("Suggestion not found");
    if (suggestion.status !== SuggestionStatus.PENDING) throw new HttpError(409, "Suggestion has already been reviewed");
    const rejected = await tx.aiSuggestion.update({ where: { id }, data: { status: SuggestionStatus.REJECTED, reviewedAt: new Date() } });
    await tx.auditLog.create({
      data: {
        ...(suggestion.product ? { vendorId: suggestion.product.vendorId } : {}),
        productId: suggestion.productId, suggestionId: id,
        action: "suggestion.rejected", actor: actorFrom(request), details: auditDetails({ field: suggestion.field }),
      },
    });
    return rejected;
  });
  response.json(result);
});

app.get("/api/audit-logs", async (request, response) => {
  const { page, pageSize } = pageParameters(request);
  const vendorId = request.query.vendorId === undefined ? undefined : parseOrThrow(idSchema, request.query.vendorId);
  const productId = request.query.productId === undefined ? undefined : parseOrThrow(idSchema, request.query.productId);
  const where: Prisma.AuditLogWhereInput = {
    ...(vendorId ? { vendorId } : {}),
    ...(productId ? { productId } : {}),
  };
  const [data, total] = await Promise.all([
    prisma.auditLog.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: "desc" } }),
    prisma.auditLog.count({ where }),
  ]);
  response.json({ data, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      response.status(409).json({ error: "A record with these unique fields already exists" });
      return;
    }
    if (error.code === "P2003") {
      response.status(409).json({ error: "The record is referenced by existing catalogue data" });
      return;
    }
    if (error.code === "P2025") {
      response.status(404).json({ error: "Record not found" });
      return;
    }
  }
  if (error instanceof multer.MulterError) {
    response.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Invalid JSON request body" });
    return;
  }
  console.error("Unhandled request error", error);
  response.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);

export { app };