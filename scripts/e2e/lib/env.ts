// Shared settings for the Monet Blackboard end-to-end suite.
//
// The suite runs against a server started in team mode with a pinned owner link, for example:
//   TEAM_MODE=1 OWNER_LINK_TOKEN=e2e-owner-token PORT=3000 pnpm start
// Most specs also pass in solo mode for the owner; specs that need guests skip themselves there.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Root of the monorepo (scripts/e2e/lib -> ../../..). */
export const REPO_ROOT = path.resolve(here, '../../..');
/** Where reports are written (ignored by git). */
export const REPORT_DIR = process.env.E2E_REPORT_DIR || path.join(REPO_ROOT, 'scripts/e2e/.report');

/** App under test. */
export const BASE_URL = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

/** The owner link token the server was started with (OWNER_LINK_TOKEN). */
export const OWNER_TOKEN = process.env.E2E_OWNER_TOKEN || 'e2e-owner-token';

/** True when the suite may seed the database directly (DATABASE_URL points at the server's database). */
export const IS_LOCAL_DEV = !!process.env.DATABASE_URL && /localhost|127\.0\.0\.1/.test(BASE_URL);

/** Chromium to use instead of Playwright's download (optional). */
export const CHROMIUM_PATH = process.env.E2E_CHROMIUM_PATH || undefined;

/** How long realtime changes may take to reach another client before a test fails. */
export const LIVE_TIMEOUT = Number(process.env.E2E_LIVE_TIMEOUT_MS || 5_000);
