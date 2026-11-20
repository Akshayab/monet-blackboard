import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests never touch a database. @monet/db needs a connection string to load, and its pool only connects on
    // the first query, so a placeholder is enough (and keeps a developer's real DATABASE_URL out of the tests).
    env: { DATABASE_URL: "postgres://unit-tests@127.0.0.1:1/none" },
  },
});
