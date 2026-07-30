const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const editor = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');

function functionBody(name) {
  const marker = 'function ' + name + '(';
  const start = canvas.indexOf(marker);
  assert(start >= 0, '找不到函数：' + name);
  const brace = canvas.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < canvas.length; index++) {
    if (canvas[index] === '{') depth += 1;
    else if (canvas[index] === '}') {
      depth -= 1;
      if (depth === 0) return canvas.slice(brace + 1, index);
    }
  }
  throw new Error('函数括号未闭合：' + name);
}

function count(body, needle) {
  return body.split(needle).length - 1;
}

const planScript = editor.indexOf('<script src="ai-canvas-plan.js" defer></script>');
const canvasScript = editor.indexOf('<script src="canvas.js" defer></script>');
assert(planScript >= 0 && canvasScript > planScript, 'AI 计划数据层必须先于 canvas.js 加载');

[
  'global.CanvasModule.describeAIContext = describeAIContext;',
  'global.CanvasModule.describeAIPresentation = describeAIPresentation;',
  'global.CanvasModule.applyAIPlan = applyAIPlan;',
].forEach((needle) => {
  assert(canvas.includes(needle), '缺少 AI V2 画布入口：' + needle);
});

assert(
  canvas.includes("curve: EDGE_CURVES.indexOf(normalEdgeDefaults.curve) >= 0 ? normalEdgeDefaults.curve : 'branch'"),
  '普通画布没有显式线型时必须以枝桠曲线兜底',
);
assert(
  canvas.includes("curveOverride === 'preset' ? (preset.branch.curve || 'branch')"),
  '导图必须优先跟随预设，并以枝桠曲线兜底',
);
assert(
  functionBody('applyAICreateMindmap').includes('normalDefaults: false'),
  'AI 新建导图不得混入普通画布的新建节点默认',
);
assert(
  canvas.includes("if (options.history !== false) pushHistory();")
    && canvas.includes("if (options.notify !== false) notify();"),
  '导图创建入口必须支持由外层统一提交历史和保存',
);
assert(
  canvas.includes("applySnapshot(before, { notify: false });"),
  'AI 计划失败时必须无保存通知地回滚',
);
assert(
  canvas.includes("options.relayoutSelection && plan.scope === 'selection'"),
  '普通画布重排必须由预览显式开启',
);
['applyAICreateMindmap', 'applyAIExtendBranch', 'applyAINormalPlan'].forEach((name) => {
  const body = functionBody(name);
  assert.strictEqual(count(body, 'pushHistory();'), 1, name + ' 必须只写一条撤销历史');
  assert.strictEqual(count(body, 'notify();'), 1, name + ' 必须只触发一次保存通知');
});
assert(
  functionBody('applyAIPlan').includes('validateAIExpectations(plan)'),
  '应用前必须重新核对预览指纹',
);

console.log('ai canvas plan contract passed');
