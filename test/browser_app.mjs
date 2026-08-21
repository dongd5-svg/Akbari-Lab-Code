import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css',
               '.json':'application/json','.mat':'application/octet-stream' };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    const buf = await readFile(p.endsWith('/') ? join(p,'index.html') : p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const M = (f) => join(ROOT, 'test/matfiles', f);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errs = [];
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(String(e)));

let fail = 0;
const ok = (c, m, extra='') => { console.log(`  ${c?'PASS':'FAIL'}  ${m}${extra?'  — '+extra:''}`); if(!c) fail++; };

await page.goto(`${base}/index.html`);
console.log('\n=== App UI ===');

// --- 1. one LSI + one SFDI ---
await page.setInputFiles('#picker', [M('Subject 101_Baseline.mat'), M('Subject 101_roi.mat')]);
await page.waitForSelector('#settingsPanel:not(.hide)', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('#fileTable tr').length >= 3, null, {timeout:30000});
const tags = await page.$$eval('#fileTable tr td:nth-child(2)', els => els.map(e => e.textContent.trim()));
ok(tags.includes('flow') && tags.includes('haemoglobin'), 'both file types detected', tags.join(' / '));
ok((await page.textContent('#runStatus')).includes('with haemoglobin'), 'pairing recognised', await page.textContent('#runStatus'));

await page.click('#run');
await page.waitForSelector('#resultsPanel:not(.hide)', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('#summary tr').length > 1, null, {timeout:30000});
const hdr = await page.$$eval('#summary tr:first-child th', e => e.map(x=>x.textContent.trim()));
const row = await page.$$eval('#summary tr:nth-child(2) td', e => e.map(x=>x.textContent.trim()));
ok(row.length === hdr.length, 'summary table rendered', row.join(' | '));
ok(row[hdr.indexOf('CMRO2')] === 'yes', 'oxygen computed');
ok(Math.abs(parseFloat(row[hdr.indexOf('rCBF')]) - 1.0) < 0.25,
   'mean rCBF is plausible', row[hdr.indexOf('rCBF')]);

await page.waitForSelector('#chartsPanel:not(.hide)');
ok((await page.$$('#charts canvas')).length >= 2, 'charts drawn',
   `${(await page.$$('#charts canvas')).length} canvases`);

// metric tabs
const metricTabs = await page.$$eval('#metricTabs button', b => b.map(x=>x.textContent.trim()));
ok(metricTabs.length === 4, 'all metric tabs present', metricTabs.join(', '));
await page.click('#metricTabs button:nth-child(3)');   // Absolute values
await page.waitForTimeout(400);
ok((await page.$$('#charts canvas')).length >= 3, 'absolute-value charts render');

await page.screenshot({ path: 'test/shot_results.png', fullPage: true });

// --- 2. flow-only animal added ---
await page.setInputFiles('#picker', [M('Subject 102_Baseline_LSI.mat')]);
await page.waitForFunction(() => document.querySelectorAll('#fileTable tr').length >= 4, null, {timeout:30000});
await page.click('#run');
await page.waitForFunction(() => document.querySelectorAll('#summary tr').length >= 3, null, {timeout:30000});
const rows2 = await page.$$eval('#summary tr', tr => tr.slice(1).map(r => [...r.querySelectorAll('td')].map(c=>c.textContent.trim())));
ok(rows2.length === 2, 'two animals analysed', `${rows2.length}`);
const oxCol = hdr.indexOf('CMRO2');
ok(rows2.some(r => r[oxCol]==='yes') && rows2.some(r => r[oxCol]==='no'),
   'one with oxygen, one flow-only', rows2.map(r=>`${r[0]}:${r[oxCol]}`).join(' '));
ok((await page.textContent('#resultMsgs')).toLowerCase().includes('haemoglobin'),
   'warns about the animal missing SFDI');

// --- 3. a junk file is rejected clearly ---
await page.setInputFiles('#picker', [M('sample_types_v7.mat')]);
await page.waitForFunction(() => [...document.querySelectorAll('#fileTable tr td:nth-child(2)')].some(t=>t.textContent.includes('not usable')), null, {timeout:30000});
ok(true, 'unusable file flagged rather than crashing');

// --- 4. CSV download ---
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlCsv')]);
const csvPath = await dl.path();
const csv = await readFile(csvPath, 'utf8');
ok(csv.split('\n').length >= 3 && csv.includes('Animal'), 'CSV downloads with data',
   csv.split('\n')[0].slice(0, 60));

// --- 5. dark mode ---
await page.click('#theme');
await page.waitForTimeout(300);
ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme') !== null), 'theme toggle works');
await page.screenshot({ path: 'test/shot_dark.png', fullPage: true });

await browser.close(); server.close();
const real = errs.filter(e => !/favicon|404/i.test(e));
if (real.length) { console.log('\nconsole errors:'); real.slice(0,8).forEach(e=>console.log('  '+e)); fail += real.length; }
console.log(fail === 0 ? '\nALL UI CHECKS PASSED\n' : `\n${fail} UI CHECK(S) FAILED\n`);
process.exit(fail ? 1 : 0);
