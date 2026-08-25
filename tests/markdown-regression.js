const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.MarkdownTable = null;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'markdown.js'), 'utf8'),
  { filename: 'markdown.js' },
);
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'markdown-notebook.js'), 'utf8'),
  { filename: 'markdown-notebook.js' },
);

const Markdown = global.MarkdownMini;
const Notebook = global.RelatumMarkdownNotebook;
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'styles.css'), 'utf8');
assert(Markdown && Markdown.structure && typeof Markdown.renderResult === 'function');

['- ', '* ', '+ ', '1. ', '1) ', '- [ ] ', '- [x] '].forEach((source) => {
  const result = Markdown.renderResult(source);
  assert.strictEqual(result.error, false, source);
  assert(result.html.includes('<p'), source);
  assert(result.html.includes(Markdown.escapeHtml(source)), source);
});

const headings = Markdown.render('# A\n## B\n### C\n#### D\n##### E\n###### F');
for (let level = 1; level <= 6; level++) {
  assert(headings.includes(`<h${level} data-ln="${level - 1}">`), `missing h${level}`);
}

const nested = Markdown.render('- A\n  - [ ] B\n  - [x] C\n1) D');
assert(nested.includes('<ul>'));
assert(nested.includes('<ol>'));
assert(nested.includes('class="md-task-item"'));

const tildeFence = Markdown.render('~~~js\nconst x = 1;\n~~~');
assert(tildeFence.includes('<pre class="md-code" data-lang="js">'));
const unfinishedFence = Markdown.render('```js\nconst x = 1;');
assert(unfinishedFence.includes('```js'));
assert(!unfinishedFence.includes('<pre class="md-code"'));

assert(Markdown.render('\\*literal\\*').includes('*literal*'));
assert(!Markdown.render('\\*literal\\*').includes('<em>'));
const escapedHighlight = Markdown.render('\\==123==');
assert(escapedHighlight.includes('==123=='), 'escaped highlight punctuation must remain literal text');
assert(!escapedHighlight.includes('<mark'), 'an escaped opening highlight marker must not render a highlight');
assert(Markdown.render('\\a').includes('\\a'), 'a non-punctuation escape must preserve its backslash');
assert(Markdown.render('`\\*`').includes('\\*'), 'Markdown escapes must not be interpreted inside inline code');
assert(Markdown.render('`**literal**`').includes('<code>**literal**</code>'), 'inline code must remain isolated from emphasis rendering');
const escapedCalloutHighlight = Markdown.render('> [!note] 1\\==2==');
assert(escapedCalloutHighlight.includes('1==2=='), 'effective escapes must survive the Callout title pipeline');
assert(!escapedCalloutHighlight.includes('<mark'), 'escaped highlight punctuation in a Callout title must not highlight');
const escapedDollar = Markdown.renderResult('\\$literal\\$');
assert.strictEqual(escapedDollar.features.math, false);
assert(escapedDollar.html.includes('$literal$'));
assert(!escapedDollar.html.includes('md-math'));
assert(Markdown.render('\\# literal').includes('# literal'));
assert(Markdown.render('<script>alert(1)</script>').includes('&lt;script&gt;'));
assert(!Markdown.render('![remote](https://example.com/a.png)').includes('<img'));
const localImage = Markdown.render('![diagram](page.assets/images/diagram.png)', { localImages: true });
assert(localImage.includes('data-note-image="page.assets/images/diagram.png"'));
assert(!localImage.includes('src='));
const obsidianImage = Markdown.render('![[photo.webp]]', { localImages: true });
assert(obsidianImage.includes('data-note-image="photo.webp"'));
const guardedRemoteImage = Markdown.render('![remote](https://example.com/a.png)', { localImages: true });
assert(guardedRemoteImage.includes('data-note-image="https://example.com/a.png"'));
assert(!guardedRemoteImage.includes('src='));
assert(Markdown.render('$$').includes('$$'));
const noteCallout = Markdown.render('> [!note] Title\n> Body');
assert(noteCallout.includes('class="md-callout"'));
assert(noteCallout.includes('data-callout="note"'));
assert(noteCallout.includes('M10.5 2.5l3 3L6 13H3v-3z'), 'Note callouts must use the pencil icon');
const exampleCallout = Markdown.render('> [!example] Example');
assert(exampleCallout.includes('data-callout="example"'));
assert(exampleCallout.includes('M6.5 4h6'), 'Example callouts must use the list icon');
assert(Markdown.render('> [!todo] Todo').includes('data-callout="todo"'), 'Todo must keep its own semantic type');
assert(Markdown.render('> [!failure] Failure').includes('data-callout="failure"'), 'Failure must keep its own semantic type');
assert(Markdown.render('> [!fail] Fail').includes('data-callout="failure"'), 'Fail must alias to Failure');
assert(Markdown.render('> [!missing] Missing').includes('data-callout="failure"'), 'Missing must alias to Failure');
assert(Markdown.render('> [!error] Error').includes('data-callout="danger"'), 'Error must alias to Danger');
assert(Markdown.render('> [!custom] Custom').includes('data-callout="note"'), 'unknown callouts must safely fall back to Note');
['note', 'todo', 'failure', 'example'].forEach((type) => {
  assert(stylesSource.includes(`.md-callout[data-callout="${type}"]`), `missing shared ${type} callout palette`);
  assert(stylesSource.includes(`.note-live-rich-block.is-callout .md-callout[data-callout="${type}"]`),
    `missing Live Preview ${type} callout palette`);
});
assert(Markdown.render('| A | B |\n| --- | --- |\n| 1 | 2 |').includes('class="md-table"'));
assert(Markdown.render('[Open](https://example.com)').includes('data-href="https://example.com"'));

