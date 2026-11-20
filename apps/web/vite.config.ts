import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './csp';

const serverPort = Number(process.env.PORT ?? 3000);
const require = createRequire(import.meta.url);

/** Excalidraw's own font files (dist/prod/fonts), served from this app instead of a public CDN. */
function excalidrawFontsDir(): string {
  // The package's exports map hides package.json, so resolve its entry (dist/prod/index.js) and go from there.
  return path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
}

/**
 * Serves Excalidraw's fonts at /fonts/* in development and copies them into the build, so the canvas never
 * loads anything from esm.sh or unpkg (see localExcalidrawFallback for the URL Excalidraw falls back to).
 */
function localExcalidrawFonts(): Plugin {
  const src = excalidrawFontsDir();
  return {
    name: 'monet-excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        const file = path.normalize(path.join(src, rel));
        if (!file.startsWith(src + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'font/woff2');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      fs.cpSync(src, path.resolve(import.meta.dirname, 'dist/public/fonts'), { recursive: true });
    },
  };
}

// Excalidraw falls back to its fonts on esm.sh (a public CDN) for every font face. Point that fallback at this
// server instead, so the canvas never contacts a CDN. Applied to the production build and to Vite's dev pre-bundle.
const ESM_FALLBACK = /`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g;
const LOCAL_FALLBACK = '`${window.location.origin}/`';
const isExcalidraw = (id: string) => /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/.test(id);

function localExcalidrawFallback(): Plugin {
  return {
    name: 'monet-excalidraw-local-fallback',
    enforce: 'pre',
    transform(code, id) {
      if (!isExcalidraw(id) || !code.includes('https://esm.sh/')) return null;
      return { code: code.replace(ESM_FALLBACK, LOCAL_FALLBACK), map: null };
    },
  };
}

/** The production page's Content Security Policy (see csp.ts), shipped as a <meta> tag. */
function productionCsp(): Plugin {
  return {
    name: 'monet-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`);
    },
  };
}

export default defineConfig({
  base: '/',
  // Required by @excalidraw/excalidraw when bundled with Vite.
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  plugins: [productionCsp(), localExcalidrawFallback(), localExcalidrawFonts(), react(), tailwindcss()],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: 'monet-excalidraw-local-fallback',
          setup(build) {
            build.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/ }, (args) => {
              const code = fs.readFileSync(args.path, 'utf8');
              return code.includes('https://esm.sh/') ? { contents: code.replace(ESM_FALLBACK, LOCAL_FALLBACK), loader: 'js' } : undefined;
            });
          },
        },
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  // In development the web app runs on :5173 and forwards /api (and the board WebSocket) to the server.
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
    proxy: {
      '/api': { target: `http://127.0.0.1:${serverPort}`, ws: true, changeOrigin: false },
    },
    fs: { strict: true },
  },
});
