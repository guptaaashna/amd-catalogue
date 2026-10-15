import "dotenv/config";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "pg";

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL must be configured in backend/.env");

const testDatabaseName = "catalogue_test_db";
const testUrl = new URL(sourceUrl);
const configuredDatabaseName = decodeURIComponent(testUrl.pathname.replace(/^\//, ""));
if (configuredDatabaseName === testDatabaseName) {
  throw new Error("DATABASE_URL must point to the application database, not the test database");
}
testUrl.pathname = `/${testDatabaseName}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";

async function ensureTestDatabase(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [testDatabaseName],
    );
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${testDatabaseName}"`);
      console.log(`Created isolated test database ${testDatabaseName}.`);
    } else {
      console.log(`Using isolated test database ${testDatabaseName} without resetting it.`);
    }
  } finally {
    await admin.end();
  }

  const verify = new Client({ connectionString: testUrl.toString() });
  await verify.connect();
  try {
    const result = await verify.query<{ current_database: string }>("SELECT current_database()");
    if (result.rows[0]?.current_database !== testDatabaseName) {
      throw new Error("Connected database does not match the isolated test database");
    }
  } finally {
    await verify.end();
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

async function main(): Promise<void> {
  await ensureTestDatabase();
  const env = { ...process.env, DATABASE_URL: testUrl.toString() };
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  const vitestCli = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  run(process.execPath, [prismaCli, "migrate", "deploy"], env);
  run(process.execPath, [vitestCli, "run", "--config", "vitest.config.mts"], {
    ...env,
    API_BASE_URL: "http://localhost:4000/api",
  });
}

main().catch((error: unknown) => {
  console.error("Vitest integration run failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
