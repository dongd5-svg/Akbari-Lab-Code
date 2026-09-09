import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css',
               '.mat':'application/octet-stream' };
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

const COHORT = [];
for (const [g, n] of [['WT',301],['WT',302],['WT',303],['FAD',311],['FAD',312],['FAD',313]]) {
  COHORT.push(M(`Mouse ${n}_${g}_Baseline.mat`), M(`Mouse ${n}_${g}_roi.mat`));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1300, height: 1100 } });
const errs = [];
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(String(e)));

let fail = 0;
const ok = (c, m, extra='') => { console.log(`  ${c?'PASS':'FAIL'}  ${m}${extra?'  - '+extra:''}`); if(!c) fail++; };

await page.goto(`${base}/index.html`);
console.log('\n=== Groups ===');

await page.setInputFiles('#picker', COHORT);
await page.waitForFunction(() => document.querySelectorAll('#fileTable input.grp').length === 12,
  null, { timeout: 60000 });

const guessed = await page.$$eval('#fileTable input.grp', els => els.map(e => e.dataset.a + '=' + e.value));
const uniq = [...new Set(guessed.map(s => s.split('=')[1]))].sort();
ok(uniq.join(',') === 'FAD,WT', 'groups guessed from the filenames', uniq.join(', '));

await page.click('#run');
await page.waitForSelector('#groupsPanel:not(.hide)', { timeout: 60000 });

const gRows = await page.$$eval('#groupTable tr', rs => rs.length - 1);
ok(gRows === 10, 'group stats table has 5 metrics per group', `${gRows} rows`);

const nCol = await page.$$eval('#groupTable tr td:nth-child(3)', e => [...new Set(e.map(x=>x.textContent.trim()))]);
ok(nCol.length === 1 && nCol[0] === '3', 'n is animals per group, not timepoints', nCol.join(','));

const sel = await page.$$eval('#cmpA option', o => o.map(x=>x.value).sort().join(','));
ok(sel === 'FAD,WT', 'comparison pickers offer both groups', sel);

const statHdr = await page.$$eval('#statsTable tr:first-child th', e => e.map(x=>x.textContent.trim()));
ok(statHdr.includes('p, t-test') && statHdr.includes('p, Mann-Whitney'), 'both tests shown',
   statHdr.join(' | '));

const rcbfRow = await page.$$eval('#statsTable tr', rs => {
  const r = rs.find(x => x.children[0] && x.children[0].textContent.trim() === 'rCBF');
  return r ? [...r.children].map(c => c.textContent.trim()) : null;
});
ok(rcbfRow && parseFloat(rcbfRow[5]) < 0.05, 'rCBF differs between the two cohorts',
   rcbfRow ? `p=${rcbfRow[5]} (t), p=${rcbfRow[6]} (MW)` : 'no row');
ok(rcbfRow && rcbfRow[6] === '0.1000', 'Mann-Whitney is exact for n=3 vs 3',
   rcbfRow ? rcbfRow[6] : '');

// --- group plots ---
await page.click('#animalTabs button:first-child');
await page.waitForTimeout(500);
const tabName = await page.$eval('#animalTabs button:first-child', b => b.textContent.trim());
ok(tabName === 'Groups', 'a Groups tab sits before the animals', tabName);
ok((await page.$$('#charts canvas')).length >= 1, 'group chart drawn');
const keyText = await page.$eval('#charts .key', e => e.textContent.trim());
ok(/n=3/.test(keyText) && /WT/.test(keyText) && /FAD/.test(keyText), 'legend names both groups with n',
   keyText.replace(/\s+/g,' '));

await page.click('#metricTabs button:nth-child(2)');
await page.waitForTimeout(400);
ok((await page.$$('#charts canvas')).length === 2, 'CMRO2 tab draws both group charts');

// --- group figure ---
await page.check('#figGroups');
await page.waitForTimeout(500);
const svg = await page.$eval('#figPreview svg', e => e.outerHTML);
ok(/fill-opacity="0\.16"/.test(svg), 'SEM band drawn in the figure');
ok((svg.match(/fill-opacity="0\.16"/g) || []).length >= 2, 'one band per group',
   `${(svg.match(/fill-opacity="0\.16"/g) || []).length} bands`);
ok(/WT \(n=3\)/.test(svg) && /FAD \(n=3\)/.test(svg), 'figure legend names the groups');

const [dlSvg] = await Promise.all([page.waitForEvent('download'), page.click('#dlSvg')]);
ok(dlSvg.suggestedFilename() === 'groups_figure.svg', 'group figure exports under its own name',
   dlSvg.suggestedFilename());

// --- CSVs ---
const grab = async (sel) => {
  const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
  return { name: d.suggestedFilename(), text: await readFile(await d.path(), 'utf8') };
};
const stats = await grab('#dlGrpStats');
ok(stats.text.split('\n')[0] === 'Group,Metric,n,Mean,SD,SEM', 'stats CSV columns',
   stats.text.split('\n')[0]);
const traces = await grab('#dlGrpTrace');
const tLines = traces.text.trim().split('\n');
ok(tLines[0] === 'Group,Metric,Time_min,Mean,SD,SEM,n' && tLines.length > 1000,
   'group traces CSV is long-format', `${tLines.length - 1} rows`);
const cmp = await grab('#dlGrpCmp');
ok(/p_ttest/.test(cmp.text) && /p_MannWhitney/.test(cmp.text), 'comparison CSV carries both p values');

const summary = await grab('#dlCsv');
ok(summary.text.split('\n')[0].startsWith('Animal,Group,'), 'summary CSV gains a Group column',
   summary.text.split('\n')[0]);
const data = await grab('#dlData');
ok(data.text.split('\n')[0].startsWith('Animal,Group,Time_min'), 'data CSV gains a Group column',
   data.text.split('\n')[0].slice(0, 50));

// --- editing a group by hand ---
await page.fill('#fileTable input.grp', 'Sham');
await page.waitForTimeout(700);
const after = await page.$$eval('#groupTable tr td:first-child',
  e => e.map(x => x.textContent.trim()).filter(Boolean));
ok(after.includes('Sham'), 'typing a new group name regroups the animal', after.join(', '));
const paired = await page.$$eval('#fileTable input.grp',
  e => e.filter(x => x.dataset.a === 'Mouse301').map(x => x.value));
ok(paired.length === 2 && paired.every(v => v === 'Sham'), 'both files of that animal follow along');

await page.screenshot({ path: 'test/shot_groups.png', fullPage: true });
await browser.close(); server.close();

const real = errs.filter(e => !/favicon|404/i.test(e));
if (real.length) { console.log('\nconsole errors:'); real.slice(0,8).forEach(e=>console.log('  '+e)); fail += real.length; }
console.log(fail === 0 ? '\nALL GROUP CHECKS PASSED\n' : `\n${fail} GROUP CHECK(S) FAILED\n`);
process.exit(fail ? 1 : 0);
