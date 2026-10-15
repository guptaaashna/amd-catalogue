import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { csvProductSchema, parseAttributes, parseProductCsv } from "./csv";

describe("CSV helpers", () => {
  it("parses normalized headers and preserves source values", () => {
    const parsed = parseProductCsv(" SKU ,Title,Category,Price\nA-1,Desk,Office,24.50\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].sku).toBe("A-1");
    expect(parsed.rows[0].price).toBe("24.50");
  });

  it("rejects attributes that are not JSON objects", () => {
    expect(() => parseAttributes("[1,2]")).toThrow(/attributes must be a JSON object/);
  });

  it("reports malformed CSV attributes as validation errors", () => {
    const result = csvProductSchema.safeParse({
      sku: "A-1", title: "Desk", category: "Office", price: "10", attributes: "{bad json",
    });
    assert.equal(result.success, false);
  });
});
