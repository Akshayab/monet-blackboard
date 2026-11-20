import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to a Postgres connection string.");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/** Applies any pending migrations from lib/db/migrations. Safe to run on every start. */
export async function runMigrations(migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}

export * from "./schema";
