// Local static file server for the committed explorer/ site.
// node: builtins only; binds 127.0.0.1; no directory listing.
// Usage: node tools/serve.mjs [port]   (default port 8080)
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'explorer');
const ROOT_REAL = await realpath(ROOT); // fail fast if explorer/ is missing

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const PLAIN = { 'content-type': 'text/plain; charset=utf-8' };

function parsePort(args) {
  if (args.length === 0) return DEFAULT_PORT;
  if (args.length !== 1 || !/^\d+$/.test(args[0])) return null;
  const port = Number(args[0]);
  return port >= 0 && port <= 65535 ? port : null;
}

// Resolve a request path to a real regular file inside the static root.
// Both the path itself and its symlink target must stay under ROOT.
// Returns null when the path escapes the root or does not exist.
async function resolveFile(pathname) {
  const candidate = path.resolve(ROOT, `.${pathname}`);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null;
  const real = await realpath(candidate).catch(() => null);
  if (real === null) return null;
  if (real !== ROOT_REAL && !real.startsWith(ROOT_REAL + path.sep)) return null;
  const info = await stat(real).catch(() => null);
  if (info === null || !info.isFile()) return null; // directories: no listing
  return { real, info };
}

function reply(res, status, message) {
  res.writeHead(status, PLAIN);
  res.end(`${status} ${message}\n`);
}

const port = parsePort(process.argv.slice(2));
if (port === null) {
  console.error('usage: node tools/serve.mjs [port]  (integer 0-65535, 0 = OS-assigned, default 8080)');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...PLAIN, allow: 'GET, HEAD' });
      res.end('405 Method Not Allowed\n');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
    } catch {
      reply(res, 400, 'Bad Request');
      return;
    }
    if (pathname.includes('\0')) {
      reply(res, 400, 'Bad Request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';

    const target = await resolveFile(pathname);
    if (target === null) {
      reply(res, 404, 'Not Found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(pathname).toLowerCase()] ?? 'application/octet-stream',
      'content-length': target.info.size,
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target.real).on('error', () => res.destroy()).pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500, PLAIN);
    res.end();
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : err.message);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`Serving ${ROOT} at http://${HOST}:${server.address().port}/`);
});
