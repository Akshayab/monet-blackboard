import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { config } from "./lib/config";
import { authMiddleware } from "./middlewares/authMiddleware";
import { requestContextMiddleware } from "./lib/request-context";
import { apiRateLimits, byUserOrIp, limiters, rateLimit } from "./middlewares/rate-limit";
import { jsonBody, jsonErrorHandler, logUrl, rejectNulInUrl, sameOriginGuard, securityHeaders, soloHostGuard, staticHeaders } from "./middlewares/security";

const app: Express = express();

// Behind a reverse proxy or tunnel (team mode), X-Forwarded-* from these addresses is trusted for the client IP and https.
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
app.use(soloHostGuard);
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => !(req.url ?? "").startsWith("/api/") },
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: logUrl(req.url) };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

const api = express.Router();
api.use(securityHeaders);
api.use(rejectNulInUrl);
// Per-IP flood limits and AI request limits run before any body is read.
api.use(apiRateLimits);
// CSRF: foreign Origin / non-JSON state-changing requests are rejected before parsing.
api.use(sameOriginGuard);
api.use(authMiddleware);
// Tiered body limits: 16 MB for board and AI routes (images as data URLs), 1 MB elsewhere, 32 KB without a session.
api.use(jsonBody);
api.use(requestContextMiddleware);

// Route-specific abuse limits (kept here so the route files stay focused on behaviour).
api.post("/api/boards", rateLimit(limiters.boardCreate, byUserOrIp, "You're creating boards too quickly. Try again later."));
api.post("/api/boards/:id/duplicate", rateLimit(limiters.boardCreate, byUserOrIp, "You're creating boards too quickly. Try again later."));
api.post("/api/boards/:id/files", rateLimit(limiters.fileUpload, byUserOrIp, "You're uploading files too quickly. Try again later."));
api.get("/api/share/:token", rateLimit(limiters.shareResolve));
api.use("/api", router);
api.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
api.use(jsonErrorHandler);

app.use((req, res, next) => (req.path === "/api" || req.path.startsWith("/api/") ? api(req, res, next) : next()));

// In production the server also serves the built web app (apps/web/dist/public).
const webDir = process.env.MONET_WEB_DIR ?? path.resolve(import.meta.dirname, "../../web/dist/public");
if (fs.existsSync(path.join(webDir, "index.html"))) {
  app.use(staticHeaders);
  app.use(
    express.static(webDir, {
      index: false,
      maxAge: "1h",
      setHeaders: (res, file) => file.includes(`${path.sep}assets${path.sep}`) && res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  );
  app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDir, "index.html"));
  });
}

export default app;
