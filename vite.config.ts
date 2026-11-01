import { defineConfig } from 'vite';
import { appendFileSync, mkdirSync } from 'node:fs';

/** Recibe los registros de manejo del navegador (src/trace.ts) y los guarda en logs/<sesión>.jsonl, una línea por envío. */
const traceSink = () => ({
  name: 'trace-sink',
  configureServer(server: { middlewares: { use: (path: string, fn: (req: any, res: any) => void) => void } }) {
    mkdirSync('logs', { recursive: true });
    server.middlewares.use('/__log', (req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      req.on('end', () => {
        try { const o = JSON.parse(body); appendFileSync(`logs/${String(o.sid).replace(/[^a-z0-9]/gi, '')}.jsonl`, JSON.stringify(o) + '\n'); } catch { /* registro malo: se ignora */ }
        res.statusCode = 204; res.end();
      });
    });
  },
});

export default defineConfig({
  plugins: [traceSink()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
});
