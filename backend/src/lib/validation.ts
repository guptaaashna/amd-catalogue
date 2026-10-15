import { z } from "zod";

export const idSchema = z.string().uuid();
export const vendorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  email: z.string().trim().email().max(320).nullable().optional(),
}).strict();

export const productSchema = z.object({
  vendorId: idSchema,
  sku: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).default(""),
  category: z.string().trim().min(1).max(200),
  price: z.coerce.number().finite().nonnegative().max(9999999999.99),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("USD"),
  attributes: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const productUpdateSchema = productSchema.omit({ vendorId: true }).partial().strict();
export const translationSchema = z.object({
  locale: z.string().trim().min(2).max(20).regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).default(""),
}).strict();

export const suggestionSchema = z.object({
  productId: idSchema,
  field: z.enum(["title", "description", "category", "price", "currency", "attributes"]),
  originalValue: z.unknown().optional(),
  proposedValue: z.unknown(),
  rationale: z.string().max(2000).optional(),
}).strict();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
