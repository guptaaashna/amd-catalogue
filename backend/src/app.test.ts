import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "./app";

describe("health endpoint", () => {
  const server = app.listen(0);

  afterAll(async () => {
    server.close();
    await once(server, "close");
  });

  it("reports service status", async () => {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    expect(address).not.toBeNull();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
