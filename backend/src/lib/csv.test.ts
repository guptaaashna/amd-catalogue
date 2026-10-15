import assert from "node:assert/strict";
import test from "node:test";
import { csvProductSchema, parseAttributes, parseProductCsv } from "./csv";

test("parses normalized CSV headers and preserves original values", () => {
  const parsed = parseProductCsv(" SKU ,Title,Category,Price\nA-1,Desk,Office,24.50\n");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].sku, "A-1");
  assert.equal(parsed.rows[0].price, "24.50");
});

test("rejects attributes that are not JSON objects", () => {
  assert.throws(() => parseAttributes("[1,2]"), /attributes must be a JSON object/);
});

test("reports malformed CSV attributes as validation errors", () => {
  const result = csvProductSchema.safeParse({
    sku: "A-1", title: "Desk", category: "Office", price: "10", attributes: "{bad json",
  });
  assert.equal(result.success, false);
});
