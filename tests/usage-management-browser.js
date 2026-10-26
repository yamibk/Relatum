'use strict';
// Real server and isolated files; deliberately loses one successful response.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), python = process.env.RELATUM_PYTHON;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
async function main() {
  assert(python, 'Set RELATUM_PYTHON');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-usage-ui-'));
  const fixture = JSON.parse(execFileSync(python, ['-B', '-m', 'tests.usage-management-fixture'], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, encoding: 'utf8' }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
  const choices = Object.fromEntries(catalog.features.map(row => [row.id, ['notes', 'career'].includes(row.id)]));
  const server = spawn(python, ['-B', 'app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify({ version: 1, features: choices })], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base+'/api/runtime')).ok) break; } catch (_) {} await delay(100); }
    await page.goto(base); await page.waitForFunction(() => !!window.RelatumGlobalSettings);
    await page.locator('button[data-start-workspace="career"]').click();
    await page.waitForSelector('.career-report-shell');
    const peer = await context.newPage(); await peer.goto(base); await peer.waitForFunction(() => !!window.RelatumGlobalSettings);
    if (await peer.evaluate(() => RelatumStartWorkspace.current !== 'career')) await peer.locator('button[data-start-workspace="career"]').click();
    await peer.waitForSelector('.career-report-shell'); await page.bringToFront();
    await page.evaluate(() => RelatumGlobalSettings.open({ category: 'usage' }));
    const manager = page.locator('[data-usage-management]'); await manager.waitFor();
    await manager.getByRole('button', { name: '归档已删除笔记的统计', exact: true }).click();
    await page.waitForSelector('[data-archive-group="deleted"]');
    assert.equal(await manager.locator('[data-archive-group="deleted"] input').count(), 40, 'candidate DOM is paginated');
    assert.equal(await manager.locator('[data-archive-group="missing"] input:checked').count(), 0, 'external missing paths default unchecked');
    await manager.locator('[data-archive-group="deleted"] input').first().uncheck();
    await manager.locator('[data-archive-group="deleted"]').getByRole('button', { name: '下一页', exact: true }).click();
    await manager.locator('[data-archive-group="deleted"]').getByRole('button', { name: '上一页', exact: true }).click();
    assert.equal(await manager.locator('[data-archive-group="deleted"] input').first().isChecked(), false);
    await manager.locator('[data-archive-group="missing"] input').first().check();
    assert.match(await manager.locator('[data-archive-selection]').textContent(), /85/);
    const downloaded = page.waitForEvent('download');
    await manager.getByRole('button', { name: '导出统计备份', exact: true }).click();
    const download = await downloaded; await download.saveAs(path.join(root, 'browser-backup.zip'));
    const backup = JSON.parse(execFileSync(python, ['-c', 'import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist()))', path.join(root, 'browser-backup.zip')], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(backup.sort(), ['README.txt', 'career-report-v2.json', 'usage-v2.sqlite3'].sort());
    await page.waitForFunction(() => document.querySelector('[data-usage-management]').getAttribute('aria-busy') === 'false');
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await manager.getByRole('button', { name: 'Export usage backup', exact: true }).count(), 1);
    assert.match(await manager.locator('.usage-management-status').textContent(), /browser downloads/);
    await page.setViewportSize({ width: 520, height: 780 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; document.documentElement.dataset.startTheme = 'dark'; });
    await manager.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'usage-dark-narrow.png') });
    const overflow = await manager.evaluate(node => node.scrollWidth > node.clientWidth+2);
    assert.equal(overflow, false, 'narrow layout has no horizontal overflow');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { RelatumI18n.setLanguage('zh-CN'); document.body.dataset.startTheme = 'light'; document.documentElement.dataset.startTheme = 'light'; });
    await manager.locator('[data-archive-review]').click();
    await page.keyboard.press('Escape');
    assert.equal(await manager.locator('.usage-archive-preview').isVisible(), true, 'Escape returns to preview');
    await manager.locator('[data-archive-review]').click();
    await page.screenshot({ path: path.join(root, 'usage-confirm.png') });
    let delayedReport = false, polls = 0;
    await page.route('**/api/career/report', async route => {
      const response = await route.fetch(), value = await response.json();
      if (!delayedReport && value.report?.history?.archivedNotes?.count === 85) {
        delayedReport = true;
        await route.fulfill({ json: { version: 2, exists: false, report: null, job: { id: 'browser-pending-job', status: 'running', progress: 10, stage: 'notes' } } });
      } else await route.fulfill({ response });
    });
    await page.route('**/api/career/jobs/browser-pending-job', route => { polls++; return route.fulfill({ json: { id: 'browser-pending-job', status: 'complete', progress: 100, stage: 'complete' } }); });
    let swallowed = false;
    await page.route('**/api/usage/archive-notes', async route => { await route.fetch(); swallowed = true; await route.abort('failed'); });
    await manager.locator('[data-archive-confirm]').click();
    await page.waitForFunction(() => document.querySelector('.usage-management-status').textContent.includes('结果不确定'));
    assert(swallowed);
    assert.equal((await (await fetch(base+'/api/usage/management')).json()).archived, 85);
    await page.unroute('**/api/usage/archive-notes');
    await manager.locator('[data-archive-confirm]').click();
    await page.waitForFunction(() => document.querySelector('.usage-management-status').textContent.includes('已归档 85'));
    assert.equal((await (await fetch(base+'/api/usage/management')).json()).archived, 85, 'lost-response retry is idempotent');
    await page.evaluate(() => RelatumGlobalSettings.close());
    await page.waitForFunction(() => window.RelatumCareerReport?.report?.history?.archivedNotes?.count === 85);
    assert(polls > 0, 'a pending automatic report resumes job polling');
    await page.waitForSelector('.career-archived-notes:not([hidden])');
    const report = await page.evaluate(() => RelatumCareerReport.report);
    assert.equal(report.history.days.reduce((sum, row) => sum+row.seconds, 0), fixture.seconds, 'archiving preserves total time');
    assert(!JSON.stringify(report).includes('Deleted-001.md'));
    assert(JSON.stringify(report).includes('Deleted-000.md'), 'unchecked note retains its history');
    assert(JSON.stringify(report).includes('External-1.md'), 'unchecked external candidate remains intact');
    assert.match(await page.locator('.career-archived-notes').textContent(), /85/);
    await peer.bringToFront();
    await peer.waitForFunction(() => window.RelatumCareerReport?.report?.history?.archivedNotes?.count === 85);
    assert(!(await peer.locator('.career-report-shell').textContent()).includes('Deleted-001.md'), 'peer window drops old report details');
    await peer.close(); await page.bringToFront();
    // Closing/switching categories cancels a delayed preview; no late UI appears.
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/usage/archive-preview', async route => { await held; await route.continue().catch(() => {}); });
    await page.evaluate(() => RelatumGlobalSettings.open({ category: 'usage' }));
    await manager.getByRole('button', { name: '归档已删除笔记的统计', exact: true }).click();
    await page.locator('#global-settings-dialog nav [data-settings-category="workspaces"]').click(); release();
    await delay(200); await page.unroute('**/api/usage/archive-preview');
    assert.equal(await manager.locator('.usage-archive-preview').isVisible(), false);
    for (const [relative, hash] of Object.entries(fixture.files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'), hash, 'content bytes preserved');
    assert.deepEqual(errors, []);
    console.log('Usage management: selection, pagination, backup download, language/themes/narrow layout, confirmation/Escape, lost response retry, report invalidation, stale preview and content preservation passed');
    console.log('Artifacts: '+root);
  } catch (error) { console.error(logs); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); console.error('Artifacts: '+root); throw error; }
  finally { await browser.close(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
