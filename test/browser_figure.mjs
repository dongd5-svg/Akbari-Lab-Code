import { chromium } from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
const errs = [];
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(String(e)));
let fail = 0;
const ok = (c,m,x='') => { console.log(`  ${c?'PASS':'FAIL'}  ${m}${x?'  '+x:''}`); if(!c) fail++; };

await page.goto('file://' + join(ROOT, 'index.html'));
await page.setInputFiles('#picker', [
  join(ROOT,'test/matfiles/Subject 101_Baseline.mat'),
  join(ROOT,'test/matfiles/Subject 101_roi.mat')]);
await page.waitForFunction(() => document.querySelectorAll('#fileTable tr').length >= 3, null, {timeout:60000});
await page.click('#run');
await page.waitForSelector('#figPanel:not(.hide)', { timeout: 60000 });

console.log('\n=== publication figure ===');
const svg = await page.$eval('#figPreview svg', el => el.outerHTML);
ok(svg.startsWith('<svg'), 'SVG generated');
ok(/width="85mm"/.test(svg), 'exported at exactly 85 mm', (svg.match(/width="[^"]+"/)||[])[0]);
ok(/viewBox="0 0 85/.test(svg), 'viewBox in millimetre units');
ok(!/<image|base64/.test(svg), 'pure vector, no embedded bitmap');
ok((svg.match(/<text/g)||[]).length > 6, 'axis text is real text, not outlines',
   `${(svg.match(/<text/g)||[]).length} text elements`);
ok(/font-size="2.469"/.test(svg), '7 pt type (2.469 mm)');
const paths = (svg.match(/<path/g)||[]).length;
ok(paths > 4 && svg.length < 200000, 'path data decimated to a sane size',
   `${paths} paths, ${(svg.length/1024).toFixed(0)} kB`);

// panel selection
const btns = await page.$$eval('#figPanels button', b => b.map(x=>x.textContent.trim()));
ok(btns.length >= 6, 'panel choices offered', btns.join(', '));
await page.click('#figPanels button:nth-child(3)');   // add rCBF/rCMRO2 ratio
await page.waitForTimeout(300);
const svg2 = await page.$eval('#figPreview svg', el => el.outerHTML);
ok((svg2.match(/font-weight="bold"/g)||[]).length >= 3, 'panel letters A, B, C added');

// width preset
await page.selectOption('#figWidth', '170');
await page.waitForTimeout(300);
ok(/width="170mm"/.test(await page.$eval('#figPreview svg', e => e.outerHTML)), 'double column preset works');
await page.selectOption('#figWidth', '85');

// greyscale
await page.check('#figGrey');
await page.waitForTimeout(300);
const g = await page.$eval('#figPreview svg', e => e.outerHTML);
ok(!/#0b62a4|#b8560f/.test(g), 'greyscale removes colour');
await page.uncheck('#figGrey');
await page.waitForTimeout(300);

await page.screenshot({ path: 'test/shot_figure.png', fullPage: true });
const finalSvg = await page.$eval('#figPreview svg', e => e.outerHTML);
await writeFile(join(ROOT,'test/out_figure.svg'), finalSvg);

// downloads
const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#dlSvg')]);
const svgFile = await readFile(await d1.path(), 'utf8');
ok(svgFile.includes('<svg') && svgFile.includes('mm'), 'SVG download works', `${(svgFile.length/1024).toFixed(0)} kB`);

await page.selectOption('#figDpi', '600');
const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#dlPngHi')]);
const png = await readFile(await d2.path());
const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
const expW = Math.round(85/25.4*600);
ok(Math.abs(w-expW) <= 1, `600 dpi PNG is ${expW}px wide for 85 mm`, `${w}x${h}px, ${(png.length/1024).toFixed(0)} kB`);

await browser.close();
const real = errs.filter(e => !/favicon|404/i.test(e));
if (real.length) { console.log('\nconsole errors:'); real.slice(0,6).forEach(e=>console.log('  '+e)); fail += real.length; }
console.log(fail===0 ? '\nFIGURE EXPORT OK\n' : `\n${fail} FAILED\n`);
process.exit(fail?1:0);
