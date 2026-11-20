// Checks the production page policy (apps/web/csp.ts) in Chromium: a sealed live-embed frame that tries
// to navigate itself to an outside site (location.href or a meta refresh) is blocked, while the embed runner and the
// supported video sites still load. The dev server sends no page CSP, so this loads the real policy string in a page.
//   pnpm --filter @monet/scripts exec tsx e2e/embed-csp-check.mjs
import { chromium } from '@playwright/test';

const { CONTENT_SECURITY_POLICY } = await import('../../apps/web/csp.ts');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  const hits = [];
  await page.route('https://**/*', (route) => {
    const u = new URL(route.request().url());
    hits.push(u.host + u.pathname);
    if (u.host === 'board.test' && u.pathname === '/board') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"></head><body>
<iframe sandbox="allow-scripts" src="/embed-frame.html?v=3"></iframe>
<iframe sandbox="allow-scripts" src="/embed-frame.html?v=3&refresh"></iframe>
<iframe src="https://www.youtube.com/embed/abc"></iframe>
<iframe src="https://player.vimeo.com/video/1"></iframe>
<iframe src="https://www.loom.com/embed/abc"></iframe>
<iframe src="https://not-allowed.example/page"></iframe>
</body></html>`,
      });
    }
    if (u.host === 'board.test' && u.pathname === '/embed-frame.html') {
      const leave = u.searchParams.has('refresh')
        ? `<meta http-equiv="refresh" content="0;url=https://example.com/refresh">`
        : `<script>setTimeout(function(){ location.href = 'https://example.com/href'; }, 100)</script>`;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><p>runner</p>${leave}` });
    }
    return route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' });
  });
  await page.goto('https://board.test/board');
  await page.waitForTimeout(2000);
  check('the embed runner loads', hits.filter((h) => h === 'board.test/embed-frame.html').length === 2, hits);
  check('location.href to an outside site is blocked', !hits.includes('example.com/href'), hits);
  check('a meta refresh to an outside site is blocked', !hits.includes('example.com/refresh'), hits);
  check(
    'YouTube, Vimeo and Loom embeds still load',
    ['www.youtube.com/embed/abc', 'player.vimeo.com/video/1', 'www.loom.com/embed/abc'].every((h) => hits.includes(h)),
    hits,
  );
  check("other sites can't be framed", !hits.includes('not-allowed.example/page'), hits);
  check('policy no longer allows every https frame', !/frame-src[^;]*\shttps:(\s|;|$)/.test(CONTENT_SECURITY_POLICY), CONTENT_SECURITY_POLICY);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
