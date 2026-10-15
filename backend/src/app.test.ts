import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { app } from "./app";

test("health endpoint reports service status", async () => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
