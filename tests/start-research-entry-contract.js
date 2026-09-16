'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('assets', 'index.html');
const start = read('assets', 'start.js');
const styles = read('assets', 'styles.css');
const i18n = read('assets', 'i18n.js');

// 齿轮面板开关与首帧状态：禁用状态出厂即开启，必须在 <head> 就写进根节点，
// 否则会先闪一帧还带着「研究」入口的顶栏。
assert(html.includes('data-role="research-entry-toggle"'), '齿轮面板缺少「禁用研究入口」开关');
assert(html.includes('data-role="research-entry-toggle" checked>'),
  '开关的出厂默认必须是开启（禁用研究入口）');
assert(html.includes('<strong>禁用研究入口</strong>'), '齿轮面板缺少开关标题');
assert(html.includes("var researchEntryDisabled = localStorage.getItem('canvas:researchEntryDisabled') !== '0'"),
  '禁用状态必须在首帧读取，且只有显式存过 0 才放开');
assert(html.includes("document.documentElement.dataset.researchEntryDisabled = researchEntryDisabled ? '1' : '0'"),
  '首帧必须把禁用状态写到根节点供顶栏样式使用');
assert(html.includes("if (researchEntryDisabled && workspace === 'research') workspace = 'canvas';"),
  '入口隐藏时首帧就不能恢复上次停留的研究页');

// 持久偏好：默认禁用研究入口，只有显式存过 '0' 才放开。
assert(start.includes("const RESEARCH_ENTRY_DISABLED_KEY = 'canvas:researchEntryDisabled'"),
  '缺少研究入口偏好的存储键');
assert(start.includes('let researchEntryDisabled = false;'), '禁用状态必须先有默认值再按偏好覆盖');
assert(start.includes("try { researchEntryDisabled = localStorage.getItem(RESEARCH_ENTRY_DISABLED_KEY) !== '0'; } catch (e) {}"),
  '出厂默认必须是禁用研究入口，只有显式存过 0 才放开，且启动判定前就要读到');
assert(start.includes("localStorage.setItem(RESEARCH_ENTRY_DISABLED_KEY, researchEntryDisabled ? '1' : '0')"),
  '开关变化必须写入本机偏好');

// 应用函数：隐藏靠原生 disabled + 根节点状态，同时处理「开启时正停在研究页」。
const applyStart = start.indexOf('function applyResearchEntryDisabled(');
const applyEnd = start.indexOf('function applyGoalTreeSimpleMode(', applyStart);
assert(applyStart >= 0 && applyEnd > applyStart, '缺少 applyResearchEntryDisabled');
const apply = start.slice(applyStart, applyEnd);
assert(apply.includes('researchEntryDisabled = !!disabled;')
  && apply.includes("document.documentElement.dataset.researchEntryDisabled = researchEntryDisabled ? '1' : '0'")
  && apply.includes("if (button.dataset.startWorkspace !== 'research') return;")
  && apply.includes('button.disabled = researchEntryDisabled;'),
  '禁用必须落在顶栏「研究」标签上，并且只改这一个按钮');
assert(apply.includes("if (persist && researchEntryDisabled && activeStartWorkspace === 'research') {")
  && apply.includes("setStartWorkspace('canvas');"),
  '用户开启开关时若正停在研究页，必须自动退回画布');
assert(!apply.includes('allowDisabled'),
  '开启时的回退只在用户切换这条路径做，不能靠放行研究页入口');

// 进入动作收口：点击、方向键与外部 set() 都必须被拦住（没有任何放行分支）。
const setStart = start.indexOf('function setStartWorkspace(');
const setEnd = start.indexOf('workspaceButtons.forEach(', setStart);
assert(setStart >= 0 && setEnd > setStart, '缺少 setStartWorkspace');
const setter = start.slice(setStart, setEnd);
assert(setter.includes("if (next === 'research' && researchEntryDisabled) {")
  && setter.includes('return Promise.resolve(false);'),
  '入口隐藏后必须阻断所有进入研究页的动作');
assert(!start.includes('allowDisabled'), '不得为冷启动保留进入研究页的后门');

// 冷启动：上次停在研究页时在 boot 分支回退，而不是显示一个没有入口的工作区。
assert(start.includes("if (researchEntryDisabled && activeStartWorkspace === 'research') activeStartWorkspace = 'canvas';"),
  '冷启动恢复上次停留的研究页必须回退到画布');

