/**
 * Serves panel/ as a static site for local use.
 *
 * Zero dependencies (just node:http + node:fs) so `npm run panel` works out of
 * the box. CORS is enabled so the wizard's in-browser LM Studio probe
 * (`GET /v1/models`) succeeds when you've started the server with `lms server
 * start --cors`.
 *
 * Usage: node scripts/serve-panel.js [port]
 */
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join, normalize, extname } = require('node:path');

const ROOT = join(__dirname, '..', 'panel');
const PORT = Number(process.argv[2]) || 8877;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

createServer(async (req, res) => {
  // CORS so the browser can probe a localhost LM Studio instance.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Strip query string and prevent path traversal.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, safe === '/' || safe === '' ? 'index.html' : safe);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`PR Risk Reviewer setup wizard: http://localhost:${PORT}`);
});