const softBreak = Markdown.render('alpha\nbeta');
assert(!softBreak.includes('<br>'));
assert(Markdown.render('alpha  \nbeta').includes('<br>'));
assert(Markdown.render('alpha\\\nbeta').includes('<br>'));

const features = Markdown.renderResult('```mermaid\ngraph TD\nA-->B\n```\n\n$x$').features;
assert.deepStrictEqual(features, { math: true, mermaid: true });
assert.deepStrictEqual(Markdown.renderResult('`$not_math$`').features, { math: false, mermaid: false });
assert.deepStrictEqual(Markdown.renderResult('$$').features, { math: false, mermaid: false });
assert.deepStrictEqual(Markdown.renderResult('\\[').features, { math: false, mermaid: false });
assert.deepStrictEqual(
  Markdown.renderResult('```mermaid\ngraph TD\nA-->B').features,
  { math: false, mermaid: false },
);

const outline = Notebook.parseOutline('Root', '# Branch\n- Item\n- \n~~~js\n# code\n~~~');
assert.strictEqual(outline.ok, true);
assert.deepStrictEqual(outline.nodes.map((node) => node.title), ['Root', 'Branch', 'Item']);
assert(outline.nodes[2].body.includes('- '));
assert(outline.nodes[2].body.includes('~~~js'));

assert.deepStrictEqual(Notebook.listContinuation('- item', 6, 6), {
  start: 6,
  end: 6,
  text: '\n- ',
  caret: 9,
});
assert.deepStrictEqual(Notebook.listContinuation('3. item', 7, 7), {
  start: 7,
  end: 7,
  text: '\n4. ',
  caret: 11,
});
assert.deepStrictEqual(Notebook.listContinuation('- [x] done', 10, 10), {
  start: 10,
  end: 10,
  text: '\n- [ ] ',
  caret: 17,
});
assert.deepStrictEqual(Notebook.listContinuation('- ', 2, 2), {
  start: 0,
  end: 2,
  text: '',
  caret: 0,
});
assert.strictEqual(Notebook.listContinuation('```\n- code', 10, 10), null);

console.log('markdown regression: ok');
