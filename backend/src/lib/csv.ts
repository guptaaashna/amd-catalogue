import Papa from "papaparse";
import { z } from "zod";

export const csvProductSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).optional().default(""),
  category: z.string().trim().min(1).max(200),
  price: z.coerce.number().finite().nonnegative().max(9999999999.99),
  currency: z.string().trim().length(3).optional().default("USD").transform((value) => value.toUpperCase()),
  attributes: z.string().optional().transform((value, context) => {
    try {
      return parseAttributes(value);
    } catch {
      context.addIssue({ code: "custom", message: "attributes must be a valid JSON object" });
      return z.NEVER;
    }
  }),
});

export function parseProductCsv(contents: string): { rows: Record<string, string>[]; errors: string[] } {
  const result = Papa.parse<Record<string, string>>(contents, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  });
  const errors = result.errors.map((error) => `CSV row ${(error.row ?? 0) + 2}: ${error.message}`);
  if (!result.meta.fields?.length || result.meta.fields.some((field) => !field)) {
    errors.push("CSV must include a header row");
  }
  return { rows: result.data, errors };
}

export function parseAttributes(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("attributes must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