// 键盘：隐藏的标签不能成为方向键落点，Home / End 按可用顺序取首尾。
assert(start.includes('const reachable = workspaceButtons.filter((item) => !item.disabled);'),
  '方向键必须跳过被隐藏的入口');
assert(start.includes('event.key === \'End\' ? reachable.length - 1'), 'End 必须落在实际可用的最后一项');

// 只记住用户真实碰过开关的选择：切开关写盘，开机与恢复默认都不写盘。
assert(start.includes('applyResearchEntryDisabled(researchEntryToggle.checked, true);'),
  '用户切换开关必须写入本机偏好，下次打开沿用');
assert(start.includes('applyResearchEntryDisabled(researchEntryDisabled, false);'),
  '开机应用出厂默认/已有偏好时不得写盘，否则“没碰过”会被记成“碰过”');
assert((start.match(/localStorage\.setItem\(RESEARCH_ENTRY_DISABLED_KEY/g) || []).length === 1,
  '研究入口偏好只能由开关的 change 处理写入一处，其他路径不得改写用户选择');

// 恢复默认：与面板其他开关一致，回到出厂默认（研究入口禁用）。
const resetStart = start.indexOf('function resetStartPanelDefaults(');
const resetEnd = start.indexOf('function syncDesktopSizeForm(', resetStart);
assert(resetStart >= 0 && resetEnd > resetStart, '缺少 resetStartPanelDefaults');
const reset = start.slice(resetStart, resetEnd);
assert(reset.includes('RESEARCH_ENTRY_DISABLED_KEY,') && reset.includes('applyResearchEntryDisabled(true, false);'),
  '面板「恢复默认」必须清掉偏好并回到出厂默认（研究入口禁用），且不写盘');

// 视觉几何：入口消失后列数、滑块宽度与档位必须一起收一档，否则最后一格空着、
// 滑块停在原来的第四格位置。四栏布局的原始规则必须保持不动。
assert(styles.includes('html[data-research-entry-disabled="1"] .start-workspace-switch button[data-start-workspace="research"] { display: none; }'),
  '缺少研究入口的隐藏样式');
assert(styles.includes('html[data-research-entry-disabled="1"] .start-workspace-switch { grid-template-columns: repeat(3, minmax(48px, 1fr)); }'),
  '隐藏入口后必须把四列网格收成三列');
assert(styles.includes('html[data-research-entry-disabled="1"] .start-workspace-switch { grid-template-columns: repeat(3, 45px); }'),
  '窄屏同样必须收成三列，否则露出一格空位');
assert(styles.includes('html[data-research-entry-disabled="1"] .start-workspace-slider { width: calc((100% - 8px) / 3); }'),
  '三格时滑块宽度必须按三列重算');
assert(styles.includes('html[data-research-entry-disabled="1"] body[data-start-workspace="career"] .start-workspace-slider { transform: translateX(calc(200% + 2px)); }'),
  '三格时生涯只前进两档，否则滑块会越位');
assert(styles.includes('html[data-research-entry-disabled="1"] body[data-start-workspace="research"] .start-workspace-slider { opacity: 0; transform: none; }'),
  '研究页尚未离开时（保存链在途或保存失败）滑块必须收成不选中，不能停在生涯档位');
assert(styles.includes('grid-template-columns: repeat(4, minmax(48px, 1fr));')
  && styles.includes('width: calc((100% - 9px) / 4);')
  && styles.includes('body[data-start-workspace="career"] .start-workspace-slider { transform: translateX(calc(300% + 3px)); }'),
  '放开研究入口时的四栏几何必须保持原样');

// 双语文案：描述必须跟着“入口消失”的行为，不能再写成“变灰”。
[
  "'禁用研究入口': 'Disable research entry'",
  "'「研究」标签从顶栏移除，只有这里能重新打开': 'Remove the Research tab from the top bar; only this switch brings it back'",
].forEach((needle) => assert(i18n.includes(needle), '研究入口禁用双语文案缺失：' + needle));
assert(!i18n.includes('变灰') && !html.includes('变灰'),
  '入口已经整个消失，面板文案不能再描述“变灰”');
assert(i18n.includes("'「研究」标签从顶栏移除，只有这里能重新打开':")
  && html.includes('<small>「研究」标签从顶栏移除，只有这里能重新打开</small>'),
  '中文文案与英文词条必须成对存在');

console.log('start research entry contract passed');
