'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkReferenceMove({ page, notes, open, save, native }) {
  const htmlId = '10b83e0a-c0d7-4f41-92a1-39a278952ee1';
  const db = id => '```database ' + id + '\n```';
  const html = '```html-embed ' + htmlId + ' autox200 zoom=70%\n```';
  const wrap = 'A long wrapped source line '.repeat(24) + 'ends here.';
  const fixtures = {
    Lines: `123\n2\n32\n3\n23\n2\n\nTail line\n\n${db('source')}\n`,
    Gaps: `Alpha\n\nBeta\n\n${db('source')}\n`,
    Wrap: `Before wrap\n${wrap}\nAfter wrap\n\n${db('source')}\n`,
    Widgets: `Heading\n\n${db('source')}\n\nMiddle\n\n${html}\n\nAfter HTML\n\n${db('target')}\n\nAfter table`,
    Duplicates: `Top line\n\n${db('source')}\n\nBetween\n\n${db('source')}\n\nFinal line`,
    Inline: `Before inline\n\nFirst **multiline\ninline span**\n\nEnd\n\n${db('source')}\n`,
    List: `Before list\n\n- First entry\n- Second entry\n- Third entry\n\n${db('source')}\n`,
    Fence: `Before\n\n${db('source')}\n\n~~~text\nUnfinished source\n`,
    Comment: `Before\n\n${db('source')}\n\n%%\nUnfinished source\n`,
    Math: `Before\n\n${db('source')}\n\n$$\nUnfinished source\n`,
    Edge: `Opening\n\n${db('source')}\n\n` + Array.from({ length: 100 }, (_, index) => `Paragraph ${index}\n\n`).join(''),
  };
  if (native) await page.evaluate(() => window.pywebview.api.set_restored_size(1450, 910));
  const companion = path.join(notes, 'Widgets.assets', 'html', htmlId);
  fs.mkdirSync(companion, { recursive: true });
  fs.writeFileSync(path.join(companion, 'Report.html'), '<!doctype html><button></button><script>document.querySelector("button").textContent = "Running";</script>');
  for (const [name, content] of Object.entries(fixtures)) {
    const file = name + '.md';
    fs.writeFileSync(path.join(notes, file), content);
    for (const id of name === 'Widgets' ? ['source', 'target'] : ['source']) {
      const response = await page.request.post(new URL('/api/note-database/action', page.url()).href, {
        data: { path: file, databaseId: id, action: { type: 'create' } },
      });
      assert(response.ok(), await response.text());
    }
  }

  const scroller = page.locator('.note-live-editor-host .cm-scroller').first();
  const body = scroller.locator(':scope > .cm-content');
  const row = text => body.locator(':scope > .cm-line').filter({ hasText: text });
  const carrier = id => body.locator(`:scope > .note-database-carrier[data-database-id="${id}"]`);
  const grip = carrier('source').locator('.note-database-move').first();
  const embed = body.locator(':scope > .note-html-embed');
  const marker = page.locator('.note-reference-block-drop:not([hidden])');
  const text = () => page.evaluate(() => __databaseTest.editor.snapshot().value);
  const centerY = box => box.y + box.height / 2;
  const closeTo = (actual, expected) => assert(Math.abs(actual - expected) < 2, `${actual} should align with ${expected}`);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  async function start(handle = grip) {
    await handle.hover();
    await settle();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, centerY(box));
    await page.mouse.down();
  }
  async function aim(x, y) {
    await page.mouse.move(x, y);
    await settle();
    return marker.evaluateAll(lines => lines[0]?.getBoundingClientRect().toJSON() ?? null);
  }
  async function keepAboveScrollEdge(target) {
    await target.evaluate(node => {
      const scroll = node.closest('.cm-scroller');
      const distanceToBottom = scroll.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom;
      scroll.scrollTop += Math.max(0, 75 - distanceToBottom);
    });
    await settle();
  }
  async function undo(name) {
    await page.keyboard.press('Control+z');
    assert.equal(await text(), fixtures[name], 'one undo restores the original Markdown');
  }
  async function contrast() {
    return marker.evaluate(line => {
      const context = document.createElement('canvas').getContext('2d');
      const paperStyle = getComputedStyle(line.closest('.note-document-body'));
      const background = paperStyle.getPropertyValue('--note-theme-paper').trim() || paperStyle.backgroundColor;
      const sample = () => context.getImageData(0, 0, 1, 1).data;
      const luminance = rgb => {
        const linear = c => c <= 10 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
        return linear(rgb[0]) * 0.2126 + linear(rgb[1]) * 0.7152 + linear(rgb[2]) * 0.0722;
      };
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      const paper = luminance(sample());
      context.fillStyle = getComputedStyle(line).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const ink = luminance(sample());
      return (Math.max(paper, ink) + 0.05) / (Math.min(paper, ink) + 0.05);
    });
  }

  assert(await open('Lines.md'));
  await start();
  const second = await row(/^2$/).first().boundingBox();
  const third = await row(/^32$/).boundingBox();
  const between = await aim(third.x + 40, third.y + 3);
  closeTo(centerY(between), second.y + second.height);
  closeTo(between.x, third.x);
  closeTo(between.width, third.width);
  assert.equal(between.height, 2);
  assert(await contrast() >= 3);
  await page.mouse.up();
  const moved = `123\n2\n\n${db('source')}\n\n32\n3\n23\n2\n\nTail line\n\n`;
  assert.equal(await text(), moved);
  await save();
  assert.equal(fs.readFileSync(path.join(notes, 'Lines.md'), 'utf8'), moved);
  await undo('Lines');

  assert(await open('Gaps.md'));
  await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
  await start();
  const alpha = await row(/^Alpha$/).boundingBox(), beta = await row(/^Beta$/).boundingBox();
  const upper = await aim(alpha.x + 40, alpha.y + alpha.height + 3);
  const lower = await aim(beta.x + 40, beta.y - 3);
  closeTo(centerY(upper), (alpha.y + alpha.height + beta.y) / 2);
  closeTo(centerY(lower), centerY(upper));
  assert(await contrast() >= 3);
  assert.equal(await aim(beta.x + 40, beta.y + beta.height - 3), null, 'the source slot has no marker');
  await page.mouse.up();
  assert.equal(await text(), fixtures.Gaps);
  const theme = (skin, mode) => page.evaluate(({ skin, mode }) => {
    window.RelatumNoteTheme.apply(skin, { persist: false });
    document.body.dataset.startTheme = mode;
  }, { skin, mode });
  for (const skin of ['claude', 'sky', 'apple']) {
    for (const mode of ['light', 'dark']) {
      await theme(skin, mode);
      await start();
      const first = await row(/^Alpha$/).boundingBox();
      assert(await aim(first.x + 40, first.y + first.height - 3));
      assert(await contrast() >= 3, `${skin} ${mode} marker contrast`);
      await page.keyboard.press('Escape');
      await page.mouse.up();
    }
  }
  await theme('default', 'light');

  assert(await open('Wrap.md'));
  await start();
  const wrapped = await row(/A long wrapped source line/).boundingBox();
  assert(wrapped.height > 45);
  closeTo(centerY(await aim(wrapped.x + 40, wrapped.y + wrapped.height * 0.7)), wrapped.y + wrapped.height);
  await page.mouse.up();
  assert((await text()).startsWith(`Before wrap\n${wrap}\n\n${db('source')}\n\nAfter wrap`));
  await undo('Wrap');

  assert(await open('Widgets.md'));
  await carrier('target').locator('table').waitFor();
  if (native) {
    await embed.getByRole('button', { name: 'Interact' }).click();
    await embed.frameLocator('iframe').getByRole('button', { name: 'Running' }).focus();
    assert(await embed.locator('iframe').evaluate(frame => frame === document.activeElement));
    await start();
    const box = await embed.boundingBox();
    assert(await aim(box.x + 40, box.y + box.height * 0.7));
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await marker.count(), 0);
    assert.equal(await text(), fixtures.Widgets, 'Esc cancels a drag from an interacting note');
    await embed.frameLocator('iframe').getByRole('button', { name: 'Running' }).click();
  } else await embed.getByText('View in the Windows desktop app').waitFor();
  await start();
  const htmlBox = await embed.boundingBox();
  const htmlUpperY = native ? htmlBox.y + htmlBox.height * 0.4 : htmlBox.y + 3;
  const htmlLowerY = native ? htmlBox.y + htmlBox.height * 0.7 : htmlBox.y + htmlBox.height - 3;
  const htmlUpper = await aim(htmlBox.x + 40, htmlUpperY);
  const htmlLower = await aim(htmlBox.x + 40, htmlLowerY);
  assert(centerY(htmlUpper) <= htmlBox.y && centerY(htmlUpper) > htmlBox.y - 35);
  assert(centerY(htmlLower) >= htmlBox.y + htmlBox.height && centerY(htmlLower) < htmlBox.y + htmlBox.height + 35);
  await page.mouse.up();
  assert((await text()).includes(`${html}\n\n${db('source')}\n\nAfter HTML`));
  await undo('Widgets');

  const htmlGrip = embed.getByRole('button', { name: 'Move HTML block', exact: true });
  await keepAboveScrollEdge(carrier('target'));
  await start(htmlGrip);
  const tableBox = await carrier('target').boundingBox();
  const tableUpper = await aim(tableBox.x + 40, tableBox.y + 4);
  const tableLower = await aim(tableBox.x + 40, tableBox.y + tableBox.height - 4);
  assert(centerY(tableUpper) <= tableBox.y && centerY(tableUpper) > tableBox.y - 35);
  assert(centerY(tableLower) >= tableBox.y + tableBox.height && centerY(tableLower) < tableBox.y + tableBox.height + 35);
  await page.mouse.up();
  assert((await text()).includes(`${db('target')}\n\n${html}\n\nAfter table`));
  await undo('Widgets');
  await keepAboveScrollEdge(row(/^After table$/));
  await start(htmlGrip);
  const end = await row(/^After table$/).boundingBox();
  closeTo(centerY(await aim(end.x + 40, end.y + end.height - 3)), end.y + end.height);
  await page.mouse.up();
  assert((await text()).endsWith(`After table\n\n${html}`));
  await undo('Widgets');
  await scroller.evaluate(node => { node.scrollTop = 0; });
  await settle();
  await start(htmlGrip);
  const head = await row(/^Heading$/).boundingBox();
  closeTo(centerY(await aim(head.x + 40, head.y + 3)), head.y);
  await page.mouse.up();
  assert((await text()).startsWith(`${html}\n\nHeading`));
  await undo('Widgets');

  assert(await open('Duplicates.md'));
  await start();
  const final = await row(/^Final line$/).boundingBox();
  await aim(final.x + 40, final.y + final.height - 3);
  await page.mouse.up();
  assert((await text()).includes(`Between\n\n${db('source')}\n\nFinal line\n\n${db('source')}`));
  await undo('Duplicates');

  assert(await open('Inline.md'));
  await start();
  const inline = await row(/First multiline/).boundingBox();
  assert.equal(await aim(inline.x + 40, inline.y + inline.height - 3), null);
  await page.mouse.up();
  assert.equal(await text(), fixtures.Inline);

  assert(await open('List.md'));
  await start();
  const firstItem = await row(/First entry/).boundingBox();
  const secondItem = await row(/Second entry/).boundingBox();
  const list = await aim(secondItem.x + 40, secondItem.y + 3);
  assert(centerY(list) <= firstItem.y && centerY(list) > firstItem.y - 35);
  await page.mouse.up();
  assert((await text()).includes(`${db('source')}\n\n- First entry\n- Second entry\n- Third entry`));
  await undo('List');

  for (const name of ['Fence', 'Comment', 'Math']) {
    assert(await open(name + '.md'));
    await start();
    const literal = await row(/Unfinished source/).boundingBox();
    assert.equal(await aim(literal.x + 40, literal.y + literal.height - 3), null, name);
    await page.mouse.up();
    assert.equal(await text(), fixtures[name]);
  }

  assert(await open('Edge.md'));
  await start();
  const viewport = await scroller.boundingBox();
  await aim(viewport.x + 80, viewport.y + viewport.height - 4);
  const sampleScroll = () => scroller.evaluate(node => ({ top: node.scrollTop, time: performance.now() }));
  const before = await sampleScroll();
  await page.waitForTimeout(360);
  const after = await sampleScroll();
  const speed = (after.top - before.top) / (after.time - before.time);
  assert(speed > 0.2 && speed < 0.88, `edge speed was ${speed} CSS px/ms`);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await marker.count(), 0);
  assert.equal(await text(), fixtures.Edge);
  const stopped = await sampleScroll();
  await settle();
  assert.equal((await sampleScroll()).top, stopped.top, 'Esc stops the drag scroll');
}

module.exports = { checkReferenceMove };
