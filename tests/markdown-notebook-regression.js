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

const Notebook = global.RelatumMarkdownNotebook;
assert(Notebook, 'RelatumMarkdownNotebook should be exposed');

const normalized = Notebook.normalizeNotebook({
  notes: [
    { id: 'same', title: ' A ', markdown: 'one' },
    { id: 'same', title: '', markdown: 2 },
    null,
  ],
});
assert.strictEqual(normalized.version, 1);
assert.strictEqual(normalized.notes.length, 2);
assert.strictEqual(normalized.notes[0].title, 'A');
assert.strictEqual(normalized.notes[1].title, '未命名笔记');
assert.notStrictEqual(normalized.notes[0].id, normalized.notes[1].id);

const parsed = Notebook.parseOutline('研究备忘', [
  '# 研究备忘',
  '根节点说明',
  '### 问题',
  '问题正文',
  '- 假设 A',
  '  - [ ] 验证',
  '- 假设 B',
  '```text',
  '# 代码里的标题不生成',
  '```',
].join('\n'));
assert.strictEqual(parsed.ok, true);
assert.strictEqual(parsed.count, 5);
assert.strictEqual(parsed.nodes[0].title, '研究备忘');
assert.strictEqual(parsed.nodes[0].body, '根节点说明');
assert.strictEqual(parsed.nodes[1].title, '问题');
assert.strictEqual(parsed.nodes[1].body, '问题正文');
assert.strictEqual(parsed.nodes[2].title, '假设 A');
assert.strictEqual(parsed.nodes[3].title, '☐ 验证');
assert.strictEqual(parsed.nodes[3].depth, 3);
assert(parsed.nodes[4].body.includes('# 代码里的标题不生成'));
assert.deepStrictEqual(parsed.edges.map((edge) => [edge.from, edge.to]), [
  [0, 1], [1, 2], [2, 3], [1, 4],
]);

const plain = Notebook.parseOutline('散记', '只有普通段落\n没有结构');
assert.strictEqual(plain.ok, false);
assert.strictEqual(plain.reason, 'no-structure');

const limited = Notebook.parseOutline('很多', '- 一\n- 二\n- 三', { maxNodes: 3 });
assert.strictEqual(limited.ok, false);
assert.strictEqual(limited.reason, 'too-many');
assert.strictEqual(limited.line, 3);

const selection = Notebook.selectionToMarkdown({
  nodes: [
    { id: 'root', title: '主题', body: '根正文', x: 0, y: 0 },
    { id: 'a', title: '分支 A', body: '', x: 100, y: 20 },
    { id: 'b', title: '分支 B', body: 'B 正文', x: 100, y: 60 },
  ],
  edges: [
    { from: 'root', to: 'a', text: '支持' },
    { from: 'root', to: 'b', text: '' },
  ],
  ignoredCount: 2,
});
assert.strictEqual(selection.complex, false);
assert(selection.markdown.includes('## 主题'));
assert(selection.markdown.includes('- 分支 A'));
assert(selection.markdown.includes('_关系：支持_'));
assert(selection.markdown.includes('B 正文'));
assert.strictEqual(selection.ignoredCount, 2);

const crossed = Notebook.selectionToMarkdown({
  nodes: [
    { id: 'a', title: 'A', x: 0, y: 0 },
    { id: 'b', title: 'B', x: 0, y: 20 },
    { id: 'c', title: 'C', x: 0, y: 40 },
  ],
  edges: [
    { from: 'a', to: 'c', text: '交叉说明' },
    { from: 'b', to: 'c' },
  ],
}, { fallbackTitle: 'Selected canvas' });
assert.strictEqual(crossed.complex, true);
assert(crossed.markdown.startsWith('## Selected canvas'));
assert(crossed.markdown.includes('_关系：交叉说明_'));

const rendered = global.MarkdownMini.render('- A\n  - [ ] B\n  - [x] C\n- D');
assert(rendered.includes('data-ln="0">A<ul>'));
assert(rendered.includes('class="md-task-item"'));
assert(rendered.includes('class="md-task-box"'));
assert(rendered.includes('>✓</span>C'));

console.log('markdown notebook regression tests passed');
