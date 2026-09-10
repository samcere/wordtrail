import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png' };
http.createServer((request, response) => { const raw = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); const relative = raw === '/' ? 'index.html' : raw.slice(1); const file = path.resolve(root, relative); if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end('Not found'); return; } response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(file).pipe(response); }).listen(Number(process.env.PORT || 4174), '127.0.0.1', () => console.log(`Wordtrail static test: http://127.0.0.1:${process.env.PORT || 4174}`));
