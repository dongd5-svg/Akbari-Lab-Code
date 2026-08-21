// Opens the pages the way David does: straight off disk, no server.
import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));

let fail = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}${x ? '  ' + x : ''}`); if (!c) fail++; };

console.log('\n=== file:// test.html ===');
await page.goto('file://' + join(ROOT, 'test.html'));
await page.waitForFunction('window.__verify !== undefined', null, { timeout: 90000 });
const v = await page.evaluate(() => window.__verify);
console.log((await page.$$eval('#out tr', (t) => t.map((r) => '  ' + r.innerText.replace(/\t+/g, ' | ')))).join('\n'));
ok(v.fails === 0, `${v.total} numerical checks, ${v.fails} failed`);

console.log('\n=== file:// index.html ===');
await page.goto('file://' + join(ROOT, 'index.html'));
await page.waitForTimeout(600);
ok(await page.evaluate(() => typeof window.AK?.analyze === 'function'), 'scripts loaded from disk');

await page.setInputFiles('#picker', [
  join(ROOT, 'test/matfiles/Subject 101_Baseline.mat'),
  join(ROOT, 'test/matfiles/Subject 101_roi.mat'),
]);
await page.waitForFunction(() => document.querySelectorAll('#fileTable tr').length >= 3, null, { timeout: 60000 });
const kinds = await page.$$eval('#fileTable tr td:nth-child(2)', (t) => t.map((x) => x.innerText.trim()));
ok(kinds.includes('flow') && kinds.includes('haemoglobin'), 'both .mat files read from disk', kinds.join(' / '));

await page.click('#run');
await page.waitForFunction(() => document.querySelectorAll('#summary tr').length > 1, null, { timeout: 60000 });
const row = await page.$$eval('#summary tr:nth-child(2) td', (t) => t.map((x) => x.innerText.trim()));
ok(row.length >= 6, 'results table filled', row.join(' | '));
await page.waitForSelector('#chartsPanel:not(.hide)');
ok((await page.$$('#charts canvas')).length >= 2, 'plots drawn');

await page.screenshot({ path: 'test/shot_file.png', fullPage: true });
await page.click('#theme');
await page.waitForTimeout(300);
await page.screenshot({ path: 'test/shot_file_dark.png', fullPage: true });

await browser.close();
const real = errs.filter((e) => !/favicon|404/i.test(e));
if (real.length) { console.log('\nconsole errors:'); real.slice(0, 6).forEach((e) => console.log('  ' + e)); fail += real.length; }
console.log(fail === 0 ? '\nWORKS FROM DISK\n' : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
