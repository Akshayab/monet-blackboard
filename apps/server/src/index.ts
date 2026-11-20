import { configErrors } from "./lib/config";

const errors = configErrors();
if (errors.length) {
  console.error("Monet Blackboard can't start:\n" + errors.map((e) => "  - " + e).join("\n") + "\nSee .env.example for every setting.");
  process.exit(1);
}

const path = await import("node:path");
const http = await import("node:http");
const { runMigrations } = await import("@monet/db");
await runMigrations(process.env.MONET_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "../../../lib/db/migrations"));

const { config } = await import("./lib/config");
const { logger } = await import("./lib/logger");
const { default: app } = await import("./app");
const { attachRealtime } = await import("./realtime/server");
const { flushAllRooms } = await import("./realtime/rooms");
const { deleteExpiredSessions, ensureOwner, ownerLinkToken, ownerLinkUrl } = await import("./lib/auth");
const { aiDescription } = await import("./ai/client");

await ensureOwner();

const server = http.createServer(app);
attachRealtime(server);

// Bound slow clients: headers within 20 s, whole request within 2 minutes (large image uploads included).
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;

const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

server.listen(config.port, config.host, async () => {
  const local = `http://localhost:${config.port}`;
  logger.info({ url: local, ai: config.mockAi ? "mock (AI_MOCK=1)" : aiDescription(), mode: config.teamMode ? "team" : "solo" }, "Monet Blackboard is running");
  if (!config.teamMode) {
    if (config.inContainer) logger.info("Running in a container. Solo mode answers only on localhost; docker-compose.yml publishes the port on 127.0.0.1.");
    else if (!isLoopback(config.host))
      logger.warn({ host: config.host }, "Solo mode only answers requests addressed to localhost. Set TEAM_MODE=1 to let other people in.");
    return;
  }
  const url = ownerLinkUrl(await ownerLinkToken());
  // Printed plainly (not through the JSON logger) so it's easy to copy. Anyone with this link becomes the owner.
  console.log(
    [
      "",
      "  Team mode is on. Open this link once to become the owner in your browser:",
      "",
      `    ${url}`,
      "",
      "  Keep it private: anyone with it can manage every board. Share boards from the board's Share button instead.",
      config.publicUrl ? "" : "  Tip: set PUBLIC_URL to the address your team uses, so this link points there.",
      "",
    ].join("\n"),
  );
});

// Expired sessions are rejected on use; this keeps the table from growing forever.
const sessionSweep = setInterval(
  () => {
    deleteExpiredSessions().catch((err) => logger.warn({ err }, "session sweep failed"));
  },
  60 * 60 * 1000,
);
sessionSweep.unref();

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down; saving open boards");
  try {
    await flushAllRooms();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
