// Renders og-image.html to apps/web/public/og-image.png (1200x630) and apple-touch-icon.html to
// apps/web/public/apple-touch-icon.png (180x180).
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '../../apps/web/public');
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });
for (const [src, out, width, height] of [
  ['og-image.html', 'og-image.png', 1200, 630],
  ['apple-touch-icon.html', 'apple-touch-icon.png', 180, 180],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto('file://' + path.join(here, src));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(pub, out) });
  await page.close();
}
await browser.close();
