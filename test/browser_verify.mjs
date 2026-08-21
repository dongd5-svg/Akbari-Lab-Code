import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.mat':'application/octet-stream',
  '.wasm':'application/wasm' };

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    const buf = await readFile(p.endsWith('/') ? join(p, 'index.html') : p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

console.log('\n=== test.html in a real browser ===');
await page.goto(`${base}/test.html`);
await page.waitForFunction('window.__verify !== undefined', null, { timeout: 90000 });
const v = await page.evaluate(() => window.__verify);
const rows = await page.$$eval('#out tr', (trs) => trs.map((t) => t.innerText.replace(/\t+/g, ' | ')).filter(Boolean));
rows.forEach((r) => console.log('  ' + r));
console.log(`\n  -> ${v.total} checks, ${v.fails} failed`);

await browser.close();
server.close();
if (errors.length) { console.log('\nconsole errors:'); errors.forEach((e) => console.log('  ' + e)); }
process.exit(v.fails === 0 ? 0 : 1);
