// 画布编辑器 — 阶段 1a
// - 从 URL 参数读 file=...，fetch /api/load 拿数据
// - Ctrl+S 触发 /api/save
// - dirty 时 beforeunload 提醒未保存
// - 节点交互留给阶段 1b；这里只把"壳子"打通。

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  let filePath = params.get('file') || '';
  const LOCATE_NODE = params.get('node') || '';
  const FROM_STUDY = params.get('from') === 'study';
  // 新建画布首次打开标志（由起步页「新建」带 &fresh=1）：进简洁模式 + 弹一次提示。
  // 读完即从地址栏抹掉，避免刷新后又触发。
  const FRESH = params.get('fresh') === '1';
  // 内嵌迷你画布（学习页 Tab 浮窗）：顶栏隐藏=无法切模式，锁「普通」，且不写回 localStorage（不污染完整编辑器的模式偏好）
  const EMBED = params.get('embed') === '1';
  if (FRESH) {
    try {
      history.replaceState(null, '', 'editor.html?file=' + encodeURIComponent(filePath)
        + (FROM_STUDY ? '&from=study' : ''));
    } catch (e) {}
  }

  const cleanBtn = document.querySelector('[data-role="assets-clean-btn"]');
  if (cleanBtn) {
    cleanBtn.addEventListener('click', async function() {
      if (!filePath) return;
      const ok = window.confirm('将删除当前画布 .assets 文件夹里「没有任何节点引用」的图片 / 附件，并裁剪已删除节点留下的阅读批注。\n不影响仍在画布中的内容，但清理后不可恢复。\n\n确定清理吗？');
      if (!ok) return;
      cleanBtn.disabled = true;
      try {
        // 先落盘，确保按「当前画布内容」判定哪些是孤儿，避免误删刚引用、尚未保存的文件
        if (typeof save === 'function' && !(await save())) {
          throw new Error('当前画布尚未成功保存，已取消清理');
        }
        const resp = await fetch('/api/clean-assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath })
        });
        const json = await resp.json();
        if (resp.ok) {
          cleanBtn.hidden = true;
          const fileCount = Number(json.removed) || 0;
          const annotationCount = Number(json.prunedAnnotations) || 0;
          const parts = [];
          if (fileCount) parts.push(fileCount + ' 个未用文件');
          if (annotationCount) parts.push(annotationCount + ' 条无主批注');
          setState(parts.length ? ('已清理 ' + parts.join('、')) : '没有需要清理的内容');
        } else {
          setState(json.error || '清理失败');
        }
      } catch (err) {
        setState('清理失败');
        console.warn('[画布] 清理附件失败', err);
      } finally {
        cleanBtn.disabled = false;
      }
    });
  }
  const titleEl = document.querySelector('[data-role="title"]');
  const stateEl = document.querySelector('[data-role="save-state"]');
  const backBtn = document.querySelector('[data-action="back"]');
  const exportBtn = document.querySelector('[data-action="export-md"]');
  const exportPngBtn = document.querySelector('[data-action="export-png"]');
  const graphBtn = document.querySelector('[data-action="graph"]');
  const backgroundBtn = document.querySelector('[data-action="background"]');
  const backgroundPanel = document.querySelector('[data-role="background-panel"]');
  let closeBackgroundPanel = null;
  const mindmapBtn = document.querySelector('[data-action="mindmap"]');
  const mindmapMenu = document.querySelector('[data-role="mindmap-menu"]');
  const mindmapPanel = document.querySelector('[data-role="mindmap-panel"]');
  const templateBtn = document.querySelector('[data-action="templates"]');
  const templateMenu = document.querySelector('[data-role="template-menu"]');
  const viewportEl = document.querySelector('[data-role="canvas-viewport"]');
  const guideLayerEl = document.querySelector('[data-role="canvas-guide-layer"]');
  const topbarGuideLayerEl = document.querySelector('[data-role="editor-topbar-guide"]');
  const topBarEl = document.querySelector('.editor-top-bar');
  const pageEl = document.body;
  const openingCoverEl = document.querySelector('[data-role="editor-opening-cover"]');
  const immersiveBackgroundEl = document.querySelector('[data-role="editor-immersive-background"]');
  const renameNotice = document.querySelector('[data-role="rename-notice"]');
  const taskExportNotice = document.querySelector('[data-role="task-export-notice"]');
  const taskExportNoticeTitle = document.querySelector('[data-role="task-export-notice-title"]');
  const taskExportNoticeDetail = document.querySelector('[data-role="task-export-notice-detail"]');
  const taskExportNoticeClose = document.querySelector('[data-role="task-export-notice-close"]');
  const toolbarLanguageSelect = document.querySelector('[data-role="toolbar-language"]');
  const toolbarLanguageLabel = document.querySelector('[data-role="toolbar-language-label"]');
  let taskExportNoticeTimer = null;
  let taskExportNoticeHideTimer = null;

  // 界面语言与起始页共用同一偏好；本文件负责画布特有控件，通用文字由 i18n.js 补齐。
  const TOOLBAR_LANGUAGE_KEY = 'canvas:toolbarLanguage';
  const TOOLBAR_COPY = {
    'zh-CN': {
      back: '起步页', canvas: '画布', mindmap: '导图', patterns: '图案',
      ai: 'AI 助手', graph: '图谱', background: '背景', templates: '模板',
      exportMd: '导出 MD', exportPng: '导出 PNG', tasks: '转为任务',
      tasksConfirm: '确认转为任务', archiveConfirm: '确认归档划线节点',
      backTitle: '返回起步页', aiTitle: 'AI 助手：对话生成 / 整理笔记',
      graphTitle: '查看当前画布的节点关系图谱', backgroundTitle: '设置所有画布共用的背景外观',
      templatesTitle: '我的模板：把常用的一组节点存成模板，拖进画布即可复用',
      exportMdTitle: '把当前画布导出为一组互相关联的 Markdown 文件',
      exportPngTitle: '把整张画布导出为一张高清 PNG 图片（不含 PDF 附件）',
      tasksTitle: '把选中的卡片节点转为学习页待办任务；成功后移除这些卡片',
      archiveTitle: '归档：收走已划删除线的正文节点，未划线节点保留在当前画布',
      modeGroup: '工作模式', actionGroup: '画布操作', languageLabel: '界面语言',
      settingsTitle: '设置', helpTitle: '快捷键速查（?）', helpAria: '快捷键速查',
      formulaTitle: '插入公式 / 数学符号', formulaAria: '插入公式与数学符号',
      textDockAria: '文字格式', textDockCollapse: '收起文字工具栏', textDockExpand: '展开文字工具栏',
      richBodyEditor: '正文富文本编辑器',
      textSize: '字号', textBold: '加粗', textHighlight: '应用高光',
      textColor: '应用文字颜色', textAlign: '对齐', textBind: '吸附与跟随', textClear: '清除格式',
      textSizeSmall: '小字号', textSizeDefault: '默认字号', textSizeLarge: '大字号', textSizeXL: '特大字号',
      textHighlightYellow: '黄色高光', textHighlightBlue: '蓝色高光', textHighlightGreen: '绿色高光',
      textHighlightRed: '红色高光', textHighlightPurple: '紫色高光',
      textColorRed: '红色文字', textColorBlue: '蓝色文字', textColorGreen: '绿色文字',
      textColorOrange: '橙色文字', textColorPurple: '紫色文字',
      textColorRailAria: '柔和颜色', textToneYellow: '柔和黄', textToneOrange: '柔和橙',
      textToneRed: '柔和红', textTonePurple: '柔和紫', textToneBlue: '柔和蓝',
      textToneCyan: '柔和青', textToneGreen: '柔和绿', textToneGray: '柔和灰', textToneWhite: '暖白·仅字色',
      textAlignLeft: '左对齐', textAlignCenter: '居中', textAlignRight: '右对齐',
      textBindToggle: '绑定到所选节点 / 解除跟随', textConvertMindmap: '将文本框转为所选节点的导图子节点',
      canvasSettings: '画布设置', panSpeed: '方向键平移速度', panInertia: '拖拽惯性',
      zoomSpeed: '滚轮缩放速度', checklistDelay: '任务清单出现延迟',
      branchDelay: '分支预展开延迟', indexDelay: '目录出现延迟',
      tooltipHoverDelay: '提示框出现延迟', tooltipHideDelay: '提示框消失延迟',
      codeLanguage: '新建代码节点语言', penPressure: '手写笔压感总开关（含批注钢笔）',
      textSnap: '文本框拖动自动对齐',
      nodeChecklists: '显示节点任务清单', foldControls: '显示收起子节点按钮',
      canvasInspector: '启动《画布》的属性检查器',
      mindmapInspector: '启动思维导图模式的属性检查器',
      decorInspector: '启动图案模式的属性检查器',
      indexHover: '悬停弹出目录',
      selectionIndex: '框选生成索引目录', boxCreate: '空白框选创建盒子', groupCreate: '框选节点创建分组',
      darkLines: '深色模式线条优化',
      darkUi: '深色语义 UI 优化', autosave: '自动保存', view: '视图',
      locateLatest: '定位最近节点', space: '空格', spaceLocate: '空格键定位最近节点',
      centerZoom: '偏好缩放并居中', zoomLevel: '缩放比例',
      canvasNewStyles: '画布 · 新建样式', nodes: '节点', typeAndOutline: '文字与轮廓',
      lines: '线条', inspectorPanel: '属性检查器', patternsMode: '图案模式', graphRelax: '舒展',
      insertShapes: '插入图案', mindMapMode: '思维导图模式', presets: '预设',
      decorCategory: '分类', decorCategoryAll: '全部', decorCategoryDefault: '默认',
      decorCategoryHanddrawn: '手绘', decorCategorySymbol: '符号', decorCategoryAcademic: '学术',
      decorCategoryEngineering: '工程', decorCategoryFlow: '流程', decorCategoryData: '数据',
      decorCategoryDecorative: '装饰', decorCategoryStructure: '组合', decorCategoryEmptyTitle: '暂时留空',
      decorCategoryEmptyHint: '这个分类已经预留，后续再逐步补充克制、实用的图案。',
      colors: '配色', layout: '排版', nodeSize: '节点尺寸', card: '卡片',
      sticky: '便签', table: '表格', newTable: '独立表格',
      style: '样式', quietStyle: '简洁样式', newDefaults: '新建默认',
      editingSelection: '编辑所选', cleanResetDefaults: '恢复简洁默认', nodeFallback: '节点',
      cleanNoteEditingBefore: '正在编辑「', cleanNoteEditingAfter: '」；连线区仍设置新建默认，清空选择后节点区也回到默认。',
      dashedBox: '虚线框', colorBlock: '纯色色块', emphasisNote: '重点便签',
      noteBubble: '旁注框', bracket: '括号标记', divider: '分隔线', cornerFrame: '角标框',
      question: '问号', sketchRect: '手绘圆角矩形', sketchDiamond: '手绘菱形',
      sketchEllipse: '手绘椭圆', sketchArrow: '手绘箭头', insertImage: '插入本地图片',
      symbolIdea: '灵感', symbolCheck: '完成', symbolCross: '错误', symbolFlag: '旗标',
      symbolWarning: '警告', symbolClock: '时间', symbolFlask: '实验',
      symbolReference: '文献', symbolQuote: '引用', symbolInfo: '信息', symbolObservation: '观察',
      moduleBox: '模块框', symbolInterface: '接口', directionArrow: '方向箭头',
      decisionNode: '判断节点', startEndNode: '起止节点', inputOutputNode: '输入 / 输出',
      symbolDatabase: '数据库', symbolDataset: '数据集', symbolFilter: '筛选', curlyBrace: '大括号',
      insertAttachment: '插入 PDF / Markdown 附件', groupPresets: '盒子 / 分组预设',
      globalDefault: '全局默认', classicBranches: '经典枝桠', academicCurves: '学术曲线',
      focusedCenter: '中心聚焦', roundedBranches: '圆角树枝',
      softOrganic: '柔彩自然', monoLines: '黑白直线', tieredTitles: '层级标题',
      blueprintS: '蓝图 S 线', highContrastElbow: '高对比折线', editorialArcs: '杂志弧线',
      nodeContent: '节点内容', contentHint: '选中一个节点后可编辑正文',
      bodyLabel: '正文', bodyNoteDefault: '只在阅读窗口显示',
      bodyHintCard: '卡片正文常驻显示；预览悬停展开；便签正文即主体；代码整块着色。',
      quickColors: '快速配色', nodeColorPresets: '节点配色预设', lineColorPresets: '连线颜色预设',
      stickyRandomColor: '随机换色',
      resetColors: '恢复配色', resetGeometry: '恢复形状与缩放', resetTypography: '恢复文字与轮廓',
      applyCurrentNewStyle: '应用当前新建样式', applyCurrentNewLineStyle: '应用当前新建连线样式',
      resetBuiltInAppearance: '恢复内置朴素外观', resetBuiltInLineStyle: '恢复内置朴素连线',
      resetNewStyleDefaults: '全部新建样式恢复朴素默认', resetLineColor: '恢复连线颜色',
      resetAppearance: '恢复所选节点外观',
      proNoteDefaults: '只影响之后新建的节点与连线；选中单个节点时可直接编辑其属性。',
      proNoteEditingBefore: '正在编辑「', proNoteEditingAfter: '」· 清空选择后回到默认样式。',
      noBodyHint: '当前节点类型不支持正文编辑。可通过上方类型按钮转换为卡片或便签。',
      codeLangLabel: '代码语言',
      bodyNoteCode: '整块只按代码渲染', bodyNoteSticky: '整块即正文，常驻显示',
      bodyNoteCard: '常驻显示在卡片上', bodyNotePreview: '悬停节点时展开',
      bodyNoteIndex: '自动读取相连节点生成目录', bodyNoteNone: '正文仅对卡片/便签/预览/代码/索引节点可用',
      codeLangHint: '只影响当前代码节点的着色；代码不会执行。',
      // 属性检查器（edit panel）动态文本
      epEmpty: '选中一个或多个节点 / 连线来精修样式；多选会批量应用。\n仍可双击新建、粘贴、复制或 Alt 拖出连线；在线身上拖动可加拐点。',
      epNodes: '节点', epBatchEdit: '批量编辑', epMixedBatch: '混合节点批量编辑',
      epSingle: '单选', epCount: ' 个', epEdgeCount: ' 条',
      epBatchNote: '已选 N 个节点，改动会应用到全部。',
      epBatchEdgeNote: '已选 N 条连线，改动会应用到全部。',
      epCreateGroup: '建立分组',
      epMindmapStyle: '思维导图样式', epFollowPreset: '跟随预设',
      epMixedSelection: '混合选择', epManualColorSize: '手工配色与尺寸',
      epManualColor: '手工配色', epManualSize: '手工尺寸',
      epResetPresetColor: '恢复预设配色', epResetAutoSize: '恢复自动尺寸',
      epMindmapHint: '编辑颜色或尺寸会转为手工值；恢复后会继续跟随脑图分支和层级。',
      epResetAppearance: '恢复所选节点外观',
      epAppliedColors: '已应用配色', epAppliedLineColor: '已应用连线颜色',
      epRestoredColors: '已恢复所选配色', epRestoredGeometry: '已恢复所选形状与缩放',
      epRestoredTypography: '已恢复所选文字与轮廓',
      epAppliedDefaults: '已应用当前新建样式', epAppliedDefaultsSkipped: '已应用当前新建样式，并跳过 N 个脑图节点',
      epAppliedEdgeDefaults: '已应用当前新建连线样式', epAppliedEdgeDefaultsSkipped: '已应用当前新建连线样式，并跳过 N 条脑图连线',
      epNormalDefaultsMindmapOnly: '脑图节点请使用“恢复预设配色 / 自动尺寸”',
      epNormalDefaultsMindmapEdgeOnly: '脑图连线请使用“恢复脑图预设样式”',
      epRestoredBuiltIn: '已恢复内置朴素外观', epRestoredBuiltInLine: '已恢复内置朴素连线',
      epConvertHint: '转换会保留标题；索引按连接关系自动生成目录，卡片正文常驻显示，预览悬停展开，代码只做语法着色。',
      epConvertNormal: '转换为普通节点', epConvertNormalHint: '仅保留标题，正文会在确认后清除。',
      epConvertContentHint: '当前内容会完整保存为正文，首行成为可见标题，可撤销。',
      epEdgeBatch: '脑图连线批量编辑', epEdgeMixed: '混合连线批量编辑',
      epEdgeMindmap: '脑图连线', epEdgeCurrent: '当前连线',
      epClearWaypoints: '清除所有拐点', epResetEdge: '恢复所选连线样式',
      epKindIndex: '索引节点', epKindCode: '代码节点', epKindSticky: '便签节点',
      epKindCard: '卡片节点', epKindPreview: '预览节点', epKindNormal: '普通节点',
      epConvertIndex: '转换为索引节点', epConvertPreview: '转换为预览节点',
      epConvertCard: '转换为卡片节点', epConvertCode: '转换为代码节点',
      epOpenReader: '阅读（F）',
      epCodeLangHint: '只影响当前代码节点的着色；代码不会执行，也不会解析 Markdown 或数学公式。',
      epBodyHintCode: 'Preserves spaces, line breaks and indentation; Markdown, links and math are not parsed.',
      epBodyHintSticky: 'Select text to add highlights, text color or font size; body supports Markdown / math / code blocks.',
      epBodyHintCard: 'Select text to add highlights, text color or font size; body is shown inline on the card.',
      epBodyHintPreview: 'Select text to add highlights, text color or font size; hover on the node to preview.',
      epBodyHintIndex: 'Select text to add highlights, text color or font size; press F to read the index body.',
      epConvertConfirmTitle: '变为普通节点后，正文内容将被清除。',
      epConvertConfirmDetail: '仅保留标题：',
      epConvertConfirmOk: '确认',
    },
    en: {
      back: 'Home', canvas: 'Canvas', mindmap: 'Mind Map', patterns: 'Shapes',
      ai: 'AI', graph: 'Graph', background: 'Background', templates: 'Templates',
      exportMd: 'Markdown', exportPng: 'PNG', tasks: 'Tasks',
      tasksConfirm: 'Confirm Tasks', archiveConfirm: 'Confirm Archive',
      backTitle: 'Back to home', aiTitle: 'AI Assistant: generate and organize notes',
      graphTitle: 'View relationships between nodes on this canvas',
      backgroundTitle: 'Set the background shared by all canvases',
      templatesTitle: 'Reuse saved groups of nodes as templates',
      exportMdTitle: 'Export this canvas as linked Markdown files',
      exportPngTitle: 'Export the full canvas as a high-resolution PNG (PDF attachments excluded)',
      tasksTitle: 'Turn selected card nodes into study tasks and remove them from this canvas',
      archiveTitle: 'Archive body nodes with strikethrough; keep all other nodes on this canvas',
      modeGroup: 'Workspace mode', actionGroup: 'Canvas actions', languageLabel: 'Interface language',
      settingsTitle: 'Settings', helpTitle: 'Keyboard shortcuts (?)', helpAria: 'Keyboard shortcuts',
      formulaTitle: 'Insert formulas / math symbols', formulaAria: 'Insert formulas and math symbols',
      textDockAria: 'Text formatting', textDockCollapse: 'Collapse text toolbar', textDockExpand: 'Expand text toolbar',
      richBodyEditor: 'Rich text body editor',
      textSize: 'Text size', textBold: 'Bold', textHighlight: 'Apply highlight',
      textColor: 'Apply text color', textAlign: 'Alignment', textBind: 'Snap and follow', textClear: 'Clear formatting',
      textSizeSmall: 'Small text', textSizeDefault: 'Default text size', textSizeLarge: 'Large text', textSizeXL: 'Extra-large text',
      textHighlightYellow: 'Yellow highlight', textHighlightBlue: 'Blue highlight', textHighlightGreen: 'Green highlight',
      textHighlightRed: 'Red highlight', textHighlightPurple: 'Purple highlight',
      textColorRed: 'Red text', textColorBlue: 'Blue text', textColorGreen: 'Green text',
      textColorOrange: 'Orange text', textColorPurple: 'Purple text',
      textColorRailAria: 'Soft colors', textToneYellow: 'Soft yellow', textToneOrange: 'Soft orange',
      textToneRed: 'Soft red', textTonePurple: 'Soft purple', textToneBlue: 'Soft blue',
      textToneCyan: 'Soft cyan', textToneGreen: 'Soft green', textToneGray: 'Soft gray', textToneWhite: 'Warm white · text only',
      textAlignLeft: 'Align left', textAlignCenter: 'Center', textAlignRight: 'Align right',
      textBindToggle: 'Bind to selected node / stop following', textConvertMindmap: 'Convert text box to child of selected node',
      canvasSettings: 'Canvas Settings', panSpeed: 'Arrow-key pan speed', panInertia: 'Drag momentum',
      zoomSpeed: 'Scroll zoom speed', checklistDelay: 'Checklist delay',
      branchDelay: 'Branch preview delay', indexDelay: 'Index preview delay',
      tooltipHoverDelay: 'Tooltip delay', tooltipHideDelay: 'Tooltip hide delay',
      codeLanguage: 'Default code language', penPressure: 'Pen pressure (including annotations)',
      textSnap: 'Align text boxes while dragging',
      nodeChecklists: 'Show node checklists', foldControls: 'Show branch controls',
      canvasInspector: 'Enable the Canvas inspector',
      mindmapInspector: 'Enable inspector in Mind Map mode',
      decorInspector: 'Enable inspector in Shapes mode',
      indexHover: 'Preview index on hover',
      selectionIndex: 'Offer index from selection', boxCreate: 'Box from empty selection', groupCreate: 'Group selected nodes',
      darkLines: 'Optimize lines on dark backgrounds',
      darkUi: 'Dark semantic UI', autosave: 'Autosave', view: 'View',
      locateLatest: 'Locate latest node', space: 'Space', spaceLocate: 'Space locates latest node',
      centerZoom: 'Center at preferred zoom', zoomLevel: 'Zoom level',
      canvasNewStyles: 'Canvas · New Styles', nodes: 'Nodes', typeAndOutline: 'Type & Outline',
      lines: 'Lines', inspectorPanel: 'Inspector', patternsMode: 'Shapes Mode', graphRelax: 'Relax',
      insertShapes: 'Insert Shapes', mindMapMode: 'Mind Map Mode', presets: 'Presets',
      decorCategory: 'Category', decorCategoryAll: 'All', decorCategoryDefault: 'Default',
      decorCategoryHanddrawn: 'Hand-drawn', decorCategorySymbol: 'Symbols', decorCategoryAcademic: 'Academic',
      decorCategoryEngineering: 'Engineering', decorCategoryFlow: 'Flow', decorCategoryData: 'Data',
      decorCategoryDecorative: 'Decorative', decorCategoryStructure: 'Structures', decorCategoryEmptyTitle: 'Reserved for later',
      decorCategoryEmptyHint: 'This category is ready for restrained, practical shapes to be added later.',
      colors: 'Colors', layout: 'Layout', nodeSize: 'Node Size', card: 'Card',
      sticky: 'Sticky', table: 'Table', newTable: 'Standalone Table',
      style: 'Style', quietStyle: 'Quiet Style', newDefaults: 'New Defaults',
      editingSelection: 'Edit Selection', cleanResetDefaults: 'Reset Minimal Defaults', nodeFallback: 'Node',
      cleanNoteEditingBefore: 'Editing "', cleanNoteEditingAfter: '"; line controls still set new defaults. Clear selection to return node controls to defaults.',
      dashedBox: 'Dashed Box', colorBlock: 'Color Block', emphasisNote: 'Emphasis Note',
      noteBubble: 'Side Note', bracket: 'Bracket', divider: 'Divider', cornerFrame: 'Corner Frame',
      question: 'Question', sketchRect: 'Sketch Rectangle', sketchDiamond: 'Sketch Diamond',
      sketchEllipse: 'Sketch Ellipse', sketchArrow: 'Sketch Arrow', insertImage: 'Insert Local Image',
      symbolIdea: 'Idea', symbolCheck: 'Done', symbolCross: 'Incorrect', symbolFlag: 'Flag',
      symbolWarning: 'Warning', symbolClock: 'Time', symbolFlask: 'Experiment',
      symbolReference: 'Reference', symbolQuote: 'Quote', symbolInfo: 'Information', symbolObservation: 'Observation',
      moduleBox: 'Module Box', symbolInterface: 'Interface', directionArrow: 'Direction Arrow',
      decisionNode: 'Decision Node', startEndNode: 'Start / End', inputOutputNode: 'Input / Output',
      symbolDatabase: 'Database', symbolDataset: 'Dataset', symbolFilter: 'Filter', curlyBrace: 'Curly Brace',
      insertAttachment: 'Insert PDF / Markdown', groupPresets: 'Box / Group Presets',
      globalDefault: 'Global Default', classicBranches: 'Classic Branches', academicCurves: 'Academic Curves',
      focusedCenter: 'Focused Center', roundedBranches: 'Rounded Branches',
      softOrganic: 'Soft Organic', monoLines: 'Monochrome Lines', tieredTitles: 'Tiered Titles',
      blueprintS: 'Blueprint S', highContrastElbow: 'High-Contrast Elbow', editorialArcs: 'Editorial Arcs',
      nodeContent: 'Node Content', contentHint: 'Select a node to edit its body',
      bodyLabel: 'Body', bodyNoteDefault: 'Shown in reader only',
      bodyHintCard: 'Card body shown inline; Preview on hover; Sticky shows full body; Code block with syntax highlighting.',
      quickColors: 'Quick Colors', nodeColorPresets: 'Node color presets', lineColorPresets: 'Edge color presets',
      stickyRandomColor: 'Random Color',
      resetColors: 'Reset Colors', resetGeometry: 'Reset Shape & Scale', resetTypography: 'Reset Type & Outline',
      applyCurrentNewStyle: 'Apply Current New-Node Style', applyCurrentNewLineStyle: 'Apply Current New-Edge Style',
      resetBuiltInAppearance: 'Reset to Built-in Plain Style', resetBuiltInLineStyle: 'Reset to Built-in Plain Edge',
      resetNewStyleDefaults: 'Reset All New Styles to Plain Defaults', resetLineColor: 'Reset Edge Color',
      resetAppearance: 'Reset Selected Node Appearance',
      proNoteDefaults: 'Changes apply to newly created nodes & lines; select a single node to edit it directly.',
      proNoteEditingBefore: 'Editing "', proNoteEditingAfter: '" · Clear selection to return to defaults.',
      noBodyHint: 'This node type does not support body editing. Convert to Card or Sticky using the type buttons above.',
      codeLangLabel: 'Code Language',
      bodyNoteCode: 'Code block only — no Markdown', bodyNoteSticky: 'Full body shown on canvas',
      bodyNoteCard: 'Body shown inline on card', bodyNotePreview: 'Body shown on hover',
      bodyNoteIndex: 'Auto-generated from linked nodes', bodyNoteNone: 'Body only available for Card / Sticky / Preview / Code / Index nodes',
      codeLangHint: 'Affects syntax highlighting only; code is not executed.',
      // Inspector (edit panel) dynamic text
      epEmpty: 'Select one or more nodes / edges to refine their style; multi-select applies changes to all.\nDouble-click, paste, copy and Alt-drag connections still work; drag on a line to add waypoints.',
      epNodes: 'Nodes', epBatchEdit: 'Batch Edit', epMixedBatch: 'Mixed Nodes Batch Edit',
      epSingle: 'Single', epCount: ' items', epEdgeCount: ' edges',
      epBatchNote: 'N nodes selected — changes apply to all.',
      epBatchEdgeNote: 'N edges selected — changes apply to all.',
      epCreateGroup: 'Create Group',
      epMindmapStyle: 'Mind Map Style', epFollowPreset: 'Following Preset',
      epMixedSelection: 'Mixed Selection', epManualColorSize: 'Manual Color & Size',
      epManualColor: 'Manual Color', epManualSize: 'Manual Size',
      epResetPresetColor: 'Reset to Preset Color', epResetAutoSize: 'Reset to Auto Size',
      epMindmapHint: 'Editing color or size switches to manual; reset to follow the branch preset again.',
      epResetAppearance: 'Reset Selected Node Appearance',
      epAppliedColors: 'Colors applied', epAppliedLineColor: 'Edge color applied',
      epRestoredColors: 'Selected colors restored', epRestoredGeometry: 'Selected shapes and scale restored',
      epRestoredTypography: 'Selected type and outline restored',
      epAppliedDefaults: 'Current new-node style applied', epAppliedDefaultsSkipped: 'New-node style applied; skipped N mind map nodes',
      epAppliedEdgeDefaults: 'Current new-edge style applied', epAppliedEdgeDefaultsSkipped: 'New-edge style applied; skipped N mind map edges',
      epNormalDefaultsMindmapOnly: 'Use preset color / auto size reset for mind map nodes',
      epNormalDefaultsMindmapEdgeOnly: 'Use the mind map preset reset for mind map edges',
      epRestoredBuiltIn: 'Built-in plain style restored', epRestoredBuiltInLine: 'Built-in plain edge restored',
      epConvertHint: 'Conversion preserves the title; Index auto-generates a table of contents from links, Card shows body inline, Preview shows on hover, Code with syntax highlighting.',
      epConvertNormal: 'Convert to Plain Node', epConvertNormalHint: 'Only the title is kept; body content will be cleared after confirmation.',
      epConvertContentHint: 'Current content is preserved as body; the first line becomes the visible title. Undo supported.',
      epEdgeBatch: 'Mind Map Edges Batch Edit', epEdgeMixed: 'Mixed Edges Batch Edit',
      epEdgeMindmap: 'Mind Map Edge', epEdgeCurrent: 'Current Edge',
      epClearWaypoints: 'Clear All Waypoints', epResetEdge: 'Reset Selected Edge Style',
      epKindIndex: 'Index Node', epKindCode: 'Code Node', epKindSticky: 'Sticky Node',
      epKindCard: 'Card Node', epKindPreview: 'Preview Node', epKindNormal: 'Plain Node',
      epConvertIndex: 'Convert to Index', epConvertPreview: 'Convert to Preview',
      epConvertCard: 'Convert to Card', epConvertCode: 'Convert to Code',
      epOpenReader: 'Read (F)',
      epCodeLangHint: 'Affects syntax highlighting only; code is not executed and Markdown / math are not parsed.',
      epBodyHintCode: 'Preserves spaces, line breaks and indentation; Markdown, links and math are not parsed.',
      epBodyHintSticky: 'Select text to add highlights, text color or font size; body supports Markdown / math / code blocks.',
      epBodyHintCard: 'Select text to add highlights, text color or font size; body is shown inline on the card.',
      epBodyHintPreview: 'Select text to add highlights, text color or font size; hover on the node to preview.',
      epBodyHintIndex: 'Select text to add highlights, text color or font size; press F to read the index body.',
      epConvertConfirmTitle: 'Body content will be cleared after converting to a plain node.',
      epConvertConfirmDetail: 'Only the title will be kept: ',
      epConvertConfirmOk: 'Confirm',
    },
  };
  const STATUS_COPY_EN = {
    '已保存': 'Saved',
    '未保存': 'Unsaved',
    '保存中…': 'Saving…',
    '打开失败': 'Open failed',
    '加载失败': 'Load failed',
    '清理失败': 'Cleanup failed',
    '没有需要清理的内容': 'Nothing to clean',
    '选择导出父目录…': 'Choose an export folder…',
    '正在合成图片…': 'Rendering image…',
    '选择保存位置…': 'Choose where to save…',
    '正在转为任务…': 'Creating tasks…',
    '任务已创建，正在刷新同步…': 'Tasks created · Syncing…',
    '归档中…': 'Archiving…',
    '已归档，正在刷新同步…': 'Archived · Syncing…',
    '保存失败': 'Save failed',
  };
  let toolbarLanguage = 'zh-CN';
  try { toolbarLanguage = localStorage.getItem(TOOLBAR_LANGUAGE_KEY) === 'en' ? 'en' : 'zh-CN'; } catch (e) {}

  function toolbarCopy(key) {
    const copy = TOOLBAR_COPY[toolbarLanguage] || TOOLBAR_COPY['zh-CN'];
    return copy[key] || TOOLBAR_COPY['zh-CN'][key] || key;
  }
  window.__tc = toolbarCopy;

  function canvasFontWeightInfo(node, fallbackKind) {
    if (window.CanvasModule && typeof window.CanvasModule.nodeFontWeightInfo === 'function') {
      return window.CanvasModule.nodeFontWeightInfo(node, fallbackKind);
    }
    const explicit = node && node.fontWeight != null && Number.isFinite(Number(node.fontWeight));
    return { value: explicit ? Number(node.fontWeight) : 400, isDefault: !explicit, bodyValue: null };
  }

  function canvasFontWeightLabel(info) {
    if (window.CanvasModule && typeof window.CanvasModule.nodeFontWeightLabel === 'function') {
      return window.CanvasModule.nodeFontWeightLabel(info, toolbarLanguage === 'en');
    }
    return String(info && info.value != null ? info.value : 400);
  }

  function canvasFontWeightDefaultInfo(node, fallbackKind) {
    if (window.CanvasModule && typeof window.CanvasModule.nodeFontWeightDefaultInfo === 'function') {
      return window.CanvasModule.nodeFontWeightDefaultInfo(node, fallbackKind);
    }
    return { value: 400, isDefault: true, bodyValue: null };
  }

  function translateTopbarStatus(label) {
    if (toolbarLanguage !== 'en' || !label) return label;
    if (STATUS_COPY_EN[label]) return STATUS_COPY_EN[label];
    if (label.indexOf('已清理 ') === 0) return 'Cleaned · ' + label.slice(4);
    return label;
  }

  function refreshModeAccessibility() {
    const sw = document.querySelector('[data-role="mode-switch"]');
    if (!sw) return;
    const descriptions = toolbarLanguage === 'en'
      ? {
          normal: 'Canvas mode for freely creating and arranging content',
          mindmap: 'Mind Map mode for organizing branches around a central idea',
          decor: 'Shapes mode for adding and adjusting visual elements',
        }
      : {
          normal: '画布模式：自由创建和整理内容',
          mindmap: '导图模式：围绕中心节点整理分支布局',
          decor: '图案模式：插入和调整装饰图案或图片',
        };
    const activeMode = document.body.dataset.mode || 'normal';
    const submode = document.body.dataset.modeSubmode || 'clean';
    sw.querySelectorAll('.editor-mode-btn').forEach((button) => {
      const active = button.dataset.mode === activeMode;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      let label = descriptions[button.dataset.mode] || '';
      if (active) {
        label += toolbarLanguage === 'en'
          ? (submode === 'full'
              ? '. Full controls are visible; click again for the quiet view'
              : '. Quiet view is active; click again for full controls')
          : (submode === 'full'
              ? '。当前显示完整工具；再次点击切换为简洁状态'
              : '。当前为简洁状态；再次点击显示完整工具');
      }
      button.setAttribute('aria-label', label);
      button.title = label;
    });
  }

  function applyToolbarLanguage(nextLanguage, persist) {
    toolbarLanguage = nextLanguage === 'en' ? 'en' : 'zh-CN';
    if (persist) {
      try { localStorage.setItem(TOOLBAR_LANGUAGE_KEY, toolbarLanguage); } catch (e) {}
    }
    document.body.dataset.toolbarLanguage = toolbarLanguage;
    if (topBarEl) topBarEl.lang = toolbarLanguage;
    document.querySelectorAll('[data-toolbar-i18n]').forEach((element) => {
      element.textContent = toolbarCopy(element.dataset.toolbarI18n);
    });
    document.querySelectorAll('[data-toolbar-i18n-title]').forEach((element) => {
      element.title = toolbarCopy(element.dataset.toolbarI18nTitle);
    });
    document.querySelectorAll('[data-editor-i18n]').forEach((element) => {
      element.textContent = toolbarCopy(element.dataset.editorI18n);
    });
    document.querySelectorAll('[data-editor-i18n-title]').forEach((element) => {
      element.title = toolbarCopy(element.dataset.editorI18nTitle);
    });
    document.querySelectorAll('[data-editor-i18n-aria]').forEach((element) => {
      element.setAttribute('aria-label', toolbarCopy(element.dataset.editorI18nAria));
    });
    const modeSwitch = document.querySelector('[data-role="mode-switch"]');
    const quickActions = document.querySelector('.editor-quick-actions');
    const settingsPop = document.querySelector('[data-role="settings-pop"]');
    if (settingsPop) settingsPop.lang = toolbarLanguage;
    if (modeSwitch) modeSwitch.setAttribute('aria-label', toolbarCopy('modeGroup'));
    if (quickActions) quickActions.setAttribute('aria-label', toolbarCopy('actionGroup'));
    if (toolbarLanguageLabel) toolbarLanguageLabel.textContent = toolbarCopy('languageLabel');
    if (toolbarLanguageSelect) {
      toolbarLanguageSelect.value = toolbarLanguage;
      toolbarLanguageSelect.setAttribute('aria-label', toolbarCopy('languageLabel'));
    }
    const archiveButton = document.querySelector('[data-action="archive"]');
    if (archiveButton) archiveButton.setAttribute('aria-label', toolbarCopy('archiveTitle'));
    const tasksButton = document.querySelector('[data-action="export-tasks"]');
    if (tasksButton) {
      tasksButton.setAttribute('aria-label', toolbarCopy('tasksTitle'));
      const confirmCount = Number(tasksButton.dataset.confirmCount) || 0;
      const confirmLabel = tasksButton.querySelector('.task-export-confirm-label');
      if (confirmLabel && confirmCount > 0) {
        confirmLabel.textContent = toolbarLanguage === 'en'
          ? ('Confirm ' + confirmCount + (confirmCount === 1 ? ' Task' : ' Tasks'))
          : ('确认转为 ' + confirmCount + ' 个任务');
      }
    }
    if (stateEl) stateEl.textContent = translateTopbarStatus(stateEl.dataset.sourceLabel || '');
    refreshModeAccessibility();
    document.dispatchEvent(new CustomEvent('editor:languagechange'));
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  if (toolbarLanguageSelect) {
    toolbarLanguageSelect.addEventListener('change', () => {
      applyToolbarLanguage(toolbarLanguageSelect.value, true);
    });
  }
  applyToolbarLanguage(toolbarLanguage, false);

  function hideTaskExportNotice() {
    if (!taskExportNotice) return;
    if (taskExportNoticeTimer) {
      clearTimeout(taskExportNoticeTimer);
      taskExportNoticeTimer = null;
    }
    taskExportNotice.classList.remove('show');
    if (taskExportNoticeHideTimer) clearTimeout(taskExportNoticeHideTimer);
    taskExportNoticeHideTimer = setTimeout(() => {
      taskExportNotice.hidden = true;
      taskExportNoticeHideTimer = null;
    }, 220);
  }

  function showTaskExportNotice(title, detail, tone) {
    if (!taskExportNotice) return;
    if (taskExportNoticeTimer) clearTimeout(taskExportNoticeTimer);
    if (taskExportNoticeHideTimer) {
      clearTimeout(taskExportNoticeHideTimer);
      taskExportNoticeHideTimer = null;
    }
    if (taskExportNoticeTitle) taskExportNoticeTitle.textContent = title || '转为任务';
    if (taskExportNoticeDetail) taskExportNoticeDetail.textContent = detail || '';
    taskExportNotice.dataset.tone = tone || 'info';
    taskExportNotice.hidden = false;
    requestAnimationFrame(() => taskExportNotice.classList.add('show'));
    taskExportNoticeTimer = setTimeout(hideTaskExportNotice, tone === 'error' ? 5600 : 4400);
  }

  if (taskExportNoticeClose) {
    taskExportNoticeClose.addEventListener('click', hideTaskExportNotice);
  }

  function closeRenameNotice() {
    if (renameNotice) renameNotice.hidden = true;
    if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
      window.CanvasModule.setExternalOverlayOpen(false);
    }
  }

  function showRenameNotice(message) {
    if (!renameNotice) {
      window.alert(message);
      return;
    }
    const detail = renameNotice.querySelector('[data-role="rename-notice-detail"]');
    if (detail) detail.textContent = message || '重命名失败';
    renameNotice.hidden = false;
    if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
      window.CanvasModule.setExternalOverlayOpen(true);
    }
  }

  if (renameNotice) {
    const closeBtn = renameNotice.querySelector('[data-role="rename-notice-close"]');
    if (closeBtn) closeBtn.addEventListener('click', closeRenameNotice);
    renameNotice.addEventListener('mousedown', (event) => {
      if (event.target === renameNotice) closeRenameNotice();
    });
    document.addEventListener('keydown', (event) => {
      if (!renameNotice.hidden && event.key === 'Escape') {
        event.preventDefault();
        closeRenameNotice();
      }
    });
  }

  // 顶栏标题先用文件名占位（文件名从 URL 即可算出），避免先显示"画布"再被 /api/load 覆盖造成闪烁
  if (titleEl && filePath) {
    titleEl.textContent = filePath.split(/[\\/]/).pop().replace(/\.canvas$/i, '');
  }

  let enteredFromStart = false;
  try {
    enteredFromStart = sessionStorage.getItem('canvas:route-from-start') === '1';
    sessionStorage.removeItem('canvas:route-from-start');
  } catch (e) {}
  if (enteredFromStart) {
    pageEl.classList.add('canvas-route-entering');
    window.setTimeout(() => pageEl.classList.remove('canvas-route-entering'), 280);
  }

  function setState(label) {
    if (!stateEl) return;
    stateEl.dataset.sourceLabel = label || '';
    stateEl.textContent = translateTopbarStatus(label || '');
  }

  // 顶栏入场：内容就位后移除 topbar-pending，让顶栏从顶部滑入（见 styles.css）。
  // 加载成功 / 失败都会调用；再加一道超时兜底，避免异常时顶栏一直藏着。
  let topBarRevealed = false;
  function revealTopBar() {
    if (topBarRevealed) return;
    topBarRevealed = true;
    document.body.classList.remove('topbar-pending');
    document.body.classList.add('canvas-ready');
  }

  let editorOpeningFinished = false;
  function finishEditorOpening() {
    if (editorOpeningFinished) return;
    editorOpeningFinished = true;
    document.body.classList.remove('background-initializing');
    revealTopBar();
    // 背景、画布和深色语义样式先在遮罩下完整绘制，再统一淡出遮罩。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.add('editor-opening-ready');
        if (openingCoverEl) {
          openingCoverEl.addEventListener('transitionend', () => openingCoverEl.remove(), { once: true });
        }
        document.dispatchEvent(new CustomEvent('editor:ready', {
          detail: { fresh: FRESH, embed: EMBED, nodes: canvasData && Array.isArray(canvasData.nodes) ? canvasData.nodes.length : 0 },
        }));
      });
    });
  }
  // 本地资源正常会远早于此完成；这里只防极端异常导致遮罩永久不退。
  window.setTimeout(finishEditorOpening, 10000);

  // 返回起步页：自动保存开启时先等待最新内容确实落盘，再开始离场动画。
  let leavingToStart = false;
  if (backBtn) {
    backBtn.addEventListener('click', async () => {
      if (leavingToStart || pageEl.classList.contains('start-route-leaving')) return;
      leavingToStart = true;
      commitPendingCanvasEdits();
      if (dirty && (EMBED || autosaveEnabled())) {
        const saved = await save();
        if (!saved) {
          leavingToStart = false;
          window.alert('当前画布保存失败，已留在本页。请稍后重试或按 Ctrl+S。');
          return;
        }
      }
      pageEl.classList.add('start-route-leaving');
      // 先让与起步页主题一致的纯色层完成一帧绘制，再切换文档。若本页确实从起步页进入，
      // history.back() 通常可直接恢复原页面（含已加载的夜空），避免重新导航的清屏间隙。
      window.setTimeout(() => {
        if (enteredFromStart && window.history.length > 1) {
          window.history.back();
        } else {
          window.location.href = FROM_STUDY ? 'index.html?view=study' : 'index.html';
        }
        // beforeunload 确认框若被用户取消，当前文档不会离开；稍后自动恢复可操作状态。
        window.setTimeout(() => {
          pageEl.classList.remove('start-route-leaving');
          leavingToStart = false;
        }, 1200);
      }, 70);
    });
  }

  // ── 模式切换骨架（5-0b）──────────────────────────
  // 顶栏只保留画布 / 导图 / 图案。旧专业模式并入新建样式，旧编辑模式
  // 改成随选择自动出现的属性检查器；历史 localStorage 值在这里迁回画布模式。
  // 三种模式各自记忆 full / clean 子模式：full 带淡黄高光并允许属性检查器，
  // clean 隐藏顶栏动作区且不让对象选择唤起属性检查器。重复点击当前模式切换子模式；
  // 切到其它模式时恢复该模式上次状态。首次没有偏好数据时三者都默认 clean。
  (function setupModeSwitch() {
    const sw = document.querySelector('[data-role="mode-switch"]');
    if (!sw) return;
    const btns = sw.querySelectorAll('.editor-mode-btn');
    const slider = sw.querySelector('[data-role="mode-slider"]');
    const hoverLine = sw.querySelector('[data-role="mode-hover-line"]');
    let sliderReady = false;
    // 把黑色滑块移到当前激活按钮处；首次（与窗口尺寸变化）瞬时定位，之后滑动过渡。
    function placeSlider(animate) {
      if (!slider) return;
      const active = sw.querySelector('.editor-mode-btn.active');
      if (!active || !active.offsetWidth) return;   // 内嵌/隐藏顶栏时按钮量不到，跳过
      if (!animate) slider.classList.add('no-transition');
      slider.style.width = active.offsetWidth + 'px';
      slider.style.height = active.offsetHeight + 'px';
      slider.style.transform = 'translate3d(' + active.offsetLeft + 'px,' + active.offsetTop + 'px,0)';
      slider.classList.add('show');
      if (!animate) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { slider.classList.remove('no-transition'); });
        });
      }
    }
    // 旧版双滑块语义：短线只跟随当前模式，不再在悬停时提前游走。
    function placeHoverLine(button) {
      if (!hoverLine || !button || !button.offsetWidth) return;
      const style = getComputedStyle(button);
      const color = style.getPropertyValue('--mode-line-color').trim();
      const shadow = style.getPropertyValue('--mode-line-shadow').trim();
      hoverLine.style.width = Math.max(18, button.offsetWidth - 20) + 'px';
      hoverLine.style.transform = 'translate3d(' + (button.offsetLeft + 10) + 'px,0,0)';
      if (color) hoverLine.style.setProperty('--mode-line-color', color);
      if (shadow) hoverLine.style.setProperty('--mode-line-shadow', shadow);
    }
    function restoreHoverLine() {
      const active = sw.querySelector('.editor-mode-btn.active');
      placeHoverLine(active);
    }
    const VALID = ['normal', 'mindmap', 'decor'];
    let mode = 'normal';
    try { mode = localStorage.getItem('canvas:mode') || 'normal'; } catch (e) {}
    if (mode === 'pro' || mode === 'edit') mode = 'normal';
    if (VALID.indexOf(mode) < 0) mode = 'normal';
    const SUBMODE_KEYS = {
      normal: 'canvas:normalSubmode',
      mindmap: 'canvas:mindmapSubmode',
      decor: 'canvas:decorSubmode',
    };
    const submodes = {};
    VALID.forEach((name) => {
      const defaultValue = name === 'decor' ? 'full' : 'clean';
      let value = defaultValue;
      try { value = localStorage.getItem(SUBMODE_KEYS[name]) || defaultValue; } catch (e) {}
      submodes[name] = (value === 'clean' || value === 'full') ? value : defaultValue;
    });

    // 新建画布首次打开 → 默认简洁普通模式
    if (FRESH) { mode = 'normal'; submodes.normal = 'clean'; }
    // 内嵌浮窗：强制正常普通模式（顶栏已藏、无法切模式），保留完整编辑能力。
    if (EMBED) { mode = 'normal'; submodes.normal = 'full'; }

    function apply() {
      const submode = submodes[mode] || 'clean';
      document.body.dataset.mode = mode;
      document.body.dataset.modeSubmode = submode;
      document.body.dataset.normalSubmode = submodes.normal;
      btns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      refreshModeAccessibility();
      placeSlider(sliderReady);   // 首次瞬时落位，之后滑动
      restoreHoverLine();
      sliderReady = true;
      if (!EMBED) {
        try {
          localStorage.setItem('canvas:mode', mode);
          VALID.forEach((name) => localStorage.setItem(SUBMODE_KEYS[name], submodes[name]));
        } catch (e) {}
      }
      // canvas.js 只关心三种工作方式；属性检查器由 selectionchange 独立驱动。
      if (window.CanvasModule && typeof window.CanvasModule.setMode === 'function') {
        window.CanvasModule.setMode(mode);
      }
      // 广播模式/子模式变化：供普通模式大小两套默认面板同步有效的新建类型。
      document.dispatchEvent(new CustomEvent('editor:modechange', { detail: { mode: mode, submode: submode } }));
    }
    window.EditorShell = window.EditorShell || {};
    window.EditorShell.setMode = function (nextMode) {
      if (VALID.indexOf(nextMode) < 0) return;
      mode = nextMode;
      apply();
    };
    window.EditorShell.setModeSubmode = function (nextSubmode) {
      if (nextSubmode !== 'clean' && nextSubmode !== 'full') return;
      submodes[mode] = nextSubmode;
      apply();
    };
    btns.forEach((b) => b.addEventListener('click', () => {
      const target = b.dataset.mode;
      if (mode === target) submodes[target] = submodes[target] === 'clean' ? 'full' : 'clean';
      else mode = target;
      apply();
    }));
    btns.forEach((button) => {
      button.addEventListener('mouseenter', () => {
        sw.classList.add('mode-hovering');
        placeHoverLine(button);
      });
      button.addEventListener('focus', () => {
        sw.classList.add('mode-hovering');
        placeHoverLine(button);
      });
    });
    sw.addEventListener('mouseleave', () => {
      sw.classList.remove('mode-hovering');
      restoreHoverLine();
    });
    sw.addEventListener('focusout', (event) => {
      if (event.relatedTarget && sw.contains(event.relatedTarget)) return;
      sw.classList.remove('mode-hovering');
      restoreHoverLine();
    });
    apply();   // 初始化：恢复上次模式 / 子模式 + 高亮 + 打 body 标记
    // 窗口尺寸变化 / 字体加载完成后，按钮宽度可能变 → 瞬时重新对齐滑块
    window.addEventListener('resize', function () {
      placeSlider(false);
      restoreHoverLine();
    });
    window.addEventListener('load', function () {
      placeSlider(false);
      restoreHoverLine();
    });
  })();

  // ── 统一属性检查器：有对象被选中就出现，无选择时回到新建样式 ──
  (function setupInspectorShell() {
    const panels = [...document.querySelectorAll(
      '.side-panel[data-role="pro-panel"], .side-panel[data-role="edit-panel"], '
      + '.side-panel[data-role="mindmap-panel"], .side-panel[data-role="decor-panel"]'
    )];
    let selection = { nodes: 0, contentNodes: 0, decorNodes: 0, edges: 0, arrow: false };
    let canvasPointerDown = false;
    let pendingView = null;
    let canvasInspectorPreferenceEnabled = true;
    let mindmapInspectorPreferenceEnabled = true;
    let decorInspectorPreferenceEnabled = true;
    try {
      canvasInspectorPreferenceEnabled = localStorage.getItem('canvas:inspectorEnabled') !== '0';
      mindmapInspectorPreferenceEnabled = localStorage.getItem('canvas:mindmapInspectorEnabled') === '1';
      decorInspectorPreferenceEnabled = localStorage.getItem('canvas:decorInspectorEnabled') !== '0';
    } catch (e) {}

    function inspectorEnabled() {
      const mode = document.body.dataset.mode || 'normal';
      const preferenceEnabled = mode === 'normal'
        ? canvasInspectorPreferenceEnabled
        : mode === 'mindmap'
          ? mindmapInspectorPreferenceEnabled
          : decorInspectorPreferenceEnabled;
      return preferenceEnabled && document.body.dataset.modeSubmode !== 'clean';
    }
    function syncInspectorEnabledState() {
      document.body.dataset.objectInspectorEnabled = inspectorEnabled() ? '1' : '0';
    }
    function defaultViewForCurrentMode() {
      return document.body.dataset.mode === 'normal' && document.body.dataset.modeSubmode === 'full'
        ? 'defaults' : '';
    }

    function selectionView() {
      if (!inspectorEnabled()) return '';
      // 只有 ≥2 个内容节点或任何连线时才显示属性检查器；单选节点复用新建面板
      if (selection.contentNodes > 1 || selection.edges > 0) return 'selection';
      if (selection.decorNodes > 0) return 'decor';
      return '';
    }
    function activePanelRole(view) {
      const mode = document.body.dataset.mode || 'normal';
      if (mode === 'decor') return 'decor-panel';
      if (view === 'defaults') return 'pro-panel';
      if (view === 'selection') return 'edit-panel';
      if (view === 'decor') return 'decor-panel';
      if (mode === 'mindmap') return 'mindmap-panel';
      return '';
    }
    function syncPanelAccessibility(view) {
      const activeRole = document.body.classList.contains('side-panels-collapsed')
        ? '' : activePanelRole(view || '');
      panels.forEach((panel) => {
        const hidden = panel.dataset.role !== activeRole;
        panel.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        panel.toggleAttribute('inert', hidden);
      });
    }

    function setView(view) {
      view = view || '';
      if ((view === 'selection' || view === 'decor') && !inspectorEnabled()) view = '';
      if (view === 'defaults' && defaultViewForCurrentMode() !== 'defaults') view = '';
      if (!view) view = defaultViewForCurrentMode();
      const previous = document.body.dataset.inspectorView || '';
      if (view) document.body.dataset.inspectorView = view;
      else document.body.removeAttribute('data-inspector-view');
      syncPanelAccessibility(view || '');
      if (previous !== (view || '')) {
        document.dispatchEvent(new CustomEvent('editor:inspectorchange', {
          detail: { view: view || '', previous: previous },
        }));
      }
    }
    function openSelection() {
      const view = selectionView();
      if (view) setView(view);
    }
    function requestView(view) {
      if (canvasPointerDown) {
        pendingView = view || '';
        return;
      }
      setView(view);
    }
    function finishCanvasPointer() {
      if (!canvasPointerDown) return;
      canvasPointerDown = false;
      if (pendingView === null) return;
      const next = pendingView;
      pendingView = null;
      // 等当前 mouseup 后的 click 完成再移动面板，避免面板出现在指针下抢走 click。
      window.setTimeout(() => setView(next), 0);
    }
    document.addEventListener('mousedown', (event) => {
      const target = event.target;
      if (event.button === 0 && target && target.closest && target.closest('[data-role="canvas-viewport"]')) {
        canvasPointerDown = true;
        pendingView = null;
      }
    }, true);
    document.addEventListener('mouseup', finishCanvasPointer, true);
    document.addEventListener('pointercancel', finishCanvasPointer, true);
    window.addEventListener('blur', finishCanvasPointer);
    document.addEventListener('editor:selectionchange', (event) => {
      selection = Object.assign(selection, event.detail || {});
      const view = selectionView();
      if (view) requestView(view);
      else if (document.body.dataset.inspectorView !== 'defaults') requestView('');
    });
    document.addEventListener('editor:modechange', (event) => {
      const mode = event.detail && event.detail.mode;
      const submode = event.detail && event.detail.submode;
      syncInspectorEnabledState();
      if (submode === 'clean') setView('');
      else if (mode === 'decor') setView('');
      else if (selectionView()) openSelection();
      else setView('');
    });
    document.addEventListener('editor:inspectorpreferencechange', (event) => {
      if (!event.detail) {
        canvasInspectorPreferenceEnabled = true;
        mindmapInspectorPreferenceEnabled = true;
        decorInspectorPreferenceEnabled = true;
      } else {
        if (typeof event.detail.canvasEnabled === 'boolean') {
          canvasInspectorPreferenceEnabled = event.detail.canvasEnabled;
        }
        if (typeof event.detail.mindmapEnabled === 'boolean') {
          mindmapInspectorPreferenceEnabled = event.detail.mindmapEnabled;
        }
        if (typeof event.detail.decorEnabled === 'boolean') {
          decorInspectorPreferenceEnabled = event.detail.decorEnabled;
        }
      }
      syncInspectorEnabledState();
      if (!inspectorEnabled()) setView('');
      else if ((document.body.dataset.mode || 'normal') === 'decor') setView('');
      else if (selectionView()) openSelection();
      else setView('');
    });
    document.addEventListener('editor:panelcollapsechange', () => {
      syncPanelAccessibility(document.body.dataset.inspectorView || '');
    });
    window.EditorShell = window.EditorShell || {};
    window.EditorShell.openInspector = requestView;
    syncInspectorEnabledState();
    setView('');
  })();

  // ── 左侧工具栏默认隐藏，鼠标移到画布左侧时浮现 ───────────────
  // 不放阻挡点击的 hotzone：用 viewport 的 mousemove 判定鼠标是否靠近左缘，
  // 靠近或正悬停在工具栏上时显示，离开后收起。
  (function setupToolboxAutoHide() {
    const toolbox = document.querySelector('[data-role="canvas-toolbox"]');
    const viewport = document.querySelector('[data-role="canvas-viewport"]');
    if (!toolbox || !viewport) return;
    toolbox.classList.add('auto-hide');
    let revealed = toolbox.classList.contains('revealed');
    function isNearLeft(e) {
      const rect = viewport.getBoundingClientRect();
      return (e.clientX - rect.left) <= REVEAL_PX;
    }
    function isToolConfigTarget(target) {
      return !!(target && target.closest && target.closest('.tool-config-pop'));
    }
    function setRevealed(next) {
      next = !!next;
      if (revealed === next) return;
      revealed = next;
      toolbox.classList.toggle('revealed', revealed);
      if (!revealed) {
        document.dispatchEvent(new CustomEvent('editor:toolbox-hidden'));
      }
    }
    const REVEAL_PX = 84;          // 离左缘多近就浮现（覆盖工具栏静止时占的宽度）
    let over = false;              // 鼠标是否正悬停在工具栏本体上
    function isPinned() {
      return toolbox.classList.contains('drag-source-active');
    }
    function update(nearLeft) {
      setRevealed(nearLeft || over || isPinned());
    }
    viewport.addEventListener('mousemove', (e) => {
      update(isNearLeft(e) || isToolConfigTarget(e.target));
    });
    viewport.addEventListener('mouseleave', () => { if (!over && !isPinned()) setRevealed(false); });
    toolbox.addEventListener('mouseenter', () => { over = true; setRevealed(true); });
    toolbox.addEventListener('mouseleave', (e) => { over = false; update(isNearLeft(e)); });
    document.addEventListener('editor:toolbox-drag-state', (event) => {
      const active = !!(event.detail && event.detail.active);
      toolbox.classList.toggle('drag-source-active', active);
      if (active) setRevealed(true);
      else update(false);
    });
  })();

  // ── 右下角设置齿轮：收纳平移 / 缩放速度滑条（滑条本身仍由 CanvasModule 按 data-role 接管）──
  (function setupSettingsPopup() {
    const btn = document.querySelector('[data-role="settings-btn"]');
    const pop = document.querySelector('[data-role="settings-pop"]');
    if (!btn || !pop) return;
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (pop.hidden) open(); else close(); });
    document.addEventListener('mousedown', (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (!pop.hidden && e.key === 'Escape') { close(); btn.focus(); }
    });
  })();

  // 小手电筒：点一下「熄灭」，模式浮窗整体淡化隐身露出画面；再点恢复。
  // 全局开关（三个面板共享），存浏览器偏好 canvas:panelDimmed。
  (function setupPanelDim() {
    const btns = [...document.querySelectorAll('[data-role="panel-dim-toggle"]')];
    if (!btns.length) return;
    const KEY = 'canvas:panelDimmed';
    let dimmed = false;
    try { dimmed = localStorage.getItem(KEY) === '1'; } catch (e) {}
    const apply = () => {
      document.body.classList.toggle('panels-dimmed', dimmed);
      btns.forEach((b) => {
        b.setAttribute('aria-pressed', dimmed ? 'true' : 'false');
        b.setAttribute('aria-label', dimmed ? '点亮面板' : '熄灭面板');
      });
    };
    apply();
    btns.forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      dimmed = !dimmed;
      try { localStorage.setItem(KEY, dimmed ? '1' : '0'); } catch (e2) {}
      apply();
    }));
  })();

  // 右侧模式浮窗：无选中对象时按 Tab 临时收起/展开，保留选中节点时 Tab 建子节点的既有手感。
  (function setupSidePanelCollapse() {
    const MODES = new Set(['mindmap', 'decor']);
    const KEY = 'canvas:sidePanelsCollapsed';
    let rememberedCollapsed = false;
    if (!EMBED) {
      try { rememberedCollapsed = localStorage.getItem(KEY) === '1'; } catch (e) {}
    }
    let collapsed = false;
    const activeMode = () => document.body.dataset.mode || 'normal';
    const setCollapsed = (next) => {
      const enabled = MODES.has(activeMode()) || !!document.body.dataset.inspectorView;
      const previous = collapsed;
      collapsed = !!next && enabled;
      document.body.classList.toggle('side-panels-collapsed', collapsed);
      if (previous !== collapsed) {
        document.dispatchEvent(new CustomEvent('editor:panelcollapsechange', {
          detail: { collapsed: collapsed },
        }));
      }
    };
    const toggle = () => {
      if (!MODES.has(activeMode()) && !document.body.dataset.inspectorView) return false;
      setCollapsed(!collapsed);
      if (!EMBED) {
        rememberedCollapsed = collapsed;
        try { localStorage.setItem(KEY, rememberedCollapsed ? '1' : '0'); } catch (e) {}
      }
      return true;
    };
    // 模式切换只改变当前是否有可收起的面板，不覆盖用户最后一次 Tab 选择。
    document.addEventListener('editor:modechange', () => setCollapsed(EMBED ? false : rememberedCollapsed));
    document.addEventListener('editor:toggle-side-panel', (e) => {
      if (!toggle()) return;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
    });
    setCollapsed(rememberedCollapsed);
  })();

  (function setupMindmapModePanel() {
    if (!mindmapPanel) return;
    const presetBtns = mindmapPanel.querySelectorAll('[data-mm-preset]');
    const presetPreview = mindmapPanel.querySelector('[data-role="mindmap-preset-preview"]');
    const previewHierarchy = mindmapPanel.querySelector('[data-role="mindmap-preview-hierarchy"]');
    const previewLines = mindmapPanel.querySelector('[data-role="mindmap-preview-lines"]');
    const previewNodes = presetPreview ? presetPreview.querySelectorAll('[data-mm-preview-node]') : [];
    const previewEdges = presetPreview ? presetPreview.querySelectorAll('[data-mm-preview-edge]') : [];
    const layoutBtns = mindmapPanel.querySelectorAll('[data-mm-layout]');
    const densityBtns = mindmapPanel.querySelectorAll('[data-mm-density]');
    const selectionState = mindmapPanel.querySelector('[data-role="mindmap-selection-state"]');
    const selectionCopy = mindmapPanel.querySelector('[data-role="mindmap-selection-copy"]');
    const curveSelect = mindmapPanel.querySelector('[data-role="mindmap-curve"]');
    const lineStyleSelect = mindmapPanel.querySelector('[data-role="mindmap-line-style"]');
    const levelGapInput = mindmapPanel.querySelector('[data-role="mindmap-level-gap"]');
    const branchGapInput = mindmapPanel.querySelector('[data-role="mindmap-branch-gap"]');
    const radialGapInput = mindmapPanel.querySelector('[data-role="mindmap-radial-gap"]');
    const levelGapVal = mindmapPanel.querySelector('[data-role="mindmap-level-gap-val"]');
    const branchGapVal = mindmapPanel.querySelector('[data-role="mindmap-branch-gap-val"]');
    const radialGapVal = mindmapPanel.querySelector('[data-role="mindmap-radial-gap-val"]');
    const centerSizeInput = mindmapPanel.querySelector('[data-role="mindmap-center-size"]');
    const branchSizeInput = mindmapPanel.querySelector('[data-role="mindmap-branch-size"]');
    const leafSizeInput = mindmapPanel.querySelector('[data-role="mindmap-leaf-size"]');
    const centerSizeVal = mindmapPanel.querySelector('[data-role="mindmap-center-size-val"]');
    const branchSizeVal = mindmapPanel.querySelector('[data-role="mindmap-branch-size-val"]');
    const leafSizeVal = mindmapPanel.querySelector('[data-role="mindmap-leaf-size-val"]');
    const autoSizeBtn = mindmapPanel.querySelector('[data-role="mindmap-size-auto"]');
    const equalSizeBtn = mindmapPanel.querySelector('[data-role="mindmap-size-equal"]');
    const repairSizeBtn = mindmapPanel.querySelector('[data-role="mindmap-size-repair"]');
    const sizeStateEl = mindmapPanel.querySelector('[data-role="mindmap-size-state"]');
    const levelGapWrap = mindmapPanel.querySelector('[data-role="mindmap-level-gap-wrap"]');
    const branchGapWrap = mindmapPanel.querySelector('[data-role="mindmap-branch-gap-wrap"]');
    const radialGapWrap = mindmapPanel.querySelector('[data-role="mindmap-radial-gap-wrap"]');
    const applyBtn = mindmapPanel.querySelector('[data-role="mindmap-apply"]');
    const alignLevelsBtn = mindmapPanel.querySelector('[data-role="mindmap-align-levels"]');
    const styleOnlyBtn = mindmapPanel.querySelector('[data-role="mindmap-style-only"]');
    const colorStateEl = mindmapPanel.querySelector('[data-role="mindmap-color-state"]');
    const colorBrushBtn = mindmapPanel.querySelector('[data-role="mindmap-color-brush"]');
    const matchParentBtn = mindmapPanel.querySelector('[data-role="mindmap-match-parent"]');
    const densityValues = {
      compact: { levelGap: 68, branchGap: 20, radialGap: 180 },
      balanced: { levelGap: 92, branchGap: 32, radialGap: 220 },
      relaxed: { levelGap: 122, branchGap: 46, radialGap: 270 },
    };
    const presetIds = new Set(['paper', 'focus', 'rounded', 'scholar', 'journal', 'ink', 'forest', 'blueprint', 'classroom', 'editorial']);
    const clamp = (n, min, max, fallback) => Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    const finiteSize = (value) => {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const writeRange = (input, value) => { if (input) input.value = String(value); };
    const readRange = (input, min, max, fallback) => clamp(parseInt(input && input.value, 10), min, max, fallback);
    let preset = 'paper';
    const scope = 'selection';
    let layout = 'auto';
    let density = 'balanced';
    let levelGap = densityValues.balanced.levelGap;
    let branchGap = densityValues.balanced.branchGap;
    let radialGap = densityValues.balanced.radialGap;
    const defaultNodeSizes = { center: 110, branch: 100, leaf: 85 };
    let centerSize = defaultNodeSizes.center;
    let branchSize = defaultNodeSizes.branch;
    let leafSize = defaultNodeSizes.leaf;
    let curveOverride = 'preset';
    let lineStyleOverride = 'preset';
    let selectedNodeCount = 0;
    let selectionStatusTimer = null;
    let colorBrushActive = false;
    let sizePreviewRaf = null;
    let sizeReflowTimer = null;
    let lastColorState = { mode: 'none', count: 0, matchable: 0 };
    const previewCurveNames = {
      'zh-CN': {
        bezier: '曲线', straight: '直线', elbow: '折线', 'rounded-elbow': '圆角折线',
        's-curve': 'S 曲线', smooth: '平滑曲线', branch: '树枝曲线', arc: '弧线', organic: '自然曲线',
      },
      en: {
        bezier: 'Curve', straight: 'Straight', elbow: 'Elbow', 'rounded-elbow': 'Rounded elbow',
        's-curve': 'S curve', smooth: 'Smooth curve', branch: 'Branch curve', arc: 'Arc', organic: 'Organic curve',
      },
    };
    const previewLineNames = {
      'zh-CN': { solid: '实线', dashed: '虚线', dotted: '点线', soft: '柔线', glow: '荧光' },
      en: { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', soft: 'Soft', glow: 'Glow' },
    };
    const previewEdgePath = (curve, start, end, cornerRadius) => {
      const x1 = start.x;
      const y1 = start.y;
      const x2 = end.x;
      const y2 = end.y;
      const dx = Math.max(1, x2 - x1);
      const dy = y2 - y1;
      const mid = x1 + dx * 0.5;
      if (curve === 'straight') return `M${x1} ${y1} L${x2} ${y2}`;
      if (curve === 'elbow') return `M${x1} ${y1} H${mid} V${y2} H${x2}`;
      if (curve === 'rounded-elbow') {
        if (Math.abs(dy) < 0.5) return `M${x1} ${y1} H${x2}`;
        const direction = dy > 0 ? 1 : -1;
        const scaledRadius = clamp((Number(cornerRadius) || 18) * 0.45, 2, 14, 8);
        const radius = Math.min(scaledRadius, Math.abs(dy) / 2, dx * 0.32);
        return `M${x1} ${y1} H${mid - radius} Q${mid} ${y1} ${mid} ${y1 + direction * radius}`
          + ` V${y2 - direction * radius} Q${mid} ${y2} ${mid + radius} ${y2} H${x2}`;
      }
      if (curve === 'arc') {
        const lift = dy > 0 ? -Math.min(13, Math.abs(dy) * 0.35 + 5) : Math.min(13, Math.abs(dy) * 0.35 + 5);
        return `M${x1} ${y1} Q${mid} ${((y1 + y2) / 2) + lift} ${x2} ${y2}`;
      }
      if (curve === 's-curve') {
        return `M${x1} ${y1} C${x1 + dx * 0.28} ${y1 - dy * 0.18} ${x1 + dx * 0.70} ${y2 + dy * 0.18} ${x2} ${y2}`;
      }
      if (curve === 'organic') {
        return `M${x1} ${y1} C${x1 + dx * 0.25} ${y1 + dy * 0.05} ${x1 + dx * 0.58} ${y2 - dy * 0.22} ${x2} ${y2}`;
      }
      if (curve === 'smooth') {
        return `M${x1} ${y1} C${x1 + dx * 0.34} ${y1} ${x1 + dx * 0.66} ${y2} ${x2} ${y2}`;
      }
      const firstControl = curve === 'branch' ? 0.44 : 0.36;
      return `M${x1} ${y1} C${x1 + dx * firstControl} ${y1} ${x1 + dx * 0.58} ${y2} ${x2} ${y2}`;
    };
    const renderPresetPreview = () => {
      if (!presetPreview) return;
      const api = window.CanvasModule;
      if (!api || typeof api.getMindmapPresetPreview !== 'function') return;
      const model = api.getMindmapPresetPreview(preset);
      if (!model) return;
      const branchEdge = Object.assign({}, model.branchEdge || {});
      const leafEdge = Object.assign({}, model.leafEdge || {});
      if (curveOverride !== 'preset') {
        [branchEdge, leafEdge].forEach((edge) => {
          const preservedRadius = edge.curve === 'rounded-elbow' ? edge.cornerRadius : null;
          edge.curve = curveOverride;
          edge.cornerRadius = curveOverride === 'rounded-elbow' ? (preservedRadius || 18) : null;
        });
      }
      if (lineStyleOverride !== 'preset') {
        branchEdge.lineStyle = lineStyleOverride;
        leafEdge.lineStyle = lineStyleOverride;
      }
      const centerWidth = 72 * clamp(centerSize / defaultNodeSizes.center, 0.78, 1.24, 1);
      const branchWidth = 80 * clamp(branchSize / defaultNodeSizes.branch, 0.78, 1.24, 1);
      const leafWidth = 58 * clamp(leafSize / defaultNodeSizes.leaf, 0.78, 1.24, 1);
      const boxes = {
        center: { x: 87 - centerWidth, y: 42, width: centerWidth, height: 26 },
        'branch-top': { x: 132, y: 19, width: branchWidth, height: 22 },
        'branch-bottom': { x: 132, y: 69, width: branchWidth, height: 22 },
        'leaf-top': { x: 270, y: 5, width: leafWidth, height: 19 },
        'leaf-bottom': { x: 270, y: 86, width: leafWidth, height: 19 },
      };
      const levels = { center: model.center, branch: model.branch, leaf: model.leaf };
      const levelLabels = toolbarLanguage === 'en'
        ? { center: 'Center', branch: 'Level 1', leaf: 'Level 2' }
        : { center: '中心', branch: '一级', leaf: '二级' };
      previewNodes.forEach((group) => {
        const levelName = group.dataset.mmPreviewNode;
        const level = levels[levelName];
        const box = boxes[group.dataset.mmPreviewSlot];
        const rect = group.querySelector('rect');
        const label = group.querySelector('text');
        if (!level || !box || !rect || !label) return;
        const radius = Math.min(box.height / 2, Math.max(1.5, Number(level.radius || 0) * 0.72));
        rect.setAttribute('x', String(box.x));
        rect.setAttribute('y', String(box.y));
        rect.setAttribute('width', String(box.width));
        rect.setAttribute('height', String(box.height));
        rect.setAttribute('rx', String(radius));
        rect.setAttribute('fill', level.hideChrome ? 'transparent' : level.bgColor);
        rect.setAttribute('stroke', level.hideChrome ? 'transparent' : level.borderColor);
        rect.setAttribute('fill-opacity', level.hideChrome ? '0' : String(level.opacity));
        rect.setAttribute('stroke-opacity', level.hideChrome ? '0' : '1');
        label.setAttribute('x', String(box.x + box.width / 2));
        label.setAttribute('y', String(box.y + box.height / 2));
        if (level.hideChrome) label.style.removeProperty('fill');
        else label.style.fill = level.textColor;
        label.textContent = levelLabels[levelName];
        group.dataset.transparent = level.hideChrome ? '1' : '0';
      });
      const points = {
        centerRight: { x: boxes.center.x + boxes.center.width, y: boxes.center.y + boxes.center.height / 2 },
        branchTopLeft: { x: boxes['branch-top'].x, y: boxes['branch-top'].y + boxes['branch-top'].height / 2 },
        branchTopRight: { x: boxes['branch-top'].x + boxes['branch-top'].width, y: boxes['branch-top'].y + boxes['branch-top'].height / 2 },
        branchBottomLeft: { x: boxes['branch-bottom'].x, y: boxes['branch-bottom'].y + boxes['branch-bottom'].height / 2 },
        branchBottomRight: { x: boxes['branch-bottom'].x + boxes['branch-bottom'].width, y: boxes['branch-bottom'].y + boxes['branch-bottom'].height / 2 },
        leafTopLeft: { x: boxes['leaf-top'].x, y: boxes['leaf-top'].y + boxes['leaf-top'].height / 2 },
        leafBottomLeft: { x: boxes['leaf-bottom'].x, y: boxes['leaf-bottom'].y + boxes['leaf-bottom'].height / 2 },
      };
      const edgeGeometry = {
        'branch-top': [branchEdge, points.centerRight, points.branchTopLeft],
        'branch-bottom': [branchEdge, points.centerRight, points.branchBottomLeft],
        'leaf-top': [leafEdge, points.branchTopRight, points.leafTopLeft],
        'leaf-bottom': [leafEdge, points.branchBottomRight, points.leafBottomLeft],
      };
      previewEdges.forEach((path) => {
        const geometry = edgeGeometry[path.dataset.mmPreviewEdge];
        if (!geometry) return;
        const edge = geometry[0];
        const lineStyle = edge.lineStyle || 'solid';
        const baseWidth = clamp(Number(edge.width) * 0.92, 1.15, 3.4, 1.8);
        path.setAttribute('d', previewEdgePath(edge.curve, geometry[1], geometry[2], edge.cornerRadius));
        path.setAttribute('stroke', edge.color || '#5a9eab');
        path.setAttribute('stroke-width', String(lineStyle === 'glow' ? baseWidth + 0.9 : baseWidth));
        path.setAttribute('stroke-opacity', lineStyle === 'soft' ? '0.55' : (lineStyle === 'glow' ? '0.92' : '0.82'));
        path.setAttribute('stroke-dasharray', lineStyle === 'dashed' ? '7 5' : (lineStyle === 'dotted' ? '1 5' : 'none'));
      });
      const nodeTone = (level) => {
        if (toolbarLanguage === 'en') {
          if (level.hideChrome) return 'transparent';
          return level.tone === 'dark' ? 'dark' : 'light';
        }
        if (level.hideChrome) return '透明';
        return level.tone === 'dark' ? '深色' : '浅色';
      };
      const hierarchyCopy = toolbarLanguage === 'en'
        ? `Center ${nodeTone(model.center)} · Level 1 ${nodeTone(model.branch)} · Level 2 ${nodeTone(model.leaf)}`
        : `中心${nodeTone(model.center)} · 一级${nodeTone(model.branch)} · 二级${nodeTone(model.leaf)}`;
      const curveNames = previewCurveNames[toolbarLanguage] || previewCurveNames['zh-CN'];
      const lineNames = previewLineNames[toolbarLanguage] || previewLineNames['zh-CN'];
      const edgeCopy = (edge) => {
        const radius = edge.curve === 'rounded-elbow' ? ` ${Math.round(Number(edge.cornerRadius) || 18)}px` : '';
        return `${curveNames[edge.curve] || edge.curve}${radius} · ${lineNames[edge.lineStyle] || edge.lineStyle}`;
      };
      const branchCopy = edgeCopy(branchEdge);
      const leafCopy = edgeCopy(leafEdge);
      const linesCopy = branchCopy === leafCopy
        ? (toolbarLanguage === 'en' ? `Lines: ${branchCopy}` : `连线：${branchCopy}`)
        : (toolbarLanguage === 'en'
          ? `Lines: Level 1 ${branchCopy}; Level 2 ${leafCopy}`
          : `连线：一级 ${branchCopy}；二级 ${leafCopy}`);
      if (previewHierarchy) previewHierarchy.textContent = hierarchyCopy;
      if (previewLines) previewLines.textContent = linesCopy;
      presetPreview.dataset.preset = model.id;
      presetPreview.dataset.branchCurve = branchEdge.curve;
      presetPreview.dataset.leafCurve = leafEdge.curve;
      presetPreview.dataset.branchCornerRadius = branchEdge.cornerRadius == null ? '' : String(branchEdge.cornerRadius);
      presetPreview.dataset.leafCornerRadius = leafEdge.cornerRadius == null ? '' : String(leafEdge.cornerRadius);
      presetPreview.dataset.leafTransparent = model.leaf.hideChrome ? '1' : '0';
      presetPreview.setAttribute('aria-label', `${hierarchyCopy}. ${linesCopy}`);
    };
    const detectDensity = () => {
      const hit = Object.keys(densityValues).find((key) => {
        const v = densityValues[key];
        return v.levelGap === levelGap && v.branchGap === branchGap && v.radialGap === radialGap;
      });
      return hit || 'custom';
    };
    const updateRangeLabels = () => {
      if (levelGapVal) levelGapVal.textContent = levelGap + 'px';
      if (branchGapVal) branchGapVal.textContent = branchGap + 'px';
      if (radialGapVal) radialGapVal.textContent = radialGap + 'px';
      if (centerSizeVal) centerSizeVal.textContent = centerSize + '%';
      if (branchSizeVal) branchSizeVal.textContent = branchSize + '%';
      if (leafSizeVal) leafSizeVal.textContent = leafSize + '%';
    };
    const applyDensity = (next) => {
      const values = densityValues[next] || densityValues.balanced;
      density = next;
      levelGap = values.levelGap;
      branchGap = values.branchGap;
      radialGap = values.radialGap;
      writeRange(levelGapInput, levelGap);
      writeRange(branchGapInput, branchGap);
      writeRange(radialGapInput, radialGap);
      updateRangeLabels();
      sync();
    };
    const readSpacing = () => {
      levelGap = readRange(levelGapInput, 56, 150, levelGap);
      branchGap = readRange(branchGapInput, 16, 80, branchGap);
      radialGap = readRange(radialGapInput, 150, 330, radialGap);
      density = detectDensity();
      updateRangeLabels();
      sync();
    };
    const layoutOptions = () => ({
      scope: scope,
      stylePreset: preset,
      cleanWaypoints: true,
      density: density,
      levelGap: levelGap,
      branchGap: branchGap,
      radialGap: radialGap,
      preserveSides: true,
      hierarchySize: true,
      curveOverride: curveOverride === 'preset' ? '' : curveOverride,
      lineStyleOverride: lineStyleOverride === 'preset' ? '' : lineStyleOverride,
      centerSize: centerSize,
      branchSize: branchSize,
      leafSize: leafSize,
      nodeSize: branchSize,
    });
    const renderColorState = (state) => {
      lastColorState = state || { mode: 'none', count: 0, matchable: 0 };
      const labels = {
        none: '未选择',
        center: '中心节点',
        auto: '跟随分支',
        custom: '自定义',
        mixed: '混合配色',
        unsupported: '自由节点',
      };
      const mode = Object.prototype.hasOwnProperty.call(labels, lastColorState.mode)
        ? lastColorState.mode
        : 'none';
      if (colorStateEl) {
        colorStateEl.dataset.state = mode;
        const copy = colorStateEl.querySelector('span');
        if (copy) copy.textContent = labels[mode];
      }
      if (colorBrushBtn) colorBrushBtn.disabled = selectedNodeCount !== 1 && !colorBrushActive;
      if (matchParentBtn) matchParentBtn.disabled = !(Number(lastColorState.matchable) > 0);
    };
    const refreshColorState = () => {
      const api = window.CanvasModule;
      if (api && typeof api.getMindmapColorState === 'function') {
        const state = api.getMindmapColorState();
        renderColorState(state);
        if (state && presetIds.has(state.presetId) && preset !== state.presetId) {
          preset = state.presetId;
          sync();
        }
      } else {
        renderColorState({ mode: selectedNodeCount ? 'unsupported' : 'none', count: selectedNodeCount, matchable: 0 });
      }
    };
    const renderSizeState = (state) => {
      state = state || { centerSize: null, branchSize: null, leafSize: null, custom: 0 };
      let changed = false;
      const stateCenterSize = finiteSize(state.centerSize);
      if (stateCenterSize != null) {
        const next = clamp(stateCenterSize, 75, 145, centerSize);
        if (next !== centerSize) { centerSize = next; changed = true; }
        writeRange(centerSizeInput, centerSize);
      }
      const legacyNodeSize = finiteSize(state.nodeSize);
      const stateBranchSize = finiteSize(state.branchSize) == null ? legacyNodeSize : finiteSize(state.branchSize);
      const stateLeafSize = finiteSize(state.leafSize) == null ? legacyNodeSize : finiteSize(state.leafSize);
      if (stateBranchSize != null) {
        const next = clamp(stateBranchSize, 70, 140, branchSize);
        if (next !== branchSize) { branchSize = next; changed = true; }
        writeRange(branchSizeInput, branchSize);
      }
      if (stateLeafSize != null) {
        const next = clamp(stateLeafSize, 70, 140, leafSize);
        if (next !== leafSize) { leafSize = next; changed = true; }
        writeRange(leafSizeInput, leafSize);
      }
      if (sizeStateEl) sizeStateEl.textContent = Number(state.custom) > 0
        ? state.custom + ' 个手工尺寸'
        : '自动适配文字';
      updateRangeLabels();
      if (changed) sync();
    };
    const refreshSizeState = () => {
      const api = window.CanvasModule;
      if (selectedNodeCount > 0 && api && typeof api.getMindmapSizeState === 'function') {
        renderSizeState(api.getMindmapSizeState());
      } else {
        renderSizeState({ centerSize: null, branchSize: null, leafSize: null, custom: 0 });
      }
    };
    const updateSelectionState = (count, message) => {
      selectedNodeCount = Math.max(0, Number(count) || 0);
      if (selectionState) selectionState.dataset.empty = selectedNodeCount ? '0' : '1';
      if (selectionCopy) {
        selectionCopy.textContent = message || (selectedNodeCount === 0
          ? '先选中一个节点'
          : (selectedNodeCount === 1
            ? '将整理与此节点相连的整张结构'
            : '将只整理已选中的 ' + selectedNodeCount + ' 个节点'));
      }
      [applyBtn, alignLevelsBtn, styleOnlyBtn].forEach((button) => {
        if (button) button.disabled = selectedNodeCount === 0;
      });
      [autoSizeBtn, equalSizeBtn, repairSizeBtn].forEach((button) => {
        if (button) button.disabled = selectedNodeCount === 0;
      });
      refreshColorState();
      refreshSizeState();
    };
    const reportActionMiss = (button) => {
      if (selectionStatusTimer) window.clearTimeout(selectionStatusTimer);
      updateSelectionState(selectedNodeCount, '没有可整理的相连结构');
      if (button) {
        button.classList.remove('mindmap-action-miss');
        void button.offsetWidth;
        button.classList.add('mindmap-action-miss');
      }
      selectionStatusTimer = window.setTimeout(() => updateSelectionState(selectedNodeCount), 1500);
    };
    const applyPresetAndLayout = (source, card) => {
      const api = window.CanvasModule;
      const ok = api && typeof api.applyMindmap === 'function'
        ? api.applyMindmap(layout, layoutOptions())
        : false;
      if (!ok) {
        reportActionMiss(source);
        return false;
      }
      if (card) {
        card.classList.remove('preset-applied');
        void card.offsetWidth;
        card.classList.add('preset-applied');
        window.setTimeout(() => card.classList.remove('preset-applied'), 460);
        const name = card.querySelector('.mindmap-preset-name');
        updateSelectionState(selectedNodeCount, '已应用“' + (name ? name.textContent : '预设') + '”并整理');
        if (selectionStatusTimer) window.clearTimeout(selectionStatusTimer);
        selectionStatusTimer = window.setTimeout(() => updateSelectionState(selectedNodeCount), 1500);
      }
      return true;
    };
    const sizeOptions = (extra) => Object.assign({}, layoutOptions(), extra || {});
    const applySizePreview = (reflow, history) => {
      const api = window.CanvasModule;
      if (!api || typeof api.setMindmapNodeSizes !== 'function') return false;
      return api.setMindmapNodeSizes(sizeOptions({
        history: history,
        notify: history,
        reflow: reflow,
        preview: !history,
      }));
    };
    const readNodeSizes = () => {
      centerSize = readRange(centerSizeInput, 75, 145, centerSize);
      branchSize = readRange(branchSizeInput, 70, 140, branchSize);
      leafSize = readRange(leafSizeInput, 70, 140, leafSize);
      updateRangeLabels();
      sync();
    };
    const previewNodeSizes = () => {
      readNodeSizes();
      document.body.classList.add('mindmap-size-tuning');
      if (sizePreviewRaf == null) {
        sizePreviewRaf = window.requestAnimationFrame(() => {
          sizePreviewRaf = null;
          applySizePreview(false, false);
        });
      }
      if (sizeReflowTimer) window.clearTimeout(sizeReflowTimer);
      sizeReflowTimer = window.setTimeout(() => {
        sizeReflowTimer = null;
        applySizePreview(true, false);
      }, 110);
    };
    const commitNodeSizes = () => {
      readNodeSizes();
      if (sizePreviewRaf != null) {
        window.cancelAnimationFrame(sizePreviewRaf);
        sizePreviewRaf = null;
      }
      if (sizeReflowTimer) {
        window.clearTimeout(sizeReflowTimer);
        sizeReflowTimer = null;
      }
      applySizePreview(true, true);
      window.setTimeout(() => document.body.classList.remove('mindmap-size-tuning'), 260);
    };
    const sync = () => {
      presetBtns.forEach((b) => b.classList.toggle('active', b.dataset.mmPreset === preset));
      layoutBtns.forEach((b) => b.classList.toggle('active', b.dataset.mmLayout === layout));
      densityBtns.forEach((b) => b.classList.toggle('active', b.dataset.mmDensity === density));
      const radial = layout === 'radial';
      if (levelGapWrap) levelGapWrap.hidden = radial;
      if (branchGapWrap) branchGapWrap.hidden = radial;
      if (radialGapWrap) radialGapWrap.hidden = !radial;
      if (curveSelect) curveSelect.value = curveOverride;
      if (lineStyleSelect) lineStyleSelect.value = lineStyleOverride;
      document.body.dataset.mindmapLayout = layout;
      document.body.dataset.mindmapLevelGap = String(levelGap);
      document.body.dataset.mindmapBranchGap = String(branchGap);
      document.body.dataset.mindmapPreset = preset;
      document.body.dataset.mindmapCurve = curveOverride;
      document.body.dataset.mindmapLineStyle = lineStyleOverride;
      document.body.dataset.mindmapHierarchySize = '1';
      document.body.dataset.mindmapCenterSize = String(centerSize);
      document.body.dataset.mindmapBranchSize = String(branchSize);
      document.body.dataset.mindmapLeafSize = String(leafSize);
      document.body.dataset.mindmapNodeSize = String(branchSize);
      renderPresetPreview();
    };
    presetBtns.forEach((card) => {
      const selectCard = () => {
        const next = card.dataset.mmPreset;
        preset = presetIds.has(next) ? next : 'paper';
        sync();
      };
      card.addEventListener('click', (event) => {
        if (event.target.closest('[data-mm-preset-apply]')) return;
        selectCard();
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectCard();
      });
      const quickApply = card.querySelector('[data-mm-preset-apply]');
      if (quickApply) quickApply.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectCard();
        applyPresetAndLayout(quickApply, card);
      });
    });
    layoutBtns.forEach((b) => b.addEventListener('click', () => {
      const next = b.dataset.mmLayout;
      layout = (next === 'balanced' || next === 'right' || next === 'left' || next === 'down' || next === 'radial') ? next : 'auto';
      sync();
    }));
    densityBtns.forEach((b) => b.addEventListener('click', () => {
      applyDensity(b.dataset.mmDensity);
    }));
    [levelGapInput, branchGapInput, radialGapInput].forEach((input) => {
      if (input) input.addEventListener('input', readSpacing);
    });
    [centerSizeInput, branchSizeInput, leafSizeInput].forEach((input) => {
      if (!input) return;
      input.addEventListener('input', previewNodeSizes);
      input.addEventListener('change', commitNodeSizes);
    });
    if (curveSelect) {
      curveSelect.addEventListener('change', () => {
        curveOverride = curveSelect.value || 'preset';
        sync();
      });
    }
    if (lineStyleSelect) {
      lineStyleSelect.addEventListener('change', () => {
        lineStyleOverride = lineStyleSelect.value || 'preset';
        sync();
      });
    }
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        applyPresetAndLayout(applyBtn, null);
      });
    }
    if (alignLevelsBtn) {
      alignLevelsBtn.addEventListener('click', () => {
        if (window.CanvasModule && typeof window.CanvasModule.alignMindmapLevels === 'function') {
          const ok = window.CanvasModule.alignMindmapLevels(layout, {
            scope: scope,
            density: density,
            levelGap: levelGap,
            branchGap: branchGap,
            radialGap: radialGap,
            preserveSides: true,
          });
          if (!ok) reportActionMiss(alignLevelsBtn);
        }
      });
    }
    if (styleOnlyBtn) {
      styleOnlyBtn.addEventListener('click', () => {
        if (window.CanvasModule && typeof window.CanvasModule.applyMindmapStyle === 'function') {
          const ok = window.CanvasModule.applyMindmapStyle(preset, {
            scope: scope,
            hierarchySize: true,
            centerSize: centerSize,
            branchSize: branchSize,
            leafSize: leafSize,
            nodeSize: branchSize,
            curveOverride: curveOverride === 'preset' ? '' : curveOverride,
            lineStyleOverride: lineStyleOverride === 'preset' ? '' : lineStyleOverride,
          });
          if (!ok) reportActionMiss(styleOnlyBtn);
        }
      });
    }
    if (autoSizeBtn) {
      autoSizeBtn.addEventListener('click', () => {
        const api = window.CanvasModule;
        const ok = api && typeof api.restoreMindmapNodeSizes === 'function'
          ? api.restoreMindmapNodeSizes(sizeOptions())
          : false;
        if (!ok) reportActionMiss(autoSizeBtn);
      });
    }
    if (equalSizeBtn) {
      equalSizeBtn.addEventListener('click', () => {
        const api = window.CanvasModule;
        const ok = api && typeof api.equalizeMindmapLevelWidths === 'function'
          ? api.equalizeMindmapLevelWidths(sizeOptions())
          : false;
        if (!ok) reportActionMiss(equalSizeBtn);
      });
    }
    if (repairSizeBtn) {
      repairSizeBtn.addEventListener('click', () => {
        const api = window.CanvasModule;
        const ok = api && typeof api.repairMindmapOverlaps === 'function'
          ? api.repairMindmapOverlaps(sizeOptions())
          : false;
        if (!ok) reportActionMiss(repairSizeBtn);
      });
    }
    if (colorBrushBtn) {
      colorBrushBtn.addEventListener('click', () => {
        const api = window.CanvasModule;
        const ok = api && typeof api.startMindmapColorBrush === 'function'
          ? api.startMindmapColorBrush()
          : false;
        if (!ok) {
          if (selectionStatusTimer) window.clearTimeout(selectionStatusTimer);
          updateSelectionState(selectedNodeCount, '请先单选一个节点作为颜色来源');
          selectionStatusTimer = window.setTimeout(() => updateSelectionState(selectedNodeCount), 1700);
        }
      });
    }
    if (matchParentBtn) {
      matchParentBtn.addEventListener('click', () => {
        const api = window.CanvasModule;
        const ok = api && typeof api.matchMindmapParentColor === 'function'
          ? api.matchMindmapParentColor()
          : false;
        if (!ok) reportActionMiss(matchParentBtn);
      });
    }
    document.addEventListener('canvas:mindmap-color-brush', (event) => {
      colorBrushActive = !!(event && event.detail && event.detail.active);
      if (colorBrushBtn) {
        colorBrushBtn.classList.toggle('active', colorBrushActive);
        colorBrushBtn.setAttribute('aria-pressed', colorBrushActive ? 'true' : 'false');
        colorBrushBtn.disabled = !colorBrushActive && selectedNodeCount !== 1;
      }
    });
    document.addEventListener('canvas:mindmap-color-state', (event) => {
      renderColorState(event && event.detail ? event.detail : null);
    });
    document.addEventListener('canvas:mindmap-size-state', (event) => {
      renderSizeState(event && event.detail ? event.detail : null);
    });
    document.addEventListener('editor:canvasready', renderPresetPreview);
    document.addEventListener('editor:languagechange', renderPresetPreview);
    document.addEventListener('editor:selectionchange', (event) => {
      if (selectionStatusTimer) {
        window.clearTimeout(selectionStatusTimer);
        selectionStatusTimer = null;
      }
      updateSelectionState(event && event.detail ? event.detail.nodes : 0);
    });
    updateRangeLabels();
    updateSelectionState(0);
    sync();
  })();

  // 任务清单出现延迟（齿轮里滑条调；全局偏好 canvas:checklistDelay，单位 ms；0=瞬发）。
  // 纯 CSS 变量驱动：写到 :root 的 --checklist-delay，styles.css 的 .node-checklist 悬停态读取。
  (function setupChecklistDelay() {
    const input = document.querySelector('[data-role="checklist-delay"]');
    const valEl = document.querySelector('[data-role="checklist-delay-val"]');
    if (!input) return;
    const KEY = 'canvas:checklistDelay';
    const MIN = 0, MAX = 2000;
    const clamp = (n) => Math.max(MIN, Math.min(MAX, n));
    const fmt = (ms) => {
      if (ms <= 0) return '瞬发';
      return (ms / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 's';
    };
    let saved = 800;
    try { const v = parseInt(localStorage.getItem(KEY), 10); if (Number.isFinite(v)) saved = clamp(v); } catch (e) {}
    const apply = (ms) => {
      document.documentElement.style.setProperty('--checklist-delay', ms + 'ms');
      if (valEl) valEl.textContent = fmt(ms);
    };
    input.value = String(saved);
    apply(saved);
    input.addEventListener('input', () => {
      const ms = clamp(parseInt(input.value, 10) || 0);
      apply(ms);
      try { localStorage.setItem(KEY, String(ms)); } catch (e) {}
    });
  })();

  // 脑图收起分支：悬停后临时预展开的延迟。只存浏览器偏好，不改 .canvas 正式折叠状态。
  (function setupMindmapHoverDelay() {
    const input = document.querySelector('[data-role="mindmap-hover-delay"]');
    const valEl = document.querySelector('[data-role="mindmap-hover-delay-val"]');
    if (!input) return;
    const KEY = 'canvas:mindmapHoverDelay';
    const MIN = 0, MAX = 2000;
    const clamp = (n) => Math.max(MIN, Math.min(MAX, n));
    const fmt = (ms) => {
      if (ms <= 0) return '瞬发';
      return (ms / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 's';
    };
    let saved = 500;
    try { const v = parseInt(localStorage.getItem(KEY), 10); if (Number.isFinite(v)) saved = clamp(v); } catch (e) {}
    const apply = (ms) => {
      if (valEl) valEl.textContent = fmt(ms);
      document.dispatchEvent(new CustomEvent('canvas:mindmap-hover-delay', { detail: ms }));
    };
    input.value = String(saved);
    apply(saved);
    input.addEventListener('input', () => {
      const ms = clamp(parseInt(input.value, 10) || 0);
      apply(ms);
      try { localStorage.setItem(KEY, String(ms)); } catch (e) {}
    });
  })();

  // 索引节点悬停目录：出现延迟。只存浏览器偏好；canvas.js 读同名键 / 听 canvas:index-hover-delay。
  (function setupIndexHoverDelay() {
    const input = document.querySelector('[data-role="index-hover-delay"]');
    const valEl = document.querySelector('[data-role="index-hover-delay-val"]');
    if (!input) return;
    const KEY = 'canvas:indexHoverDelay';
    const MIN = 0, MAX = 2000;
    const clamp = (n) => Math.max(MIN, Math.min(MAX, n));
    const fmt = (ms) => {
      if (ms <= 0) return '瞬发';
      return (ms / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 's';
    };
    let saved = 400;
    try { const v = parseInt(localStorage.getItem(KEY), 10); if (Number.isFinite(v)) saved = clamp(v); } catch (e) {}
    const apply = (ms) => {
      if (valEl) valEl.textContent = fmt(ms);
      document.dispatchEvent(new CustomEvent('canvas:index-hover-delay', { detail: ms }));
    };
    input.value = String(saved);
    apply(saved);
    input.addEventListener('input', () => {
      const ms = clamp(parseInt(input.value, 10) || 0);
      apply(ms);
      try { localStorage.setItem(KEY, String(ms)); } catch (e) {}
    });
  })();

  // 提示框悬停出现延迟：只存浏览器偏好；tooltip.js 读同名键 / 听 canvas:tooltip-hover-delay。
  (function setupTooltipHoverDelay() {
    const input = document.querySelector('[data-role="tooltip-hover-delay"]');
    const valEl = document.querySelector('[data-role="tooltip-hover-delay-val"]');
    if (!input) return;
    const KEY = 'canvas:tooltipHoverDelay';
    const MIN = 0, MAX = 5000;
    const clamp = (n) => Math.max(MIN, Math.min(MAX, n));
    const fmt = (ms) => {
      if (ms <= 0) return '瞬发';
      return (ms / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 's';
    };
    let saved = 3500;
    try { const v = parseInt(localStorage.getItem(KEY), 10); if (Number.isFinite(v)) saved = clamp(v); } catch (e) {}
    const apply = (ms) => {
      if (valEl) valEl.textContent = fmt(ms);
      document.dispatchEvent(new CustomEvent('canvas:tooltip-hover-delay', { detail: ms }));
    };
    input.value = String(saved);
    apply(saved);
    input.addEventListener('input', () => {
      const ms = clamp(parseInt(input.value, 10) || 0);
      apply(ms);
      try { localStorage.setItem(KEY, String(ms)); } catch (e) {}
    });
  })();

  // 提示框离开消失延迟：只存浏览器偏好；tooltip.js 听 canvas:tooltip-hide-delay。
  (function setupTooltipHideDelay() {
    const input = document.querySelector('[data-role="tooltip-hide-delay"]');
    const valEl = document.querySelector('[data-role="tooltip-hide-delay-val"]');
    if (!input) return;
    const KEY = 'canvas:tooltipHideDelay';
    const MIN = 0, MAX = 500;
    const clamp = (n) => Math.max(MIN, Math.min(MAX, n));
    const fmt = (ms) => {
      if (ms <= 0) return '瞬收';
      return ms + 'ms';
    };
    let saved = 70;
    try { const v = parseInt(localStorage.getItem(KEY), 10); if (Number.isFinite(v)) saved = clamp(v); } catch (e) {}
    const apply = (ms) => {
      if (valEl) valEl.textContent = fmt(ms);
      document.dispatchEvent(new CustomEvent('canvas:tooltip-hide-delay', { detail: ms }));
    };
    input.value = String(saved);
    apply(saved);
    input.addEventListener('input', () => {
      const ms = clamp(parseInt(input.value, 10) || 0);
      apply(ms);
      try { localStorage.setItem(KEY, String(ms)); } catch (e) {}
    });
  })();

  // 新建代码节点的默认语言：只存浏览器偏好；已有节点各自保存 language，不会被联动修改。
  (function setupCodeDefaultLanguage() {
    const select = document.querySelector('[data-role="code-default-language"]');
    if (!select) return;
    const KEY = 'canvas:codeDefaultLanguage';
    const LANGS = new Set(['c', 'python', 'matlab']);
    let saved = 'c';
    try {
      const v = localStorage.getItem(KEY);
      if (LANGS.has(v)) saved = v;
    } catch (e) {}
    select.value = saved;
    select.addEventListener('change', () => {
      const value = LANGS.has(select.value) ? select.value : 'c';
      select.value = value;
      try { localStorage.setItem(KEY, value); } catch (e) {}
    });
  })();

  // 手写笔压感开关（齿轮里勾选；全局偏好 canvas:penPressure，默认开。'0'=关）。
  // canvas.js 起笔时直接读这个键，故这里只负责持久化勾选状态。
  (function setupPenPressure() {
    const cb = document.querySelector('[data-role="pen-pressure"]');
    if (!cb) return;
    const KEY = 'canvas:penPressure';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // 文本框拖动软吸附：默认关闭；开启后 canvas.js 同时恢复绿色参考线与自动对齐。
  (function setupTextSnapToggle() {
    const cb = document.querySelector('[data-role="enable-text-snap"]');
    if (!cb) return;
    const KEY = 'canvas:textSnapEnabled';
    let on = false;
    try { on = localStorage.getItem(KEY) === '1'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
      document.dispatchEvent(new CustomEvent('canvas:text-snap-enabled', { detail: cb.checked }));
    });
  })();

  // 属性检查器分为画布、导图、图案三个独立偏好；默认都开启。
  (function setupInspectorPreference() {
    const canvasCb = document.querySelector('[data-role="enable-inspector"]');
    const mindmapCb = document.querySelector('[data-role="enable-mindmap-inspector"]');
    const decorCb = document.querySelector('[data-role="enable-decor-inspector"]');
    if (!canvasCb) return;
    const CANVAS_KEY = 'canvas:inspectorEnabled';
    const MINDMAP_KEY = 'canvas:mindmapInspectorEnabled';
    const DECOR_KEY = 'canvas:decorInspectorEnabled';
    let canvasOn = true;
    let mindmapOn = true;
    let decorOn = true;
    try {
      canvasOn = localStorage.getItem(CANVAS_KEY) !== '0';
      mindmapOn = localStorage.getItem(MINDMAP_KEY) === '1';
      decorOn = localStorage.getItem(DECOR_KEY) !== '0';
    } catch (e) {}
    canvasCb.checked = canvasOn;
    if (mindmapCb) mindmapCb.checked = mindmapOn;
    if (decorCb) decorCb.checked = decorOn;
    function notify() {
      document.dispatchEvent(new CustomEvent('editor:inspectorpreferencechange', {
        detail: {
          canvasEnabled: canvasCb.checked,
          mindmapEnabled: mindmapCb ? mindmapCb.checked : true,
          decorEnabled: decorCb ? decorCb.checked : true,
        },
      }));
    }
    canvasCb.addEventListener('change', () => {
      try { localStorage.setItem(CANVAS_KEY, canvasCb.checked ? '1' : '0'); } catch (e) {}
      notify();
    });
    if (mindmapCb) mindmapCb.addEventListener('change', () => {
      try { localStorage.setItem(MINDMAP_KEY, mindmapCb.checked ? '1' : '0'); } catch (e) {}
      notify();
    });
    if (decorCb) decorCb.addEventListener('change', () => {
      try { localStorage.setItem(DECOR_KEY, decorCb.checked ? '1' : '0'); } catch (e) {}
      notify();
    });
  })();

  // 节点两侧的辅助入口默认保持安静，需要时可从齿轮里恢复显示。
  // 这里只切视觉类，不改任务清单或脑图折叠数据。
  (function setupNodeAssistVisibility() {
    [
      { role: 'show-node-checklists', key: 'canvas:showNodeChecklists', cls: 'show-node-checklists' },
      { role: 'show-mindmap-folds', key: 'canvas:showMindmapFolds', cls: 'show-mindmap-folds' },
    ].forEach((pref) => {
      const cb = document.querySelector('[data-role="' + pref.role + '"]');
      if (!cb) return;
      let on = false;
      try { on = localStorage.getItem(pref.key) === '1'; } catch (e) {}
      const apply = (enabled) => {
        cb.checked = enabled;
        document.body.classList.toggle(pref.cls, enabled);
      };
      apply(on);
      cb.addEventListener('change', () => {
        apply(cb.checked);
        try { localStorage.setItem(pref.key, cb.checked ? '1' : '0'); } catch (e) {}
      });
    });
  })();

  // 框选生成索引：默认关闭，开启后框选 ≥2 节点才浮出「生成索引」小钮（canvas.js 读同名键）
  (function setupGenIndexToggle() {
    const cb = document.querySelector('[data-role="enable-gen-index"]');
    if (!cb) return;
    const KEY = 'canvas:genIndexEnabled';
    let on = false;
    try { on = localStorage.getItem(KEY) === '1'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // 空白框选创建盒子：默认开启，仅控制空选区后的「+ 盒子」按钮（canvas.js 读同名键）
  (function setupBoxCreateToggle() {
    const cb = document.querySelector('[data-role="enable-box-create"]');
    if (!cb) return;
    const KEY = 'canvas:boxCreateEnabled';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // 框选节点创建分组：默认开启，仅控制框选节点后的「+ 分组」按钮（canvas.js 读同名键）
  (function setupGroupCreateToggle() {
    const cb = document.querySelector('[data-role="enable-group-create"]');
    if (!cb) return;
    const KEY = 'canvas:groupCreateEnabled';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // 深色背景线条优化：只存全局视觉偏好，不改任何 edge.lineStyle。
  // canvas.js 在背景语义为 dark 时把连线临时按荧光样式渲染。
  (function setupDarkEdgeOptimization() {
    const cb = document.querySelector('[data-role="enable-dark-edge-optimization"]');
    if (!cb) return;
    const KEY = 'canvas:darkEdgeOptimization';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
      document.dispatchEvent(new CustomEvent('canvas:edge-visual-refresh'));
    });
  })();

  // 索引节点悬停目录开关：默认开启。canvas.js 读同名键 / 听 canvas:index-hover-enabled。
  // Dark semantic UI optimization: default on and purely visual.
  // It controls dark editor panels without changing canvas data or background tone.
  (function setupDarkSemanticUiOptimization() {
    const cb = document.querySelector('[data-role="enable-dark-semantic-ui"]');
    if (!cb) return;
    const KEY = 'canvas:darkSemanticUiOptimization';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    const apply = (enabled) => {
      cb.checked = enabled;
      document.documentElement.classList.toggle('dark-semantic-ui', enabled);
      document.body.classList.toggle('dark-semantic-ui', enabled);
    };
    const label = cb.closest('.settings-check');
    if (label) {
      label.title = '背景语义为深色时，让思维导图、专业、编辑、图案、图谱、背景、脑图和模板使用深色界面；关闭后恢复原来的浅色界面';
    }
    apply(on);
    cb.addEventListener('change', () => {
      apply(cb.checked);
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  (function setupIndexHoverToggle() {
    const cb = document.querySelector('[data-role="enable-index-hover"]');
    if (!cb) return;
    const KEY = 'canvas:indexHoverEnabled';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      document.dispatchEvent(new CustomEvent('canvas:index-hover-enabled', { detail: cb.checked }));
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // 自动保存开关：默认开启；关掉则回到纯手动 Ctrl+S + 未保存提醒
  (function setupAutosaveToggle() {
    const cb = document.querySelector('[data-role="enable-autosave"]');
    if (!cb) return;
    const KEY = 'canvas:autosaveEnabled';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // ── 正常普通模式 · 新建默认样式面板（节点 + 线条）─────────────
  // 无选择时：所有控件写 localStorage 默认值（canvas:proNodeDefaults / canvas:proEdgeDefaults）
  // 选中单个节点时：上半区控件直接编辑节点属性，下半区「节点内容」展开可用；
  //   线条控件始终写默认值不受影响。
  (function setupProPanel() {
    const panel = document.querySelector('[data-role="pro-panel"]');
    if (!panel) return;
    const NKEY = 'canvas:proNodeDefaults';
    const EKEY = 'canvas:proEdgeDefaults';

    function read(key) {
      try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
      catch (e) { return {}; }
    }
    function writeNode() { try { localStorage.setItem(NKEY, JSON.stringify(n)); } catch (e) {} }
    function writeEdge() { try { localStorage.setItem(EKEY, JSON.stringify(g)); } catch (e) {} }

    let n = read(NKEY);   // 节点默认
    let g = read(EKEY);   // 线条默认
    let activeNodeId = null;   // 当前选中的单个节点 id（非单选时清空）
    let contentExpanded = false;  // 用户对节点内容区的展开/折叠偏好；首次默认收起
    try {
      var saved = localStorage.getItem('canvas:proContentExpanded');
      if (saved === '1') contentExpanded = true;
    } catch (e) {}
    function pushEffectiveKind() {
      if (document.body.dataset.mode !== 'normal' || document.body.dataset.modeSubmode !== 'full') return;
      try { localStorage.setItem('canvas:normalNodeKind', n.kind || 'card'); } catch (e) {}
    }

    // 节点控件
    const kindBtns = panel.querySelectorAll('[data-role="pro-kind"] button[data-kind]');
    const shapeBtns = panel.querySelectorAll('[data-role="pro-shape"] button');
    const borderInput = panel.querySelector('[data-role="pro-border"]');
    const bgInput = panel.querySelector('[data-role="pro-bg"]');
    const nodeColorPresetsEl = panel.querySelector('[data-role="pro-node-color-presets"]');
    const resetColorsBtn = panel.querySelector('[data-role="pro-reset-colors"]');
    const opacityInput = panel.querySelector('[data-role="pro-opacity"]');
    const opacityVal = panel.querySelector('[data-role="pro-opacity-val"]');
    const hideChromeInput = panel.querySelector('[data-role="pro-hide-chrome"]');
    const resetGeometryBtn = panel.querySelector('[data-role="pro-reset-geometry"]');
    const scaleInput = panel.querySelector('[data-role="pro-scale"]');
    const scaleVal = panel.querySelector('[data-role="pro-scale-val"]');
    const radiusInput = panel.querySelector('[data-role="pro-radius"]');
    const radiusVal = panel.querySelector('[data-role="pro-radius-val"]');
    const fontWeightInput = panel.querySelector('[data-role="pro-font-weight"]');
    const fontWeightVal = panel.querySelector('[data-role="pro-font-weight-val"]');
    window.CanvasDiscreteRange.enhance(fontWeightInput, {
      detent: 10, fineStep: 10, majorStep: 100, pageStep: 100, defaultValue: 400,
    });
    const fontScaleInput = panel.querySelector('[data-role="pro-font-scale"]');
    const fontScaleVal = panel.querySelector('[data-role="pro-font-scale-val"]');
    const textAlignBtns = panel.querySelectorAll('[data-role="pro-text-align"] button');
    const resetTypographyBtn = panel.querySelector('[data-role="pro-reset-typography"]');
    // 线条控件
    const curveBtns = panel.querySelectorAll('[data-role="pro-curve"] button');
    const lineStyleBtns = panel.querySelectorAll('[data-role="pro-line-style"] button');
    const colorInput = panel.querySelector('[data-role="pro-color"]');
    const edgeColorPresetsEl = panel.querySelector('[data-role="pro-edge-color-presets"]');
    const arrowBtns = panel.querySelectorAll('[data-role="pro-arrow"] button');
    const widthInput = panel.querySelector('[data-role="pro-width"]');
    const widthVal = panel.querySelector('[data-role="pro-width-val"]');
    const arrowSizeInput = panel.querySelector('[data-role="pro-arrowsize"]');
    const arrowSizeVal = panel.querySelector('[data-role="pro-arrowsize-val"]');
    const resetBtn = panel.querySelector('[data-role="pro-reset"]');
    const applyDefaultsBtn = panel.querySelector('[data-role="pro-apply-defaults"]');
    // 节点内容区控件
    const contentHead = panel.querySelector('[data-role="pro-content-head"]');
    const contentToggle = panel.querySelector('[data-role="pro-content-toggle"]');
    const contentBody = panel.querySelector('[data-role="pro-content-body"]');
    const contentHint = panel.querySelector('[data-role="pro-content-hint"]');
    const proBody = panel.querySelector('[data-role="pro-body"]');
    const proBodyRich = panel.querySelector('[data-role="pro-body-rich"]');
    const proBodyNote = panel.querySelector('[data-role="pro-body-note"]');
    const proCodeLangWrap = panel.querySelector('[data-role="pro-code-lang-wrap"]');
    const proCodeLang = panel.querySelector('[data-role="pro-code-language"]');
    const proBodyHint = panel.querySelector('[data-role="pro-body-hint"]');
    const proNote = panel.querySelector('[data-role="pro-note"]');
    const headTitle = panel.querySelector('.side-panel-head-title');
    let proBodyRichDirty = false;

    const nodeColorPresets = (window.CanvasModule && Array.isArray(window.CanvasModule.normalNodeColorPresets))
      ? window.CanvasModule.normalNodeColorPresets : [];
    const edgeColorPresets = (window.CanvasModule && Array.isArray(window.CanvasModule.normalEdgeColorPresets))
      ? window.CanvasModule.normalEdgeColorPresets : [];
    const stickySwatches = (window.CanvasModule && Array.isArray(window.CanvasModule.stickySwatches))
      ? window.CanvasModule.stickySwatches : [];
    let renderedNodePalette = '';
    let renderedEdgePresets = false;

    function isStickyDefaultContext() {
      return !activeNodeId && (n.kind || 'card') === 'sticky';
    }
    function stickyDefaultFixedColor() {
      if (n.stickyColorMode !== 'fixed') return '';
      const color = String(n.stickyBgColor || '').toLowerCase();
      return /^#[0-9a-f]{6}$/.test(color) ? color : '';
    }

    function renderProColorPresets(force) {
      function render(container, presets, type) {
        if (!container) return;
        const frag = document.createDocumentFragment();
        presets.forEach((preset) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = type === 'node' ? 'canvas-color-preset' : 'canvas-edge-color-preset';
          const label = toolbarLanguage === 'en' ? preset.en : preset.zh;
          button.title = label;
          button.setAttribute('aria-label', label);
          if (type === 'node') {
            button.dataset.nodeColorPreset = preset.id;
            button.style.setProperty('--canvas-preset-border', preset.borderColor);
            button.style.setProperty('--canvas-preset-bg', preset.bgColor);
            button.addEventListener('click', () => {
              if (activeNodeId && cm() && typeof cm().applySelectedNodeColorPreset === 'function') {
                cm().applySelectedNodeColorPreset(preset);
                updatePanelForNode(cm().findNode(activeNodeId));
              } else {
                if (preset.borderColor.toLowerCase() === '#000000') delete n.borderColor;
                else n.borderColor = preset.borderColor;
                if (preset.bgColor.toLowerCase() === '#ffffff') delete n.bgColor;
                else n.bgColor = preset.bgColor;
                writeNode();
                syncUI();
              }
            });
          } else {
            button.dataset.edgeColorPreset = preset.id;
            button.style.setProperty('--canvas-edge-preset-color', preset.color);
            button.addEventListener('click', () => {
              if (preset.color.toLowerCase() === '#000000') delete g.color;
              else g.color = preset.color;
              writeEdge();
              syncUI();
            });
          }
          frag.append(button);
        });
        container.replaceChildren(frag);
      }
      const activeNode = activeNodeId && cm() ? cm().findNode(activeNodeId) : null;
      const nodePalette = (activeNode && cm().isStickyNode(activeNode)) || isStickyDefaultContext()
        ? 'sticky' : 'node';
      if (force || renderedNodePalette !== nodePalette) {
        if (nodePalette === 'sticky') {
          const frag = document.createDocumentFragment();
          const randomButton = document.createElement('button');
          randomButton.type = 'button';
          randomButton.className = 'canvas-color-preset canvas-sticky-color-preset canvas-sticky-random-preset';
          randomButton.dataset.stickyColorPreset = 'random';
          randomButton.textContent = '?';
          randomButton.title = toolbarCopy('stickyRandomColor');
          randomButton.setAttribute('aria-label', toolbarCopy('stickyRandomColor'));
          randomButton.addEventListener('click', () => {
            if (activeNodeId && cm() && typeof cm().applySelectedStickyColor === 'function') {
              cm().applySelectedStickyColor('', true);
              updatePanelForNode(cm().findNode(activeNodeId));
            } else if (isStickyDefaultContext()) {
              n.stickyColorMode = 'random';
              delete n.stickyBgColor;
              writeNode();
              syncUI();
            }
          });
          frag.append(randomButton);
          stickySwatches.forEach((swatch) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'canvas-color-preset canvas-sticky-color-preset';
            button.dataset.stickyColorPreset = swatch.hex;
            button.style.setProperty('--canvas-sticky-preset-bg', swatch.hex);
            const label = toolbarLanguage === 'en' ? swatch.en : swatch.zh;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', () => {
              if (activeNodeId && cm() && typeof cm().applySelectedStickyColor === 'function') {
                cm().applySelectedStickyColor(swatch.hex, false);
                updatePanelForNode(cm().findNode(activeNodeId));
              } else if (isStickyDefaultContext()) {
                n.stickyColorMode = 'fixed';
                n.stickyBgColor = swatch.hex;
                writeNode();
                syncUI();
              }
            });
            frag.append(button);
          });
          nodeColorPresetsEl.replaceChildren(frag);
          nodeColorPresetsEl.dataset.palette = 'sticky';
        } else {
          render(nodeColorPresetsEl, nodeColorPresets, 'node');
          nodeColorPresetsEl.dataset.palette = 'node';
        }
        renderedNodePalette = nodePalette;
      }
      if (force || !renderedEdgePresets) {
        render(edgeColorPresetsEl, edgeColorPresets, 'edge');
        renderedEdgePresets = true;
      }
    }

    function syncProColorPresets(nodeSource) {
      renderProColorPresets(false);
      const border = String((nodeSource && nodeSource.borderColor) || '#000000').toLowerCase();
      const bg = String((nodeSource && nodeSource.bgColor) || '#ffffff').toLowerCase();
      // 便签缺少显式底色时并不代表“白底”：新建便签会在创建阶段写入随机果冻色，
      // 已有便签缺色时也会显示便签自己的黄色 CSS 兜底。此时不应误选“黑框白底”。
      // 新建默认里的显式白色同样会被 applyProDefaults 视为内置缺省，最终仍走随机色。
      const stickySource = !!(nodeSource && nodeSource.kind === 'sticky');
      const stickyWithoutConcreteBg = stickySource && (
        activeNodeId ? !nodeSource.bgColor : (!nodeSource.bgColor || bg === '#ffffff')
      );
      if (nodeColorPresetsEl) {
        if (renderedNodePalette === 'sticky') {
          const defaultSticky = isStickyDefaultContext();
          const defaultFixedColor = defaultSticky ? stickyDefaultFixedColor() : '';
          nodeColorPresetsEl.querySelectorAll('[data-sticky-color-preset]').forEach((button) => {
            const color = String(button.dataset.stickyColorPreset || '').toLowerCase();
            button.classList.toggle('active', defaultSticky
              ? (color === 'random' ? !defaultFixedColor : color === defaultFixedColor)
              : (color !== 'random' && color === bg));
          });
        } else {
          nodeColorPresetsEl.querySelectorAll('[data-node-color-preset]').forEach((button) => {
            const preset = nodeColorPresets.find((item) => item.id === button.dataset.nodeColorPreset);
            button.classList.toggle('active', !stickyWithoutConcreteBg && !!preset
              && preset.borderColor.toLowerCase() === border
              && preset.bgColor.toLowerCase() === bg);
          });
        }
      }
      const edgeColor = String(g.color || '#000000').toLowerCase();
      if (edgeColorPresetsEl) {
        edgeColorPresetsEl.querySelectorAll('[data-edge-color-preset]').forEach((button) => {
          const preset = edgeColorPresets.find((item) => item.id === button.dataset.edgeColorPreset);
          button.classList.toggle('active', !!preset && preset.color.toLowerCase() === edgeColor);
        });
      }
    }
    renderProColorPresets();

    function setActive(btns, attr, val) {
      btns.forEach((b) => b.classList.toggle('active', b.dataset[attr] === val));
    }

    function cm() { return window.CanvasModule; }
    function setProRichBody(node) {
      if (!proBodyRich) return;
      var rich = window.RelatumRichText;
      if (rich) rich.renderEditable(proBodyRich, node && node.body || '', node && node.bodyMarks || []);
      else proBodyRich.textContent = node && node.body || '';
    }
    function readProRichBody() {
      var rich = window.RelatumRichText;
      if (rich) return rich.extractEditable(proBodyRich);
      return { text: proBodyRich ? (proBodyRich.textContent || '') : '', marks: [] };
    }
    function prepareProRichBody() {
      if (!proBodyRich || proBodyRich.dataset.richEditorReady === '1') return;
      proBodyRich.dataset.richEditorReady = '1';
      proBodyRich.addEventListener('beforeinput', function (event) {
        if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return;
        event.preventDefault();
        document.execCommand('insertText', false, '\n');
      });
      proBodyRich.addEventListener('paste', function (event) {
        var text = event.clipboardData && event.clipboardData.getData('text/plain');
        if (text == null) return;
        event.preventDefault();
        document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
      });
      proBodyRich.addEventListener('drop', function (event) {
        var text = event.dataTransfer && event.dataTransfer.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
      });
    }
    prepareProRichBody();

    // ── 控件同步：无选择 → localStorage 默认值；选中节点 → 节点当前值 ──
    function syncUI() {
      const node = activeNodeId && cm() ? cm().findNode(activeNodeId) : null;
      if (node) {
        // 从节点读取
        setActive(kindBtns, 'kind', node.kind || 'card');
        setActive(shapeBtns, 'shape', node.shape || 'rect');
        borderInput.value = node.borderColor || '#000000';
        bgInput.value = node.bgColor || '#ffffff';
        var op = (node.opacity == null) ? 100 : Math.round(node.opacity * 100);
        opacityInput.value = op;
        opacityVal.textContent = op + '%';
        if (hideChromeInput) hideChromeInput.checked = !!node.hideChrome;
        var scale = Number(node.scale) > 0 ? Math.round(Number(node.scale) * 100) : 100;
        scale = Math.max(50, Math.min(200, scale));
        scaleInput.value = scale;
        scaleVal.textContent = scale + '%';
        var mindmap = node.mindmapStyleRole || node.mindmapStylePreset || node.mindmapRoot;
        var radius = mindmap ? (Number(node.mindmapRadius) >= 0 ? Math.round(Number(node.mindmapRadius)) : 6)
          : (Number(node.radius) >= 0 ? Math.round(Number(node.radius)) : 10);
        radiusInput.value = radius;
        radiusVal.textContent = radius + 'px';
        var fontWeightInfo = canvasFontWeightInfo(node);
        var fontWeightDefault = (cm() && typeof cm().getSingleNodeDefaultFontWeight === 'function')
          ? cm().getSingleNodeDefaultFontWeight(activeNodeId)
          : canvasFontWeightDefaultInfo(node).value;
        fontWeightInput.value = fontWeightInfo.value;
        window.CanvasDiscreteRange.sync(fontWeightInput, { defaultValue: fontWeightDefault });
        fontWeightVal.textContent = canvasFontWeightLabel(fontWeightInfo);
        var fontScale = Number(node.fontScale) > 0 ? Math.round(Number(node.fontScale) * 100) : 100;
        fontScaleInput.value = fontScale;
        fontScaleVal.textContent = fontScale + '%';
        var align = mindmap ? (node.mindmapTextAlign || 'left') : (node.textAlign || 'left');
        setActive(textAlignBtns, 'textAlign', align);
      } else {
        // 从 localStorage 默认值读取（原逻辑）
        if (n.kind === 'text') n.kind = 'index';
        setActive(kindBtns, 'kind', n.kind || 'card');
        setActive(shapeBtns, 'shape', n.shape || 'rect');
        borderInput.value = n.borderColor || '#000000';
        bgInput.value = isStickyDefaultContext() ? (stickyDefaultFixedColor() || '#ffffff') : (n.bgColor || '#ffffff');
        var op2 = (n.opacity == null) ? 100 : Math.round(n.opacity * 100);
        opacityInput.value = op2;
        opacityVal.textContent = op2 + '%';
        if (hideChromeInput) hideChromeInput.checked = !!n.hideChrome;
        var scale2 = Number(n.scale) > 0 ? Math.round(Number(n.scale) * 100) : 100;
        scale2 = Math.max(50, Math.min(200, scale2));
        scaleInput.value = scale2;
        scaleVal.textContent = scale2 + '%';
        var r2 = Number(n.radius) >= 0 ? Math.round(Number(n.radius)) : 10;
        radiusInput.value = r2;
        radiusVal.textContent = r2 + 'px';
        var fw2 = canvasFontWeightInfo(n, n.kind || 'card');
        var fwDefault2 = canvasFontWeightDefaultInfo(n, n.kind || 'card').value;
        fontWeightInput.value = fw2.value;
        window.CanvasDiscreteRange.sync(fontWeightInput, { defaultValue: fwDefault2 });
        fontWeightVal.textContent = canvasFontWeightLabel(fw2);
        var fs2 = Number(n.fontScale) > 0 ? Math.round(Number(n.fontScale) * 100) : 100;
        fontScaleInput.value = fs2;
        fontScaleVal.textContent = fs2 + '%';
        setActive(textAlignBtns, 'textAlign', n.textAlign || 'left');
      }
      // 线条始终从 localStorage 读取（不受选择影响）
      setActive(curveBtns, 'curve', g.curve || 'bezier');
      setActive(lineStyleBtns, 'lineStyle', g.lineStyle || 'solid');
      if (colorInput) colorInput.value = g.color || '#000000';
      setActive(arrowBtns, 'arrow', g.arrow || 'none');
      var w = (g.width == null) ? 1.5 : g.width;
      widthInput.value = w;
      widthVal.textContent = String(w);
      var as = (g.arrowSize == null) ? 12 : g.arrowSize;
      arrowSizeInput.value = as;
      arrowSizeVal.textContent = String(as);
      syncProColorPresets(node || n);
    }

    // ── 节点内容区同步 ──
    function syncContentUI(node) {
      if (!node) return;
      var readable = cm() && cm().isReadableNode(node);
      var bodyNode = cm() && cm().isBodyNode(node);
      var codeNode = cm() && cm().isCodeNode(node);
      var stickyNode = cm() && cm().isStickyNode(node);
      var cardNode = cm() && cm().isCardNode(node);
      var previewNode = cm() && cm().isPreviewNode(node);

      // 正文
      if (proBody && bodyNode && codeNode && document.activeElement !== proBody) {
        proBody.value = node.body || '';
        proBody.placeholder = '直接输入代码。Tab 缩进，Shift+Tab 减少缩进。';
        proBody.classList.toggle('code-source-editor', codeNode);
      }
      if (proBody && !bodyNode) {
        proBody.value = '';
        proBody.placeholder = toolbarCopy('noBodyHint');
        proBody.classList.remove('code-source-editor');
      }
      if (proBody) proBody.hidden = !bodyNode || !codeNode;
      if (proBodyRich) {
        proBodyRich.hidden = !bodyNode || codeNode;
        if (bodyNode && !codeNode && document.activeElement !== proBodyRich) {
          setProRichBody(node);
          proBodyRichDirty = false;
        } else if (!bodyNode) {
          proBodyRich.textContent = '';
          proBodyRichDirty = false;
        }
      }
      if (proBodyHint) proBodyHint.hidden = !readable;
      if (proBodyNote) {
        proBodyNote.textContent = codeNode ? toolbarCopy('bodyNoteCode')
          : stickyNode ? toolbarCopy('bodyNoteSticky')
          : cardNode ? toolbarCopy('bodyNoteCard')
          : previewNode ? toolbarCopy('bodyNotePreview')
          : readable ? toolbarCopy('bodyNoteIndex')
          : toolbarCopy('bodyNoteNone');
      }
      // 代码语言
      if (proCodeLangWrap) proCodeLangWrap.hidden = !codeNode;
      if (proCodeLang && codeNode) {
        proCodeLang.value = (node.language === 'c' || node.language === 'python' || node.language === 'matlab')
          ? node.language : 'python';
      }
    }

    function nodeTypeLabel(node) {
      if (!node || !cm()) return toolbarCopy('nodeFallback');
      if (cm().isIndexNode(node)) return toolbarCopy('epKindIndex');
      if (cm().isCodeNode(node)) return toolbarCopy('epKindCode');
      if (cm().isStickyNode(node)) return toolbarCopy('epKindSticky');
      if (cm().isCardNode(node)) return toolbarCopy('epKindCard');
      if (cm().isPreviewNode(node)) return toolbarCopy('epKindPreview');
      return toolbarCopy('nodeFallback');
    }

    function syncContentSectionState(hasActiveNode) {
      if (contentHead) contentHead.setAttribute('aria-expanded', contentExpanded ? 'true' : 'false');
      if (contentBody) {
        if (hasActiveNode && contentExpanded) contentBody.removeAttribute('inert');
        else contentBody.setAttribute('inert', '');
      }
      // 提示只表达“当前没有可编辑目标”；单选后即使用户保持收起，也不再误报需要选中节点。
      if (contentHint) contentHint.hidden = !!hasActiveNode;
    }

    function updatePanelForNode(node) {
      if (!node) return;
      activeNodeId = node.id;
      document.body.dataset.proPanelTarget = 'node';
      if (headTitle) headTitle.textContent = nodeTypeLabel(node);
      if (resetBtn) resetBtn.textContent = toolbarCopy('resetBuiltInAppearance');
      if (applyDefaultsBtn) {
        applyDefaultsBtn.hidden = false;
        applyDefaultsBtn.disabled = !!(node.mindmapStyleRole || node.mindmapStylePreset || node.mindmapRoot);
      }
      syncUI();
      // 选择变化只切换内容是否可编辑；展开状态完全由用户的箭头偏好决定。
      syncContentSectionState(true);
      syncContentUI(node);
      // 底部提示
      if (proNote) proNote.textContent = toolbarCopy('proNoteEditingBefore') + (node.text || nodeTypeLabel(node)) + toolbarCopy('proNoteEditingAfter');
    }

    function updatePanelForDefaults() {
      activeNodeId = null;
      document.body.removeAttribute('data-pro-panel-target');
      if (headTitle) headTitle.textContent = toolbarCopy('canvasNewStyles');
      if (resetBtn) resetBtn.textContent = toolbarCopy('resetNewStyleDefaults');
      if (applyDefaultsBtn) {
        applyDefaultsBtn.hidden = true;
        applyDefaultsBtn.disabled = false;
      }
      syncUI();
      // 不替用户收起：保持面板高度稳定，仅禁用没有编辑目标的内容控件。
      syncContentSectionState(false);
      // 恢复底部提示
      if (proNote) proNote.textContent = toolbarCopy('proNoteDefaults');
    }

    // ── 节点控件事件：根据 activeNodeId 决定写入目标 ──
    kindBtns.forEach((b) => b.addEventListener('click', () => {
      if (activeNodeId && cm()) {
        // 编辑模式：修改选中节点的类型
        var node = cm().findNode(activeNodeId);
        if (!node) return;
        var kind = b.dataset.kind;
        if (!['index', 'preview', 'card', 'sticky', 'code'].includes(kind)) return;
        if (cm().isReadableNode(node)) {
          cm().switchSingleNodeKind(activeNodeId, kind);
        } else {
          cm().convertSingleToBodyNode(activeNodeId, kind);
        }
        cm().pushHistory();
        cm().notify();
        // 刷新面板显示
        updatePanelForNode(cm().findNode(activeNodeId));
      } else {
        // 默认模式：写 localStorage
        if (b.dataset.kind === 'index' || b.dataset.kind === 'preview'
            || b.dataset.kind === 'card' || b.dataset.kind === 'sticky' || b.dataset.kind === 'code') n.kind = b.dataset.kind;
        else delete n.kind;
        pushEffectiveKind();
        writeNode();
        syncUI();
        document.dispatchEvent(new CustomEvent('editor:default-kind-change', { detail: { kind: n.kind || 'card' } }));
      }
    }));
    // 数字键 3–7 始终只改“接下来新建”的默认类型；即使当前有单选节点，
    // 也不能复用上面的检查器点击路径去转换现有内容。
    document.addEventListener('editor:quick-new-kind', (event) => {
      if (document.body.dataset.mode !== 'normal' || document.body.dataset.modeSubmode !== 'full') return;
      const kind = event.detail && event.detail.kind;
      if (!['index', 'preview', 'card', 'sticky', 'code'].includes(kind)) return;
      n.kind = kind;
      pushEffectiveKind();
      writeNode();
      if (!activeNodeId) syncUI();
      document.dispatchEvent(new CustomEvent('editor:default-kind-change', {
        detail: { kind: kind, source: 'keyboard-full' },
      }));
    });
    shapeBtns.forEach((b) => b.addEventListener('click', () => {
      if (activeNodeId && cm()) {
        cm().editSingleNodeField(activeNodeId, 'shape', b.dataset.shape, b.dataset.shape === 'rect');
        cm().pushHistory();
        syncUI();
      } else {
        n.shape = b.dataset.shape; writeNode(); syncUI();
      }
    }));
    if (resetColorsBtn) resetColorsBtn.addEventListener('click', () => {
      if (activeNodeId && cm() && typeof cm().resetSelectedNodeAppearanceSection === 'function') {
        cm().resetSelectedNodeAppearanceSection('colors');
        updatePanelForNode(cm().findNode(activeNodeId));
      } else if (isStickyDefaultContext()) {
        n.stickyColorMode = 'random';
        delete n.stickyBgColor;
        writeNode();
        syncUI();
      } else {
        delete n.borderColor;
        delete n.bgColor;
        writeNode();
        syncUI();
      }
    });
    if (resetGeometryBtn) resetGeometryBtn.addEventListener('click', () => {
      if (activeNodeId && cm() && typeof cm().resetSelectedNodeAppearanceSection === 'function') {
        cm().resetSelectedNodeAppearanceSection('geometry');
        updatePanelForNode(cm().findNode(activeNodeId));
      } else {
        delete n.shape;
        delete n.scale;
        writeNode();
        syncUI();
      }
    });
    if (resetTypographyBtn) resetTypographyBtn.addEventListener('click', () => {
      if (activeNodeId && cm() && typeof cm().resetSelectedNodeAppearanceSection === 'function') {
        cm().resetSelectedNodeAppearanceSection('typography');
        updatePanelForNode(cm().findNode(activeNodeId));
      } else {
        ['radius', 'fontWeight', 'fontScale', 'textAlign'].forEach((prop) => { delete n[prop]; });
        writeNode();
        syncUI();
      }
    });
    borderInput.addEventListener('input', () => {
      if (activeNodeId && cm()) {
        cm().editSingleNodeField(activeNodeId, 'borderColor', borderInput.value, borderInput.value.toLowerCase() === '#000000');
      } else { n.borderColor = borderInput.value; writeNode(); }
      syncProColorPresets(activeNodeId && cm() ? cm().findNode(activeNodeId) : n);
    });
    borderInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    bgInput.addEventListener('input', () => {
      if (activeNodeId && cm()) {
        cm().editSingleNodeField(activeNodeId, 'bgColor', bgInput.value, bgInput.value.toLowerCase() === '#ffffff');
      } else if (isStickyDefaultContext()) {
        n.stickyColorMode = 'fixed';
        n.stickyBgColor = bgInput.value;
        writeNode();
      } else { n.bgColor = bgInput.value; writeNode(); }
      syncProColorPresets(activeNodeId && cm() ? cm().findNode(activeNodeId) : n);
    });
    bgInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    opacityInput.addEventListener('input', () => {
      var v = parseInt(opacityInput.value, 10);
      opacityVal.textContent = v + '%';
      if (activeNodeId && cm()) {
        cm().editSingleNodeField(activeNodeId, 'opacity', v / 100, v === 100);
      } else { n.opacity = v / 100; writeNode(); }
    });
    opacityInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    if (hideChromeInput) hideChromeInput.addEventListener('change', () => {
      if (activeNodeId && cm()) {
        cm().editSingleNodeField(activeNodeId, 'hideChrome', true, !hideChromeInput.checked);
        cm().pushHistory();
        syncUI();
      } else {
        if (hideChromeInput.checked) n.hideChrome = true;
        else delete n.hideChrome;
        writeNode();
        syncUI();
      }
    });
    scaleInput.addEventListener('input', () => {
      var v = parseInt(scaleInput.value, 10);
      scaleVal.textContent = v + '%';
      if (activeNodeId && cm()) {
        cm().editSingleNodeField(activeNodeId, 'scale', v / 100, v === 100);
      } else {
        if (v === 100) delete n.scale; else n.scale = v / 100;
        writeNode();
      }
    });
    scaleInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    radiusInput.addEventListener('input', () => {
      var v = parseInt(radiusInput.value, 10);
      radiusVal.textContent = v + 'px';
      if (activeNodeId && cm()) {
        cm().editSingleNodeContextField(activeNodeId, 'radius', v);
      } else {
        if (v === 10) delete n.radius; else n.radius = v;
        writeNode();
      }
    });
    radiusInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    fontWeightInput.addEventListener('input', () => {
      var v = parseInt(fontWeightInput.value, 10);
      fontWeightVal.textContent = String(v);
      if (activeNodeId && cm()) {
        cm().editSingleNodeContextField(activeNodeId, 'fontWeight', v);
      } else {
        n.fontWeight = v;
        writeNode();
      }
    });
    fontWeightInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    fontScaleInput.addEventListener('input', () => {
      var v = parseInt(fontScaleInput.value, 10);
      fontScaleVal.textContent = v + '%';
      if (activeNodeId && cm()) {
        cm().editSingleNodeContextField(activeNodeId, 'fontScale', v / 100);
      } else {
        if (v === 100) delete n.fontScale; else n.fontScale = v / 100;
        writeNode();
      }
    });
    fontScaleInput.addEventListener('change', () => {
      if (activeNodeId && cm()) cm().pushHistory();
    });
    textAlignBtns.forEach((b) => b.addEventListener('click', () => {
      if (activeNodeId && cm()) {
        cm().editSingleNodeContextField(activeNodeId, 'textAlign', b.dataset.textAlign);
        cm().pushHistory();
        syncUI();
      } else {
        if (b.dataset.textAlign === 'left') delete n.textAlign; else n.textAlign = b.dataset.textAlign;
        writeNode();
        syncUI();
      }
    }));
    // 线条事件（始终写 localStorage，不受选择影响）
    curveBtns.forEach((b) => b.addEventListener('click', () => {
      var v = b.dataset.curve;
      if (v === 'bezier') delete g.curve; else g.curve = v;
      writeEdge(); syncUI();
    }));
    lineStyleBtns.forEach((b) => b.addEventListener('click', () => {
      var v = b.dataset.lineStyle;
      if (v === 'solid') delete g.lineStyle; else g.lineStyle = v;
      writeEdge(); syncUI();
    }));
    if (colorInput) colorInput.addEventListener('input', () => {
      if (colorInput.value.toLowerCase() === '#000000') delete g.color; else g.color = colorInput.value;
      writeEdge();
      syncProColorPresets(activeNodeId && cm() ? cm().findNode(activeNodeId) : n);
    });
    arrowBtns.forEach((b) => b.addEventListener('click', () => { g.arrow = b.dataset.arrow; writeEdge(); syncUI(); }));
    widthInput.addEventListener('input', () => {
      g.width = parseFloat(widthInput.value);
      widthVal.textContent = widthInput.value;
      writeEdge();
    });
    arrowSizeInput.addEventListener('input', () => {
      g.arrowSize = parseInt(arrowSizeInput.value, 10);
      arrowSizeVal.textContent = arrowSizeInput.value;
      writeEdge();
    });
    resetBtn.addEventListener('click', () => {
      if (activeNodeId && cm()) {
        cm().resetSingleNodeAppearance(activeNodeId);
        cm().pushHistory();
        cm().notify();
        updatePanelForNode(cm().findNode(activeNodeId));
      } else {
        n = {}; g = {};
        writeNode(); writeEdge();
        pushEffectiveKind();
        syncUI();
        document.dispatchEvent(new CustomEvent('editor:default-kind-change', { detail: { kind: 'card' } }));
      }
    });
    if (applyDefaultsBtn) applyDefaultsBtn.addEventListener('click', () => {
      if (!activeNodeId || !cm() || typeof cm().applyCurrentNodeDefaultsToSelection !== 'function') return;
      cm().applyCurrentNodeDefaultsToSelection();
      updatePanelForNode(cm().findNode(activeNodeId));
    });

    // ── 节点内容区事件 ──
    if (contentToggle) contentToggle.addEventListener('click', () => {
      var expanded = contentHead.getAttribute('aria-expanded') === 'true';
      contentExpanded = !expanded;
      try { localStorage.setItem('canvas:proContentExpanded', contentExpanded ? '1' : '0'); } catch (e) {}
      syncContentSectionState(!!activeNodeId);
      // 展开时若有选中节点则刷新内容
      if (contentExpanded && activeNodeId && cm()) {
        var node = cm().findNode(activeNodeId);
        if (node) syncContentUI(node);
      }
    });
    // 正文
    if (proBody) {
      proBody.addEventListener('keydown', function (e) {
        if (!activeNodeId || !cm()) return;
        var node = cm().findNode(activeNodeId);
        if (!node || !cm().isCodeNode(node) || e.key !== 'Tab') return;
        e.preventDefault();
        // 简单 Tab 缩进
        var start = proBody.selectionStart;
        var end = proBody.selectionEnd;
        if (e.shiftKey) {
          // Shift+Tab 减少缩进（简化版）
          var lineStart = proBody.value.lastIndexOf('\n', start - 1) + 1;
          if (proBody.value.substring(lineStart, lineStart + 2) === '  ') {
            proBody.value = proBody.value.substring(0, lineStart) + proBody.value.substring(lineStart + 2);
            proBody.selectionStart = start - 2; proBody.selectionEnd = end - 2;
          }
        } else {
          proBody.value = proBody.value.substring(0, start) + '  ' + proBody.value.substring(end);
          proBody.selectionStart = proBody.selectionEnd = start + 2;
        }
        proBody.dispatchEvent(new Event('input', { bubbles: true }));
      });
      proBody.addEventListener('input', function () {
        if (!activeNodeId || !cm()) return;
        cm().applySingleNodeBody(activeNodeId, proBody.value);
      });
      proBody.addEventListener('change', function () {
        if (activeNodeId && cm()) cm().pushHistory();
      });
    }
    if (proBodyRich) {
      proBodyRich.addEventListener('input', function () {
        if (!activeNodeId || !cm()) return;
        var node = cm().findNode(activeNodeId);
        if (!node || !cm().isBodyNode(node) || cm().isCodeNode(node)) return;
        var draft = readProRichBody();
        proBodyRichDirty = true;
        cm().applySingleNodeBody(activeNodeId, draft.text, draft.marks);
      });
      proBodyRich.addEventListener('blur', function () {
        if (!activeNodeId || !cm()) return;
        var node = cm().findNode(activeNodeId);
        if (node && cm().isBodyNode(node) && !cm().isCodeNode(node)) setProRichBody(node);
        if (proBodyRichDirty) cm().pushHistory();
        proBodyRichDirty = false;
      });
    }
    // 代码语言
    if (proCodeLang) proCodeLang.addEventListener('change', function () {
      if (!activeNodeId || !cm()) return;
      var node = cm().findNode(activeNodeId);
      if (!node || !cm().isCodeNode(node)) return;
      node.language = proCodeLang.value;
      cm().applySingleNodeBody(activeNodeId, node.body || '');
      cm().pushHistory();
      cm().notify();
      updatePanelForNode(node);
    });
    // ── 监听选择变化 ──
    document.addEventListener('editor:singleselect', function (event) {
      var node = event.detail && event.detail.node;
      if (node) {
        updatePanelForNode(node);
      } else {
        updatePanelForDefaults();
      }
    });
    // 非单选（多选、连线选、箭头选）时重置面板
    document.addEventListener('editor:selectionchange', function (event) {
      var detail = event.detail || {};
      if ((detail.contentNodes !== 1 || detail.edges > 0 || detail.arrow) && activeNodeId !== null) {
        updatePanelForDefaults();
      }
    });
    document.addEventListener('editor:nodestylechange', function (event) {
      if (!activeNodeId || !cm() || !event.detail || event.detail.nodeId !== activeNodeId) return;
      var node = cm().findNode(activeNodeId);
      if (node) updatePanelForNode(node);
    });

    document.addEventListener('editor:modechange', function () {
      pushEffectiveKind();
      // 离开 normal+full 时重置面板状态
      if (document.body.dataset.mode !== 'normal' || document.body.dataset.modeSubmode !== 'full') {
        updatePanelForDefaults();
      }
    });
    // 语言切换时刷新动态文本
    document.addEventListener('editor:languagechange', function () {
      renderProColorPresets(true);
      if (activeNodeId && cm()) {
        var node = cm().findNode(activeNodeId);
        if (node) updatePanelForNode(node);
      } else {
        updatePanelForDefaults();
      }
    });
    syncUI();
    pushEffectiveKind();
    syncContentSectionState(false);
  })();

  // ── 简洁画布模式 · 常用新建类型偏好 ───────────────────────
  // 右侧小浮窗保留卡片/便签两个高频入口，完整五种类型由“样式”面板控制。
  // clean 默认的 kind 是持久来源；canvas:normalNodeKindPref 只保留旧版本兼容。
  (function setupNormalKindPanel() {
    const panel = document.querySelector('[data-role="normal-kind"]');
    if (!panel) return;
    const PREF = 'canvas:normalNodeKindPref';
    const EFF = 'canvas:normalNodeKind';
    const CLEAN_NKEY = 'canvas:cleanNodeDefaults';
    const ALLOWED = ['index', 'preview', 'card', 'sticky', 'code'];
    // 表格按钮由 canvas.js 管理为独立创建工具，不参与普通节点 kind 偏好。
    const btns = panel.querySelectorAll('.nkf-btn[data-kind]');
    let pref = 'card';
    let effective = 'card';
    try {
      const clean = JSON.parse(localStorage.getItem(CLEAN_NKEY) || '{}') || {};
      const legacy = localStorage.getItem(PREF);
      if (ALLOWED.includes(clean.kind)) pref = clean.kind;
      else if (ALLOWED.includes(legacy)) pref = legacy;
    } catch (e) {}
    try {
      const v = localStorage.getItem(EFF);
      if (ALLOWED.includes(v)) effective = v;
      else effective = pref;
    } catch (e) { effective = pref; }
    function persistPref() {
      try {
        localStorage.setItem(PREF, pref);
        const clean = JSON.parse(localStorage.getItem(CLEAN_NKEY) || '{}') || {};
        clean.kind = pref;
        localStorage.setItem(CLEAN_NKEY, JSON.stringify(clean));
      } catch (e) {}
    }
    function syncUI() { btns.forEach((b) => b.classList.toggle('active', b.dataset.kind === effective)); }
    function pushEffective() {
      const cleanNormal = document.body.dataset.mode === 'normal'
        && document.body.dataset.modeSubmode === 'clean';
      if (!cleanNormal) return;
      try { localStorage.setItem(EFF, effective); } catch (e) {}
    }
    btns.forEach((b) => b.addEventListener('click', () => {
      pref = ALLOWED.includes(b.dataset.kind) ? b.dataset.kind : 'card';
      effective = pref;
      persistPref();
      syncUI();
      pushEffective();
      document.dispatchEvent(new CustomEvent('editor:default-kind-change', {
        detail: { kind: pref, source: 'clean-quick' },
      }));
    }));
    document.addEventListener('editor:quick-new-kind', (event) => {
      if (document.body.dataset.mode !== 'normal' || document.body.dataset.modeSubmode !== 'clean') return;
      const kind = event.detail && event.detail.kind;
      if (!ALLOWED.includes(kind)) return;
      pref = kind;
      effective = kind;
      persistPref();
      syncUI();
      pushEffective();
      document.dispatchEvent(new CustomEvent('editor:default-kind-change', {
        detail: { kind: kind, source: 'keyboard-clean' },
      }));
    });
    document.addEventListener('editor:default-kind-change', (event) => {
      const kind = event.detail && event.detail.kind;
      if (!ALLOWED.includes(kind)) return;
      effective = kind;
      const cleanNormal = document.body.dataset.mode === 'normal'
        && document.body.dataset.modeSubmode === 'clean';
      if (cleanNormal) {
        pref = kind;
        persistPref();
      }
      syncUI();
      pushEffective();
    });
    document.addEventListener('editor:modechange', () => {
      if (document.body.dataset.mode === 'normal' && document.body.dataset.modeSubmode === 'clean') {
        effective = pref;
        syncUI();
      }
      pushEffective();
    });
    if (document.body.dataset.mode === 'normal' && document.body.dataset.modeSubmode === 'clean') effective = pref;
    persistPref();
    syncUI();
    pushEffective();   // 初始化即按当前模式落定有效值（setupModeSwitch 已先 apply 过）
  })();

  // ── 简洁画布模式 · 独立上下文样式面板 ─────────────────────
  // 无单选时写 clean 专属默认键；单选内容节点时直接编辑该节点。
  // 始终保持 clean 子模式，不启用完整属性检查器。
  (function setupCleanStylePanel() {
    const panel = document.querySelector('[data-role="clean-style-panel"]');
    const trigger = document.querySelector('[data-action="open-clean-style"]');
    if (!panel || !trigger) return;
    const closeBtn = panel.querySelector('[data-action="close-clean-style"]');
    const NKEY = 'canvas:cleanNodeDefaults';
    const EKEY = 'canvas:cleanEdgeDefaults';
    function read(key) {
      try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
      catch (e) { return {}; }
    }
    let n = read(NKEY);
    let g = read(EKEY);
    let activeNodeId = null;
    const writeNode = () => { try { localStorage.setItem(NKEY, JSON.stringify(n)); } catch (e) {} };
    const writeEdge = () => { try { localStorage.setItem(EKEY, JSON.stringify(g)); } catch (e) {} };

    const kindBtns = panel.querySelectorAll('[data-role="clean-kind"] button');
    const shapeBtns = panel.querySelectorAll('[data-role="clean-shape"] button');
    const bgInput = panel.querySelector('[data-role="clean-bg"]');
    const borderInput = panel.querySelector('[data-role="clean-border"]');
    const opacityInput = panel.querySelector('[data-role="clean-opacity"]');
    const opacityVal = panel.querySelector('[data-role="clean-opacity-val"]');
    const hideChromeInput = panel.querySelector('[data-role="clean-hide-chrome"]');
    const radiusInput = panel.querySelector('[data-role="clean-radius"]');
    const radiusVal = panel.querySelector('[data-role="clean-radius-val"]');
    const fontWeightInput = panel.querySelector('[data-role="clean-font-weight"]');
    const fontWeightVal = panel.querySelector('[data-role="clean-font-weight-val"]');
    window.CanvasDiscreteRange.enhance(fontWeightInput, {
      detent: 10, fineStep: 10, majorStep: 100, pageStep: 100, defaultValue: 400,
    });
    const fontScaleInput = panel.querySelector('[data-role="clean-font-scale"]');
    const fontScaleVal = panel.querySelector('[data-role="clean-font-scale-val"]');
    const textAlignBtns = panel.querySelectorAll('[data-role="clean-text-align"] button');
    const curveBtns = panel.querySelectorAll('[data-role="clean-curve"] button');
    const lineStyleBtns = panel.querySelectorAll('[data-role="clean-line-style"] button');
    const colorInput = panel.querySelector('[data-role="clean-color"]');
    const widthInput = panel.querySelector('[data-role="clean-width"]');
    const widthVal = panel.querySelector('[data-role="clean-width-val"]');
    const arrowBtns = panel.querySelectorAll('[data-role="clean-arrow"] button');
    const resetBtn = panel.querySelector('[data-role="clean-reset"]');
    const scopeLabel = panel.querySelector('[data-role="clean-style-scope"]');
    const contextHint = panel.querySelector('[data-role="clean-style-hint"]');

    function setActive(btns, attr, value) {
      btns.forEach((button) => button.classList.toggle('active', button.dataset[attr] === value));
    }
    function cm() { return window.CanvasModule; }
    function activeNode() {
      return activeNodeId && cm() && typeof cm().findNode === 'function' ? cm().findNode(activeNodeId) : null;
    }
    function syncUI() {
      const node = activeNode();
      if (!node && n.kind === 'text') n.kind = 'index';
      const source = node || n;
      const mindmap = !!(node && (node.mindmapStyleRole || node.mindmapStylePreset || node.mindmapRoot));
      const kind = node && cm() && cm().isIndexNode(node) ? 'index' : (source.kind || 'card');
      setActive(kindBtns, 'kind', kind);
      setActive(shapeBtns, 'shape', source.shape || 'rect');
      bgInput.value = source.bgColor || '#ffffff';
      borderInput.value = source.borderColor || '#000000';
      const opacity = source.opacity == null ? 100 : Math.round(Number(source.opacity) * 100);
      opacityInput.value = opacity;
      opacityVal.textContent = opacity + '%';
      hideChromeInput.checked = !!source.hideChrome;
      const radius = mindmap
        ? (Number(node.mindmapRadius) >= 0 ? Math.round(Number(node.mindmapRadius)) : 6)
        : (Number(source.radius) >= 0 ? Math.round(Number(source.radius)) : 10);
      radiusInput.value = radius;
      radiusVal.textContent = radius + 'px';
      const fontWeight = canvasFontWeightInfo(source, kind);
      const fontWeightDefault = (node && cm() && typeof cm().getSingleNodeDefaultFontWeight === 'function')
        ? cm().getSingleNodeDefaultFontWeight(activeNodeId)
        : canvasFontWeightDefaultInfo(source, kind).value;
      fontWeightInput.value = fontWeight.value;
      window.CanvasDiscreteRange.sync(fontWeightInput, { defaultValue: fontWeightDefault });
      fontWeightVal.textContent = canvasFontWeightLabel(fontWeight);
      const fontScale = Number(source.fontScale) > 0 ? Math.round(Number(source.fontScale) * 100) : 100;
      fontScaleInput.value = fontScale;
      fontScaleVal.textContent = fontScale + '%';
      setActive(textAlignBtns, 'textAlign', mindmap ? (node.mindmapTextAlign || 'left') : (source.textAlign || 'left'));
      setActive(curveBtns, 'curve', g.curve || 'bezier');
      setActive(lineStyleBtns, 'lineStyle', g.lineStyle || 'solid');
      colorInput.value = g.color || '#000000';
      const width = g.width == null ? 1.5 : Number(g.width);
      widthInput.value = width;
      widthVal.textContent = String(width);
      setActive(arrowBtns, 'arrow', g.arrow || 'none');
      panel.dataset.target = node ? 'node' : 'defaults';
      if (scopeLabel) scopeLabel.textContent = toolbarCopy(node ? 'editingSelection' : 'newDefaults');
      if (resetBtn) resetBtn.textContent = toolbarCopy(node ? 'resetAppearance' : 'cleanResetDefaults');
      if (contextHint) {
        contextHint.textContent = node
          ? toolbarCopy('cleanNoteEditingBefore') + (node.text || toolbarCopy('nodeFallback')) + toolbarCopy('cleanNoteEditingAfter')
          : toolbarCopy('proNoteDefaults');
      }
    }
    function isCleanNormal() {
      return document.body.dataset.mode === 'normal' && document.body.dataset.modeSubmode === 'clean';
    }
    function setOpen(open) {
      open = !!open && isCleanNormal();
      if (open) {
        n = read(NKEY);
        g = read(EKEY);
        syncUI();
        document.body.dataset.cleanStyleOpen = '1';
      } else {
        delete document.body.dataset.cleanStyleOpen;
      }
      trigger.classList.toggle('active', open);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      panel.toggleAttribute('inert', !open);
    }

    trigger.addEventListener('click', () => setOpen(document.body.dataset.cleanStyleOpen !== '1'));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || document.body.dataset.cleanStyleOpen !== '1') return;
      setOpen(false);
      trigger.focus();
    });
    document.addEventListener('editor:modechange', () => {
      if (!isCleanNormal()) setOpen(false);
    });
    document.addEventListener('editor:toggle-side-panel', () => {
      if (!isCleanNormal()) return;
      setOpen(document.body.dataset.cleanStyleOpen !== '1');
    });

    kindBtns.forEach((button) => button.addEventListener('click', () => {
      const kind = button.dataset.kind;
      if (!['index', 'preview', 'card', 'sticky', 'code'].includes(kind)) return;
      const node = activeNode();
      if (node && cm()) {
        if (cm().isReadableNode(node)) cm().switchSingleNodeKind(activeNodeId, kind);
        else cm().convertSingleToBodyNode(activeNodeId, kind);
        cm().pushHistory();
        cm().notify();
        syncUI();
      } else {
        n.kind = kind;
        writeNode();
        try { localStorage.setItem('canvas:normalNodeKind', kind); } catch (e) {}
        syncUI();
        document.dispatchEvent(new CustomEvent('editor:default-kind-change', {
          detail: { kind: kind, source: 'clean-style' },
        }));
      }
    }));
    shapeBtns.forEach((button) => button.addEventListener('click', () => {
      const shape = button.dataset.shape;
      if (activeNode() && cm()) {
        cm().editSingleNodeField(activeNodeId, 'shape', shape, shape === 'rect');
        cm().pushHistory();
      } else {
        if (shape === 'rect') delete n.shape;
        else n.shape = shape;
        writeNode();
      }
      syncUI();
    }));
    document.addEventListener('editor:default-kind-change', (event) => {
      if (!isCleanNormal()) return;
      const kind = event.detail && event.detail.kind;
      if (!['index', 'preview', 'card', 'sticky', 'code'].includes(kind)) return;
      n = read(NKEY);
      n.kind = kind;
      writeNode();
      syncUI();
    });

    bgInput.addEventListener('input', () => {
      const isDefault = bgInput.value.toLowerCase() === '#ffffff';
      if (activeNode() && cm()) cm().editSingleNodeField(activeNodeId, 'bgColor', bgInput.value, isDefault);
      else {
        if (isDefault) delete n.bgColor; else n.bgColor = bgInput.value;
        writeNode();
      }
    });
    bgInput.addEventListener('change', () => { if (activeNode() && cm()) cm().pushHistory(); });
    borderInput.addEventListener('input', () => {
      const isDefault = borderInput.value.toLowerCase() === '#000000';
      if (activeNode() && cm()) cm().editSingleNodeField(activeNodeId, 'borderColor', borderInput.value, isDefault);
      else {
        if (isDefault) delete n.borderColor; else n.borderColor = borderInput.value;
        writeNode();
      }
    });
    borderInput.addEventListener('change', () => { if (activeNode() && cm()) cm().pushHistory(); });
    opacityInput.addEventListener('input', () => {
      const value = parseInt(opacityInput.value, 10);
      opacityVal.textContent = value + '%';
      if (activeNode() && cm()) cm().editSingleNodeField(activeNodeId, 'opacity', value / 100, value === 100);
      else {
        if (value === 100) delete n.opacity; else n.opacity = value / 100;
        writeNode();
      }
    });
    opacityInput.addEventListener('change', () => { if (activeNode() && cm()) cm().pushHistory(); });
    hideChromeInput.addEventListener('change', () => {
      if (activeNode() && cm()) {
        cm().editSingleNodeField(activeNodeId, 'hideChrome', true, !hideChromeInput.checked);
        cm().pushHistory();
      } else {
        if (hideChromeInput.checked) n.hideChrome = true; else delete n.hideChrome;
        writeNode();
      }
      syncUI();
    });
    radiusInput.addEventListener('input', () => {
      const value = parseInt(radiusInput.value, 10);
      radiusVal.textContent = value + 'px';
      if (activeNode() && cm()) cm().editSingleNodeContextField(activeNodeId, 'radius', value);
      else {
        if (value === 10) delete n.radius; else n.radius = value;
        writeNode();
      }
    });
    radiusInput.addEventListener('change', () => { if (activeNode() && cm()) cm().pushHistory(); });
    fontWeightInput.addEventListener('input', () => {
      const value = parseInt(fontWeightInput.value, 10);
      fontWeightVal.textContent = String(value);
      if (activeNode() && cm()) cm().editSingleNodeContextField(activeNodeId, 'fontWeight', value);
      else {
        n.fontWeight = value;
        writeNode();
      }
    });
    fontWeightInput.addEventListener('change', () => { if (activeNode() && cm()) cm().pushHistory(); });
    fontScaleInput.addEventListener('input', () => {
      const value = parseInt(fontScaleInput.value, 10);
      fontScaleVal.textContent = value + '%';
      if (activeNode() && cm()) cm().editSingleNodeContextField(activeNodeId, 'fontScale', value / 100);
      else {
        if (value === 100) delete n.fontScale; else n.fontScale = value / 100;
        writeNode();
      }
    });
    fontScaleInput.addEventListener('change', () => { if (activeNode() && cm()) cm().pushHistory(); });
    textAlignBtns.forEach((button) => button.addEventListener('click', () => {
      const align = button.dataset.textAlign;
      if (activeNode() && cm()) {
        cm().editSingleNodeContextField(activeNodeId, 'textAlign', align);
        cm().pushHistory();
      } else {
        if (align === 'left') delete n.textAlign; else n.textAlign = align;
        writeNode();
      }
      syncUI();
    }));
    curveBtns.forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.curve === 'bezier') delete g.curve; else g.curve = button.dataset.curve;
      writeEdge();
      syncUI();
    }));
    lineStyleBtns.forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.lineStyle === 'solid') delete g.lineStyle; else g.lineStyle = button.dataset.lineStyle;
      writeEdge();
      syncUI();
    }));
    colorInput.addEventListener('input', () => {
      if (colorInput.value.toLowerCase() === '#000000') delete g.color; else g.color = colorInput.value;
      writeEdge();
    });
    widthInput.addEventListener('input', () => {
      const value = parseFloat(widthInput.value);
      if (value === 1.5) delete g.width; else g.width = value;
      widthVal.textContent = String(value);
      writeEdge();
    });
    arrowBtns.forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.arrow === 'none') delete g.arrow; else g.arrow = button.dataset.arrow;
      writeEdge();
      syncUI();
    }));
    resetBtn.addEventListener('click', () => {
      if (activeNode() && cm()) {
        cm().resetSingleNodeAppearance(activeNodeId);
        cm().pushHistory();
        cm().notify();
        syncUI();
      } else {
        n = { kind: 'card' };
        g = {};
        writeNode();
        writeEdge();
        syncUI();
        try { localStorage.setItem('canvas:normalNodeKind', 'card'); } catch (e) {}
        document.dispatchEvent(new CustomEvent('editor:default-kind-change', {
          detail: { kind: 'card', source: 'clean-reset' },
        }));
      }
    });

    document.addEventListener('editor:singleselect', (event) => {
      const node = event.detail && event.detail.node;
      activeNodeId = node ? node.id : null;
      if (isCleanNormal()) syncUI();
    });
    document.addEventListener('editor:selectionchange', (event) => {
      const detail = event.detail || {};
      if (detail.contentNodes === 1 && detail.edges === 0 && !detail.arrow) return;
      if (activeNodeId === null) return;
      activeNodeId = null;
      if (isCleanNormal()) syncUI();
    });
    document.addEventListener('editor:languagechange', () => {
      if (isCleanNormal()) syncUI();
    });
    document.addEventListener('editor:nodestylechange', (event) => {
      if (!activeNodeId || !event.detail || event.detail.nodeId !== activeNodeId) return;
      if (isCleanNormal()) syncUI();
    });

    syncUI();
    setOpen(false);
  })();

  if (!filePath) {
    if (titleEl) titleEl.textContent = '(未指定文件)';
    setState('');
    return;
  }

  let canvasData = null;
  let dirty = false;
  let isSaving = false;
  let savePromise = null;
  let dirtyEpoch = 0;   // 每次 markDirty 自增；保存开始时记下，回包时若已变化说明"保存途中又改了"
  let isExporting = false;
  let backgroundReady = false;
  let backgroundProbeVersion = 0;
  let backgroundPreference = null;
  let guidePreference = { type: 'none' };
  let backgroundSaveTimer = null;
  let backgroundSaveQueue = Promise.resolve();
  let viewportSaveTimer = null;
  let pendingViewport = null;
  let viewportSaveQueue = Promise.resolve();
  let graphView = null;

  const BACKGROUND_GRADIENTS = {
    'morning-mist': {
      fill: 'linear-gradient(135deg, #fbfaf6 0%, #edf2f5 100%)',
      tone: 'light',
      layout: 'soft-toolbar',
    },
    'ivory-light': {
      fill: 'linear-gradient(140deg, #fdfaf4 0%, #f2e8dd 100%)',
      tone: 'light',
      layout: 'soft-toolbar',
    },
    'sage-smoke': {
      fill: 'linear-gradient(135deg, #eaf1e7 0%, #fbfaf6 100%)',
      tone: 'light',
      layout: 'soft-toolbar',
    },
    'after-rain': {
      fill: 'linear-gradient(135deg, #ebf1f5 0%, #f2edf5 100%)',
      tone: 'light',
      layout: 'soft-toolbar',
    },
    'dusk-sand': {
      fill: 'linear-gradient(140deg, #f5eae7 0%, #fcf8ef 100%)',
      tone: 'light',
      layout: 'soft-toolbar',
    },
    'moon-white': {
      fill: 'linear-gradient(135deg, #edf1f3 0%, #faf8f2 100%)',
      tone: 'light',
      layout: 'soft-toolbar',
    },
    'quiet-dawn': {
      fill: 'radial-gradient(54% 46% at 74% 22%, rgba(255,207,170,0.38), transparent 72%), radial-gradient(58% 50% at 18% 72%, rgba(119,159,181,0.22), transparent 74%), linear-gradient(145deg, #f5e4d4 0%, #dce7e6 52%, #b7cbd1 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'cloud-lake': {
      fill: 'radial-gradient(58% 44% at 18% 18%, rgba(255,255,255,0.82), transparent 70%), radial-gradient(62% 52% at 78% 34%, rgba(164,198,202,0.34), transparent 74%), radial-gradient(48% 38% at 30% 78%, rgba(222,211,190,0.42), transparent 72%), linear-gradient(150deg, #f7f2e7 0%, #e8f0ee 48%, #cfdfe1 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'snow-ridge': {
      fill: 'radial-gradient(50% 36% at 70% 18%, rgba(255,255,255,0.90), transparent 70%), radial-gradient(64% 46% at 22% 86%, rgba(176,190,198,0.28), transparent 74%), linear-gradient(158deg, #fbfaf7 0%, #edf1f2 46%, #d9e1e3 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'almond-light': {
      fill: 'radial-gradient(48% 38% at 82% 24%, rgba(255,214,165,0.48), transparent 72%), radial-gradient(52% 42% at 14% 76%, rgba(222,188,169,0.24), transparent 74%), linear-gradient(145deg, #fff8eb 0%, #f3e5d3 48%, #e4d8c8 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'bamboo-mist': {
      fill: 'radial-gradient(48% 38% at 18% 20%, rgba(255,255,255,0.72), transparent 72%), radial-gradient(58% 48% at 78% 68%, rgba(138,165,121,0.30), transparent 74%), linear-gradient(142deg, #f7f6ed 0%, #e8efe1 50%, #d7e0ce 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'pearl-haze': {
      fill: 'radial-gradient(54% 44% at 76% 20%, rgba(244,218,226,0.44), transparent 70%), radial-gradient(58% 48% at 18% 72%, rgba(177,195,206,0.30), transparent 74%), linear-gradient(145deg, #fbf8f4 0%, #ece9ec 45%, #dce5e7 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'rain-glass': {
      fill: 'radial-gradient(58% 44% at 24% 18%, rgba(255,255,255,0.70), transparent 72%), radial-gradient(48% 42% at 80% 72%, rgba(135,166,173,0.28), transparent 74%), linear-gradient(150deg, #f4f8f7 0%, #e2ecea 52%, #cad8d7 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'rose-cloud': {
      fill: 'radial-gradient(50% 42% at 76% 24%, rgba(255,190,178,0.42), transparent 72%), radial-gradient(52% 44% at 18% 70%, rgba(180,196,202,0.25), transparent 74%), linear-gradient(145deg, #fff2ec 0%, #eee6e4 48%, #dbe4e7 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    // —— 沉浸预设（浅色）2026-06-09 新增：补干净蓝 / 薄荷 / 薰衣草 / 藕荷 / 暖白纸 ——
    'sky-azure': {
      fill: 'radial-gradient(58% 46% at 24% 16%, rgba(255,255,255,0.85), transparent 70%), radial-gradient(64% 54% at 80% 30%, rgba(150,194,232,0.42), transparent 74%), radial-gradient(50% 44% at 50% 96%, rgba(176,206,224,0.30), transparent 76%), linear-gradient(155deg, #f3f8fc 0%, #e2eef7 50%, #cadcec 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'mint': {
      fill: 'radial-gradient(56% 46% at 22% 18%, rgba(255,255,255,0.82), transparent 70%), radial-gradient(62% 52% at 80% 28%, rgba(150,216,196,0.40), transparent 74%), radial-gradient(50% 44% at 32% 90%, rgba(176,214,200,0.30), transparent 74%), linear-gradient(150deg, #f1faf6 0%, #e0f1ea 48%, #cae6da 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'lavender': {
      fill: 'radial-gradient(56% 46% at 22% 18%, rgba(255,255,255,0.82), transparent 70%), radial-gradient(62% 52% at 80% 26%, rgba(196,178,228,0.42), transparent 74%), radial-gradient(52% 44% at 30% 88%, rgba(214,196,222,0.34), transparent 74%), linear-gradient(150deg, #f8f5fb 0%, #efe9f5 48%, #ddd2ea 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'lotus-haze': {
      fill: 'radial-gradient(50% 40% at 40% 12%, rgba(255,255,255,0.6), transparent 70%), radial-gradient(58% 46% at 78% 20%, rgba(252,200,186,0.44), transparent 72%), radial-gradient(56% 48% at 18% 82%, rgba(206,188,228,0.36), transparent 74%), linear-gradient(150deg, #fdf3ee 0%, #f6ebf0 50%, #e6dcf0 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'rice-paper': {
      fill: 'radial-gradient(60% 50% at 26% 20%, rgba(255,255,255,0.9), transparent 72%), radial-gradient(64% 54% at 82% 34%, rgba(240,228,206,0.40), transparent 76%), radial-gradient(50% 44% at 40% 92%, rgba(232,226,214,0.34), transparent 76%), linear-gradient(150deg, #fdfbf6 0%, #f6f1e8 52%, #efe7da 100%)',
      tone: 'light',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    // —— 沉浸预设（深色）2026-06-09 第6轮：改用用户提供的真实夜景照片（assets/bg/*.jpg）。
    // 每张统一叠「顶部 scrim（压暗标题栏）+ 整体压暗」两层，保证白卡片 / 深色文字始终清楚；
    // 沉浸背景层 CSS 已 background-size:cover，照片自动铺满。原来手搓的渐变深色全部删除。
    'aurora-corona': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/aurora-corona.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'snow-aurora': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/snow-aurora.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'star-peaks': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/star-peaks.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'full-moon': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/full-moon.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'lone-moon': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/lone-moon.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'crescent': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/crescent.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'dusk-lake': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/dusk-lake.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'dusk-bridge': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/dusk-bridge.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'dusk-road': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/dusk-road.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'evening-glow': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/evening-glow.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'deep-forest': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/deep-forest.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'night-boat': {
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/bg/night-boat.jpg")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
    'polar-light': {
      // 北极光 = 直接复用起始页那张真实极光照片（assets/sky-dark.png），叠一层压暗 + 顶部 scrim 保证白卡/文字可读。
      // 沉浸背景层 CSS 已是 background-size:cover，照片自动铺满。
      fill: 'linear-gradient(180deg, rgba(5,7,9,0.50) 0%, rgba(5,7,9,0.10) 18%, rgba(5,7,9,0) 40%), linear-gradient(rgba(6,10,12,0.34), rgba(6,10,12,0.34)), url("/sky-dark.png")',
      tone: 'dark',
      layout: 'immersive',
      toolbarReadability: 'light',
    },
  };
  const DEFAULT_IMAGE_FRAMING = { scale: 1, positionX: 50, positionY: 50 };
  const IMAGE_LAYOUTS = ['immersive', 'soft-toolbar'];
  const TOOLBAR_READABILITY = ['off', 'light', 'medium'];
  const BACKGROUND_TONES = ['light', 'dark'];
  const GUIDE_TYPES = ['none', 'ruled', 'dots', 'grid', 'major-grid'];

  // 没设过全局背景时的出厂默认：月灰、横线纸、全屏沉浸、浅色语义，不加标题栏保护层。
  const DEFAULT_BACKGROUND = {
    type: 'solid',
    color: '#f1f0ed',
    layout: 'immersive',
    tone: 'light',
    toolbarReadability: 'off',
  };
  const DEFAULT_GUIDE = { type: 'ruled' };

  function backgroundGradientPreset(preset) {
    return BACKGROUND_GRADIENTS[preset] || null;
  }

  function backgroundGradientTone(preset) {
    const meta = backgroundGradientPreset(preset);
    return meta && meta.tone === 'dark' ? 'dark' : 'light';
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  let autosaveTimer = null;
  function autosaveEnabled() {
    try { return localStorage.getItem('canvas:autosaveEnabled') !== '0'; } catch (e) { return true; }
  }
  // 改动后防抖自动保存（沿用 save() 写 /api/save）。
  // 内嵌浮窗始终自动保存；主编辑器看「自动保存」开关（默认开），关掉则回到纯手动 Ctrl+S。
  function scheduleAutosave() {
    if (!EMBED && !autosaveEnabled()) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (!dirty) return;
      // 用户正在就地编辑节点/连线/文本框时，自动保存礼让——save() 会 commit 退出编辑态、
      // 关掉 contentEditable，在打字途中触发会吞掉后续输入。推迟到这次编辑落定
      //（commit 后 markDirty 会重新排一次 autosave，不会漏存）。手动 Ctrl+S / 离开 / 导出不受影响。
      if (window.CanvasModule && typeof window.CanvasModule.isEditing === 'function'
          && window.CanvasModule.isEditing()) {
        scheduleAutosave();
        return;
      }
      save();
    }, EMBED ? 900 : 1500);
  }

  function markDirty() {
    if (canvasData === null) return;
    dirty = true;
    dirtyEpoch++;            // 记一次新编辑，供保存回包时比对（见 save 的 savedEpoch）
    setState('未保存');
    if (window.CanvasDesktop) window.CanvasDesktop.setDirty(true);
    scheduleAutosave();
    document.dispatchEvent(new CustomEvent('canvas:mutated', {
      detail: {
        nodes: canvasData && Array.isArray(canvasData.nodes) ? canvasData.nodes.length : 0,
        edges: canvasData && Array.isArray(canvasData.edges) ? canvasData.edges.length : 0,
      },
    }));
  }

  function markClean(label) {
    dirty = false;
    setState(label || '已保存');
    if (window.CanvasDesktop) window.CanvasDesktop.setDirty(false);
  }

  function queueViewportSave(viewport) {
    pendingViewport = viewport;
    if (viewportSaveTimer !== null) window.clearTimeout(viewportSaveTimer);
    viewportSaveTimer = window.setTimeout(() => flushViewportSave(false), 180);
  }

  function flushViewportSave(keepalive) {
    if (viewportSaveTimer !== null) {
      window.clearTimeout(viewportSaveTimer);
      viewportSaveTimer = null;
    }
    if (!pendingViewport || !filePath) return;
    const viewport = pendingViewport;
    pendingViewport = null;
    const submit = () => fetch('/api/viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, viewport }),
      keepalive: !!keepalive,
    }).then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
    });
    if (keepalive) {
      submit().catch(function () {});
      return;
    }
    viewportSaveQueue = viewportSaveQueue.then(submit).catch((err) => {
      console.warn('[画布] 视野位置保存失败', err);
    });
  }

  // ── 全局背景外观 ─────────────────────────────
  function normalizeBackgroundLayout(raw, fallback) {
    return IMAGE_LAYOUTS.includes(raw && raw.layout) ? raw.layout : (fallback || 'soft-toolbar');
  }

  function normalizeToolbarReadability(raw, fallback) {
    return TOOLBAR_READABILITY.includes(raw && raw.toolbarReadability)
      ? raw.toolbarReadability : (fallback || 'light');
  }

  function normalizeBackgroundTone(raw, fallback) {
    return BACKGROUND_TONES.includes(raw && raw.tone) ? raw.tone : (fallback || 'light');
  }

  function normalizeBackground(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'solid' && /^#[0-9a-f]{6}$/i.test(raw.color || '')) {
      return {
        type: 'solid',
        color: raw.color,
        layout: normalizeBackgroundLayout(raw),
        toolbarReadability: normalizeToolbarReadability(raw),
        tone: normalizeBackgroundTone(raw, 'light'),
      };
    }
    const gradientMeta = raw.type === 'gradient' ? backgroundGradientPreset(raw.preset) : null;
    if (gradientMeta) {
      return {
        type: 'gradient',
        preset: raw.preset,
        layout: normalizeBackgroundLayout(raw, gradientMeta.layout || 'soft-toolbar'),
        toolbarReadability: normalizeToolbarReadability(raw, gradientMeta.toolbarReadability || 'light'),
        tone: normalizeBackgroundTone(raw, gradientMeta.tone || 'light'),
      };
    }
    if (raw.type === 'image' && typeof raw.path === 'string' && raw.path.trim()) {
      return {
        type: 'image',
        path: raw.path,
        opacity: clampNumber(raw.opacity, 0, 1, 0.22),
        scale: clampNumber(raw.scale, 1, 2.5, DEFAULT_IMAGE_FRAMING.scale),
        positionX: clampNumber(raw.positionX, 0, 100, DEFAULT_IMAGE_FRAMING.positionX),
        positionY: clampNumber(raw.positionY, 0, 100, DEFAULT_IMAGE_FRAMING.positionY),
        layout: normalizeBackgroundLayout(raw, 'immersive'),
        toolbarReadability: normalizeToolbarReadability(raw),
        tone: normalizeBackgroundTone(raw, 'light'),
      };
    }
    return null;
  }

  function normalizeGuide(raw) {
    const type = raw && GUIDE_TYPES.includes(raw.type) ? raw.type : 'none';
    return { type };
  }

  function withCurrentBackgroundLayout(next) {
    const old = normalizeBackground(backgroundPreference);
    if (!next || typeof next !== 'object') return next;
    if (old && IMAGE_LAYOUTS.includes(old.layout)) next.layout = old.layout;
    if (old && TOOLBAR_READABILITY.includes(old.toolbarReadability)) {
      next.toolbarReadability = old.toolbarReadability;
    }
    if (old && old.type === next.type && BACKGROUND_TONES.includes(old.tone)) {
      next.tone = old.tone;
    }
    return next;
  }

  function queueBackgroundPreferenceSave(deferred) {
    clearTimeout(backgroundSaveTimer);
    const save = () => {
      const snapshot = backgroundPreference ? { ...backgroundPreference } : null;
      const guideSnapshot = normalizeGuide(guidePreference);
      backgroundSaveQueue = backgroundSaveQueue
        .catch(() => {})
        .then(async () => {
          const resp = await fetch('/api/background-preference', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              background: snapshot,
              guide: guideSnapshot.type === 'none' ? null : guideSnapshot,
            }),
          });
          const json = await resp.json();
          if (!resp.ok) throw new Error(json.error || '保存失败');
        })
        .catch((err) => {
          window.alert('保存全局背景设置失败：' + err.message);
        });
    };
    if (deferred) backgroundSaveTimer = setTimeout(save, 120);
    else save();
  }

  async function loadBackgroundPreference() {
    try {
      const resp = await fetch('/api/background-preference');
      const json = await resp.json();
      if (resp.ok && json.configured) {
        backgroundPreference = normalizeBackground(json.background);
        guidePreference = normalizeGuide(json.guide);
        return;
      }
    } catch (err) {
      console.warn('[画布] 读取全局背景失败，尝试兼容旧画布背景', err);
    }
    // 旧版背景曾跟随单张画布保存；尚无全局配置时迁移首次遇到的旧设置，
    // 仍没有则落到出厂默认「月灰 + 横线纸」；迁移旧画布背景时保持旧版无底纹行为。
    const legacyBackground = normalizeBackground(canvasData && canvasData.background);
    backgroundPreference = legacyBackground || normalizeBackground(DEFAULT_BACKGROUND);
    guidePreference = normalizeGuide(legacyBackground ? null : DEFAULT_GUIDE);
    if (backgroundPreference) queueBackgroundPreferenceSave(false);
  }

  function backgroundFileName(path) {
    return String(path || '').split(/[\\/]/).pop() || '已选择图片';
  }

  function syncGuidePanel() {
    if (!backgroundPanel) return;
    const guide = normalizeGuide(guidePreference);
    backgroundPanel.querySelectorAll('[data-guide-type]').forEach((button) => {
      const active = button.dataset.guideType === guide.type;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function syncBackgroundPanel(bg, imageError) {
    if (!backgroundPanel) return;
    backgroundPanel.querySelectorAll('[data-background-color]').forEach((button) => {
      button.classList.toggle(
        'active',
        !!bg && bg.type === 'solid'
          && button.dataset.backgroundColor.toLowerCase() === bg.color.toLowerCase(),
      );
    });
    backgroundPanel.querySelectorAll('[data-background-gradient]').forEach((button) => {
      button.classList.toggle('active', !!bg && bg.type === 'gradient'
        && button.dataset.backgroundGradient === bg.preset);
    });
    syncGuidePanel();
    const colorInput = backgroundPanel.querySelector('[data-role="background-custom-color"]');
    if (colorInput && bg && bg.type === 'solid') colorInput.value = bg.color;
    const imageMode = !!bg && bg.type === 'image';
    const layoutMode = !!bg;
    const nameEl = backgroundPanel.querySelector('[data-role="background-image-name"]');
    const opacity = backgroundPanel.querySelector('[data-role="background-opacity"]');
    const opacityVal = backgroundPanel.querySelector('[data-role="background-opacity-val"]');
    const scale = backgroundPanel.querySelector('[data-role="background-scale"]');
    const scaleVal = backgroundPanel.querySelector('[data-role="background-scale-val"]');
    const positionX = backgroundPanel.querySelector('[data-role="background-position-x"]');
    const positionXVal = backgroundPanel.querySelector('[data-role="background-position-x-val"]');
    const positionY = backgroundPanel.querySelector('[data-role="background-position-y"]');
    const positionYVal = backgroundPanel.querySelector('[data-role="background-position-y-val"]');
    const framingReset = backgroundPanel.querySelector('[data-action="background-image-framing-reset"]');
    const preview = backgroundPanel.querySelector('[data-role="background-image-preview"]');
    const layoutBtns = backgroundPanel.querySelectorAll('[data-role="background-layout"] button');
    const toneWrap = backgroundPanel.querySelector('[data-role="background-tone-wrap"]');
    const toneBtns = backgroundPanel.querySelectorAll('[data-role="background-tone"] button');
    const readabilityWrap = backgroundPanel.querySelector('[data-role="background-readability-wrap"]');
    const readabilityBtns = backgroundPanel.querySelectorAll('[data-role="background-readability"] button');
    const remove = backgroundPanel.querySelector('[data-action="background-image-remove"]');
    if (nameEl) {
      nameEl.textContent = imageMode
        ? backgroundFileName(bg.path) + (imageError ? '（文件不存在或不可读取）' : '')
        : '尚未选择图片';
    }
    if (opacity) {
      opacity.disabled = !imageMode;
      opacity.value = imageMode ? String(Math.round(bg.opacity * 100)) : '22';
    }
    if (opacityVal) opacityVal.textContent = (imageMode ? Math.round(bg.opacity * 100) : 22) + '%';
    if (scale) {
      scale.disabled = !imageMode;
      scale.value = imageMode ? String(Math.round(bg.scale * 100)) : '100';
    }
    if (scaleVal) scaleVal.textContent = (imageMode ? Math.round(bg.scale * 100) : 100) + '%';
    if (positionX) {
      positionX.disabled = !imageMode;
      positionX.value = imageMode ? String(Math.round(bg.positionX)) : '50';
    }
    if (positionXVal) positionXVal.textContent = (imageMode ? Math.round(bg.positionX) : 50) + '%';
    if (positionY) {
      positionY.disabled = !imageMode;
      positionY.value = imageMode ? String(Math.round(bg.positionY)) : '50';
    }
    if (positionYVal) positionYVal.textContent = (imageMode ? Math.round(bg.positionY) : 50) + '%';
    if (framingReset) framingReset.disabled = !imageMode;
    layoutBtns.forEach((button) => {
      button.disabled = !layoutMode;
      button.classList.toggle('active', layoutMode && button.dataset.layout === bg.layout);
    });
    if (toneWrap) toneWrap.classList.toggle('disabled', !layoutMode);
    toneBtns.forEach((button) => {
      button.disabled = !layoutMode;
      button.classList.toggle('active', layoutMode && button.dataset.tone === bg.tone);
    });
    const immersive = layoutMode && bg.layout === 'immersive';
    if (readabilityWrap) readabilityWrap.classList.toggle('disabled', !immersive);
    readabilityBtns.forEach((button) => {
      button.disabled = !immersive;
      button.classList.toggle(
        'active',
        immersive && button.dataset.readability === bg.toolbarReadability,
      );
    });
    if (preview) {
      preview.classList.toggle('has-image', imageMode && !imageError);
      preview.classList.toggle('immersive', immersive);
    }
    if (remove) remove.disabled = !imageMode;
  }

  function resetBackgroundVisuals() {
    if (pageEl) {
      pageEl.classList.remove('immersive-background', 'immersive-background-light', 'immersive-background-dark');
    }
    viewportEl.classList.remove('image-background', 'flowing-background');
    viewportEl.style.setProperty('--canvas-background-fill', 'var(--bg)');
    viewportEl.style.setProperty('--canvas-background-image', 'none');
    viewportEl.style.setProperty('--canvas-background-opacity', '0');
    viewportEl.style.setProperty('--canvas-background-scale', '1');
    viewportEl.style.setProperty('--canvas-background-position', '50% 50%');
    if (topBarEl) {
      topBarEl.style.setProperty('--editor-toolbar-fill', 'var(--surface)');
      topBarEl.style.setProperty('--editor-toolbar-image', 'none');
      topBarEl.style.setProperty('--editor-toolbar-image-opacity', '0');
      topBarEl.style.setProperty('--editor-toolbar-image-scale', '1');
      topBarEl.style.setProperty('--editor-toolbar-image-position', '50% 50%');
      topBarEl.style.setProperty('--editor-toolbar-wash', 'transparent');
      topBarEl.style.borderBottomColor = '';
    }
    if (immersiveBackgroundEl) {
      immersiveBackgroundEl.style.setProperty('--immersive-background-image', 'none');
      immersiveBackgroundEl.style.setProperty('--immersive-background-opacity', '0');
      immersiveBackgroundEl.style.setProperty('--immersive-background-scale', '1');
      immersiveBackgroundEl.style.setProperty('--immersive-background-position', '50% 50%');
    }
    const preview = backgroundPanel
      && backgroundPanel.querySelector('[data-role="background-image-preview"]');
    if (preview) {
      preview.style.setProperty('--background-preview-image', 'none');
      preview.style.setProperty('--background-preview-scale', '1');
      preview.style.setProperty('--background-preview-position', '50% 50%');
      preview.classList.remove('has-image', 'immersive', 'dragging');
    }
  }

  function applyCanvasBackgroundTone(tone) {
    const next = tone === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem('canvas:backgroundTone', next); } catch (e) {}
    document.documentElement.dataset.editorBackgroundTone = next;
    if (!pageEl || pageEl.dataset.backgroundTone === next) return;
    pageEl.dataset.backgroundTone = next;
    document.dispatchEvent(new CustomEvent('canvas:edge-visual-refresh'));
  }

  function imagePosition(bg) {
    return bg.positionX + '% ' + bg.positionY + '%';
  }

  function immersiveToolbarWash(readability, tone) {
    if (tone === 'dark') {
      if (readability === 'medium') return 'rgba(0, 0, 0, 0.26)';
      if (readability === 'light') return 'rgba(0, 0, 0, 0.12)';
      return 'transparent';
    }
    if (readability === 'medium') return 'rgba(255, 255, 255, 0.32)';
    if (readability === 'light') return 'rgba(255, 255, 255, 0.16)';
    return 'transparent';
  }

  function applyPresetAppearance(bg, fill, tone) {
    const layerFill = /^#[0-9a-f]{6}$/i.test(fill || '')
      ? 'linear-gradient(' + fill + ', ' + fill + ')'
      : fill;
    const immersive = bg.layout === 'immersive';
    const immersiveTone = tone === 'dark' ? 'dark' : 'light';
    if (immersive) {
      if (pageEl) {
        pageEl.classList.add('immersive-background');
        pageEl.classList.toggle('immersive-background-dark', immersiveTone === 'dark');
        pageEl.classList.toggle('immersive-background-light', immersiveTone !== 'dark');
      }
      viewportEl.classList.remove('image-background', 'flowing-background');
      viewportEl.style.setProperty('--canvas-background-fill', 'transparent');
      viewportEl.style.setProperty('--canvas-background-image', 'none');
      if (immersiveBackgroundEl) {
        immersiveBackgroundEl.style.setProperty('--immersive-background-image', layerFill);
        immersiveBackgroundEl.style.setProperty('--immersive-background-opacity', '1');
        immersiveBackgroundEl.style.setProperty('--immersive-background-scale', '1');
        immersiveBackgroundEl.style.setProperty('--immersive-background-position', '50% 50%');
      }
      if (topBarEl) {
        topBarEl.style.setProperty('--editor-toolbar-fill', 'transparent');
        topBarEl.style.setProperty('--editor-toolbar-image', 'none');
        topBarEl.style.setProperty('--editor-toolbar-image-opacity', '0');
        topBarEl.style.setProperty('--editor-toolbar-wash', immersiveToolbarWash(bg.toolbarReadability, immersiveTone));
        topBarEl.style.borderBottomColor = 'transparent';
      }
      return;
    }
    viewportEl.classList.add('flowing-background');
    viewportEl.style.setProperty('--canvas-background-fill', fill);
    if (topBarEl) {
      topBarEl.style.setProperty(
        '--editor-toolbar-fill',
        'linear-gradient(rgba(255, 255, 255, 0.56), rgba(255, 255, 255, 0.56)), ' + fill,
      );
      topBarEl.style.borderBottomColor = 'rgba(75, 75, 75, 0.09)';
    }
  }

  function applyImageAppearance(bg) {
    const position = imagePosition(bg);
    const immersive = bg.layout === 'immersive';
    const immersiveTone = bg.tone === 'dark' ? 'dark' : 'light';
    if (immersive) {
      if (pageEl) {
        pageEl.classList.add('immersive-background');
        pageEl.classList.toggle('immersive-background-dark', immersiveTone === 'dark');
        pageEl.classList.toggle('immersive-background-light', immersiveTone !== 'dark');
      }
      viewportEl.classList.remove('image-background');
      viewportEl.style.setProperty('--canvas-background-fill', 'transparent');
      viewportEl.style.setProperty('--canvas-background-image', 'none');
      if (immersiveBackgroundEl) {
        immersiveBackgroundEl.style.setProperty('--immersive-background-opacity', String(bg.opacity));
        immersiveBackgroundEl.style.setProperty('--immersive-background-scale', String(bg.scale));
        immersiveBackgroundEl.style.setProperty('--immersive-background-position', position);
      }
      if (topBarEl) {
        topBarEl.style.setProperty('--editor-toolbar-fill', 'transparent');
        topBarEl.style.setProperty('--editor-toolbar-image', 'none');
        topBarEl.style.setProperty('--editor-toolbar-image-opacity', '0');
        topBarEl.style.setProperty('--editor-toolbar-wash', immersiveToolbarWash(bg.toolbarReadability, immersiveTone));
        topBarEl.style.borderBottomColor = 'transparent';
      }
    } else {
      viewportEl.classList.add('image-background');
      viewportEl.style.setProperty('--canvas-background-opacity', String(bg.opacity));
      viewportEl.style.setProperty('--canvas-background-scale', String(bg.scale));
      viewportEl.style.setProperty('--canvas-background-position', position);
      if (topBarEl) {
        topBarEl.style.setProperty('--editor-toolbar-image-opacity', String(Math.min(1, bg.opacity * 2.2)));
        topBarEl.style.setProperty('--editor-toolbar-image-scale', String(bg.scale));
        topBarEl.style.setProperty('--editor-toolbar-image-position', position);
        topBarEl.style.setProperty('--editor-toolbar-wash', 'rgba(255, 255, 255, 0.70)');
        topBarEl.style.borderBottomColor = 'transparent';
      }
    }
    const preview = backgroundPanel
      && backgroundPanel.querySelector('[data-role="background-image-preview"]');
    if (preview) {
      preview.style.setProperty('--background-preview-scale', String(bg.scale));
      preview.style.setProperty('--background-preview-position', position);
    }
  }

  function applyLoadedImage(source, bg) {
    const value = 'url("' + source + '")';
    if (bg.layout === 'immersive') {
      if (immersiveBackgroundEl) immersiveBackgroundEl.style.setProperty('--immersive-background-image', value);
    } else {
      viewportEl.style.setProperty('--canvas-background-image', value);
      if (topBarEl) topBarEl.style.setProperty('--editor-toolbar-image', value);
    }
    const preview = backgroundPanel
      && backgroundPanel.querySelector('[data-role="background-image-preview"]');
    if (preview) preview.style.setProperty('--background-preview-image', value);
    syncBackgroundPanel(bg, false);
  }

  function waitForBackgroundFillImages(fill) {
    const sources = [];
    const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let match;
    while ((match = pattern.exec(String(fill || '')))) {
      if (match[2] && !sources.includes(match[2])) sources.push(match[2]);
    }
    if (!sources.length) return Promise.resolve();
    return Promise.all(sources.map((source) => new Promise((resolve) => {
      const probe = new Image();
      probe.addEventListener('load', resolve, { once: true });
      probe.addEventListener('error', resolve, { once: true });
      probe.src = source;
    }))).then(() => {});
  }

  function renderBackground(options) {
    if (!viewportEl) return Promise.resolve();
    const initial = !!(options && options.initial);
    const bg = normalizeBackground(backgroundPreference);
    backgroundProbeVersion += 1;
    const version = backgroundProbeVersion;
    resetBackgroundVisuals();
    applyCanvasBackgroundTone(bg && bg.tone);
    syncBackgroundPanel(bg, false);
    if (!bg) {
      viewportEl.classList.add('flowing-background');
      return Promise.resolve();
    }
    if (bg.type === 'solid') {
      applyPresetAppearance(bg, bg.color, bg.tone);
      return Promise.resolve();
    }
    if (bg.type === 'gradient') {
      const meta = backgroundGradientPreset(bg.preset);
      applyPresetAppearance(bg, meta.fill, bg.tone || backgroundGradientTone(bg.preset));
      return initial ? waitForBackgroundFillImages(meta.fill) : Promise.resolve();
    }
    const source = '/api/background-image?path=' + encodeURIComponent(bg.path);
    applyImageAppearance(bg);
    // 防硬切：先把背景层透明度压到 0，等图片真正下载完再过渡到目标透明度 → 平滑淡入，
    // 避免"先白底、图片加载完突然冒出来"。淡入靠背景层 ::before 已有的 opacity transition。
    const fadeTarget = bg.opacity;
    const setLayerOpacity = (value) => {
      if (bg.layout === 'immersive') {
        if (immersiveBackgroundEl) {
          immersiveBackgroundEl.style.setProperty('--immersive-background-opacity', String(value));
        }
      } else {
        viewportEl.style.setProperty('--canvas-background-opacity', String(value));
      }
    };
    setLayerOpacity(initial ? fadeTarget : 0);
    return new Promise((resolve) => {
      const probe = new Image();
      probe.addEventListener('load', () => {
        if (version !== backgroundProbeVersion) {
          resolve();
          return;
        }
        applyLoadedImage(source, bg);
        if (initial) {
          setLayerOpacity(fadeTarget);
          resolve();
          return;
        }
        requestAnimationFrame(() => {
          if (version === backgroundProbeVersion) setLayerOpacity(fadeTarget);
          resolve();
        });
      });
      probe.addEventListener('error', () => {
        if (version === backgroundProbeVersion) {
          resetBackgroundVisuals();
          applyCanvasBackgroundTone('light');
          syncBackgroundPanel(bg, true);
        }
        resolve();
      });
      probe.src = source;
    });
  }

  function renderGuide() {
    if (!viewportEl || !guideLayerEl) return;
    const guide = normalizeGuide(guidePreference);
    guidePreference = guide;
    viewportEl.dataset.guideType = guide.type;
    guideLayerEl.hidden = guide.type === 'none';
    if (topbarGuideLayerEl) {
      topbarGuideLayerEl.dataset.guideType = guide.type;
      topbarGuideLayerEl.hidden = guide.type === 'none';
    }
    syncGuidePanel();
    document.dispatchEvent(new CustomEvent('canvas:guide-visual-refresh'));
  }

  function setBackground(next, deferred) {
    if (canvasData === null) return;
    backgroundPreference = normalizeBackground(next);
    renderBackground();
    queueBackgroundPreferenceSave(!!deferred);
  }

  function setGuide(next) {
    if (canvasData === null) return;
    guidePreference = normalizeGuide(next);
    renderGuide();
    queueBackgroundPreferenceSave(false);
  }

  function resetBackgroundAndGuide() {
    if (canvasData === null) return;
    backgroundPreference = null;
    guidePreference = normalizeGuide(null);
    renderBackground();
    renderGuide();
    queueBackgroundPreferenceSave(false);
  }

  function updateImageAppearance(updates, deferred) {
    const bg = normalizeBackground(backgroundPreference);
    if (!bg) return;
    if (bg.type !== 'image') {
      const allowed = {};
      if (updates.layout) allowed.layout = updates.layout;
      if (updates.tone) allowed.tone = updates.tone;
      if (updates.toolbarReadability) allowed.toolbarReadability = updates.toolbarReadability;
      if (!Object.keys(allowed).length) return;
      Object.assign(bg, allowed);
      backgroundPreference = bg;
      renderBackground();
      queueBackgroundPreferenceSave(!!deferred);
      return;
    }
    const layoutChanged = updates.layout && updates.layout !== bg.layout;
    const toneChanged = updates.tone && updates.tone !== bg.tone;
    const readabilityChanged = updates.toolbarReadability && updates.toolbarReadability !== bg.toolbarReadability;
    Object.assign(bg, updates);
    backgroundPreference = bg;
    if (layoutChanged || toneChanged || readabilityChanged) renderBackground();
    else {
      applyImageAppearance(bg);
      syncBackgroundPanel(bg, false);
    }
    queueBackgroundPreferenceSave(!!deferred);
  }

  function setupBackgroundPanel() {
    if (backgroundReady || !backgroundBtn || !backgroundPanel) return;
    backgroundReady = true;
    let closing = false;
    let closeTimer = null;
    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {}

    const finishClose = () => {
      if (!closing) return;
      closing = false;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      backgroundPanel.removeEventListener('animationend', onCloseAnimationEnd);
      backgroundPanel.classList.remove('closing');
      backgroundPanel.hidden = true;
    };
    const onCloseAnimationEnd = (event) => {
      if (event.target === backgroundPanel && event.animationName === 'background-panel-out') {
        finishClose();
      }
    };
    const open = () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      backgroundPanel.removeEventListener('animationend', onCloseAnimationEnd);
      closing = false;
      backgroundPanel.classList.remove('closing');
      backgroundPanel.hidden = false;
      backgroundBtn.classList.add('active');
      backgroundBtn.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      backgroundBtn.classList.remove('active');
      backgroundBtn.setAttribute('aria-expanded', 'false');
      if (backgroundPanel.hidden || closing) return;
      closing = true;
      if (reduceMotion) {
        finishClose();
        return;
      }
      backgroundPanel.classList.add('closing');
      backgroundPanel.addEventListener('animationend', onCloseAnimationEnd);
      closeTimer = setTimeout(finishClose, 150);
    };
    closeBackgroundPanel = close;
    backgroundBtn.addEventListener('click', () => {
      if (backgroundPanel.hidden || closing) open();
      else close();
    });
    const closeBtn = backgroundPanel.querySelector('[data-action="background-close"]');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const reset = backgroundPanel.querySelector('[data-background-reset]');
    if (reset) reset.addEventListener('click', resetBackgroundAndGuide);
    backgroundPanel.querySelectorAll('[data-background-color]').forEach((button) => {
      button.addEventListener('click', () => {
        setBackground(withCurrentBackgroundLayout({ type: 'solid', color: button.dataset.backgroundColor }));
      });
    });
    const customColor = backgroundPanel.querySelector('[data-role="background-custom-color"]');
    if (customColor) {
      customColor.addEventListener('input', () => {
        setBackground(withCurrentBackgroundLayout({ type: 'solid', color: customColor.value }), true);
      });
      customColor.addEventListener('change', () => queueBackgroundPreferenceSave(false));
    }
    backgroundPanel.querySelectorAll('[data-background-gradient]').forEach((button) => {
      button.addEventListener('click', () => {
        const preset = button.dataset.backgroundGradient;
        const meta = backgroundGradientPreset(preset);
        const next = withCurrentBackgroundLayout({ type: 'gradient', preset });
        if (IMAGE_LAYOUTS.includes(button.dataset.backgroundLayout)) {
          next.layout = button.dataset.backgroundLayout;
        }
        if (BACKGROUND_TONES.includes(button.dataset.backgroundTone)) {
          next.tone = button.dataset.backgroundTone;
        } else if (meta && BACKGROUND_TONES.includes(meta.tone)) {
          next.tone = meta.tone;
        }
        if (meta && TOOLBAR_READABILITY.includes(meta.toolbarReadability)
            && next.layout === 'immersive') {
          next.toolbarReadability = meta.toolbarReadability;
        }
        setBackground(next);
      });
    });
    backgroundPanel.querySelectorAll('[data-guide-type]').forEach((button) => {
      button.addEventListener('click', () => setGuide({ type: button.dataset.guideType }));
    });
    const chooseImage = backgroundPanel.querySelector('[data-action="background-image-pick"]');
    if (chooseImage) {
      chooseImage.addEventListener('click', async () => {
        chooseImage.disabled = true;
        try {
          const file = await new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.opacity = '0';
            input.addEventListener('change', () => {
              const f = input.files && input.files[0] ? input.files[0] : null;
              input.remove();
              resolve(f);
            }, { once: true });
            document.body.appendChild(input);
            input.click();
          });

          if (!file) {
            return; // cancelled
          }

          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
            reader.readAsDataURL(file);
          });

          const resp = await fetch('/api/upload-background-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name || 'bg.png', data: dataUrl })
          });
          const json = await resp.json();
          if (!resp.ok || !json.path) {
            window.alert(json.error || '上传背景图片失败');
            return;
          }
          const old = normalizeBackground(backgroundPreference);
          const opacity = old && old.type === 'image' ? old.opacity : 0.22;
          const tone = old && old.type === 'image' ? old.tone : 'light';
          setBackground({
            type: 'image',
            path: json.path,
            opacity,
            scale: DEFAULT_IMAGE_FRAMING.scale,
            positionX: DEFAULT_IMAGE_FRAMING.positionX,
            positionY: DEFAULT_IMAGE_FRAMING.positionY,
            layout: 'immersive',
            toolbarReadability: 'light',
            tone,
          });
        } catch (err) {
          window.alert('选择背景图片失败：' + err.message);
        } finally {
          chooseImage.disabled = false;
        }
      });
    }
    const opacity = backgroundPanel.querySelector('[data-role="background-opacity"]');
    if (opacity) {
      opacity.addEventListener('input', () => {
        updateImageAppearance({ opacity: parseInt(opacity.value, 10) / 100 }, true);
      });
      opacity.addEventListener('change', () => queueBackgroundPreferenceSave(false));
    }
    backgroundPanel.querySelectorAll('[data-role="background-layout"] button').forEach((button) => {
      button.addEventListener('click', () => {
        updateImageAppearance({ layout: button.dataset.layout });
      });
    });
    backgroundPanel.querySelectorAll('[data-role="background-tone"] button').forEach((button) => {
      button.addEventListener('click', () => {
        updateImageAppearance({ tone: button.dataset.tone });
      });
    });
    backgroundPanel.querySelectorAll('[data-role="background-readability"] button').forEach((button) => {
      button.addEventListener('click', () => {
        updateImageAppearance({ toolbarReadability: button.dataset.readability });
      });
    });
    const scale = backgroundPanel.querySelector('[data-role="background-scale"]');
    if (scale) {
      scale.addEventListener('input', () => {
        updateImageAppearance({ scale: parseInt(scale.value, 10) / 100 }, true);
      });
      scale.addEventListener('change', () => queueBackgroundPreferenceSave(false));
    }
    const positionX = backgroundPanel.querySelector('[data-role="background-position-x"]');
    if (positionX) {
      positionX.addEventListener('input', () => {
        updateImageAppearance({ positionX: parseInt(positionX.value, 10) }, true);
      });
      positionX.addEventListener('change', () => queueBackgroundPreferenceSave(false));
    }
    const positionY = backgroundPanel.querySelector('[data-role="background-position-y"]');
    if (positionY) {
      positionY.addEventListener('input', () => {
        updateImageAppearance({ positionY: parseInt(positionY.value, 10) }, true);
      });
      positionY.addEventListener('change', () => queueBackgroundPreferenceSave(false));
    }
    const framingReset = backgroundPanel.querySelector('[data-action="background-image-framing-reset"]');
    if (framingReset) {
      framingReset.addEventListener('click', () => {
        updateImageAppearance({
          scale: DEFAULT_IMAGE_FRAMING.scale,
          positionX: DEFAULT_IMAGE_FRAMING.positionX,
          positionY: DEFAULT_IMAGE_FRAMING.positionY,
        });
      });
    }
    const preview = backgroundPanel.querySelector('[data-role="background-image-preview"]');
    if (preview) {
      let drag = null;
      preview.addEventListener('pointerdown', (event) => {
        const bg = normalizeBackground(backgroundPreference);
        if (!bg || bg.type !== 'image' || event.button !== 0) return;
        event.preventDefault();
        drag = {
          id: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          positionX: bg.positionX,
          positionY: bg.positionY,
          width: Math.max(1, preview.clientWidth),
          height: Math.max(1, preview.clientHeight),
        };
        preview.classList.add('dragging');
        preview.setPointerCapture(event.pointerId);
      });
      preview.addEventListener('pointermove', (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        updateImageAppearance({
          positionX: Math.round(clampNumber(
            drag.positionX - ((event.clientX - drag.clientX) / drag.width) * 100,
            0, 100, DEFAULT_IMAGE_FRAMING.positionX,
          )),
          positionY: Math.round(clampNumber(
            drag.positionY - ((event.clientY - drag.clientY) / drag.height) * 100,
            0, 100, DEFAULT_IMAGE_FRAMING.positionY,
          )),
        }, true);
      });
      const stopDragging = (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        if (preview.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId);
        drag = null;
        preview.classList.remove('dragging');
        queueBackgroundPreferenceSave(false);
      };
      preview.addEventListener('pointerup', stopDragging);
      preview.addEventListener('pointercancel', stopDragging);
    }
    const removeImage = backgroundPanel.querySelector('[data-action="background-image-remove"]');
    if (removeImage) removeImage.addEventListener('click', () => setBackground(null));
    document.addEventListener('mousedown', (event) => {
      if (!backgroundPanel.hidden && !backgroundPanel.contains(event.target)
          && !backgroundBtn.contains(event.target)) {
        close();
      }
    });
  }

  // ── 加载（并行请求画布数据 + 全局背景偏好）───────
  Promise.all([
    fetch('/api/load?path=' + encodeURIComponent(filePath))
      .then((r) => r.json().then((j) => ({ ok: r.ok, json: j }))),
    fetch('/api/background-preference')
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
  ])
    .then(async ([{ ok, json }, bgJson]) => {
      if (!ok) {
        // 文件不存在 / 已被移动：给友好兜底，引导回起步页，
        // 而不是留一个空白画布 + 干巴巴的"文件不存在"
        if (titleEl) titleEl.textContent = '(打开失败)';
        setState(json.error || '打开失败');
        const hint = document.querySelector('[data-role="empty-hint"]');
        if (hint) {
          hint.hidden = false;
          hint.textContent = '这个文件不存在或已被移动。点左上角「‹ 起步页」回到列表。';
        }
        finishEditorOpening();
        return;
      }
      canvasData = json.data || { version: 2, nodes: [], edges: [] };
      if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
      if (!Array.isArray(canvasData.edges)) canvasData.edges = [];
      if (titleEl) titleEl.textContent = json.title || '画布';
      // 数据已加载成功：立即启用标题改名。早于画布渲染绑定，确保即便后续渲染 / 桥接出意外，
      // 标题改名也始终可用（此前它排在渲染之后，渲染一抛错就被整段跳过 → 改不了名）。
      setupRename();

      // 利用已并行拿到的背景偏好，跳过 loadBackgroundPreference 里的重复 fetch
      if (bgJson && bgJson.configured) {
        backgroundPreference = normalizeBackground(bgJson.background);
        guidePreference = normalizeGuide(bgJson.guide);
      } else {
        // 旧版背景曾跟随单张画布保存；尚无全局配置时迁移首次遇到的旧设置，
        // 仍没有则落到出厂默认「月灰 + 横线纸」；迁移旧画布背景时保持旧版无底纹行为。
        const legacyBackground = normalizeBackground(canvasData && canvasData.background);
        backgroundPreference = legacyBackground || normalizeBackground(DEFAULT_BACKGROUND);
        guidePreference = normalizeGuide(legacyBackground ? null : DEFAULT_GUIDE);
        if (backgroundPreference) queueBackgroundPreferenceSave(false);
      }
      setupBackgroundPanel();
      const backgroundReady = renderBackground({ initial: true });
      renderGuide();

      // 启动画布交互（canvas.js 直接 mutate canvasData.nodes）
      if (window.CanvasModule) {
        window.CanvasModule.init({
          viewport: viewportEl,
          guideLayer: guideLayerEl,
          topbarGuideLayer: topbarGuideLayerEl,
          surface: document.querySelector('[data-role="canvas-surface"]'),
          emptyHint: document.querySelector('[data-role="empty-hint"]'),
          edgesLayer: document.querySelector('[data-role="canvas-edges"]'),
          edgesCanvas: document.querySelector('[data-role="canvas-edges-canvas"]'),
          inkLayer: document.querySelector('[data-role="canvas-ink"]'),
          drawToolbar: document.querySelector('[data-role="canvas-toolbox"]'),
          zoomIndicator: document.querySelector('[data-role="zoom-indicator"]'),
          panSpeedInput: document.querySelector('[data-role="pan-speed"]'),
          panInertiaInput: document.querySelector('[data-role="pan-inertia"]'),
          zoomSpeedInput: document.querySelector('[data-role="zoom-speed"]'),
          locateBtn: document.querySelector('[data-role="locate-recent"]'),
          spaceLocateInput: document.querySelector('[data-role="enable-space-locate"]'),
          zoomPresetBtn: document.querySelector('[data-role="zoom-preset"]'),
          zoomPrefInput: document.querySelector('[data-role="zoom-pref"]'),
          shortcutsOverlay: document.querySelector('[data-role="shortcuts"]'),
          shortcutsClose: document.querySelector('[data-role="shortcuts-close"]'),
          helpBtn: document.querySelector('[data-role="help-btn"]'),
          onboardingHint: document.querySelector('[data-role="first-open-hint"]'),
          // 完整的新手引导由 editor-onboarding.js 接管；旧的定时文字胶囊仅保留兼容数据，不再由新建画布触发。
          onboardingReset: null,
          fresh: false,
          nodeMenu: document.querySelector('[data-role="node-menu"]'),
          edgeMenu: document.querySelector('[data-role="edge-menu"]'),
          editPanel: document.querySelector('[data-role="edit-panel"]'),
          decorPanel: document.querySelector('[data-role="decor-panel"]'),
          textReader: document.querySelector('[data-role="text-reader"]'),
          pdfReader: document.querySelector('[data-role="pdf-reader"]'),
          mdReader: document.querySelector('[data-role="md-reader"]'),
          selToolbar: document.querySelector('[data-role="sel-toolbar"]'),
          textDock: document.querySelector('[data-role="text-format-dock"]'),
          formulaPanel: document.querySelector('[data-role="formula-panel"]'),
          formulaBtn: document.querySelector('[data-role="formula-btn"]'),
          confirmOverlay: document.querySelector('[data-role="confirm"]'),
          searchBar: document.querySelector('[data-role="search-bar"]'),
          searchInput: document.querySelector('[data-role="search-input"]'),
          searchCount: document.querySelector('[data-role="search-count"]'),
          searchPrev: document.querySelector('[data-role="search-prev"]'),
          searchNext: document.querySelector('[data-role="search-next"]'),
          searchClose: document.querySelector('[data-role="search-close"]'),
          minimap: document.querySelector('[data-role="minimap"]'),
          minimapNodes: document.querySelector('[data-role="minimap-nodes"]'),
          minimapViewbox: document.querySelector('[data-role="minimap-viewbox"]'),
          filePath: filePath,
          data: canvasData,
          initialViewport: json.viewport,
          onViewportChange: queueViewportSave,
          onChange: markDirty,
        });
        document.dispatchEvent(new CustomEvent('editor:canvasready'));
        if (LOCATE_NODE && typeof window.CanvasModule.revealNode === 'function') {
          window.setTimeout(() => {
            try { window.CanvasModule.revealNode(LOCATE_NODE); } catch (e) {}
          }, 240);
        }
      }
      setupGraphPanel();

      markClean('已保存');
        const cleanBtn = document.querySelector('[data-role="assets-clean-btn"]');
        if (cleanBtn) {
          if (json.orphanCount > 0) {
            cleanBtn.hidden = false;
          } else {
            cleanBtn.hidden = true;
          }
        }
      // 背景、画布和标题都已是最终状态，再统一揭开开场遮罩。
      await backgroundReady;
      finishEditorOpening();
    })
    .catch((err) => {
      setState('加载失败');
      console.warn('[画布] 加载失败', err);
      finishEditorOpening();
    });

  // ── 顶栏文件名重命名 ──────────────────────────
  // 点文件名 → 行内输入框，Enter/失焦提交、Esc 取消。改名只动磁盘文件名、
  // 不动内容，所以无需 reload：成功后更新 filePath（后续 Ctrl+S 写新路径）、
  // 标题、地址栏（history.replaceState）。同目录改名，外部链接 baseDir 不变。
  function setupRename() {
    if (!titleEl) return;
    titleEl.title = '点击重命名';
    titleEl.classList.add('renamable');
    titleEl.addEventListener('click', startTitleRename);
  }

  function startTitleRename() {
    if (canvasData === null || titleEl.dataset.renaming === '1') return;
    titleEl.dataset.renaming = '1';
    const cur = titleEl.textContent;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'editor-rename-input';
    input.value = cur;
    input.spellcheck = false;
    titleEl.style.display = 'none';
    titleEl.parentNode.insertBefore(input, titleEl);
    input.focus();
    input.select();

    let settled = false;
    const restore = () => {
      input.remove();
      titleEl.style.display = '';
      titleEl.dataset.renaming = '';
    };
    const commit = async () => {
      if (settled) return;
      settled = true;
      const newName = input.value.trim();
      if (!newName || newName === cur) { restore(); return; }
      try {
        const resp = await fetch('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, newName }),
        });
        const json = await resp.json();
        if (resp.ok && json.path) {
          filePath = json.path;
          if (window.CanvasModule && typeof window.CanvasModule.setFilePath === 'function') {
            window.CanvasModule.setFilePath(filePath);
          }
          titleEl.textContent = json.title || newName;
          history.replaceState(null, '', 'editor.html?file=' + encodeURIComponent(json.path));
        } else {
          showRenameNotice(json.error || '重命名失败');
        }
      } catch (err) {
        showRenameNotice('重命名失败：' + err.message);
      }
      restore();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); settled = true; restore(); }
    });
    input.addEventListener('blur', commit);
  }

  // ── 保存 ──────────────────────────────────────
  const KEEPALIVE_SAVE_LIMIT = 60 * 1024;
  let unloadSaveBody = null;

  function commitPendingCanvasEdits() {
    if (window.CanvasModule && typeof window.CanvasModule.commitPendingEdits === 'function') {
      window.CanvasModule.commitPendingEdits();
    }
  }

  function buildSaveRequestBody() {
    if (!filePath || canvasData === null) return '';
    return JSON.stringify({ path: filePath, data: canvasData });
  }

  function saveBodySize(body) {
    try { return new Blob([body]).size; } catch (e) { return body.length * 3; }
  }

  async function performSave() {
    isSaving = true;
    const savedEpoch = dirtyEpoch;   // 记下本次保存覆盖到的编辑版本，用于识别"保存途中又改了"
    setState('保存中…');
    try {
      const resp = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildSaveRequestBody(),
      });
      const json = await resp.json();
      if (resp.ok) {
        if (dirtyEpoch === savedEpoch) {
          markClean('已保存');             // 保存途中没有新编辑 → 确实干净
        } else {
          // 保存途中又改了：这次落盘已过时，保持"未保存"并尽快补存，绝不把新改动误标成已保存
          setState('未保存');
          scheduleAutosave();
        }
        const cleanBtn = document.querySelector('[data-role="assets-clean-btn"]');
        if (cleanBtn) {
          if (json.orphanCount > 0) {
            cleanBtn.hidden = false;
          } else {
            cleanBtn.hidden = true;
          }
        }
        return true;
      } else {
        setState(json.error || '保存失败');
        scheduleAutosave();                // 失败也排一次重试，别把未落盘的改动晾在那
        return false;
      }
    } catch (err) {
      setState('保存失败');
      console.warn('[画布] 保存失败', err);
      scheduleAutosave();                  // 网络/异常同样补存
      return false;
    } finally {
      isSaving = false;
      // 兜底：若保存期间 isSaving 挡掉过自动保存触发，这里补排一次，确保脏数据最终落盘
      if (dirty && autosaveTimer === null) scheduleAutosave();
    }
  }

  async function save() {
    commitPendingCanvasEdits();
    if (canvasData === null) return false;
    if (savePromise) {
      const pendingSave = savePromise;
      const pendingOk = await pendingSave;
      if (savePromise === pendingSave) savePromise = null;
      if (!pendingOk || !dirty) return pendingOk;
      return save();
    }
    if (!dirty) return true;

    const currentSave = performSave();
    savePromise = currentSave;
    const ok = await currentSave;
    if (savePromise === currentSave) savePromise = null;
    // 保存途中又发生编辑时，调用方必须等补存完成，不能拿到一个“已保存”的假成功。
    if (ok && dirty) return save();
    return ok;
  }

  async function exportMarkdown() {
    if (isExporting || canvasData === null) return;
    if (window.CanvasModule && typeof window.CanvasModule.commitPendingEdits === 'function') {
      window.CanvasModule.commitPendingEdits();
    }
    isExporting = true;
    if (exportBtn) exportBtn.disabled = true;
    setState('选择导出父目录…');
    try {
      const resp = await fetch('/api/export-markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, data: canvasData }),
      });
      const json = await resp.json();
      if (resp.ok && json.cancelled) return;
      if (!resp.ok) {
        window.alert(json.error || '导出失败');
        return;
      }
      window.alert('导出完成：' + json.count + ' 个 Markdown 文件\n\n' + json.path);
      try {
        await fetch('/api/open-external', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'file', target: json.path }),
        });
      } catch (openErr) {
        console.warn('[画布] 自动打开导出文件夹失败', openErr);
      }
    } catch (err) {
      window.alert('导出失败：' + err.message);
    } finally {
      isExporting = false;
      if (exportBtn) exportBtn.disabled = false;
      setState(dirty ? '未保存' : '已保存');
    }
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportMarkdown);
  }

  async function exportPng() {
    if (isExporting || canvasData === null) return;
    if (!window.CanvasModule || typeof window.CanvasModule.exportImage !== 'function') {
      window.alert('当前画布尚未就绪，无法导出 PNG');
      return;
    }
    isExporting = true;
    if (exportPngBtn) exportPngBtn.disabled = true;
    setState('正在合成图片…');
    try {
      const result = await window.CanvasModule.exportImage();   // { blob, width, height }
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('图片读取失败'));
        fr.readAsDataURL(result.blob);
      });
      setState('选择保存位置…');
      const resp = await fetch('/api/export-png', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, png: dataUrl }),
      });
      const json = await resp.json();
      if (resp.ok && json.cancelled) return;
      if (!resp.ok) {
        window.alert(json.error || '导出失败');
        return;
      }
      window.alert('已导出 PNG（' + result.width + '×' + result.height + '）\n\n' + json.path);
      try {
        await fetch('/api/open-external', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'file', target: json.path }),
        });
      } catch (openErr) {
        console.warn('[画布] 自动打开导出图片失败', openErr);
      }
    } catch (err) {
      window.alert('导出 PNG 失败：' + (err && err.message || err));
    } finally {
      isExporting = false;
      if (exportPngBtn) exportPngBtn.disabled = false;
      setState(dirty ? '未保存' : '已保存');
    }
  }

  if (exportPngBtn) {
    exportPngBtn.addEventListener('click', exportPng);
  }

  // ── 转为任务：只处理当前选中的卡片；全部成功后才从画布移除 ──
  const taskExportBtn = document.querySelector('[data-action="export-tasks"]');
  const taskExportLabel = taskExportBtn && taskExportBtn.querySelector('.task-export-confirm-label');
  let exportingTasks = false;
  let taskExportConfirmTimer = null;
  let pendingTaskExportIds = [];

  function selectedCardIds() {
    const getter = window.CanvasModule && window.CanvasModule.getSelectedCardIds;
    if (typeof getter !== 'function') return [];
    const ids = getter();
    return Array.isArray(ids) ? ids.slice() : [];
  }

  function exitTaskExportConfirm() {
    if (taskExportConfirmTimer) {
      clearTimeout(taskExportConfirmTimer);
      taskExportConfirmTimer = null;
    }
    if (taskExportBtn) {
      taskExportBtn.classList.remove('confirming');
      delete taskExportBtn.dataset.confirmCount;
    }
    if (taskExportLabel) taskExportLabel.textContent = toolbarCopy('tasksConfirm');
    pendingTaskExportIds = [];
    document.removeEventListener('pointerdown', onTaskExportOutside, true);
    document.removeEventListener('keydown', onTaskExportEsc, true);
  }

  function onTaskExportOutside(event) {
    if (taskExportBtn && !taskExportBtn.contains(event.target)) exitTaskExportConfirm();
  }

  function onTaskExportEsc(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      exitTaskExportConfirm();
    }
  }

  function enterTaskExportConfirm() {
    if (!taskExportBtn) return;
    const ids = selectedCardIds();
    const count = ids.length;
    if (count <= 0) {
      showTaskExportNotice(
        '还没有选中卡片',
        '框选卡片，或按住 Shift 逐个多选，再点一次「转为任务」。',
        'info'
      );
      return;
    }
    if (count > 20) {
      showTaskExportNotice(
        '这次选得有点多',
        '已选中 ' + count + ' 张卡片，一次最多转换 20 张，请分批处理。',
        'warning'
      );
      return;
    }
    pendingTaskExportIds = ids;
    taskExportBtn.dataset.confirmCount = String(count);
    if (taskExportLabel) {
      taskExportLabel.textContent = toolbarLanguage === 'en'
        ? ('Confirm ' + count + (count === 1 ? ' Task' : ' Tasks'))
        : ('确认转为 ' + count + ' 个任务');
    }
    taskExportBtn.classList.add('confirming');
    document.addEventListener('pointerdown', onTaskExportOutside, true);
    document.addEventListener('keydown', onTaskExportEsc, true);
    taskExportConfirmTimer = setTimeout(exitTaskExportConfirm, 4200);
  }

  async function exportCanvasToTasks(nodeIds) {
    if (exportingTasks || canvasData === null || !filePath) return;
    if (!Array.isArray(nodeIds) || nodeIds.length <= 0) return;
    exportingTasks = true;
    if (window.CanvasModule && typeof window.CanvasModule.commitPendingEdits === 'function') {
      window.CanvasModule.commitPendingEdits();
    }
    if (taskExportBtn) taskExportBtn.disabled = true;
    setState('正在转为任务…');
    try {
      if (dirty && !(await save())) {
        throw new Error('当前画布尚未成功保存，已取消转换');
      }
      const resp = await fetch('/api/export-canvas-to-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, nodeIds: nodeIds }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '转为任务失败');

      dirty = false;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
      if (window.CanvasDesktop) window.CanvasDesktop.setDirty(false);
      document.dispatchEvent(new CustomEvent('canvas:data-changed', {
        detail: { source: 'study', path: '/api/export-canvas-to-tasks' },
      }));
      const remover = window.CanvasModule && window.CanvasModule.removeArchivedNodes;
      if (typeof remover !== 'function') {
        setState('任务已创建，正在刷新同步…');
        setTimeout(() => window.location.reload(), 260);
        return;
      }
      try {
        remover(json.removedNodeIds || []);
      } catch (syncError) {
        console.warn('[画布] 转为任务后原地同步失败，改为刷新同步', syncError);
        setState('任务已创建，正在刷新同步…');
        setTimeout(() => window.location.reload(), 260);
        return;
      }
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
      markClean('已创建 ' + (json.count || 0) + ' 个待办任务');
      showTaskExportNotice(
        '已转为 ' + (json.count || 0) + ' 个待办任务',
        '卡片已从画布移除，可以在学习页继续安排。',
        'success'
      );
    } catch (err) {
      showTaskExportNotice(
        '没有完成转换',
        (err && err.message) || String(err || '请稍后再试。'),
        'error'
      );
      setState(dirty ? '未保存' : '已保存');
    } finally {
      exportingTasks = false;
      if (taskExportBtn) taskExportBtn.disabled = false;
    }
  }

  if (taskExportBtn) {
    taskExportBtn.addEventListener('click', () => {
      if (exportingTasks) return;
      if (taskExportBtn.classList.contains('confirming')) {
        const nodeIds = pendingTaskExportIds.slice();
        exitTaskExportConfirm();
        exportCanvasToTasks(nodeIds);
      } else {
        enterTaskExportConfirm();
      }
    });
    document.addEventListener('editor:selectionchange', () => {
      if (taskExportBtn.classList.contains('confirming')) exitTaskExportConfirm();
    });
  }

  // ── 归档：收走已划删除线的正文节点 + 写归档记录，未划线节点留在当前画布 ──
  // 顶栏小图标：点一下进入「确认归档」轻确认态，再点一下才真正执行（Esc / 点别处取消）。
  const archiveBtn = document.querySelector('[data-action="archive"]');
  let archiving = false;
  let archiveConfirmTimer = null;

  function exitArchiveConfirm() {
    if (archiveConfirmTimer) { clearTimeout(archiveConfirmTimer); archiveConfirmTimer = null; }
    if (archiveBtn) archiveBtn.classList.remove('confirming');
    document.removeEventListener('pointerdown', onArchiveOutside, true);
    document.removeEventListener('keydown', onArchiveEsc, true);
  }
  function onArchiveOutside(e) {
    if (archiveBtn && !archiveBtn.contains(e.target)) exitArchiveConfirm();
  }
  function onArchiveEsc(e) {
    if (e.key === 'Escape') { e.stopPropagation(); exitArchiveConfirm(); }
  }
  function enterArchiveConfirm() {
    if (!archiveBtn) return;
    archiveBtn.classList.add('confirming');
    document.addEventListener('pointerdown', onArchiveOutside, true);
    document.addEventListener('keydown', onArchiveEsc, true);
    archiveConfirmTimer = setTimeout(exitArchiveConfirm, 3600);
  }

  async function archiveCanvas() {
    if (archiving || canvasData === null || !filePath) return;
    archiving = true;
    if (window.CanvasModule && typeof window.CanvasModule.commitPendingEdits === 'function') {
      window.CanvasModule.commitPendingEdits();
    }
    if (archiveBtn) archiveBtn.disabled = true;
    setState('归档中…');
    try {
      if (dirty && !(await save())) {
        throw new Error('当前画布尚未成功保存，已取消归档');
      }
      const resp = await fetch('/api/archive-canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        window.alert(json.error || '归档失败');
        archiving = false;
        if (archiveBtn) archiveBtn.disabled = false;
        setState(dirty ? '未保存' : '已保存');
        return;
      }
      dirty = false;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
      if (window.CanvasDesktop) window.CanvasDesktop.setDirty(false);
      try {
        const remover = window.CanvasModule && window.CanvasModule.removeArchivedNodes;
        if (typeof remover !== 'function') throw new Error('缺少原地消除入口');
        remover(json.removedNodeIds || []);
        if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
        markClean('已归档 ' + (json.count || 0) + ' 个划线节点');
        archiving = false;
        if (archiveBtn) archiveBtn.disabled = false;
      } catch (removeErr) {
        console.warn('[画布] 原地消除归档节点失败，改为刷新同步', removeErr);
        setState('已归档，正在刷新同步…');
        setTimeout(() => {
          window.location.reload();
        }, 260);
      }
    } catch (err) {
      window.alert('归档失败：' + (err && err.message || err));
      archiving = false;
      if (archiveBtn) archiveBtn.disabled = false;
      setState(dirty ? '未保存' : '已保存');
    }
  }

  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => {
      if (archiving) return;
      if (archiveBtn.classList.contains('confirming')) {
        exitArchiveConfirm();
        archiveCanvas();
      } else {
        enterArchiveConfirm();
      }
    });
  }

  function setupGraphPanel() {
    if (!graphBtn || !window.GraphView || graphView) return;
    graphView = window.GraphView.init({
      overlay: document.querySelector('[data-role="graph-overlay"]'),
      trigger: graphBtn,
      onSelect: (nodeId) => {
        if (window.CanvasModule && typeof window.CanvasModule.revealNode === 'function') {
          window.CanvasModule.revealNode(nodeId);
        }
      },
      onVisibilityChange: (open) => {
        if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
          window.CanvasModule.setExternalOverlayOpen(open);
        }
      },
    });
    if (!graphView) return;
    graphBtn.disabled = false;
    graphBtn.addEventListener('click', () => {
      if (!canvasData) return;
      if (window.CanvasModule && typeof window.CanvasModule.commitPendingEdits === 'function') {
        window.CanvasModule.commitPendingEdits();
      }
      if (mindmapMenu) {
        mindmapMenu.hidden = true;
        if (mindmapBtn) mindmapBtn.setAttribute('aria-expanded', 'false');
      }
      if (backgroundPanel && !backgroundPanel.hidden) {
        if (closeBackgroundPanel) closeBackgroundPanel();
      }
      graphView.open(canvasData, titleEl ? titleEl.textContent : '画布');
    });
  }

  // 脑图：顶栏按钮弹出布局菜单 → 调 CanvasModule.applyMindmap(layout)
  if (mindmapBtn && mindmapMenu) {
    const closeMindmap = () => {
      mindmapMenu.hidden = true;
      mindmapBtn.setAttribute('aria-expanded', 'false');
    };
    const openMindmap = () => {
      mindmapMenu.hidden = false;
      mindmapBtn.setAttribute('aria-expanded', 'true');
      const r = mindmapBtn.getBoundingClientRect();
      const visibleSidePanel = [...document.querySelectorAll('.side-panel')].find((panel) => {
        const style = window.getComputedStyle(panel);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      const sidePanelLeft = visibleSidePanel ? visibleSidePanel.getBoundingClientRect().left - 8 : window.innerWidth - 8;
      const menuLeft = Math.min(r.right - mindmapMenu.offsetWidth, sidePanelLeft - mindmapMenu.offsetWidth);
      mindmapMenu.style.top = (r.bottom + 6) + 'px';
      mindmapMenu.style.left = Math.max(8, menuLeft) + 'px';
    };
    mindmapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mindmapMenu.hidden) openMindmap(); else closeMindmap();
    });
    mindmapMenu.querySelectorAll('[data-mindmap]').forEach((b) => {
      b.addEventListener('click', () => {
        if (window.CanvasModule && typeof window.CanvasModule.applyMindmap === 'function') {
          window.CanvasModule.applyMindmap(b.dataset.mindmap, { scope: b.dataset.mindmapScope || 'selection' });
        }
        closeMindmap();
      });
    });
    document.addEventListener('mousedown', (e) => {
      if (mindmapMenu.hidden) return;
      if (e.target === mindmapBtn || mindmapBtn.contains(e.target) || mindmapMenu.contains(e.target)) return;
      closeMindmap();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMindmap(); });
  }

  // 「模板」库：顶栏按钮向下展开下拉，列出存好的模板；拖卡片到画布即落地，× 两步确认删除（连数据一起删）
  if (templateBtn && templateMenu) {
    const listEl = templateMenu.querySelector('[data-role="template-list"]');
    const emptyEl = templateMenu.querySelector('[data-role="template-empty"]');
    let templates = [];
    let renderedTemplateSignature = '';
    let templateRequestVersion = 0;
    let templateClosing = false;
    let templateCloseTimer = null;
    let reduceTemplateMotion = false;
    try {
      reduceTemplateMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {}

    const finishTemplateClose = () => {
      if (!templateClosing) return;
      templateClosing = false;
      if (templateCloseTimer) {
        clearTimeout(templateCloseTimer);
        templateCloseTimer = null;
      }
      templateMenu.removeEventListener('animationend', onTemplateCloseAnimationEnd);
      templateMenu.classList.remove('closing');
      templateMenu.hidden = true;
    };
    const onTemplateCloseAnimationEnd = (event) => {
      if (event.target === templateMenu && event.animationName === 'template-collapse') {
        finishTemplateClose();
      }
    };
    const hideTemplatesImmediately = () => {
      if (templateCloseTimer) {
        clearTimeout(templateCloseTimer);
        templateCloseTimer = null;
      }
      templateMenu.removeEventListener('animationend', onTemplateCloseAnimationEnd);
      templateClosing = false;
      templateMenu.classList.remove('closing');
      templateMenu.hidden = true;
      templateBtn.setAttribute('aria-expanded', 'false');
    };
    const closeTemplates = () => {
      templateBtn.setAttribute('aria-expanded', 'false');
      if (templateMenu.hidden || templateClosing) return;
      templateClosing = true;
      if (reduceTemplateMotion) {
        finishTemplateClose();
        return;
      }
      templateMenu.classList.add('closing');
      templateMenu.addEventListener('animationend', onTemplateCloseAnimationEnd);
      templateCloseTimer = setTimeout(finishTemplateClose, 170);
    };
    const positionMenu = () => {
      const r = templateBtn.getBoundingClientRect();
      templateMenu.style.top = (r.bottom + 6) + 'px';
      const left = Math.min(r.left, window.innerWidth - templateMenu.offsetWidth - 8);
      templateMenu.style.left = Math.max(8, left) + 'px';
    };
    const fmtMeta = (tpl) => {
      const nc = Array.isArray(tpl.nodes) ? tpl.nodes.length : 0;
      const ec = Array.isArray(tpl.edges) ? tpl.edges.length : 0;
      return ec ? (nc + ' 个元素 · ' + ec + ' 条连线') : (nc + ' 个元素');
    };
    const persist = () => fetch('/api/templates-save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templates }),
    });
    const templateSignature = (items) => {
      try { return JSON.stringify(items || []); } catch (e) { return ''; }
    };
    const render = (animate) => {
      const fragment = document.createDocumentFragment();
      if (!templates.length) {
        listEl.replaceChildren();
        emptyEl.hidden = false;
        renderedTemplateSignature = templateSignature(templates);
        return;
      }
      emptyEl.hidden = true;
      templates.forEach((tpl, i) => {
        const card = buildCard(tpl);
        if (animate) {
          const enterDelay = i * 42;
          card.style.setProperty('--enter-delay', enterDelay + 'ms');
          card.classList.add('entering');
          const finishEntering = () => card.classList.remove('entering');
          card.addEventListener('animationend', finishEntering, { once: true });
          // reduced-motion 或页面在后台时 animationend 可能不触发，兜底也要清掉一次性类。
          setTimeout(finishEntering, enterDelay + 420);
        }
        fragment.appendChild(card);
      });
      // 先在文档片段中建好整批卡片，再一次性替换，避免列表经历可见的空白帧。
      listEl.replaceChildren(fragment);
      renderedTemplateSignature = templateSignature(templates);
    };
    const removeTemplate = (id, cardEl) => {
      templates = templates.filter((t) => t.id !== id);
      renderedTemplateSignature = templateSignature(templates);
      persist().catch(() => {});
      if (!cardEl) { render(false); return; }
      // 平滑塌陷 + 淡出，再从 DOM 摘除；下方卡片顺势上移（不整列重绘，保住动画）
      const h = cardEl.offsetHeight;
      cardEl.style.height = h + 'px';
      void cardEl.offsetHeight;            // 触发过渡前先把高度定死
      cardEl.classList.add('removing');
      requestAnimationFrame(() => {
        cardEl.style.height = '0px';
        cardEl.style.marginBottom = '0px';
        cardEl.style.paddingTop = '0px';
        cardEl.style.paddingBottom = '0px';
      });
      let gone = false;
      const finish = () => {
        if (gone) return;
        gone = true;
        cardEl.remove();
        if (!templates.length) emptyEl.hidden = false;
      };
      cardEl.addEventListener('transitionend', (ev) => { if (ev.propertyName === 'height') finish(); });
      setTimeout(finish, 420);             // 兜底，防 transitionend 漏触发
    };

    // 自定义指针拖拽：按住卡片移动 → 跟手虚影 + 收起下拉；松手若落在画布内 → 落地模板
    const attachDrag = (card, tpl) => {
      card.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || (e.target.closest && e.target.closest('.template-card-del'))) return;
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        let ghost = null, dragging = false;
        const onMove = (ev) => {
          if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          if (!dragging) {
            dragging = true;
            card.classList.add('dragging');
            ghost = document.createElement('div');
            ghost.className = 'template-drag-ghost';
            const gn = Array.isArray(tpl.nodes) ? tpl.nodes.length : 0;
            ghost.textContent = (tpl.name || '模板') + ' · ' + gn + ' 元素';
            document.body.appendChild(ghost);
            hideTemplatesImmediately();        // 拖动时立即收起下拉，露出画布
          }
          ghost.style.left = ev.clientX + 'px';
          ghost.style.top = ev.clientY + 'px';
        };
        const onUp = (ev) => {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup', onUp, true);
          card.classList.remove('dragging');
          if (ghost) ghost.remove();
          if (!dragging) return;
          const r = viewportEl ? viewportEl.getBoundingClientRect() : null;
          const inCanvas = r && ev.clientX >= r.left && ev.clientX <= r.right
            && ev.clientY >= r.top && ev.clientY <= r.bottom;
          if (inCanvas && window.CanvasModule && typeof window.CanvasModule.instantiateTemplate === 'function') {
            window.CanvasModule.instantiateTemplate(tpl, { x: ev.clientX, y: ev.clientY });
          }
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
      });
    };

    const buildCard = (tpl) => {
      const card = document.createElement('div');
      card.className = 'template-card';
      card.dataset.id = tpl.id;
      card.title = '拖到画布放置';
      const name = document.createElement('div');
      name.className = 'template-card-name';
      name.textContent = tpl.name || '未命名模板';
      const meta = document.createElement('div');
      meta.className = 'template-card-meta';
      meta.textContent = fmtMeta(tpl);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'template-card-del';
      del.title = '删除模板';
      del.setAttribute('aria-label', '删除模板');
      del.textContent = '×';
      // 两步确认，防误删：第一下变「删除？」，第二下才真删；移开 / 超时回退
      let confirming = false, confirmTimer = null;
      const resetConfirm = () => {
        confirming = false;
        del.classList.remove('confirm');
        del.textContent = '×';
        if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
      };
      del.addEventListener('mousedown', (e) => { e.stopPropagation(); });   // 别触发卡片拖拽
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirming) {
          confirming = true;
          del.classList.add('confirm');
          del.textContent = '删除？';
          confirmTimer = setTimeout(resetConfirm, 2600);
          return;
        }
        resetConfirm();
        removeTemplate(tpl.id, card);
      });
      del.addEventListener('mouseleave', () => { if (confirming) resetConfirm(); });
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(del);
      attachDrag(card, tpl);
      return card;
    };

    const openTemplates = () => {
      if (templateCloseTimer) {
        clearTimeout(templateCloseTimer);
        templateCloseTimer = null;
      }
      templateMenu.removeEventListener('animationend', onTemplateCloseAnimationEnd);
      templateClosing = false;
      templateMenu.classList.remove('closing');
      templateMenu.hidden = false;
      templateBtn.setAttribute('aria-expanded', 'true');
      positionMenu();
      // 每次打开都拉最新（与套索保存共用磁盘数据，不留前端缓存以防失同步）
      const requestVersion = ++templateRequestVersion;
      fetch('/api/templates', { cache: 'no-store' })
        .then((r) => r.ok ? r.json() : { templates: [] })
        .catch(() => ({ templates: [] }))
        .then((lib) => {
          if (requestVersion !== templateRequestVersion) return;
          const nextTemplates = (lib && Array.isArray(lib.templates)) ? lib.templates : [];
          const nextSignature = templateSignature(nextTemplates);
          if (nextSignature !== renderedTemplateSignature) {
            // 首次载入可错峰入场；已有卡片刷新时直接稳定替换，不让内容先消失再出现。
            const animate = listEl.childElementCount === 0;
            templates = nextTemplates;
            render(animate);
          } else {
            templates = nextTemplates;
          }
          positionMenu();
        });
    };

    templateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (templateMenu.hidden || templateClosing) openTemplates(); else closeTemplates();
    });
    document.addEventListener('mousedown', (e) => {
      if (templateMenu.hidden) return;
      if (e.target === templateBtn || templateBtn.contains(e.target) || templateMenu.contains(e.target)) return;
      closeTemplates();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTemplates(); });

    // 套索存好模板后：顶栏「模板」按钮轻轻一跳，把目光引到模板存进去的地方；下拉开着就顺手刷新
    window.addEventListener('canvas:template-saved', () => {
      templateBtn.classList.remove('just-saved');
      void templateBtn.offsetWidth;        // 重启动画
      templateBtn.classList.add('just-saved');
      setTimeout(() => templateBtn.classList.remove('just-saved'), 720);
      if (!templateMenu.hidden) openTemplates();
    });
  }

  // Ctrl+S / Cmd+S
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      save();
    }
  });

  // 关闭/刷新前先提交编辑态。小画布可由 pagehide keepalive 静默补存；大画布超过浏览器
  // keepalive 请求上限时必须提醒，避免“界面看似自动保存、最后几秒实际丢失”。
  window.addEventListener('beforeunload', (e) => {
    commitPendingCanvasEdits();
    unloadSaveBody = null;
    if (!dirty) return;
    const canAutosave = EMBED || autosaveEnabled();
    if (canAutosave) {
      const body = buildSaveRequestBody();
      if (body && saveBodySize(body) <= KEEPALIVE_SAVE_LIMIT) {
        unloadSaveBody = body;
        return;
      }
    }
    e.preventDefault();
    // 现代浏览器只看 preventDefault；保留 returnValue 是兼容老浏览器
    e.returnValue = '';
  });
  window.addEventListener('pagehide', () => {
    flushViewportSave(true);
    commitPendingCanvasEdits();
    // 切换/关闭瞬间若仍有未保存（防抖未到），用 keepalive 兜底落盘（内嵌浮窗或开了自动保存时）
    if (dirty && canvasData && (EMBED || autosaveEnabled())) {
      try {
        const body = unloadSaveBody || buildSaveRequestBody();
        if (!body || saveBodySize(body) > KEEPALIVE_SAVE_LIMIT) return;
        fetch('/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        });
      } catch (e) {}
    }
  });

  // 暴露给阶段 1b 使用：节点交互调 setData 或 markDirty
  window.__canvasEditor = {
    save,
    markDirty,
    isDirty: () => dirty,
    getData: () => canvasData,
    setData: (next) => {
      canvasData = next;
      renderBackground();
      markDirty();
    },
  };
})();
