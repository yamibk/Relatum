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
  const LOCATE_TASK_ROOT = params.get('taskRoot') || '';
  const FROM_STUDY = params.get('from') === 'study';
  // 新建画布首次打开标志（由起步页「新建」带 &fresh=1）：进简洁模式 + 弹一次提示。
  // 读完即从地址栏抹掉，避免刷新后又触发。
  const FRESH = params.get('fresh') === '1';
  // 内嵌迷你画布（学习页 Tab 浮窗）：顶栏隐藏=无法切模式，锁「普通」，且不写回 localStorage（不污染完整编辑器的模式偏好）
  const EMBED = params.get('embed') === '1';
  const READONLY = params.get('readonly') === '1';
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
  const toolbarLanguageSelect = document.querySelector('[data-role="toolbar-language"]');
  const toolbarLanguageLabel = document.querySelector('[data-role="toolbar-language-label"]');

  // 界面语言与起始页共用同一偏好；本文件负责画布特有控件，通用文字由 i18n.js 补齐。
  const TOOLBAR_LANGUAGE_KEY = 'canvas:toolbarLanguage';
  const toolLayerMotionTimers = new WeakMap();

  function prefersReducedToolMotion() {
    return !!(window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function revealToolLayer(layer) {
    if (!layer) return false;
    const pending = toolLayerMotionTimers.get(layer);
    if (pending) window.clearTimeout(pending);
    toolLayerMotionTimers.delete(layer);
    layer.classList.remove('tool-layer-leaving');
    layer.classList.add('tool-layer-entering');
    layer.hidden = false;
    if (prefersReducedToolMotion()) {
      layer.classList.remove('tool-layer-entering');
      return true;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!layer.hidden && !layer.classList.contains('tool-layer-leaving')) {
          layer.classList.remove('tool-layer-entering');
        }
      });
    });
    return true;
  }

  function concealToolLayer(layer, onHidden, duration) {
    if (!layer || layer.hidden || layer.classList.contains('tool-layer-leaving')) return false;
    layer.classList.remove('tool-layer-entering');
    layer.classList.add('tool-layer-leaving');
    const finish = () => {
      toolLayerMotionTimers.delete(layer);
      layer.hidden = true;
      layer.classList.remove('tool-layer-leaving');
      if (typeof onHidden === 'function') onHidden();
    };
    if (prefersReducedToolMotion()) {
      finish();
      return true;
    }
    const timer = window.setTimeout(finish, Math.max(0, Number(duration) || 210));
    toolLayerMotionTimers.set(layer, timer);
    return true;
  }

  const managedCanvasLibrarySession = (() => {
    const freshForMs = 2000;
    const snapshots = new Map();
    const inFlight = new Map();

    function keyFor(current) {
      return String(current || '');
    }

    function peek(current) {
      return snapshots.get(keyFor(current)) || null;
    }

    function refresh(current) {
      const key = keyFor(current);
      if (inFlight.has(key)) return inFlight.get(key);
      const cached = snapshots.get(key);
      if (cached && Date.now() - cached.refreshedAt < freshForMs) {
        return Promise.resolve(cached);
      }
      const request = fetch(
        '/api/canvas-import-library?current=' + encodeURIComponent(key),
        { cache: 'no-store' },
      ).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || toolbarCopy('canvasLibraryLoadFailed'));
        const entry = {
          payload: payload,
          signature: JSON.stringify(payload),
          refreshedAt: Date.now(),
        };
        snapshots.set(key, entry);
        return entry;
      }).finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
      inFlight.set(key, request);
      return request;
    }

    return { peek, refresh };
  })();

  if (!EMBED) {
    document.addEventListener('editor:canvasready', () => {
      const warmLibrary = () => {
        managedCanvasLibrarySession.refresh(filePath).catch(() => {});
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(warmLibrary, { timeout: 1800 });
      } else {
        window.setTimeout(warmLibrary, 700);
      }
    }, { once: true });
  }

  const TOOLBAR_COPY = {
    'zh-CN': {
      back: '起步页', canvas: '画布', mindmap: '导图', patterns: '图案', tools: '工具',
      notebookShortcut: '笔记', taskbookShortcut: '任务',
      ruler: '尺子', rulerHint: '对齐笔迹与节点',
      removeRuler: '移除尺子',
      markdownNotebook: '笔记坞', markdownNotebookHint: '长期笔记与导图快照',
      markdownNotebookKicker: '画布工具', markdownNotebookTitle: '笔记坞',
      markdownNotebookSavedWithCanvas: '随当前 .canvas 保存',
      markdownNotebookTopbarToggle: '将笔记坞添加到编辑器顶栏',
      taskbookTopbarToggle: '将任务簿添加到编辑器顶栏',
      markdownNotebookClose: '关闭笔记坞', markdownNotebookList: '笔记列表',
      markdownNotebookPages: '笔记', markdownNotebookAdd: '新建笔记',
      markdownNotebookUntitled: '未命名笔记', markdownNotebookDelete: '删除当前笔记',
      markdownNotebookNoteTitle: '笔记标题', markdownNotebookSource: 'Markdown 源码',
      markdownNotebookModes: '编辑与预览',
      markdownNotebookEdit: '编辑', markdownNotebookPreview: '预览',
      markdownNotebookSourceHint: '标题与缩进列表会成为导图节点',
      markdownNotebookPlaceholder: '# 主题\n\n- 分支\n  - 子分支',
      markdownNotebookPreviewEmpty: '开始输入后，这里会显示实时预览。',
      markdownNotebookNeedStructure: '添加标题或列表后即可生成导图',
      markdownNotebookStyle: '样式', markdownNotebookLayout: '布局',
      layoutBalanced: '左右平衡', layoutRight: '向右', layoutLeft: '向左',
      layoutDown: '向下', layoutRadial: '放射',
      markdownNotebookAppend: '追加选中内容', markdownNotebookGenerate: '生成导图',
      markdownNotebookNoSelection: '未选择画布内容',
      markdownNotebookSelected: '已选中 {count} 项',
      markdownNotebookIgnored: '，忽略 {count} 项',
      markdownNotebookNodes: '{count} 个节点',
      markdownNotebookDepth: '{count} 层结构',
      markdownNotebookEmptyError: '请先写下标题或列表，再生成导图。',
      markdownNotebookLimitError: '一篇笔记最多生成 200 个结构节点。',
      markdownNotebookDeleteConfirm: '这篇笔记会从当前 .canvas 中移除，已生成的导图不会受到影响。',
      markdownNotebookDeleteTitle: '删除“{title}”？',
      markdownNotebookCancel: '取消', markdownNotebookConfirmDelete: '删除笔记',
      markdownNotebookHelp: '了解导图生成规则',
      markdownNotebookHelpClose: '关闭导图生成说明',
      markdownNotebookHelpEyebrow: '一次性结构快照',
      markdownNotebookHelpTitle: '导图如何生成？',
      markdownNotebookHelpIntro: '笔记坞只读取 Markdown 结构，不会在两边建立同步。',
      markdownNotebookHelpCurrent: '当前笔记',
      markdownNotebookHelpReady: '将生成 {count} 个节点',
      markdownNotebookHelpReadyDetail: '{count} 层结构 · 生成后独立',
      markdownNotebookHelpEmpty: '还没有可生成的结构',
      markdownNotebookHelpRoot: '笔记标题成为根节点；相同的首个一级标题会自动合并。',
      markdownNotebookHelpStructure: 'H1–H6、缩进列表和任务列表生成结构节点。',
      markdownNotebookHelpBody: '段落、引用、代码、公式和表格进入最近节点正文。',
      markdownNotebookHelpSnapshot: '生成的是独立快照，之后修改任意一侧都不会同步。',
      markdownNotebookHelpLimit: '单次最多生成 200 个结构节点。',
      markdownNotebookHelpExample: '结构示例',
      markdownNotebookHelpExampleMarkdown: '# 研究\n- 假设 A\n  - 证据',
      markdownNotebookHelpExampleTree: '研究\n└ 假设 A\n  └ 证据',
      markdownNotebookAppended: '已追加画布选区快照。后续修改不会自动同步。',
      markdownNotebookComplexSelection: '选区包含交叉关系，已按画布位置转为平级列表。',
      markdownNotebookGenerated: '已生成独立导图快照。',
      markdownNotebookUnavailable: '笔记坞尚未准备好。',
      canvasScenes: '镜头册', canvasScenesHint: '保存视角并组织演示',
      canvasScenesKicker: '画布工具', canvasScenesClose: '关闭镜头册',
      canvasScenesMoveHint: '拖动移动镜头册；双击恢复默认位置',
      canvasScenesList: '镜头列表', canvasScenesSaveView: '保存当前视角',
      canvasScenesSaveSelection: '收录所选内容',
      canvasScenesSelectionHint: '选择节点或分组后可创建跟随镜头',
      canvasScenesSelectionReady: '已选择 {count} 项',
      canvasScenesIgnored: '，将忽略 {count} 项',
      canvasScenesEmpty: '还没有镜头',
      canvasScenesEmptyHint: '保存当前视角，或选择内容创建会跟随移动的章节。',
      canvasScenesGroups: '按所选分组创建', canvasScenesPresent: '演示',
      canvasScenesDeleted: '镜头已删除', canvasScenesUndo: '撤销',
      canvasScenesCamera: '固定视角', canvasScenesFollow: '跟随内容',
      canvasScenesMissing: '内容已缺失', canvasScenesPartialMissing: '部分内容已缺失',
      canvasScenesUpdate: '更新镜头', canvasScenesRename: '重命名',
      canvasScenesDelete: '删除镜头', canvasScenesMenu: '镜头操作',
      canvasScenesUntitled: '未命名镜头', canvasScenesDefaultName: '镜头 {count}',
      canvasScenesNoSelection: '请先选择节点、连线或语义分组。',
      canvasScenesCreated: '已保存镜头。', canvasScenesGroupsCreated: '已从 {count} 个分组创建镜头。',
      canvasScenesNoGroups: '请先选择一个或多个语义分组。',
      canvasScenesUpdated: '镜头已更新。', canvasScenesUnavailable: '镜头册尚未准备好。',
      canvasScenesPresentation: '镜头演示', canvasScenesPrevious: '上一镜头',
      canvasScenesRestart: '回到第一个镜头',
      canvasScenesNext: '下一镜头', canvasScenesExit: '退出演示',
      canvasTaskbook: '任务簿', canvasTaskbookHint: '管理顶级任务与任务树',
      canvasTaskbookKicker: '画布工具', canvasTaskbookClose: '关闭任务簿',
      canvasTaskbookSavedWithCanvas: '随当前 .canvas 保存',
      canvasTaskbookStructure: '结构', canvasTaskbookDetail: '详情',
      canvasTaskbookBooks: '任务簿', canvasTaskbookNew: '新建任务簿',
      canvasTaskbookEmpty: '还没有任务簿',
      canvasTaskbookEmptyHint: '新建一个任务簿，把复杂工作拆成可以开始的小步骤。',
      canvasTaskbookCollectSelected: '收录所选节点', canvasTaskbookArrange: '整理到画布',
      canvasTaskbookAddRoot: '添加任务', canvasTaskbookNoTasks: '尚无任务',
      canvasTaskbookNoTasksHint: '添加任务，或从画布收录卡片和预览节点。',
      canvasTaskbookSelectTask: '选择一项任务',
      canvasTaskbookSelectTaskHint: '在中间的任务树中选择任务以编辑详情。',
      canvasTaskbookLocate: '定位到画布', canvasTaskbookTaskTitle: '任务名称',
      canvasTaskbookTaskBody: '附加说明 · Markdown', canvasTaskbookTaskType: '节点类型',
      canvasTaskbookCard: '卡片', canvasTaskbookPreview: '预览',
      canvasTaskbookEstimate: '估时（分钟）', canvasTaskbookActual: '实际用时',
      canvasTaskbookStart: '开始', canvasTaskbookPause: '暂停',
      canvasTaskbookAddSibling: '添加同级', canvasTaskbookAddChild: '添加子级',
      canvasTaskbookOutdent: '升一级', canvasTaskbookIndent: '降一级',
      canvasTaskbookDeleteSubtree: '删除子树',
      canvasTaskbookBudget: '总预算（分钟，可选）',
      canvasTaskbookRelease: '释放任务', canvasTaskbookComplete: '完成并沉淀',
      canvasTaskbookCancel: '取消', canvasTaskbookConfirm: '确认',
      canvasTaskbookUntitled: '未命名任务簿', canvasTaskbookUntitledTask: '未命名任务',
      canvasTaskbookReorderTask: '调整任务顺序',
      canvasTaskbookNoExecutable: '尚无可执行任务',
      canvasTaskbookProgress: '{done} / {total} 个叶子任务完成',
      canvasTaskbookCreated: '已创建任务簿。',
      canvasTaskbookCollected: '已收录 {count} 个节点。',
      canvasTaskbookNothingSelected: '请先选择卡片或预览节点。',
      canvasTaskbookArrangeDone: '任务结构已整理到画布。',
      canvasTaskbookReleaseTitle: '释放“{title}”？',
      canvasTaskbookReleaseCopy: '任务簿对象将被删除，后代节点会保留并解除管理锁，工作流连线转为普通连线。',
      canvasTaskbookDeleteTitle: '删除“{title}”及其子任务？',
      canvasTaskbookDeleteCopy: '这会从画布删除整棵子树，且只能通过画布历史撤销。',
      canvasTaskbookCompleteTitle: '完成并沉淀“{title}”？',
      canvasTaskbookCompleteCopy: '计时段会写入专注记录，任务节点原地保留并归入普通分组；此终局操作不进入 Ctrl+Z。',
      canvasTaskbookCompleteUnavailable: '至少需要一个叶子任务，且所有叶子都必须完成。',
      canvasTaskbookCompleteDone: '任务簿已沉淀为完成分组。',
      canvasTaskbookSaveFailed: '任务簿沉淀失败，请稍后重试。',
      importCanvas: '导入画布', importCanvasHint: '合并另一张画布的内容',
      dualScreen: '双屏', dualScreenHint: '打开只读参考画布',
      dualNoCanvas: '选择参考画布', dualPick: '切换参考画布', dualClose: '关闭参考画布',
      dualPickerTitle: '打开参考画布', dualPickerSearch: '搜索画布标题',
      dualPickerEmpty: '没有匹配的画布。', dualLoading: '正在打开参考画布…',
      dualShortcutLead: '右侧选中对象后', dualShortcutMiddle: '，再到主画布',
      dualReady: '参考画布已打开。', dualPickFailed: '无法打开参考画布',
      dualCopied: '已复制，可在主画布按 Ctrl+V 粘贴。', dualPasting: '正在复制到主画布…',
      dualPasted: '已复制到主画布。', dualClipboardExpired: '这份参考选区已过期，请在右侧重新复制。',
      nodeMatrix: '节点矩阵', nodeMatrixHint: '批量创建规则排列的节点',
      canvasTimer: '倒计时 / 正计时', canvasTimerHint: '添加独立计时器',
      toolsAria: '画布工具：尺子、笔记坞、镜头册、任务簿、内容导入、节点矩阵与计时器',
      canvasTimerKicker: '画布工具', canvasTimerCreateTitle: '创建计时器',
      canvasTimerEditTitle: '编辑计时器', canvasTimerClose: '关闭计时器面板',
      canvasTimerType: '计时方式', canvasTimerCountdown: '倒计时', canvasTimerCountup: '正计时',
      canvasTimerName: '名称（可选）', canvasTimerNamePlaceholder: '例如：阅读',
      canvasTimerDuration: '倒计时时长', canvasTimerHours: '时', canvasTimerMinutes: '分',
      canvasTimerSeconds: '秒', canvasTimerCancel: '取消', canvasTimerCreate: '创建到画布',
      canvasTimerSave: '保存', canvasTimerResetSave: '重置并保存',
      canvasTimerInvalidDuration: '请输入 00:00:01–99:59:59 之间的时长。',
      nodeMatrixKicker: '画布工具', nodeMatrixTitle: '创建节点矩阵',
      nodeMatrixClose: '关闭节点矩阵', nodeMatrixDimensions: '矩阵尺寸',
      nodeMatrixRows: '行数', nodeMatrixColumns: '列数', nodeMatrixKind: '节点类型',
      matrixKindCard: '卡片', matrixKindSticky: '便签', matrixKindIndex: '索引',
      matrixKindPreview: '预览', matrixKindCode: '代码', nodeMatrixContent: '节点内容',
      nodeMatrixBlank: '空白', nodeMatrixSequence: '连续编号', nodeMatrixPaste: '粘贴内容',
      nodeMatrixStart: '起始', nodeMatrixPrefix: '前缀', nodeMatrixSuffix: '后缀',
      nodeMatrixOrder: '编号顺序', nodeMatrixRowFirst: '按行', nodeMatrixColumnFirst: '按列',
      nodeMatrixPasteLabel: '二维文本', nodeMatrixPasteAria: '粘贴二维文本',
      nodeMatrixPasteHint: '可直接粘贴 Excel 或表格区域；自动按列和行拆分。',
      nodeMatrixLayout: '排列', nodeMatrixSpacing: '节点间距',
      nodeMatrixCompact: '紧凑', nodeMatrixStandard: '标准', nodeMatrixLoose: '宽松',
      nodeMatrixCustom: '自定义', nodeMatrixGapX: '水平', nodeMatrixGapY: '垂直',
      nodeMatrixWidth: '统一宽度', nodeMatrixWidthAuto: '自动', nodeMatrixWidthCustom: '手动',
      nodeMatrixWidthAria: '节点宽度', nodeMatrixPreview: '布局预览',
      nodeMatrixStyleHint: '颜色、形状和文字样式继承当前画布的新建样式。',
      nodeMatrixCancel: '取消', nodeMatrixCreate: '生成到画布',
      nodeMatrixNodes: '个节点', nodeMatrixWillCreate: '将生成',
      nodeMatrixInvalid: '请检查矩阵设置。', nodeMatrixSuccess: '已生成',
      canvasLibraryKicker: '画布工具', canvasLibraryTitle: '从画布库导入',
      canvasLibraryClose: '关闭画布库', canvasLibrarySearch: '搜索画布标题',
      canvasLibraryGroups: '画布分组', canvasLibraryFiles: '可导入的画布',
      canvasLibraryRecent: '最近', canvasLibraryFavorites: '收藏',
      canvasLibraryInbox: '未分组', canvasLibraryEmpty: '这里没有可导入的画布',
      canvasLibraryEmptyHint: '当前画布不会出现在来源列表中。',
      canvasLibrarySearchEmpty: '没有匹配的画布', canvasLibrarySearchEmptyHint: '换一个标题关键词试试。',
      canvasLibraryLoading: '正在读取画布库…', canvasLibraryCancel: '取消',
      canvasLibraryConfirm: '导入到当前画布', canvasLibraryNothingSelected: '尚未选择画布',
      canvasLibrarySelected: '已选择：', canvasLibraryImporting: '正在复制内容与素材…',
      canvasLibraryLoadFailed: '读取画布库失败',
      rulerAngleTitle: '尺子角度', rulerAnglePresets: '角度预设',
      rulerAngleCustom: '自定义', rulerAngleInput: '自定义尺子角度',
      rulerAngleInvalid: '请输入整数角度', apply: '应用',
      ai: 'AI 助手', graph: '图谱', background: '背景', templates: '模板',
      exportMd: '导出 MD', exportPng: '导出 PNG', archiveConfirm: '确认归档划线节点',
      backTitle: '返回起步页', aiTitle: 'AI 助手：对话生成 / 整理笔记',
      graphTitle: '查看当前画布的节点关系图谱', backgroundTitle: '设置所有画布共用的背景外观',
      templatesTitle: '我的模板：把常用的一组节点存成模板，拖进画布即可复用',
      exportMdTitle: '把当前画布导出为一组互相关联的 Markdown 文件',
      exportPngTitle: '把整张画布导出为一张高清 PNG 图片（不含 PDF 附件）',
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
      zoomSpeed: '滚轮缩放速度',
      branchDelay: '分支预展开延迟', indexDelay: '目录出现延迟',
      tooltipHoverDelay: '提示框出现延迟', tooltipHideDelay: '提示框消失延迟',
      codeLanguage: '新建代码节点语言', penPressure: '手写笔压感总开关（含批注钢笔）',
      textSnap: '文本框拖动自动对齐', foldControls: '显示收起子节点按钮',
      canvasInspector: '启动《画布》的属性检查器',
      mindmapInspector: '启动思维导图模式的属性检查器',
      decorInspector: '启动图案模式的属性检查器',
      indexHover: '悬停弹出目录',
      selectionIndex: '框选生成索引目录', boxCreate: '空白框选创建盒子', groupCreate: '框选节点创建分组',
      taskbookArchiveSnapshot: '归档时在画布保留完成副本',
      taskbookLeafTimerButtons: '显示子任务悬停计时按钮',
      taskbookLeafTimerButtonsHint: '鼠标悬停任务簿叶子任务时，在节点左侧显示开始或暂停计时按钮（默认开启）。',
      darkLines: '深色模式线条优化',
      darkUi: '深色语义 UI 优化', autosave: '自动保存', view: '视图',
      locateLatest: '定位最近节点', space: '空格', spaceLocate: '空格键定位最近节点',
      settingsReset: '恢复默认设置',
      settingsResetConfirmTitle: '恢复默认设置？',
      settingsResetConfirmCopy: '只重置本面板；保留语言、画布内容和引导记录。',
      settingsResetAccept: '恢复默认', settingsResetDone: '已恢复', cancel: '取消',
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
      back: 'Home', canvas: 'Canvas', mindmap: 'Mind Map', patterns: 'Shapes', tools: 'Tools',
      notebookShortcut: 'Notes', taskbookShortcut: 'Tasks',
      ruler: 'Ruler', rulerHint: 'Align strokes and nodes',
      removeRuler: 'Remove Ruler',
      markdownNotebook: 'Notebook', markdownNotebookHint: 'Long-term notes and mind-map snapshots',
      markdownNotebookKicker: 'CANVAS TOOL', markdownNotebookTitle: 'Notebook',
      markdownNotebookSavedWithCanvas: 'Saved with this .canvas',
      markdownNotebookTopbarToggle: 'Add Notebook to the editor toolbar',
      taskbookTopbarToggle: 'Add Taskbook to the editor toolbar',
      markdownNotebookClose: 'Close Notebook', markdownNotebookList: 'Note list',
      markdownNotebookPages: 'Notes', markdownNotebookAdd: 'New note',
      markdownNotebookUntitled: 'Untitled note', markdownNotebookDelete: 'Delete current note',
      markdownNotebookNoteTitle: 'Note title', markdownNotebookSource: 'Markdown source',
      markdownNotebookModes: 'Edit and preview',
      markdownNotebookEdit: 'Edit', markdownNotebookPreview: 'Preview',
      markdownNotebookSourceHint: 'Headings and nested lists become mind-map nodes',
      markdownNotebookPlaceholder: '# Topic\n\n- Branch\n  - Sub-branch',
      markdownNotebookPreviewEmpty: 'Start typing to see a live preview here.',
      markdownNotebookNeedStructure: 'Add a heading or list to generate a mind map',
      markdownNotebookStyle: 'Style', markdownNotebookLayout: 'Layout',
      layoutBalanced: 'Balanced', layoutRight: 'Right', layoutLeft: 'Left',
      layoutDown: 'Down', layoutRadial: 'Radial',
      markdownNotebookAppend: 'Append Selection', markdownNotebookGenerate: 'Generate Mind Map',
      markdownNotebookNoSelection: 'No canvas selection',
      markdownNotebookSelected: '{count} selected',
      markdownNotebookIgnored: ', {count} ignored',
      markdownNotebookNodes: '{count} nodes',
      markdownNotebookDepth: '{count} levels',
      markdownNotebookEmptyError: 'Add a heading or list before generating a mind map.',
      markdownNotebookLimitError: 'A note can generate at most 200 structural nodes.',
      markdownNotebookDeleteConfirm: 'This note will be removed from the current .canvas. Existing generated mind maps will remain.',
      markdownNotebookDeleteTitle: 'Delete “{title}”?',
      markdownNotebookCancel: 'Cancel', markdownNotebookConfirmDelete: 'Delete Note',
      markdownNotebookHelp: 'Learn how mind-map generation works',
      markdownNotebookHelpClose: 'Close mind-map generation guide',
      markdownNotebookHelpEyebrow: 'ONE-TIME STRUCTURE SNAPSHOT',
      markdownNotebookHelpTitle: 'How is the mind map built?',
      markdownNotebookHelpIntro: 'Notebook reads Markdown structure only. It never creates a hidden sync between both sides.',
      markdownNotebookHelpCurrent: 'Current note',
      markdownNotebookHelpReady: 'Will create {count} nodes',
      markdownNotebookHelpReadyDetail: '{count} levels · independent after generation',
      markdownNotebookHelpEmpty: 'No generatable structure yet',
      markdownNotebookHelpRoot: 'The note title becomes the root; a matching first H1 is merged automatically.',
      markdownNotebookHelpStructure: 'H1–H6, nested lists, and task lists create structural nodes.',
      markdownNotebookHelpBody: 'Paragraphs, quotes, code, math, and tables become the nearest node body.',
      markdownNotebookHelpSnapshot: 'Generation creates an independent snapshot; later edits on either side never sync.',
      markdownNotebookHelpLimit: 'One generation can contain at most 200 structural nodes.',
      markdownNotebookHelpExample: 'Structure example',
      markdownNotebookHelpExampleMarkdown: '# Research\n- Hypothesis A\n  - Evidence',
      markdownNotebookHelpExampleTree: 'Research\n└ Hypothesis A\n  └ Evidence',
      markdownNotebookAppended: 'Canvas selection appended as a snapshot. Later edits will not sync.',
      markdownNotebookComplexSelection: 'Cross-links were flattened into a position-ordered list.',
      markdownNotebookGenerated: 'Independent mind-map snapshot created.',
      markdownNotebookUnavailable: 'Notebook is not ready yet.',
      canvasScenes: 'Scenes', canvasScenesHint: 'Save views and organize presentations',
      canvasScenesKicker: 'CANVAS TOOL', canvasScenesClose: 'Close Scenes',
      canvasScenesMoveHint: 'Drag to move Scenes; double-click to reset its position',
      canvasScenesList: 'Scene list', canvasScenesSaveView: 'Save Current View',
      canvasScenesSaveSelection: 'Capture Selection',
      canvasScenesSelectionHint: 'Select nodes or groups to create a following scene',
      canvasScenesSelectionReady: '{count} selected',
      canvasScenesIgnored: ', {count} will be ignored',
      canvasScenesEmpty: 'No scenes yet',
      canvasScenesEmptyHint: 'Save the current view, or capture content to create a chapter that follows it.',
      canvasScenesGroups: 'Create from Groups', canvasScenesPresent: 'Present',
      canvasScenesDeleted: 'Scene deleted', canvasScenesUndo: 'Undo',
      canvasScenesCamera: 'Fixed view', canvasScenesFollow: 'Follows content',
      canvasScenesMissing: 'Content missing', canvasScenesPartialMissing: 'Some content missing',
      canvasScenesUpdate: 'Update scene', canvasScenesRename: 'Rename',
      canvasScenesDelete: 'Delete scene', canvasScenesMenu: 'Scene actions',
      canvasScenesUntitled: 'Untitled scene', canvasScenesDefaultName: 'Scene {count}',
      canvasScenesNoSelection: 'Select nodes, edges, or semantic groups first.',
      canvasScenesCreated: 'Scene saved.', canvasScenesGroupsCreated: 'Created scenes from {count} groups.',
      canvasScenesNoGroups: 'Select one or more semantic groups first.',
      canvasScenesUpdated: 'Scene updated.', canvasScenesUnavailable: 'Scenes is not ready yet.',
      canvasScenesPresentation: 'Scene presentation', canvasScenesPrevious: 'Previous scene',
      canvasScenesRestart: 'Restart from the first scene',
      canvasScenesNext: 'Next scene', canvasScenesExit: 'Exit Presentation',
      canvasTaskbook: 'Taskbook', canvasTaskbookHint: 'Manage top-level tasks and task trees',
      canvasTaskbookKicker: 'CANVAS TOOL', canvasTaskbookClose: 'Close Taskbook',
      canvasTaskbookSavedWithCanvas: 'Saved with this .canvas',
      canvasTaskbookStructure: 'Structure', canvasTaskbookDetail: 'Details',
      canvasTaskbookBooks: 'Taskbooks', canvasTaskbookNew: 'New Taskbook',
      canvasTaskbookEmpty: 'No taskbooks yet',
      canvasTaskbookEmptyHint: 'Create a taskbook and turn complex work into small, startable steps.',
      canvasTaskbookCollectSelected: 'Collect Selection', canvasTaskbookArrange: 'Arrange on Canvas',
      canvasTaskbookAddRoot: 'Add Task', canvasTaskbookNoTasks: 'No tasks yet',
      canvasTaskbookNoTasksHint: 'Add a task, or collect selected card and preview nodes.',
      canvasTaskbookSelectTask: 'Select a task',
      canvasTaskbookSelectTaskHint: 'Choose a task in the tree to edit its details.',
      canvasTaskbookLocate: 'Locate on Canvas', canvasTaskbookTaskTitle: 'Task name',
      canvasTaskbookTaskBody: 'Notes · Markdown', canvasTaskbookTaskType: 'Node type',
      canvasTaskbookCard: 'Card', canvasTaskbookPreview: 'Preview',
      canvasTaskbookEstimate: 'Estimate (minutes)', canvasTaskbookActual: 'Actual time',
      canvasTaskbookStart: 'Start', canvasTaskbookPause: 'Pause',
      canvasTaskbookAddSibling: 'Add Sibling', canvasTaskbookAddChild: 'Add Child',
      canvasTaskbookOutdent: 'Outdent', canvasTaskbookIndent: 'Indent',
      canvasTaskbookDeleteSubtree: 'Delete Subtree',
      canvasTaskbookBudget: 'Total budget (minutes, optional)',
      canvasTaskbookRelease: 'Release Tasks', canvasTaskbookComplete: 'Complete & Preserve',
      canvasTaskbookCancel: 'Cancel', canvasTaskbookConfirm: 'Confirm',
      canvasTaskbookUntitled: 'Untitled Taskbook', canvasTaskbookUntitledTask: 'Untitled Task',
      canvasTaskbookReorderTask: 'Reorder task',
      canvasTaskbookNoExecutable: 'No executable tasks yet',
      canvasTaskbookProgress: '{done} / {total} leaf tasks complete',
      canvasTaskbookCreated: 'Taskbook created.',
      canvasTaskbookCollected: 'Collected {count} nodes.',
      canvasTaskbookNothingSelected: 'Select card or preview nodes first.',
      canvasTaskbookArrangeDone: 'Task structure arranged on the canvas.',
      canvasTaskbookReleaseTitle: 'Release “{title}”?',
      canvasTaskbookReleaseCopy: 'The Taskbook object will be removed. Descendant nodes remain unlocked and workflow links become ordinary links.',
      canvasTaskbookDeleteTitle: 'Delete “{title}” and its subtasks?',
      canvasTaskbookDeleteCopy: 'The entire subtree will be removed from the canvas. Canvas history is the only way to undo it.',
      canvasTaskbookCompleteTitle: 'Complete and preserve “{title}”?',
      canvasTaskbookCompleteCopy: 'Time segments will be written to Focus history. Task nodes stay in place inside a normal group. This final action is not added to Ctrl+Z.',
      canvasTaskbookCompleteUnavailable: 'Add at least one leaf task and complete every leaf first.',
      canvasTaskbookCompleteDone: 'Taskbook preserved as a completed group.',
      canvasTaskbookSaveFailed: 'Could not preserve this Taskbook. Try again.',
      importCanvas: 'Import Canvas', importCanvasHint: 'Merge content from another canvas',
      dualScreen: 'Dual Screen', dualScreenHint: 'Open a read-only reference canvas',
      dualNoCanvas: 'Choose reference canvas', dualPick: 'Switch reference canvas', dualClose: 'Close reference canvas',
      dualPickerTitle: 'Open Reference Canvas', dualPickerSearch: 'Search canvas titles',
      dualPickerEmpty: 'No matching canvases.', dualLoading: 'Opening reference canvas…',
      dualShortcutLead: 'Select on the right, copy with', dualShortcutMiddle: ', then paste on the main canvas with',
      dualReady: 'Reference canvas is ready.', dualPickFailed: 'Could not open reference canvas',
      dualCopied: 'Copied. Press Ctrl+V on the main canvas to paste.', dualPasting: 'Copying to the main canvas…',
      dualPasted: 'Copied to the main canvas.', dualClipboardExpired: 'This reference selection has expired. Copy it again on the right.',
      nodeMatrix: 'Node Matrix', nodeMatrixHint: 'Create a regular grid of nodes',
      canvasTimer: 'Countdown / Stopwatch', canvasTimerHint: 'Add an independent timer',
      toolsAria: 'Canvas tools: ruler, Notebook, Scenes, Taskbook, content import, node matrix, and timers',
      canvasTimerKicker: 'CANVAS TOOL', canvasTimerCreateTitle: 'Create Timer',
      canvasTimerEditTitle: 'Edit Timer', canvasTimerClose: 'Close timer panel',
      canvasTimerType: 'Timer Type', canvasTimerCountdown: 'Countdown', canvasTimerCountup: 'Stopwatch',
      canvasTimerName: 'Name (optional)', canvasTimerNamePlaceholder: 'For example: Reading',
      canvasTimerDuration: 'Countdown Duration', canvasTimerHours: 'hr', canvasTimerMinutes: 'min',
      canvasTimerSeconds: 'sec', canvasTimerCancel: 'Cancel', canvasTimerCreate: 'Create on Canvas',
      canvasTimerSave: 'Save', canvasTimerResetSave: 'Reset and Save',
      canvasTimerInvalidDuration: 'Enter a duration from 00:00:01 to 99:59:59.',
      nodeMatrixKicker: 'CANVAS TOOL', nodeMatrixTitle: 'Create Node Matrix',
      nodeMatrixClose: 'Close node matrix', nodeMatrixDimensions: 'Matrix Size',
      nodeMatrixRows: 'Rows', nodeMatrixColumns: 'Columns', nodeMatrixKind: 'Node Type',
      matrixKindCard: 'Card', matrixKindSticky: 'Sticky', matrixKindIndex: 'Index',
      matrixKindPreview: 'Preview', matrixKindCode: 'Code', nodeMatrixContent: 'Node Content',
      nodeMatrixBlank: 'Blank', nodeMatrixSequence: 'Sequence', nodeMatrixPaste: 'Paste',
      nodeMatrixStart: 'Start', nodeMatrixPrefix: 'Prefix', nodeMatrixSuffix: 'Suffix',
      nodeMatrixOrder: 'Numbering', nodeMatrixRowFirst: 'By Row', nodeMatrixColumnFirst: 'By Column',
      nodeMatrixPasteLabel: 'Grid Text', nodeMatrixPasteAria: 'Paste grid text',
      nodeMatrixPasteHint: 'Paste a range from Excel or another table; rows and columns are detected automatically.',
      nodeMatrixLayout: 'Layout', nodeMatrixSpacing: 'Node Spacing',
      nodeMatrixCompact: 'Compact', nodeMatrixStandard: 'Standard', nodeMatrixLoose: 'Loose',
      nodeMatrixCustom: 'Custom', nodeMatrixGapX: 'Horizontal', nodeMatrixGapY: 'Vertical',
      nodeMatrixWidth: 'Uniform Width', nodeMatrixWidthAuto: 'Auto', nodeMatrixWidthCustom: 'Manual',
      nodeMatrixWidthAria: 'Node width', nodeMatrixPreview: 'Layout Preview',
      nodeMatrixStyleHint: 'Colors, shapes, and typography inherit the current canvas creation style.',
      nodeMatrixCancel: 'Cancel', nodeMatrixCreate: 'Create on Canvas',
      nodeMatrixNodes: 'nodes', nodeMatrixWillCreate: 'Will create',
      nodeMatrixInvalid: 'Check the matrix settings.', nodeMatrixSuccess: 'Created',
      canvasLibraryKicker: 'CANVAS TOOL', canvasLibraryTitle: 'Import from Canvas Library',
      canvasLibraryClose: 'Close canvas library', canvasLibrarySearch: 'Search canvas titles',
      canvasLibraryGroups: 'Canvas groups', canvasLibraryFiles: 'Canvases available to import',
      canvasLibraryRecent: 'Recent', canvasLibraryFavorites: 'Favorites',
      canvasLibraryInbox: 'Ungrouped', canvasLibraryEmpty: 'No canvases to import here',
      canvasLibraryEmptyHint: 'The current canvas is excluded from source choices.',
      canvasLibrarySearchEmpty: 'No matching canvases', canvasLibrarySearchEmptyHint: 'Try a different title.',
      canvasLibraryLoading: 'Loading canvas library…', canvasLibraryCancel: 'Cancel',
      canvasLibraryConfirm: 'Import into Current Canvas', canvasLibraryNothingSelected: 'No canvas selected',
      canvasLibrarySelected: 'Selected: ', canvasLibraryImporting: 'Copying content and assets…',
      canvasLibraryLoadFailed: 'Could not load the canvas library',
      rulerAngleTitle: 'Ruler Angle', rulerAnglePresets: 'Angle presets',
      rulerAngleCustom: 'Custom', rulerAngleInput: 'Custom ruler angle',
      rulerAngleInvalid: 'Enter an integer angle', apply: 'Apply',
      ai: 'AI', graph: 'Graph', background: 'Background', templates: 'Templates',
      exportMd: 'Markdown', exportPng: 'PNG', archiveConfirm: 'Confirm Archive',
      backTitle: 'Back to home', aiTitle: 'AI Assistant: generate and organize notes',
      graphTitle: 'View relationships between nodes on this canvas',
      backgroundTitle: 'Set the background shared by all canvases',
      templatesTitle: 'Reuse saved groups of nodes as templates',
      exportMdTitle: 'Export this canvas as linked Markdown files',
      exportPngTitle: 'Export the full canvas as a high-resolution PNG (PDF attachments excluded)',
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
      zoomSpeed: 'Scroll zoom speed',
      branchDelay: 'Branch preview delay', indexDelay: 'Index preview delay',
      tooltipHoverDelay: 'Tooltip delay', tooltipHideDelay: 'Tooltip hide delay',
      codeLanguage: 'Default code language', penPressure: 'Pen pressure (including annotations)',
      textSnap: 'Align text boxes while dragging', foldControls: 'Show branch controls',
      canvasInspector: 'Enable the Canvas inspector',
      mindmapInspector: 'Enable inspector in Mind Map mode',
      decorInspector: 'Enable inspector in Shapes mode',
      indexHover: 'Preview index on hover',
      selectionIndex: 'Offer index from selection', boxCreate: 'Box from empty selection', groupCreate: 'Group selected nodes',
      taskbookArchiveSnapshot: 'Keep a completed canvas copy when archiving',
      taskbookLeafTimerButtons: 'Show task timer button on hover',
      taskbookLeafTimerButtonsHint: 'Show a start or pause timer button to the left of Taskbook leaf tasks on hover (enabled by default).',
      darkLines: 'Optimize lines on dark backgrounds',
      darkUi: 'Dark semantic UI', autosave: 'Autosave', view: 'View',
      locateLatest: 'Locate latest node', space: 'Space', spaceLocate: 'Space locates latest node',
      settingsReset: 'Restore Default Settings',
      settingsResetConfirmTitle: 'Restore default settings?',
      settingsResetConfirmCopy: 'Only this panel resets. Language, canvas content, and onboarding stay untouched.',
      settingsResetAccept: 'Reset', settingsResetDone: 'Restored', cancel: 'Cancel',
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
    sw.querySelectorAll('.editor-mode-btn[data-mode]').forEach((button) => {
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
    document.querySelectorAll('[data-editor-i18n-placeholder]').forEach((element) => {
      element.setAttribute('placeholder', toolbarCopy(element.dataset.editorI18nPlaceholder));
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

  // 需要在缺少 file 参数的空壳页也可安全读取；后续加载成功后再写入真实画布。
  // 放在 opening 回调之前，避免空壳页提前结束初始化时触发 let 的暂时性死区。
  let canvasData = null;

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
    const btns = sw.querySelectorAll('.editor-mode-btn[data-mode]');
    const toolsButton = sw.querySelector('[data-action="tools"]');
    const slider = sw.querySelector('[data-role="mode-slider"]');
    const hoverLine = sw.querySelector('[data-role="mode-hover-line"]');
    let sliderReady = false;
    // 把黑色滑块移到当前激活按钮处；首次（与窗口尺寸变化）瞬时定位，之后滑动过渡。
    function placeSlider(animate) {
      if (!slider) return;
      const active = sw.querySelector('.editor-mode-btn[data-mode].active');
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
      const active = sw.querySelector('.editor-mode-btn[data-mode].active');
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
    if (toolsButton) {
      const leaveModePreview = () => {
        sw.classList.remove('mode-hovering');
        restoreHoverLine();
      };
      toolsButton.addEventListener('mouseenter', leaveModePreview);
      toolsButton.addEventListener('focus', leaveModePreview);
    }
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

  // ── 临时工具入口：不参与 canvas:mode / 子模式持久化 ──
  (function setupToolsMenu() {
    const button = document.querySelector('[data-action="tools"]');
    const pop = document.querySelector('[data-role="tools-pop"]');
    const useRuler = pop && pop.querySelector('[data-action="use-ruler"]');
    const removeRuler = pop && pop.querySelector('[data-action="remove-ruler"]');
    const markdownNotebook = pop && pop.querySelector('[data-action="markdown-notebook"]');
    const canvasScenes = pop && pop.querySelector('[data-action="canvas-scenes"]');
    const canvasTaskbook = pop && pop.querySelector('[data-action="canvas-taskbook"]');
    const importCanvas = pop && pop.querySelector('[data-action="import-canvas"]');
    const dualScreen = pop && pop.querySelector('[data-action="dual-screen"]');
    const nodeMatrix = pop && pop.querySelector('[data-action="node-matrix"]');
    const canvasTimer = pop && pop.querySelector('[data-action="canvas-timer"]');
    const importLibrary = document.querySelector('[data-role="canvas-import-library"]');
    const importSearch = importLibrary && importLibrary.querySelector('[data-role="canvas-import-search"]');
    const importGroups = importLibrary && importLibrary.querySelector('[data-role="canvas-import-groups"]');
    const importFiles = importLibrary && importLibrary.querySelector('[data-role="canvas-import-files"]');
    const importEmpty = importLibrary && importLibrary.querySelector('[data-role="canvas-import-empty"]');
    const importLoading = importLibrary && importLibrary.querySelector('[data-role="canvas-import-loading"]');
    const importError = importLibrary && importLibrary.querySelector('[data-role="canvas-import-error"]');
    const importSelection = importLibrary && importLibrary.querySelector('[data-role="canvas-import-selection"]');
    const importConfirm = importLibrary && importLibrary.querySelector('[data-action="confirm-canvas-import"]');
    const importCancel = importLibrary && importLibrary.querySelector('[data-action="cancel-canvas-import"]');
    const importClose = importLibrary && importLibrary.querySelector('[data-action="close-canvas-import-library"]');
    if (!button || !pop || !useRuler || !removeRuler || !markdownNotebook || !canvasScenes
        || !canvasTaskbook
        || !importCanvas || !nodeMatrix || !canvasTimer) return;
    let importState = null;
    let importView = 'recent';
    let importSelectedId = '';
    let importBusy = false;
    let importRequestToken = 0;
    let importReturnFocus = null;

    function editorIsEnglish() {
      return toolbarLanguage === 'en';
    }

    function importFormatSize(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '';
      if (value < 1024) return Math.round(value) + ' B';
      if (value < 1048576) {
        const kb = value / 1024;
        return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
      }
      return (value / 1048576).toFixed(1) + ' MB';
    }

    function importFormatTime(iso) {
      const then = new Date(iso || '');
      if (Number.isNaN(then.getTime())) return '';
      const diff = Date.now() - then.getTime();
      const minute = 60000;
      const hour = minute * 60;
      const day = hour * 24;
      if (diff < minute) return editorIsEnglish() ? 'Just now' : '刚刚';
      if (diff < hour) {
        const value = Math.max(1, Math.floor(diff / minute));
        return editorIsEnglish() ? value + ' min ago' : value + ' 分钟前';
      }
      if (diff < day) {
        const value = Math.max(1, Math.floor(diff / hour));
        return editorIsEnglish() ? value + ' hr ago' : value + ' 小时前';
      }
      if (diff < day * 7) {
        const value = Math.max(1, Math.floor(diff / day));
        return editorIsEnglish()
          ? value + (value === 1 ? ' day ago' : ' days ago')
          : value + ' 天前';
      }
      return then.getFullYear() + '-'
        + String(then.getMonth() + 1).padStart(2, '0') + '-'
        + String(then.getDate()).padStart(2, '0');
    }

    function importRank(file, field) {
      const value = Number(file && file[field]);
      return Number.isFinite(value) ? value : 0;
    }

    function importOpenedAt(file) {
      const value = Date.parse(file && file.lastOpenedAt || '');
      return Number.isFinite(value) ? value : 0;
    }

    function importByRank(field) {
      return (a, b) => importRank(a, field) - importRank(b, field)
        || importOpenedAt(b) - importOpenedAt(a)
        || String(a.id || '').localeCompare(String(b.id || ''));
    }

    function importGroupMap() {
      return new Map(((importState && importState.groups) || [])
        .map((group) => [String(group.id || ''), group]));
    }

    function importGroupName(file) {
      const groups = importGroupMap();
      const group = groups.get(String(file && file.groupId || ''));
      return group ? String(group.name || '') : toolbarCopy('canvasLibraryInbox');
    }

    function importViewFiles() {
      if (!importState) return [];
      const files = Array.isArray(importState.files) ? importState.files.slice() : [];
      const query = String(importSearch && importSearch.value || '').trim().toLocaleLowerCase();
      if (query) {
        return files
          .filter((file) => String(file.title || '').toLocaleLowerCase().includes(query))
          .sort((a, b) => importOpenedAt(b) - importOpenedAt(a)
            || String(a.id || '').localeCompare(String(b.id || '')));
      }
      if (importView === 'favorites') {
        return files.filter((file) => file.favorite).sort(importByRank('favoriteRank'));
      }
      if (importView === 'inbox') {
        const validGroups = new Set(((importState && importState.groups) || [])
          .map((group) => String(group.id || '')));
        return files
          .filter((file) => !file.groupId || !validGroups.has(String(file.groupId)))
          .sort(importByRank('groupRank'));
      }
      if (importView.indexOf('group:') === 0) {
        const groupId = importView.slice(6);
        return files
          .filter((file) => String(file.groupId || '') === groupId)
          .sort(importByRank('groupRank'));
      }
      return files
        .sort((a, b) => importOpenedAt(b) - importOpenedAt(a)
          || String(a.id || '').localeCompare(String(b.id || '')))
        .slice(0, Number(importState.recentLimit) || 30);
    }

    function importViewCount(view) {
      if (!importState) return 0;
      const files = importState.files || [];
      if (view === 'recent') return Math.min(files.length, Number(importState.recentLimit) || 30);
      if (view === 'favorites') return files.filter((file) => file.favorite).length;
      if (view === 'inbox') {
        const valid = new Set((importState.groups || []).map((group) => String(group.id || '')));
        return files.filter((file) => !file.groupId || !valid.has(String(file.groupId))).length;
      }
      const groupId = view.slice(6);
      return files.filter((file) => String(file.groupId || '') === groupId).length;
    }

    function setImportError(message) {
      if (!importError) return;
      importError.textContent = message || '';
      importError.hidden = !message;
    }

    function setImportBusy(next) {
      importBusy = !!next;
      if (!importLibrary) return;
      importLibrary.dataset.busy = importBusy ? 'true' : 'false';
      if (importConfirm) importConfirm.disabled = importBusy || !importSelectedId;
      if (importSelection) {
        importSelection.textContent = importBusy
          ? toolbarCopy('canvasLibraryImporting')
          : (importSelectedId
              ? toolbarCopy('canvasLibrarySelected') + (
                (importState.files || []).find((file) => String(file.id) === importSelectedId) || {}
              ).title
              : toolbarCopy('canvasLibraryNothingSelected'));
      }
    }

    function renderImportGroups() {
      if (!importGroups || !importState) return;
      importGroups.innerHTML = '';
      const searching = !!String(importSearch && importSearch.value || '').trim();
      const entries = [
        { view: 'recent', label: toolbarCopy('canvasLibraryRecent') },
        { view: 'favorites', label: toolbarCopy('canvasLibraryFavorites') },
        { view: 'inbox', label: toolbarCopy('canvasLibraryInbox') },
      ].concat((importState.groups || []).map((group) => ({
        view: 'group:' + group.id,
        label: String(group.name || ''),
      })));
      entries.forEach((entry) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'canvas-import-library-group';
        item.classList.toggle('active', !searching && entry.view === importView);
        item.setAttribute(
          'aria-pressed',
          !searching && entry.view === importView ? 'true' : 'false',
        );
        item.dataset.importView = entry.view;
        const name = document.createElement('span');
        name.textContent = entry.label;
        const count = document.createElement('span');
        count.textContent = String(importViewCount(entry.view));
        item.append(name, count);
        item.addEventListener('click', () => {
          if (importBusy) return;
          importView = entry.view;
          if (importSearch) importSearch.value = '';
          importSelectedId = '';
          renderImportLibrary();
        });
        importGroups.appendChild(item);
      });
    }

    function selectImportFile(fileId, focus) {
      if (importBusy || !importState) return;
      importSelectedId = String(fileId || '');
      importFiles.querySelectorAll('.canvas-import-library-file').forEach((item) => {
        const selected = item.dataset.sourceId === importSelectedId;
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected && focus) item.focus();
      });
      setImportBusy(false);
    }

    function renderImportFiles() {
      if (!importFiles || !importState) return;
      importFiles.innerHTML = '';
      const files = importViewFiles();
      const query = String(importSearch && importSearch.value || '').trim();
      if (!files.some((file) => String(file.id) === importSelectedId)) importSelectedId = '';
      files.forEach((file) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'canvas-import-library-file';
        item.dataset.sourceId = String(file.id || '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(file.id) === importSelectedId ? 'true' : 'false');
        const title = document.createElement('span');
        title.className = 'canvas-import-library-file-title';
        title.textContent = String(file.title || (editorIsEnglish() ? 'Untitled' : '未命名'));
        title.setAttribute('data-user-content', '');
        const group = document.createElement('span');
        group.className = 'canvas-import-library-file-group';
        group.textContent = query ? importGroupName(file) : '';
        const meta = document.createElement('span');
        meta.className = 'canvas-import-library-file-meta';
        const when = document.createElement('span');
        when.textContent = importFormatTime(file.lastOpenedAt);
        const size = document.createElement('span');
        size.textContent = importFormatSize(file.sizeBytes);
        if (when.textContent) meta.appendChild(when);
        if (size.textContent) meta.appendChild(size);
        item.append(title, group, meta);
        item.addEventListener('click', () => selectImportFile(file.id, false));
        item.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (importSelectedId === String(file.id)) confirmCanvasImport();
          else selectImportFile(file.id, false);
        });
        importFiles.appendChild(item);
      });
      const emptyTitle = importEmpty && importEmpty.querySelector('strong');
      const emptyHint = importEmpty && importEmpty.querySelector('span');
      if (emptyTitle) {
        emptyTitle.textContent = toolbarCopy(
          query ? 'canvasLibrarySearchEmpty' : 'canvasLibraryEmpty',
        );
      }
      if (emptyHint) {
        emptyHint.textContent = toolbarCopy(
          query ? 'canvasLibrarySearchEmptyHint' : 'canvasLibraryEmptyHint',
        );
      }
      if (importEmpty) importEmpty.hidden = files.length > 0;
      setImportBusy(importBusy);
    }

    function renderImportLibrary() {
      if (!importState) return;
      renderImportGroups();
      renderImportFiles();
    }

    function syncImportLibraryLanguage() {
      if (!importLibrary) return;
      importLibrary.lang = toolbarLanguage;
      if (importSearch) {
        importSearch.placeholder = toolbarCopy('canvasLibrarySearch');
        importSearch.setAttribute('aria-label', toolbarCopy('canvasLibrarySearch'));
        importSearch.removeAttribute('title');
      }
      if (importGroups) importGroups.setAttribute('aria-label', toolbarCopy('canvasLibraryGroups'));
      if (importFiles) importFiles.setAttribute('aria-label', toolbarCopy('canvasLibraryFiles'));
      if (importState) renderImportLibrary();
    }

    function closeImportLibrary(restoreFocus) {
      if (!importLibrary || importBusy || importLibrary.hidden
          || importLibrary.classList.contains('tool-layer-leaving')) return false;
      importRequestToken += 1;
      const focusTarget = restoreFocus !== false && importReturnFocus && importReturnFocus.isConnected
        ? importReturnFocus : null;
      return concealToolLayer(importLibrary, () => {
        importLibrary.removeAttribute('data-busy');
        importState = null;
        importSelectedId = '';
        setImportError('');
        if (focusTarget) focusTarget.focus();
        importReturnFocus = null;
      }, 210);
    }

    function applyImportLibrarySnapshot(entry, initializeView) {
      const json = entry && entry.payload || {};
      importState = {
        groups: Array.isArray(json.groups) ? json.groups : [],
        files: Array.isArray(json.files) ? json.files : [],
        recentLimit: Number(json.recentLimit) || 30,
      };
      if (initializeView) {
        const groupIds = new Set(importState.groups.map((group) => String(group.id || '')));
        if (json.currentGroupId === '__inbox__') importView = 'inbox';
        else if (json.currentGroupId && groupIds.has(String(json.currentGroupId))) {
          importView = 'group:' + json.currentGroupId;
        }
      }
      if (importLoading) importLoading.hidden = true;
      renderImportLibrary();
    }

    async function openImportLibrary() {
      if (!importLibrary || EMBED) return;
      importReturnFocus = button;
      revealToolLayer(importLibrary);
      importSelectedId = '';
      importView = 'recent';
      if (importSearch) importSearch.value = '';
      if (importEmpty) importEmpty.hidden = true;
      if (importConfirm) importConfirm.disabled = true;
      setImportError('');
      syncImportLibraryLanguage();
      const token = ++importRequestToken;
      const cached = managedCanvasLibrarySession.peek(filePath);
      let displayedSignature = '';
      if (cached) {
        displayedSignature = cached.signature;
        applyImportLibrarySnapshot(cached, true);
      } else {
        importState = null;
        if (importFiles) importFiles.innerHTML = '';
        if (importGroups) importGroups.innerHTML = '';
        if (importLoading) importLoading.hidden = false;
      }
      requestAnimationFrame(() => { if (importSearch) importSearch.focus(); });
      try {
        const fresh = await managedCanvasLibrarySession.refresh(filePath);
        if (token !== importRequestToken || importLibrary.hidden) return;
        if (fresh.signature !== displayedSignature) {
          applyImportLibrarySnapshot(fresh, !displayedSignature);
        }
      } catch (error) {
        if (token !== importRequestToken || importLibrary.hidden) return;
        if (cached) return;
        if (importLoading) importLoading.hidden = true;
        if (importEmpty) importEmpty.hidden = true;
        setImportError(
          toolbarCopy('canvasLibraryLoadFailed')
          + (editorIsEnglish() ? ': ' : '：')
          + error.message,
        );
      }
    }

    async function confirmCanvasImport() {
      if (importBusy || !importSelectedId || !window.CanvasModule
          || typeof window.CanvasModule.importManagedCanvas !== 'function') return;
      setImportError('');
      setImportBusy(true);
      try {
        await window.CanvasModule.importManagedCanvas(importSelectedId);
        setImportBusy(false);
        closeImportLibrary(false);
      } catch (error) {
        setImportBusy(false);
        setImportError(
          error && (error.displayMessage || error.message)
            ? (error.displayMessage || error.message)
            : toolbarCopy('canvasLibraryLoadFailed'),
        );
      }
    }

    function rulerExists() {
      return !!(window.CanvasModule
        && typeof window.CanvasModule.hasRuler === 'function'
        && window.CanvasModule.hasRuler());
    }
    function sync() {
      const exists = rulerExists();
      removeRuler.hidden = !exists;
      button.setAttribute('aria-label', toolbarCopy('toolsAria'));
      pop.setAttribute('aria-label', toolbarCopy('toolsAria'));
    }
    function close() {
      if (pop.hidden || pop.classList.contains('tool-layer-leaving')) return;
      button.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
      concealToolLayer(pop, () => {
        document.body.classList.remove('editor-tools-open');
      }, 180);
    }
    function position() {
      const rect = button.getBoundingClientRect();
      const left = Math.max(12, Math.min(
        window.innerWidth - pop.offsetWidth - 12,
        rect.left,
      ));
      pop.style.left = left + 'px';
      pop.style.top = (rect.bottom + 8) + 'px';
    }
    function open() {
      sync();
      revealToolLayer(pop);
      position();
      button.classList.add('open');
      document.body.classList.add('editor-tools-open');
      button.setAttribute('aria-expanded', 'true');
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (pop.hidden) open(); else close();
    });
    useRuler.addEventListener('click', () => {
      if (window.EditorShell && typeof window.EditorShell.setMode === 'function') {
        window.EditorShell.setMode('normal');
      }
      if (window.CanvasModule) {
        if (rulerExists() && typeof window.CanvasModule.focusRuler === 'function') {
          window.CanvasModule.focusRuler();
        } else if (typeof window.CanvasModule.ensureRuler === 'function') {
          window.CanvasModule.ensureRuler();
        }
      }
      close();
    });
    removeRuler.addEventListener('click', () => {
      if (window.CanvasModule && typeof window.CanvasModule.removeRuler === 'function') {
        window.CanvasModule.removeRuler();
      }
      close();
    });
    markdownNotebook.addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('editor:open-markdown-notebook'));
    });
    canvasScenes.addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('editor:open-canvas-scenes'));
    });
    canvasTaskbook.addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('editor:open-taskbook'));
    });
    importCanvas.addEventListener('click', () => {
      close();
      openImportLibrary();
    });
    if (dualScreen) dualScreen.addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('editor:open-dual-screen'));
    });
    nodeMatrix.addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('editor:open-node-matrix'));
    });
    canvasTimer.addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('editor:open-canvas-timer'));
    });
    if (importSearch) {
      importSearch.addEventListener('input', () => {
        if (!importState || importBusy) return;
        importSelectedId = '';
        renderImportLibrary();
      });
      importSearch.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && importSelectedId) {
          event.preventDefault();
          confirmCanvasImport();
        }
      });
    }
    if (importConfirm) importConfirm.addEventListener('click', confirmCanvasImport);
    if (importCancel) importCancel.addEventListener('click', () => closeImportLibrary(true));
    if (importClose) importClose.addEventListener('click', () => closeImportLibrary(true));
    if (importLibrary) {
      importLibrary.addEventListener('mousedown', (event) => {
        if (event.target === importLibrary) closeImportLibrary(true);
      });
      importLibrary.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          if (!importBusy) {
            event.preventDefault();
            closeImportLibrary(true);
          }
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...importLibrary.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].filter((element) => !element.hidden && element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }
    document.addEventListener('mousedown', (event) => {
      if (!pop.hidden && !pop.contains(event.target) && !button.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (!pop.hidden && event.key === 'Escape') {
        event.preventDefault();
        close();
        button.focus();
      }
    });
    document.addEventListener('editor:modechange', () => {
      close();
      closeImportLibrary(false);
    });
    document.addEventListener('editor:languagechange', () => {
      sync();
      syncImportLibraryLanguage();
    });
    document.addEventListener('canvas:rulerchange', sync);
    document.addEventListener('editor:canvasready', sync);
    window.addEventListener('resize', () => { if (!pop.hidden) position(); });
    sync();
  })();

  (function setupDualScreen() {
    if (EMBED) return;
    const pane = document.querySelector('[data-role="dual-pane"]');
    const resizer = document.querySelector('[data-role="dual-resizer"]');
    const sharedBackground = document.querySelector('[data-role="dual-shared-background"]');
    const frameWrap = document.querySelector('[data-role="dual-frame-wrap"]');
    const title = document.querySelector('[data-role="dual-title"]');
    const titleButton = document.querySelector('[data-action="dual-open-picker"]');
    const closeButton = document.querySelector('[data-action="close-dual-screen"]');
    const picker = document.querySelector('[data-role="dual-picker"]');
    const pickerClose = document.querySelector('[data-action="dual-close-picker"]');
    const search = document.querySelector('[data-role="dual-search"]');
    const filesShell = document.querySelector('[data-role="dual-files-shell"]');
    const filesList = document.querySelector('[data-role="dual-files"]');
    const scrollRail = document.querySelector('[data-role="dual-scrollbar"]');
    const scrollThumb = document.querySelector('[data-role="dual-scrollbar-thumb"]');
    const pickerState = document.querySelector('[data-role="dual-picker-state"]');
    const copyShortcut = document.querySelector('[data-role="dual-copy-shortcut"]');
    const pasteShortcut = document.querySelector('[data-role="dual-paste-shortcut"]');
    const toast = document.querySelector('[data-role="dual-toast"]');
    if (!pane || !resizer || !frameWrap || !picker || !search || !filesList) return;

    const macPlatform = /Mac|iPhone|iPad|iPod/i.test(
      String(navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || ''),
    );
    if (copyShortcut) copyShortcut.textContent = macPlatform ? '⌘C' : 'Ctrl+C';
    if (pasteShortcut) pasteShortcut.textContent = macPlatform ? '⌘V' : 'Ctrl+V';

    let libraryFiles = [];
    let filteredFiles = [];
    let activeIndex = 0;
    let activeFrame = null;
    let pendingFrame = null;
    let loadToken = 0;
    let rightInfo = null;
    let dualClipboard = null;
    let toastTimer = 0;
    let pickerRequest = 0;
    let pickerEntranceTimer = 0;
    let scrollbarFrame = 0;
    let scrollbarTimer = 0;
    let scrollbarDrag = null;
    const scrollbarMetrics = { travel: 0, maxScroll: 0 };

    function showDualToast(message, isError) {
      if (!toast) return;
      window.clearTimeout(toastTimer);
      toast.textContent = String(message || '');
      toast.classList.toggle('error', !!isError);
      if (!message) {
        concealToolLayer(toast, null, 140);
        return;
      }
      revealToolLayer(toast);
      toastTimer = window.setTimeout(() => concealToolLayer(toast, null, 140), 2600);
    }

    function showMainToast(message, isError) {
      const fn = window.CanvasModule && window.CanvasModule.showToast;
      if (typeof fn === 'function') fn(String(message || ''), !!isError);
      else showDualToast(message, isError);
    }

    function updateDualScrollbar() {
      scrollbarFrame = 0;
      if (!filesShell || !scrollRail || !scrollThumb || picker.hidden) return;
      const clientHeight = filesList.clientHeight;
      const scrollHeight = filesList.scrollHeight;
      const railHeight = scrollRail.clientHeight;
      const scrollable = clientHeight > 0 && railHeight > 0 && scrollHeight > clientHeight + 1;
      scrollRail.classList.toggle('is-scrollable', scrollable);
      if (!scrollable) {
        scrollRail.classList.remove('is-active', 'is-dragging');
        scrollbarMetrics.travel = 0;
        scrollbarMetrics.maxScroll = 0;
        return;
      }
      const thumbHeight = Math.min(railHeight, Math.max(32, railHeight * (clientHeight / scrollHeight)));
      const travel = Math.max(0, railHeight - thumbHeight);
      const maxScroll = Math.max(1, scrollHeight - clientHeight);
      const top = travel * Math.max(0, Math.min(1, filesList.scrollTop / maxScroll));
      scrollThumb.style.height = Math.round(thumbHeight) + 'px';
      scrollThumb.style.transform = 'translate3d(0,' + Math.round(top) + 'px,0)';
      scrollbarMetrics.travel = travel;
      scrollbarMetrics.maxScroll = maxScroll;
    }

    function queueDualScrollbarUpdate() {
      if (!scrollbarFrame) scrollbarFrame = window.requestAnimationFrame(updateDualScrollbar);
    }

    function markDualScrollbarActive(keepVisible) {
      if (!scrollRail || !scrollRail.classList.contains('is-scrollable')) return;
      window.clearTimeout(scrollbarTimer);
      scrollRail.classList.add('is-active');
      if (!keepVisible && !scrollbarDrag) {
        scrollbarTimer = window.setTimeout(() => scrollRail.classList.remove('is-active'), 800);
      }
    }

    function moveDualScrollbar(clientY) {
      if (!scrollbarDrag || !scrollbarMetrics.travel) return;
      const rect = scrollRail.getBoundingClientRect();
      const top = Math.max(0, Math.min(
        scrollbarMetrics.travel,
        clientY - rect.top - scrollbarDrag.pointerOffset,
      ));
      filesList.scrollTop = (top / scrollbarMetrics.travel) * scrollbarMetrics.maxScroll;
      markDualScrollbarActive(true);
    }

    function finishDualScrollbarDrag(event) {
      if (!scrollbarDrag) return;
      if (event && event.pointerId != null && event.pointerId !== scrollbarDrag.pointerId) return;
      const pointerId = scrollbarDrag.pointerId;
      scrollbarDrag = null;
      window.removeEventListener('pointermove', onDualScrollbarDragMove);
      window.removeEventListener('pointerup', finishDualScrollbarDrag);
      window.removeEventListener('pointercancel', finishDualScrollbarDrag);
      try { scrollRail.releasePointerCapture(pointerId); } catch (_) {}
      scrollRail.classList.remove('is-dragging');
      markDualScrollbarActive(false);
    }

    function onDualScrollbarDragMove(event) {
      if (!scrollbarDrag || event.pointerId !== scrollbarDrag.pointerId) return;
      event.preventDefault();
      moveDualScrollbar(event.clientY);
    }

    function startDualScrollbarDrag(event) {
      if (event.button !== 0 || scrollbarDrag || !scrollRail.classList.contains('is-scrollable')) return;
      event.preventDefault();
      event.stopPropagation();
      updateDualScrollbar();
      const thumbRect = scrollThumb.getBoundingClientRect();
      scrollbarDrag = {
        pointerId: event.pointerId,
        pointerOffset: event.target === scrollThumb
          ? event.clientY - thumbRect.top
          : thumbRect.height / 2,
      };
      try { scrollRail.setPointerCapture(event.pointerId); } catch (_) {}
      scrollRail.classList.add('is-active', 'is-dragging');
      window.addEventListener('pointermove', onDualScrollbarDragMove, { passive: false });
      window.addEventListener('pointerup', finishDualScrollbarDrag);
      window.addEventListener('pointercancel', finishDualScrollbarDrag);
      if (event.target !== scrollThumb) moveDualScrollbar(event.clientY);
    }

    function dualLibraryFiles(entry) {
      const json = entry && entry.payload || {};
      return (Array.isArray(json.files) ? json.files : []).slice().sort((a, b) =>
        String(b.lastOpenedAt || '').localeCompare(String(a.lastOpenedAt || '')));
    }

    function renderDualPicker(options) {
      const staggerEnter = !!(options && options.staggerEnter) && !prefersReducedToolMotion();
      const reuseExisting = !!(options && options.reuseExisting);
      const term = search.value.trim().toLocaleLowerCase();
      filteredFiles = libraryFiles.filter((file) =>
        !term || String(file.title || '').toLocaleLowerCase().includes(term));
      activeIndex = Math.max(0, Math.min(activeIndex, filteredFiles.length - 1));
      let buttons = [...filesList.querySelectorAll('.canvas-dual-file')];
      const canReuse = reuseExisting && buttons.length === filteredFiles.length
        && buttons.every((button, index) =>
          button.dataset.sourceId === String(filteredFiles[index] && filteredFiles[index].id || ''));
      if (!canReuse) {
        filesList.innerHTML = '';
        buttons = filteredFiles.map((file, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'canvas-dual-file';
          button.dataset.sourceId = String(file.id || '');
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
          if (rightInfo && rightInfo.id === String(file.id || '')) button.classList.add('current');
          const name = document.createElement('span');
          name.textContent = String(file.title || (toolbarLanguage === 'en' ? 'Untitled' : '未命名'));
          button.appendChild(name);
          button.addEventListener('mouseenter', () => {
            activeIndex = index;
            syncPickerSelection();
          });
          button.addEventListener('click', () => openRightCanvas(file));
          filesList.appendChild(button);
          return button;
        });
      } else {
        buttons.forEach((button, index) => {
          const file = filteredFiles[index];
          button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
          button.classList.toggle('current', !!(
            rightInfo && rightInfo.id === String(file && file.id || '')
          ));
          const name = button.querySelector('span');
          if (name) name.textContent = String(
            file && file.title || (toolbarLanguage === 'en' ? 'Untitled' : '未命名'),
          );
        });
      }
      buttons.forEach((button) => {
        button.classList.remove('is-entering');
        button.style.removeProperty('--dual-file-delay');
        button.onanimationend = null;
      });
      if (staggerEnter && buttons.length) {
        void filesList.offsetWidth;
        buttons.slice(0, 14).forEach((button, index) => {
          button.classList.add('is-entering');
          button.style.setProperty('--dual-file-delay', Math.min(index * 22, 154) + 'ms');
          button.onanimationend = () => {
            button.classList.remove('is-entering');
            button.style.removeProperty('--dual-file-delay');
            button.onanimationend = null;
          };
        });
      }
      if (pickerState) {
        pickerState.textContent = filteredFiles.length ? '' : toolbarCopy('dualPickerEmpty');
      }
      queueDualScrollbarUpdate();
    }

    function syncPickerSelection() {
      [...filesList.querySelectorAll('.canvas-dual-file')].forEach((button, index) => {
        button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
      });
    }

    function playDualPickerEntrance() {
      window.clearTimeout(pickerEntranceTimer);
      picker.classList.remove('content-entering');
      if (prefersReducedToolMotion()) return;
      void picker.offsetWidth;
      picker.classList.add('content-entering');
      pickerEntranceTimer = window.setTimeout(() => {
        picker.classList.remove('content-entering');
      }, 480);
    }

    async function showDualPicker() {
      const request = ++pickerRequest;
      revealToolLayer(picker);
      playDualPickerEntrance();
      pane.classList.add('picker-open');
      if (titleButton) titleButton.setAttribute('aria-expanded', 'true');
      search.value = '';
      filesList.scrollTop = 0;
      filesList.setAttribute('aria-busy', 'true');
      if (pickerState) pickerState.textContent = '';
      const cached = managedCanvasLibrarySession.peek(filePath);
      let displayedSignature = '';
      if (cached) {
        displayedSignature = cached.signature;
        libraryFiles = dualLibraryFiles(cached);
        const currentIndex = rightInfo
          ? libraryFiles.findIndex((file) => String(file.id || '') === rightInfo.id)
          : -1;
        activeIndex = currentIndex >= 0 ? currentIndex : 0;
        renderDualPicker({ staggerEnter: true, reuseExisting: true });
      } else {
        libraryFiles = [];
        filteredFiles = [];
        filesList.innerHTML = '';
      }
      queueDualScrollbarUpdate();
      window.requestAnimationFrame(() => search.focus());
      try {
        const fresh = await managedCanvasLibrarySession.refresh(filePath);
        if (request !== pickerRequest || picker.hidden) return;
        if (fresh.signature !== displayedSignature) {
          libraryFiles = dualLibraryFiles(fresh);
          const currentIndex = rightInfo
            ? libraryFiles.findIndex((file) => String(file.id || '') === rightInfo.id)
            : -1;
          activeIndex = currentIndex >= 0 ? currentIndex : 0;
          renderDualPicker({ staggerEnter: !displayedSignature, reuseExisting: false });
        }
      } catch (error) {
        if (request !== pickerRequest || picker.hidden) return;
        if (cached) return;
        if (pickerState) pickerState.textContent = toolbarCopy('dualPickFailed') + ': ' + error.message;
        queueDualScrollbarUpdate();
      } finally {
        if (request === pickerRequest) filesList.removeAttribute('aria-busy');
      }
    }

    function hideDualPicker() {
      pickerRequest += 1;
      window.clearTimeout(pickerEntranceTimer);
      picker.classList.remove('content-entering');
      pane.classList.remove('picker-open');
      if (titleButton) titleButton.setAttribute('aria-expanded', 'false');
      concealToolLayer(picker, null, 210);
    }

    function appearancePayload() {
      const readVars = (element, names) => {
        const style = element ? window.getComputedStyle(element) : null;
        const output = {};
        names.forEach((name) => { output[name] = style ? style.getPropertyValue(name).trim() : ''; });
        return output;
      };
      const pageStyle = window.getComputedStyle(document.body);
      const surfaceMode = document.body.classList.contains('immersive-background')
        ? 'immersive'
        : (viewportEl && viewportEl.classList.contains('image-background')
          ? 'image'
          : (viewportEl && viewportEl.classList.contains('flowing-background') ? 'flowing' : 'plain'));
      return {
        sharedBackground: true,
        tone: document.body.dataset.backgroundTone === 'dark' ? 'dark' : 'light',
        baseFill: pageStyle.backgroundColor || (document.body.dataset.backgroundTone === 'dark' ? '#121815' : '#f1f0ed'),
        guideType: viewportEl && viewportEl.dataset.guideType || 'none',
        surfaceMode: surfaceMode,
        viewportVars: readVars(viewportEl, [
          '--canvas-background-fill', '--canvas-background-image', '--canvas-background-opacity',
          '--canvas-background-scale', '--canvas-background-position',
        ]),
        backgroundVars: readVars(immersiveBackgroundEl, [
          '--immersive-background-image', '--immersive-background-opacity',
          '--immersive-background-scale', '--immersive-background-position',
        ]),
      };
    }

    function applyPaneAppearance(appearance) {
      if (!appearance || !frameWrap) return;
      if (sharedBackground) {
        sharedBackground.dataset.backgroundTone = appearance.tone === 'dark' ? 'dark' : 'light';
        sharedBackground.dataset.surfaceMode = appearance.surfaceMode || 'plain';
        const sharedFill = appearance.surfaceMode === 'immersive'
          ? 'transparent'
          : String(appearance.viewportVars && appearance.viewportVars['--canvas-background-fill']
            || appearance.baseFill || '');
        sharedBackground.style.setProperty('--dual-shared-background-fill', sharedFill);
        [appearance.viewportVars, appearance.backgroundVars].forEach((vars) => {
          Object.keys(vars || {}).forEach((name) => {
            sharedBackground.style.setProperty(name, String(vars[name] || ''));
          });
        });
      }
      frameWrap.dataset.backgroundTone = appearance.tone === 'dark' ? 'dark' : 'light';
      frameWrap.dataset.guideType = appearance.guideType || 'none';
      frameWrap.dataset.surfaceMode = appearance.surfaceMode || 'plain';
      frameWrap.style.setProperty('--dual-background-base', String(appearance.baseFill || ''));
      [appearance.viewportVars, appearance.backgroundVars].forEach((vars) => {
        Object.keys(vars || {}).forEach((name) => {
          frameWrap.style.setProperty(name, String(vars[name] || ''));
        });
      });
    }

    function sendAppearance(frame) {
      const appearance = appearancePayload();
      applyPaneAppearance(appearance);
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage({
        type: 'relatum:dual:appearance',
        appearance: appearance,
      }, window.location.origin);
    }

    function openRightCanvas(file) {
      const sourceId = String(file && file.id || '');
      if (!sourceId) return;
      const token = ++loadToken;
      if (pendingFrame) pendingFrame.remove();
      const frame = document.createElement('iframe');
      frame.className = 'canvas-dual-frame pending';
      frame.dataset.loadToken = String(token);
      frame.dataset.sourceId = sourceId;
      frame.title = toolbarCopy('dualScreen');
      frame.loading = 'eager';
      frame.src = 'dual-viewer.html?id=' + encodeURIComponent(sourceId)
        + '&current=' + encodeURIComponent(filePath);
      frame.addEventListener('load', () => sendAppearance(frame), { once: true });
      pendingFrame = frame;
      frameWrap.appendChild(frame);
      pane.classList.add('loading');
      showDualToast(toolbarCopy('dualLoading'));
      applyPaneAppearance(appearancePayload());
    }

    function activateFrame(frame, info) {
      const previous = activeFrame;
      activeFrame = frame;
      pendingFrame = null;
      rightInfo = info;
      frame.classList.remove('pending');
      frame.classList.add('active');
      pane.classList.add('has-active-frame');
      if (previous && previous !== frame) {
        previous.classList.remove('active');
        previous.classList.add('outgoing');
        window.setTimeout(() => previous.remove(), 220);
      }
      pane.classList.remove('loading');
      if (title) {
        title.removeAttribute('data-toolbar-i18n');
        title.textContent = info.title || toolbarCopy('dualScreen');
      }
      hideDualPicker();
      sendAppearance(frame);
      showDualToast(toolbarCopy('dualReady'));
    }

    async function importToMain(data) {
      if (!data || !data.payload || !data.sourceId || !data.revision) {
        showMainToast(toolbarCopy('dualClipboardExpired'), true);
        return;
      }
      const importer = window.CanvasModule && window.CanvasModule.importDualSelectionPayload;
      if (typeof importer !== 'function') {
        showMainToast(toolbarCopy('dualPickFailed'), true);
        return;
      }
      showMainToast(toolbarCopy('dualPasting'));
      try {
        await importer({
          sourceId: data.sourceId,
          revision: data.revision,
          payload: data.payload,
        });
        showMainToast(toolbarCopy('dualPasted'));
      } catch (error) {
        showMainToast(error && (error.displayMessage || error.message)
          ? (error.displayMessage || error.message)
          : toolbarCopy('dualPickFailed'), true);
      }
    }

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
      const fromPending = pendingFrame && event.source === pendingFrame.contentWindow;
      const fromActive = activeFrame && event.source === activeFrame.contentWindow;
      if (!fromPending && !fromActive) return;
      const data = event.data;
      if (data.type === 'relatum:dual:ready' && fromPending) {
        if (Number(pendingFrame.dataset.loadToken) !== loadToken) return;
        activateFrame(pendingFrame, {
          id: String(data.sourceId || pendingFrame.dataset.sourceId || ''),
          title: String(data.title || ''),
          revision: String(data.revision || ''),
        });
      } else if (data.type === 'relatum:dual:error' && fromPending) {
        const failed = pendingFrame;
        pendingFrame = null;
        failed.remove();
        pane.classList.remove('loading');
        showDualToast(toolbarCopy('dualPickFailed') + ': ' + String(data.error || ''), true);
        if (!activeFrame) showDualPicker();
      } else if (data.type === 'relatum:dual:copy' && fromActive) {
        dualClipboard = {
          token: String(data.token || ''),
          sourceId: String(data.sourceId || ''),
          revision: String(data.revision || ''),
          payload: data.payload,
        };
        showDualToast(toolbarCopy('dualCopied'));
      } else if (data.type === 'relatum:dual:paste-to-main' && fromActive) {
        importToMain({
          sourceId: String(data.sourceId || ''),
          revision: String(data.revision || ''),
          payload: data.payload,
        });
      }
    });

    window.addEventListener('paste', (event) => {
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const helper = window.RelatumDualClipboard;
      const token = helper && typeof helper.readToken === 'function'
        ? helper.readToken(event.clipboardData)
        : '';
      if (!token) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!dualClipboard || dualClipboard.token !== token) {
        showMainToast(toolbarCopy('dualClipboardExpired'), true);
        return;
      }
      importToMain(dualClipboard);
    }, true);

    function openDualScreen() {
      revealToolLayer(pane);
      resizer.hidden = false;
      resizer.classList.remove('tool-layer-leaving');
      resizer.classList.add('tool-layer-entering');
      document.body.classList.add('dual-screen-open');
      applyPaneAppearance(appearancePayload());
      if (!prefersReducedToolMotion()) {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          if (!resizer.hidden) resizer.classList.remove('tool-layer-entering');
        }));
      } else {
        resizer.classList.remove('tool-layer-entering');
      }
      if (!activeFrame) showDualPicker();
    }

    function closeDualScreen() {
      if (pane.hidden) return;
      hideDualPicker();
      resizer.classList.remove('tool-layer-entering');
      resizer.classList.add('tool-layer-leaving');
      concealToolLayer(pane, () => {
        resizer.hidden = true;
        resizer.classList.remove('tool-layer-leaving');
        document.body.classList.remove('dual-screen-open');
      }, 180);
    }

    let resizeState = null;
    let resizeFrame = 0;
    let pendingWidth = 0;
    function applyResize() {
      resizeFrame = 0;
      if (pendingWidth) document.documentElement.style.setProperty('--dual-pane-width', pendingWidth + 'px');
    }
    resizer.addEventListener('pointerdown', (event) => {
      if (pane.hidden || event.button !== 0) return;
      resizeState = {
        startX: event.clientX,
        startWidth: pane.getBoundingClientRect().width,
      };
      document.body.classList.add('dual-screen-resizing');
      try { resizer.setPointerCapture(event.pointerId); } catch (_) {}
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!resizeState) return;
      const next = resizeState.startWidth - (event.clientX - resizeState.startX);
      const min = Math.max(280, window.innerWidth * 0.3);
      const max = Math.max(min, window.innerWidth * 0.7);
      pendingWidth = Math.max(min, Math.min(max, next));
      if (!resizeFrame) resizeFrame = window.requestAnimationFrame(applyResize);
    });
    function endResize(event) {
      if (!resizeState) return;
      resizeState = null;
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
        applyResize();
      }
      document.body.classList.remove('dual-screen-resizing');
      try { resizer.releasePointerCapture(event.pointerId); } catch (_) {}
    }
    resizer.addEventListener('pointerup', endResize);
    resizer.addEventListener('pointercancel', endResize);

    filesList.addEventListener('scroll', () => {
      queueDualScrollbarUpdate();
      markDualScrollbarActive(false);
    }, { passive: true });
    if (filesShell) {
      filesShell.addEventListener('mouseenter', () => {
        queueDualScrollbarUpdate();
        window.requestAnimationFrame(() => markDualScrollbarActive(true));
      });
      filesShell.addEventListener('mouseleave', () => markDualScrollbarActive(false));
      filesShell.addEventListener('focusin', () => markDualScrollbarActive(true));
      filesShell.addEventListener('focusout', () => markDualScrollbarActive(false));
    }
    if (scrollRail && scrollThumb) scrollRail.addEventListener('pointerdown', startDualScrollbarDrag);
    if (window.ResizeObserver && filesShell) {
      const scrollbarObserver = new ResizeObserver(queueDualScrollbarUpdate);
      scrollbarObserver.observe(filesShell);
      scrollbarObserver.observe(filesList);
    }
    window.addEventListener('resize', queueDualScrollbarUpdate);

    search.addEventListener('input', () => { activeIndex = 0; renderDualPicker(); });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!filteredFiles.length) return;
        activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filteredFiles.length)
          % filteredFiles.length;
        syncPickerSelection();
        const selected = filesList.querySelector('[aria-selected="true"]');
        if (selected) {
          selected.scrollIntoView({ block: 'nearest' });
          queueDualScrollbarUpdate();
          markDualScrollbarActive(false);
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (filteredFiles[activeIndex]) openRightCanvas(filteredFiles[activeIndex]);
      } else if (event.key === 'Escape' && activeFrame) {
        event.preventDefault();
        hideDualPicker();
        if (titleButton) titleButton.focus();
      }
    });
    if (titleButton) titleButton.addEventListener('click', showDualPicker);
    if (pickerClose) pickerClose.addEventListener('click', () => {
      if (activeFrame) hideDualPicker();
      else closeDualScreen();
    });
    if (closeButton) closeButton.addEventListener('click', closeDualScreen);
    document.addEventListener('editor:open-dual-screen', openDualScreen);
    document.addEventListener('editor:languagechange', () => {
      if (!rightInfo && title) {
        title.dataset.toolbarI18n = 'dualNoCanvas';
        title.textContent = toolbarCopy('dualNoCanvas');
      }
      if (!picker.hidden) renderDualPicker();
    });

    const appearanceObserver = new MutationObserver(() => {
      applyPaneAppearance(appearancePayload());
      sendAppearance(activeFrame);
      sendAppearance(pendingFrame);
    });
    if (viewportEl) appearanceObserver.observe(viewportEl, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-guide-type'],
    });
    if (immersiveBackgroundEl) appearanceObserver.observe(immersiveBackgroundEl, {
      attributes: true,
      attributeFilter: ['style'],
    });
    appearanceObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-background-tone'],
    });
    applyPaneAppearance(appearancePayload());
  })();

  // ── 笔记坞：随当前 .canvas 保存；与画布内容只交换显式快照 ──
  (function setupMarkdownNotebook() {
    const dialog = document.querySelector('[data-role="markdown-notebook-dialog"]');
    const shell = dialog && dialog.querySelector('[data-role="markdown-notebook-shell"]');
    const list = dialog && dialog.querySelector('[data-role="markdown-notebook-list"]');
    const mobileSelect = dialog && dialog.querySelector('[data-role="markdown-notebook-mobile-select"]');
    const workspace = dialog && dialog.querySelector('.markdown-notebook-workspace');
    const titleInput = dialog && dialog.querySelector('[data-role="markdown-notebook-note-title"]');
    const sourceInput = dialog && dialog.querySelector('[data-role="markdown-notebook-source"]');
    const preview = dialog && dialog.querySelector('[data-role="markdown-notebook-preview"]');
    const previewEmpty = dialog && dialog.querySelector('[data-role="markdown-notebook-preview-empty"]');
    const previewMeta = dialog && dialog.querySelector('[data-role="markdown-notebook-preview-meta"]');
    const split = dialog && dialog.querySelector('[data-role="markdown-notebook-split"]');
    const structureCount = dialog && dialog.querySelector('[data-role="markdown-notebook-structure-count"]');
    const structureDetail = dialog && dialog.querySelector('[data-role="markdown-notebook-structure-detail"]');
    const message = dialog && dialog.querySelector('[data-role="markdown-notebook-message"]');
    const selectionLabel = dialog && dialog.querySelector('[data-role="markdown-notebook-selection"]');
    const presetSelect = dialog && dialog.querySelector('[data-role="markdown-notebook-preset"]');
    const layoutSelect = dialog && dialog.querySelector('[data-role="markdown-notebook-layout"]');
    const appendButton = dialog && dialog.querySelector('[data-action="append-selection-to-note"]');
    const generateButton = dialog && dialog.querySelector('[data-action="generate-note-mindmap"]');
    const closeButton = dialog && dialog.querySelector('[data-action="close-markdown-notebook"]');
    const addButtons = dialog ? [...dialog.querySelectorAll('[data-action="add-markdown-note"]')] : [];
    const deleteButton = dialog && dialog.querySelector('[data-action="delete-markdown-note"]');
    const helpButton = dialog && dialog.querySelector('[data-action="toggle-markdown-notebook-help"]');
    const helpCloseButton = dialog && dialog.querySelector('[data-action="close-markdown-notebook-help"]');
    const helpPopover = dialog && dialog.querySelector('[data-role="markdown-notebook-help"]');
    const helpCount = dialog && dialog.querySelector('[data-role="markdown-notebook-help-count"]');
    const helpDetail = dialog && dialog.querySelector('[data-role="markdown-notebook-help-detail"]');
    const helpLive = dialog && dialog.querySelector('.markdown-notebook-help-live');
    const deleteConfirm = dialog && dialog.querySelector('[data-role="markdown-notebook-delete-confirm"]');
    const deleteConfirmTitle = dialog && dialog.querySelector('[data-role="markdown-notebook-delete-title"]');
    const deleteCancelButton = dialog && dialog.querySelector('[data-action="cancel-markdown-note-delete"]');
    const deleteConfirmButton = dialog && dialog.querySelector('[data-action="confirm-markdown-note-delete"]');
    const paneButtons = dialog ? [...dialog.querySelectorAll('[data-notebook-pane]')] : [];
    const topbarShortcut = document.querySelector('[data-action="markdown-notebook-shortcut"]');
    const topbarToggle = dialog && dialog.querySelector('[data-role="markdown-notebook-topbar-toggle"]');
    const Notebook = window.RelatumMarkdownNotebook;
    if (!dialog || !shell || !list || !mobileSelect || !workspace || !titleInput
        || !sourceInput || !preview || !helpButton || !helpPopover || !deleteConfirm
        || !deleteCancelButton || !deleteConfirmButton || !topbarShortcut || !topbarToggle
        || !Notebook || !window.MarkdownMini) return;

    const DEFAULTS_KEY = 'canvas:notebookMindmapDefaults:v1';
    const TOPBAR_SHORTCUT_KEY = 'canvas:notebookTopbarShortcut';
    const VALID_PRESETS = new Set([
      'paper', 'focus', 'rounded', 'scholar', 'journal',
      'ink', 'forest', 'blueprint', 'classroom', 'editorial',
    ]);
    const VALID_LAYOUTS = new Set(['balanced', 'right', 'left', 'down', 'radial']);
    let activeId = '';
    let virtualNote = null;
    let capturedSelection = null;
    let outlineModel = null;
    let returnFocus = null;
    let previewTimer = 0;
    let previewRevision = 0;
    let noteDrag = null;
    let noteDragClickGuard = '';
    const noteFlipAnimations = new Map();
    let pendingDeleteId = '';
    let noteMotionTimer = 0;

    function copyWithCount(key, count) {
      return toolbarCopy(key).replace('{count}', String(Math.max(0, Number(count) || 0)));
    }

    function copyWithTitle(key, title) {
      return toolbarCopy(key).replace('{title}', String(title || toolbarCopy('markdownNotebookUntitled')));
    }

    function noteTitle(note) {
      const value = String(note && note.title || '').trim();
      return value || toolbarCopy('markdownNotebookUntitled');
    }

    function notebookNotes() {
      const notebook = canvasData && canvasData.markdownNotebook;
      return notebook && Array.isArray(notebook.notes) ? notebook.notes : [];
    }

    function currentNote() {
      if (virtualNote && virtualNote.id === activeId) return virtualNote;
      return notebookNotes().find((note) => note.id === activeId) || null;
    }

    function ensureNotebook() {
      if (!canvasData) return null;
      if (!canvasData.markdownNotebook || !Array.isArray(canvasData.markdownNotebook.notes)) {
        canvasData.markdownNotebook = { version: Notebook.VERSION, notes: [] };
      }
      canvasData.markdownNotebook.version = Notebook.VERSION;
      return canvasData.markdownNotebook;
    }

    function persistVirtual() {
      if (!virtualNote) return currentNote();
      const notebook = ensureNotebook();
      if (!notebook) return null;
      notebook.notes.push(virtualNote);
      const note = virtualNote;
      virtualNote = null;
      return note;
    }

    function touchNote(note) {
      if (!note) return;
      note.updatedAt = new Date().toISOString();
      markDirty();
    }

    function setMessage(text, tone) {
      if (!message) return;
      message.textContent = text || '';
      if (tone) message.dataset.tone = tone;
      else message.removeAttribute('data-tone');
    }

    function readDefaults() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}') || {}; }
      catch (error) {}
      return {
        preset: VALID_PRESETS.has(saved.preset) ? saved.preset : 'paper',
        layout: VALID_LAYOUTS.has(saved.layout) ? saved.layout : 'balanced',
      };
    }

    function notebookTopbarShortcutEnabled() {
      if (EMBED) return false;
      try { return localStorage.getItem(TOPBAR_SHORTCUT_KEY) === '1'; }
      catch (error) { return false; }
    }

    function syncNotebookTopbarShortcut(enabled) {
      const visible = !EMBED && !!enabled;
      const dialogOpen = visible && !dialog.hidden
        && !dialog.classList.contains('tool-layer-leaving');
      topbarToggle.checked = visible;
      topbarShortcut.hidden = !visible;
      topbarShortcut.classList.toggle('open', dialogOpen);
      topbarShortcut.setAttribute('aria-expanded', dialogOpen ? 'true' : 'false');
      if (!visible) {
        if (returnFocus === topbarShortcut) {
          returnFocus = document.querySelector('[data-action="tools"]');
        }
      }
    }

    function setNotebookTopbarShortcut(enabled) {
      const visible = !EMBED && !!enabled;
      try {
        if (visible) localStorage.setItem(TOPBAR_SHORTCUT_KEY, '1');
        else localStorage.removeItem(TOPBAR_SHORTCUT_KEY);
      } catch (error) {}
      syncNotebookTopbarShortcut(visible);
    }

    function saveDefaults() {
      try {
        localStorage.setItem(DEFAULTS_KEY, JSON.stringify({
          preset: VALID_PRESETS.has(presetSelect.value) ? presetSelect.value : 'paper',
          layout: VALID_LAYOUTS.has(layoutSelect.value) ? layoutSelect.value : 'balanced',
        }));
      } catch (error) {}
    }

    function noteLineCount(note) {
      return String(note && note.markdown || '').split(/\r?\n/)
        .filter((line) => line.trim()).length;
    }

    function noteLineLabel(note) {
      const lines = noteLineCount(note);
      return toolbarLanguage === 'en'
        ? (lines + (lines === 1 ? ' line' : ' lines'))
        : (lines + ' 行');
    }

    function updateActiveNoteMeta() {
      const note = currentNote();
      if (!note) return;
      const row = list.querySelector('[data-note-id="' + CSS.escape(note.id) + '"]');
      if (row) {
        const title = row.querySelector('strong');
        const detail = row.querySelector('small');
        if (title) title.textContent = noteTitle(note);
        if (detail) detail.textContent = noteLineLabel(note);
      }
      const option = [...mobileSelect.options].find((item) => item.value === note.id);
      if (option) {
        const visibleNotes = notebookNotes().length ? notebookNotes() : (virtualNote ? [virtualNote] : []);
        const index = Math.max(0, visibleNotes.findIndex((item) => item.id === note.id));
        option.textContent = (index + 1) + '. ' + noteTitle(note);
      }
    }

    function noteListRows() {
      return [...list.querySelectorAll('.markdown-notebook-list-item[data-note-id]')];
    }

    function stopNoteFlipAnimations() {
      noteFlipAnimations.forEach((animation) => animation.cancel());
      noteFlipAnimations.clear();
    }

    function flipNoteRows(mutate) {
      if (prefersReducedToolMotion()) {
        mutate();
        return;
      }
      const rows = noteListRows();
      const before = new Map();
      rows.forEach((row) => before.set(row, row.getBoundingClientRect()));
      mutate();
      rows.forEach((row) => {
        const animation = noteFlipAnimations.get(row);
        if (animation) animation.cancel();
      });
      rows.forEach((row) => {
        if (noteDrag && row === noteDrag.row) return;
        const oldRect = before.get(row);
        if (!oldRect) return;
        const newRect = row.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        const distance = Math.hypot(dx, dy);
        const animation = row.animate([
          { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
          { transform: 'translate3d(0,0,0)' },
        ], {
          duration: Math.max(170, Math.min(280, 160 + distance * 0.28)),
          easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)',
        });
        noteFlipAnimations.set(row, animation);
        animation.finished.catch(() => undefined).then(() => {
          if (noteFlipAnimations.get(row) === animation) noteFlipAnimations.delete(row);
        });
      });
    }

    function positionNoteDragGhost(drag, clientX, clientY) {
      if (!drag || !drag.ghost) return;
      const left = clientX - drag.offsetX;
      const top = clientY - drag.offsetY;
      drag.ghostLeft = left;
      drag.ghostTop = top;
      drag.ghost.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale(1.028)';
      drag.ghost.dataset.dragLeft = String(left);
      drag.ghost.dataset.dragTop = String(top);
    }

    function noteInsertPoint(clientY) {
      if (!noteDrag) return null;
      const rows = noteListRows().filter((row) => row !== noteDrag.row);
      let beforeNode = null;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          beforeNode = row;
          break;
        }
      }
      return beforeNode;
    }

    function liveReorderNote(clientY) {
      if (!noteDrag) return;
      const beforeNode = noteInsertPoint(clientY);
      if (noteDrag.row.nextElementSibling === beforeNode) return;
      flipNoteRows(() => list.insertBefore(noteDrag.row, beforeNode));
    }

    function noteEdgeScroll(clientY) {
      const rect = list.getBoundingClientRect();
      const edge = Math.min(42, Math.max(28, rect.height * 0.12));
      let velocity = 0;
      if (clientY < rect.top + edge) {
        velocity = -Math.ceil(10 * (rect.top + edge - clientY) / edge);
      } else if (clientY > rect.bottom - edge) {
        velocity = Math.ceil(10 * (clientY - (rect.bottom - edge)) / edge);
      }
      if (!velocity) return false;
      const previous = list.scrollTop;
      list.scrollTop += velocity;
      return Math.abs(list.scrollTop - previous) > 0.5;
    }

    function runNoteDragFrame() {
      const drag = noteDrag;
      if (!drag || !drag.active) return;
      drag.frame = 0;
      positionNoteDragGhost(drag, drag.pendingX, drag.pendingY);
      const scrolled = noteEdgeScroll(drag.pendingY);
      liveReorderNote(drag.pendingY);
      if (scrolled && noteDrag === drag) {
        drag.frame = window.requestAnimationFrame(runNoteDragFrame);
      }
    }

    function scheduleNoteDragFrame(clientX, clientY) {
      if (!noteDrag) return;
      noteDrag.pendingX = clientX;
      noteDrag.pendingY = clientY;
      if (!noteDrag.frame) {
        noteDrag.frame = window.requestAnimationFrame(runNoteDragFrame);
      }
    }

    function activateNoteDrag() {
      const drag = noteDrag;
      if (!drag || drag.active) return;
      try { drag.handle.setPointerCapture(drag.pointerId); } catch (error) {}
      const ghost = drag.row.cloneNode(true);
      const rowStyle = window.getComputedStyle(drag.row);
      const notebookStyle = window.getComputedStyle(dialog);
      ghost.classList.add('markdown-notebook-list-ghost');
      ghost.classList.remove('drag-source', 'is-entering', 'is-removing');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.tabIndex = -1;
      ghost.style.width = drag.width + 'px';
      ghost.style.height = drag.height + 'px';
      ghost.style.color = rowStyle.color;
      ghost.style.background = notebookStyle.getPropertyValue('--notebook-card').trim()
        || rowStyle.backgroundColor;
      ghost.style.borderColor = notebookStyle.getPropertyValue('--notebook-card-border').trim()
        || rowStyle.borderColor;
      ghost.style.transition = 'none';
      ghost.style.animation = 'none';
      drag.ghost = ghost;
      positionNoteDragGhost(drag, drag.startX, drag.startY);
      document.body.appendChild(ghost);
      drag.active = true;
      drag.row.classList.add('drag-source');
      document.body.classList.add('markdown-notebook-dragging');
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    }

    function onNoteDragPointerMove(event) {
      if (!noteDrag || event.pointerId !== noteDrag.pointerId) return;
      const dx = event.clientX - noteDrag.startX;
      const dy = event.clientY - noteDrag.startY;
      if (!noteDrag.active) {
        if (Math.hypot(dx, dy) < 6) return;
        activateNoteDrag();
      }
      event.preventDefault();
      scheduleNoteDragFrame(event.clientX, event.clientY);
    }

    function clearNoteDragListeners(drag) {
      window.removeEventListener('pointermove', onNoteDragPointerMove);
      window.removeEventListener('pointerup', onNoteDragPointerUp);
      window.removeEventListener('pointercancel', onNoteDragPointerCancel);
      if (drag && drag.frame) window.cancelAnimationFrame(drag.frame);
      if (drag) drag.frame = 0;
      try {
        if (drag) drag.handle.releasePointerCapture(drag.pointerId);
      } catch (error) {}
    }

    function revealNoteLanding(row, ghost, immediate) {
      if (!row) {
        if (ghost) ghost.remove();
        return;
      }
      const ghostStyle = ghost ? window.getComputedStyle(ghost) : null;
      row.classList.add('drag-handoff');
      if (ghostStyle) {
        row.style.backgroundColor = ghostStyle.backgroundColor;
        row.style.borderColor = ghostStyle.borderColor;
        row.style.boxShadow = ghostStyle.boxShadow;
        row.style.color = ghostStyle.color;
      }
      row.classList.remove('drag-source');
      if (ghost) ghost.remove();
      if (immediate || prefersReducedToolMotion()) {
        row.classList.remove('drag-handoff');
        row.style.removeProperty('background-color');
        row.style.removeProperty('border-color');
        row.style.removeProperty('box-shadow');
        row.style.removeProperty('color');
        return;
      }
      window.requestAnimationFrame(() => {
        if (!row.isConnected) return;
        row.classList.remove('drag-handoff');
        window.requestAnimationFrame(() => {
          if (!row.isConnected) return;
          row.style.removeProperty('background-color');
          row.style.removeProperty('border-color');
          row.style.removeProperty('box-shadow');
          row.style.removeProperty('color');
        });
      });
    }

    function flyNoteGhostTo(ghost, row, done) {
      if (!ghost || !row || prefersReducedToolMotion()) {
        if (done) done();
        return;
      }
      const target = row.getBoundingClientRect();
      const ghostRect = ghost.getBoundingClientRect();
      const fromLeft = Number(ghost.dataset.dragLeft);
      const fromTop = Number(ghost.dataset.dragTop);
      const startLeft = Number.isFinite(fromLeft) ? fromLeft : ghostRect.left;
      const startTop = Number.isFinite(fromTop) ? fromTop : ghostRect.top;
      const distance = Math.hypot(target.left - startLeft, target.top - startTop);
      const ghostStyle = window.getComputedStyle(ghost);
      const targetStyle = window.getComputedStyle(row);
      const duration = distance < 8
        ? 130
        : Math.max(300, Math.min(470, 270 + distance * 0.18));
      const animation = ghost.animate([
        {
          transform: 'translate3d(' + startLeft + 'px,' + startTop + 'px,0) scale(1.028)',
          opacity: 1,
          backgroundColor: ghostStyle.backgroundColor,
          borderColor: ghostStyle.borderColor,
          boxShadow: ghostStyle.boxShadow,
        },
        {
          transform: 'translate3d(' + target.left + 'px,' + target.top + 'px,0) scale(1)',
          opacity: 1,
          backgroundColor: targetStyle.backgroundColor,
          borderColor: targetStyle.borderColor,
          boxShadow: targetStyle.boxShadow,
        },
      ], {
        duration,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      });
      animation.finished.catch(() => undefined).then(() => {
        if (done) done();
      });
    }

    function restoreNoteDomOrder(order) {
      order.forEach((id) => {
        const row = list.querySelector('[data-note-id="' + CSS.escape(id) + '"]');
        if (row) list.appendChild(row);
      });
    }

    function syncMobileNoteOrder(order) {
      const notesById = new Map(notebookNotes().map((note) => [note.id, note]));
      const optionsById = new Map(
        [...mobileSelect.options].map((option) => [option.value, option]),
      );
      order.forEach((id, index) => {
        const option = optionsById.get(id);
        const note = notesById.get(id);
        if (!option || !note) return;
        option.textContent = (index + 1) + '. ' + noteTitle(note);
        mobileSelect.appendChild(option);
      });
      mobileSelect.value = activeId;
    }

    function finishNoteDrag(options) {
      options = options || {};
      const drag = noteDrag;
      if (!drag) return false;
      noteDrag = null;
      clearNoteDragListeners(drag);
      document.body.classList.remove('markdown-notebook-dragging');

      if (!drag.active) return false;
      noteDragClickGuard = drag.noteId;
      window.setTimeout(() => {
        if (noteDragClickGuard === drag.noteId) noteDragClickGuard = '';
      }, 0);

      if (options.cancel) {
        if (options.immediate || prefersReducedToolMotion()) {
          stopNoteFlipAnimations();
          restoreNoteDomOrder(drag.originalOrder);
        } else {
          flipNoteRows(() => restoreNoteDomOrder(drag.originalOrder));
        }
      }

      const domOrder = noteListRows().map((row) => row.dataset.noteId);
      const changed = !options.cancel
        && domOrder.some((id, index) => id !== drag.originalOrder[index]);
      if (changed) {
        const notes = notebookNotes();
        const byId = new Map(notes.map((note) => [note.id, note]));
        const ordered = domOrder.map((id) => byId.get(id)).filter(Boolean);
        if (ordered.length === notes.length) notes.splice(0, notes.length, ...ordered);
        touchNote(byId.get(drag.noteId));
        syncMobileNoteOrder(domOrder);
      }

      const landingRow = list.querySelector(
        '[data-note-id="' + CSS.escape(drag.noteId) + '"]',
      );
      if (landingRow) landingRow.classList.add('drag-source');
      if (options.immediate) {
        stopNoteFlipAnimations();
        revealNoteLanding(landingRow, drag.ghost, true);
      } else {
        flyNoteGhostTo(drag.ghost, landingRow, () => revealNoteLanding(landingRow, drag.ghost));
      }
      return true;
    }

    function onNoteDragPointerUp(event) {
      if (!noteDrag || event.pointerId !== noteDrag.pointerId) return;
      if (noteDrag.active) {
        if (noteDrag.frame) {
          window.cancelAnimationFrame(noteDrag.frame);
          noteDrag.frame = 0;
        }
        positionNoteDragGhost(noteDrag, event.clientX, event.clientY);
        noteEdgeScroll(event.clientY);
        liveReorderNote(event.clientY);
      }
      finishNoteDrag();
    }

    function onNoteDragPointerCancel(event) {
      if (!noteDrag || event.pointerId !== noteDrag.pointerId) return;
      finishNoteDrag({ cancel: true });
    }

    function beginNoteDrag(event, row, note) {
      if (event.button !== 0 || notebookNotes().length < 2 || noteDrag) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      noteDrag = {
        noteId: note.id,
        row,
        handle: event.currentTarget,
        pointerId: event.pointerId,
        active: false,
        ghost: null,
        frame: 0,
        startX: event.clientX,
        startY: event.clientY,
        pendingX: event.clientX,
        pendingY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        originalOrder: noteListRows().map((item) => item.dataset.noteId),
      };
      window.addEventListener('pointermove', onNoteDragPointerMove, { passive: false });
      window.addEventListener('pointerup', onNoteDragPointerUp);
      window.addEventListener('pointercancel', onNoteDragPointerCancel);
    }

    function renderList(options) {
      options = options || {};
      const notes = notebookNotes();
      const visibleNotes = notes.length ? notes : (virtualNote ? [virtualNote] : []);
      list.innerHTML = '';
      mobileSelect.innerHTML = '';
      visibleNotes.forEach((note, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'markdown-notebook-list-item';
        row.dataset.noteId = note.id;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', note.id === activeId ? 'true' : 'false');
        row.classList.toggle('active', note.id === activeId);
        row.classList.toggle('is-entering', note.id === options.enteringId);
        row.innerHTML = '<span class="markdown-notebook-list-grip" aria-hidden="true">⋮⋮</span>'
          + '<span class="markdown-notebook-list-copy"><strong></strong><small></small></span>';
        row.querySelector('strong').textContent = noteTitle(note);
        row.querySelector('small').textContent = noteLineLabel(note);
        const grip = row.querySelector('.markdown-notebook-list-grip');
        row.addEventListener('click', () => {
          if (noteDragClickGuard !== note.id) selectNote(note.id);
        });
        grip.addEventListener('pointerdown', (event) => beginNoteDrag(event, row, note));
        grip.addEventListener('click', (event) => event.stopPropagation());
        list.appendChild(row);

        const option = document.createElement('option');
        option.value = note.id;
        option.textContent = (index + 1) + '. ' + noteTitle(note);
        option.selected = note.id === activeId;
        mobileSelect.appendChild(option);
      });
      if (options.enteringId && !prefersReducedToolMotion()) {
        const entering = list.querySelector('[data-note-id="' + CSS.escape(options.enteringId) + '"]');
        if (entering) {
          window.requestAnimationFrame(() => entering.classList.remove('is-entering'));
        }
      }
    }

    function renderPreview(revision) {
      if (revision !== previewRevision || dialog.hidden) return;
      const note = currentNote();
      const markdown = String(note && note.markdown || '');
      const title = noteTitle(note);
      outlineModel = Notebook.parseOutline(title, markdown, { maxNodes: 200 });
      preview.hidden = !markdown.trim();
      if (previewEmpty) previewEmpty.hidden = !!markdown.trim();
      if (markdown.trim()) {
        const rendered = typeof window.MarkdownMini.renderResult === 'function'
          ? window.MarkdownMini.renderResult(markdown)
          : {
            html: window.MarkdownMini.render(markdown),
            features: window.MarkdownMini.structure.scanFeatures(markdown),
          };
        preview.dataset.notebookRenderRevision = String(revision);
        preview.innerHTML = rendered.html;
        const canvasApi = window.CanvasModule;
        if (rendered.features.math && canvasApi
            && typeof canvasApi.scheduleMarkdownMath === 'function') {
          canvasApi.scheduleMarkdownMath(preview, markdown, true);
        } else if (canvasApi && typeof canvasApi.clearMarkdownMath === 'function') {
          canvasApi.clearMarkdownMath(preview);
        }
        if (rendered.features.mermaid && window.MermaidRenderer
            && typeof window.MermaidRenderer.renderAll === 'function') {
          Promise.resolve(window.MermaidRenderer.renderAll(preview)).then(() => {
            if (revision !== previewRevision
                || preview.dataset.notebookRenderRevision !== String(revision)) return;
            preview.dataset.notebookRenderRevision = String(revision);
          }).catch(() => {});
        }
      } else {
        const canvasApi = window.CanvasModule;
        if (canvasApi && typeof canvasApi.clearMarkdownMath === 'function') {
          canvasApi.clearMarkdownMath(preview);
        }
        preview.innerHTML = '';
      }
      const count = outlineModel && outlineModel.ok
        ? outlineModel.count
        : (outlineModel && outlineModel.reason === 'too-many'
          && Array.isArray(outlineModel.nodes) ? outlineModel.nodes.length : 0);
      if (helpCount && helpDetail && helpLive) {
        if (outlineModel && outlineModel.ok) {
          helpCount.textContent = copyWithCount('markdownNotebookHelpReady', outlineModel.count);
          helpDetail.textContent = copyWithCount(
            'markdownNotebookHelpReadyDetail',
            outlineModel.maxDepth,
          );
          helpLive.removeAttribute('data-tone');
        } else if (outlineModel && outlineModel.reason === 'too-many') {
          helpCount.textContent = toolbarCopy('markdownNotebookLimitError');
          helpDetail.textContent = copyWithCount('markdownNotebookNodes', count);
          helpLive.dataset.tone = 'error';
        } else {
          helpCount.textContent = toolbarCopy('markdownNotebookHelpEmpty');
          helpDetail.textContent = toolbarCopy('markdownNotebookNeedStructure');
          helpLive.removeAttribute('data-tone');
        }
      }
      if (structureCount) structureCount.textContent = copyWithCount('markdownNotebookNodes', count);
      if (structureDetail) {
        structureDetail.textContent = outlineModel && outlineModel.ok
          ? copyWithCount('markdownNotebookDepth', outlineModel.maxDepth)
          : (outlineModel && outlineModel.reason === 'too-many'
            ? toolbarCopy('markdownNotebookLimitError')
            : toolbarCopy('markdownNotebookNeedStructure'));
      }
      if (previewMeta) previewMeta.textContent = count
        ? copyWithCount('markdownNotebookNodes', count) : '';
      if (generateButton) generateButton.disabled = !(outlineModel && outlineModel.ok);
    }

    function schedulePreview(immediate) {
      if (previewTimer) window.clearTimeout(previewTimer);
      const revision = ++previewRevision;
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        window.requestAnimationFrame(() => renderPreview(revision));
      }, immediate ? 0 : 100);
    }

    function animateNoteSwitch() {
      if (prefersReducedToolMotion()) return;
      if (noteMotionTimer) window.clearTimeout(noteMotionTimer);
      workspace.classList.remove('is-switching');
      void workspace.offsetWidth;
      workspace.classList.add('is-switching');
      noteMotionTimer = window.setTimeout(() => {
        workspace.classList.remove('is-switching');
        noteMotionTimer = 0;
      }, 180);
    }

    function selectNote(id, options) {
      options = options || {};
      const note = (virtualNote && virtualNote.id === id)
        ? virtualNote : notebookNotes().find((item) => item.id === id);
      if (!note) return;
      activeId = note.id;
      titleInput.value = note.title || '';
      sourceInput.value = note.markdown || '';
      setMessage('');
      renderList({ enteringId: options.enteringId || '' });
      schedulePreview(true);
    }

    function createVirtualIfEmpty() {
      const notes = notebookNotes();
      if (notes.length) {
        virtualNote = null;
        return notes[0];
      }
      if (!virtualNote) {
        virtualNote = Notebook.createNote(toolbarCopy('markdownNotebookUntitled'), '');
      }
      return virtualNote;
    }

    function addNote() {
      if (!canvasData) return;
      const note = Notebook.createNote(toolbarCopy('markdownNotebookUntitled'), '');
      ensureNotebook().notes.push(note);
      virtualNote = null;
      markDirty();
      selectNote(note.id, { enteringId: note.id });
      requestAnimationFrame(() => {
        titleInput.focus();
        titleInput.select();
      });
    }

    function setNotebookShellBlocked(blocked) {
      shell.inert = !!blocked;
      if (blocked) shell.setAttribute('aria-hidden', 'true');
      else shell.removeAttribute('aria-hidden');
    }

    function closeMindmapHelp(restoreFocus) {
      helpButton.setAttribute('aria-expanded', 'false');
      if (helpPopover.hidden) return false;
      return concealToolLayer(helpPopover, () => {
        if (restoreFocus !== false) helpButton.focus();
      }, 180);
    }

    function toggleMindmapHelp() {
      if (!helpPopover.hidden && !helpPopover.classList.contains('tool-layer-leaving')) {
        closeMindmapHelp(true);
        return;
      }
      helpButton.setAttribute('aria-expanded', 'true');
      revealToolLayer(helpPopover);
      schedulePreview(true);
      window.requestAnimationFrame(() => {
        if (helpCloseButton) helpCloseButton.focus({ preventScroll: true });
      });
    }

    function closeDeleteConfirm(restoreFocus) {
      if (deleteConfirm.hidden) return false;
      const shouldRestore = restoreFocus !== false;
      return concealToolLayer(deleteConfirm, () => {
        setNotebookShellBlocked(false);
        deleteConfirmButton.disabled = false;
        pendingDeleteId = '';
        if (shouldRestore && deleteButton.isConnected) deleteButton.focus();
      }, 190);
    }

    function deleteNote() {
      const note = currentNote();
      if (!note || !deleteConfirm.hidden) return;
      closeMindmapHelp(false);
      pendingDeleteId = note.id;
      if (deleteConfirmTitle) {
        deleteConfirmTitle.textContent = copyWithTitle('markdownNotebookDeleteTitle', noteTitle(note));
      }
      deleteButton.classList.remove('is-acknowledged');
      void deleteButton.offsetWidth;
      deleteButton.classList.add('is-acknowledged');
      window.setTimeout(() => deleteButton.classList.remove('is-acknowledged'), 200);
      setNotebookShellBlocked(true);
      revealToolLayer(deleteConfirm);
      window.requestAnimationFrame(() => deleteCancelButton.focus({ preventScroll: true }));
    }

    function removeNoteById(noteId) {
      if (!noteId) return;
      if (virtualNote && noteId === virtualNote.id) {
        virtualNote = null;
      } else {
        const notebook = ensureNotebook();
        const index = notebook.notes.findIndex((item) => item.id === noteId);
        if (index >= 0) notebook.notes.splice(index, 1);
        if (!notebook.notes.length) delete canvasData.markdownNotebook;
        markDirty();
      }
      const next = createVirtualIfEmpty();
      selectNote(next.id);
    }

    function confirmDeleteNote() {
      const noteId = pendingDeleteId;
      if (!noteId || deleteConfirmButton.disabled) return;
      deleteConfirmButton.disabled = true;
      const row = list.querySelector('[data-note-id="' + CSS.escape(noteId) + '"]');
      if (row) row.classList.add('is-removing');
      closeDeleteConfirm(false);
      window.setTimeout(() => removeNoteById(noteId), prefersReducedToolMotion() ? 0 : 175);
    }

    function captureCanvasSelection() {
      capturedSelection = null;
      if (window.CanvasModule && typeof window.CanvasModule.getSelectedMarkdownOutline === 'function') {
        capturedSelection = window.CanvasModule.getSelectedMarkdownOutline();
      }
      const count = capturedSelection && Array.isArray(capturedSelection.nodes)
        ? capturedSelection.nodes.length : 0;
      const ignored = capturedSelection ? Number(capturedSelection.ignoredCount) || 0 : 0;
      selectionLabel.textContent = count
        ? copyWithCount('markdownNotebookSelected', count)
          + (ignored ? copyWithCount('markdownNotebookIgnored', ignored) : '')
        : toolbarCopy('markdownNotebookNoSelection');
      appendButton.disabled = count < 1;
    }

    function appendSelection() {
      if (!capturedSelection) return;
      const result = Notebook.selectionToMarkdown(capturedSelection, {
        untitled: toolbarCopy('markdownNotebookUntitled'),
        fallbackTitle: toolbarLanguage === 'en' ? 'Canvas selection' : '画布选区',
        relationLabel: toolbarLanguage === 'en' ? 'Relation' : '关系',
        relationSeparator: toolbarLanguage === 'en' ? ': ' : '：',
      });
      if (!result.markdown.trim()) return;
      let note = currentNote();
      if (virtualNote && note === virtualNote) note = persistVirtual();
      const start = sourceInput.selectionStart;
      const end = sourceInput.selectionEnd;
      const before = String(note.markdown || '');
      const needsGap = before.slice(0, start).trim() ? '\n\n' : '';
      const addition = needsGap + result.markdown.trimEnd();
      note.markdown = before.slice(0, start) + addition + before.slice(end);
      note.updatedAt = new Date().toISOString();
      sourceInput.value = note.markdown;
      const caret = start + addition.length;
      sourceInput.setSelectionRange(caret, caret);
      markDirty();
      renderList();
      schedulePreview();
      setMessage(result.complex
        ? toolbarCopy('markdownNotebookComplexSelection')
        : toolbarCopy('markdownNotebookAppended'));
      sourceInput.focus();
    }

    function close(restoreFocus) {
      if (dialog.hidden || dialog.classList.contains('tool-layer-leaving')) return false;
      if (noteDrag) finishNoteDrag({ cancel: true, immediate: true });
      if (previewTimer) window.clearTimeout(previewTimer);
      if (noteMotionTimer) window.clearTimeout(noteMotionTimer);
      previewTimer = 0;
      noteMotionTimer = 0;
      previewRevision += 1;
      workspace.classList.remove('is-switching');
      closeMindmapHelp(false);
      const focusTarget = restoreFocus !== false && returnFocus && returnFocus.isConnected
        && !returnFocus.hidden
        ? returnFocus : null;
      topbarShortcut.classList.remove('open');
      topbarShortcut.setAttribute('aria-expanded', 'false');
      if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
        window.CanvasModule.setExternalOverlayOpen(false);
      }
      return concealToolLayer(dialog, () => {
        setMessage('');
        capturedSelection = null;
        if (focusTarget) focusTarget.focus();
        returnFocus = null;
      }, 220);
    }

    function open(event) {
      if (!canvasData || dialog.classList.contains('tool-layer-entering')) return;
      const requestedReturnFocus = event && event.detail && event.detail.returnFocus;
      returnFocus = requestedReturnFocus && requestedReturnFocus.isConnected
        ? requestedReturnFocus
        : document.querySelector('[data-action="tools"]');
      if (!topbarShortcut.hidden) {
        topbarShortcut.classList.add('open');
        topbarShortcut.setAttribute('aria-expanded', 'true');
      }
      helpPopover.hidden = true;
      helpPopover.classList.remove('tool-layer-entering', 'tool-layer-leaving');
      helpButton.setAttribute('aria-expanded', 'false');
      deleteConfirm.hidden = true;
      deleteConfirm.classList.remove('tool-layer-entering', 'tool-layer-leaving');
      deleteConfirmButton.disabled = false;
      pendingDeleteId = '';
      setNotebookShellBlocked(false);
      const normalized = Notebook.normalizeNotebook(canvasData.markdownNotebook);
      if (canvasData.markdownNotebook && normalized.notes.length) {
        canvasData.markdownNotebook = normalized;
      }
      const first = createVirtualIfEmpty();
      activeId = activeId && (normalized.notes.some((note) => note.id === activeId)
        || (virtualNote && virtualNote.id === activeId)) ? activeId : first.id;
      const defaults = readDefaults();
      presetSelect.value = defaults.preset;
      layoutSelect.value = defaults.layout;
      split.dataset.activePane = 'edit';
      paneButtons.forEach((button) => button.classList.toggle('active', button.dataset.notebookPane === 'edit'));
      dialog.lang = toolbarLanguage;
      setMessage('');
      captureCanvasSelection();
      selectNote(activeId);
      revealToolLayer(dialog);
      if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
        window.CanvasModule.setExternalOverlayOpen(true);
      }
      requestAnimationFrame(() => sourceInput.focus());
    }

    function generateMindmap() {
      const note = currentNote();
      outlineModel = Notebook.parseOutline(noteTitle(note), note && note.markdown || '', { maxNodes: 200 });
      if (!outlineModel.ok) {
        setMessage(
          outlineModel.reason === 'too-many'
            ? toolbarCopy('markdownNotebookLimitError')
            : toolbarCopy('markdownNotebookEmptyError'),
          'error',
        );
        return;
      }
      const api = window.CanvasModule;
      if (!api || typeof api.createMindmapFromOutline !== 'function') {
        setMessage(toolbarCopy('markdownNotebookUnavailable'), 'error');
        return;
      }
      saveDefaults();
      const result = api.createMindmapFromOutline(outlineModel, {
        preset: presetSelect.value,
        layout: layoutSelect.value,
      });
      if (!result || !result.ok) {
        setMessage(toolbarCopy('markdownNotebookUnavailable'), 'error');
        return;
      }
      if (window.EditorShell && typeof window.EditorShell.setMode === 'function') {
        window.EditorShell.setMode('mindmap');
      }
      setMessage(toolbarCopy('markdownNotebookGenerated'));
      close(false);
    }

    function commitSourceInput() {
      let note = currentNote();
      if (virtualNote && note === virtualNote) note = persistVirtual();
      if (!note) return;
      note.markdown = sourceInput.value;
      touchNote(note);
      updateActiveNoteMeta();
      schedulePreview(false);
    }

    function replaceSourceRange(start, end, replacement) {
      const before = sourceInput.value;
      const expected = before.slice(0, start) + replacement + before.slice(end);
      sourceInput.focus();
      sourceInput.setSelectionRange(start, end);
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, replacement);
      } catch (error) {}
      if (!inserted || sourceInput.value !== expected) {
        sourceInput.value = before;
        sourceInput.setSelectionRange(start, end);
        sourceInput.setRangeText(replacement, start, end, 'end');
        commitSourceInput();
      } else {
        const note = currentNote();
        if (!note || note.markdown !== expected) commitSourceInput();
      }
    }

    function continueMarkdownList(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
          || event.isComposing || sourceInput.selectionStart !== sourceInput.selectionEnd) return false;
      const edit = Notebook.listContinuation(
        sourceInput.value,
        sourceInput.selectionStart,
        sourceInput.selectionEnd,
      );
      if (!edit) return false;
      event.preventDefault();
      replaceSourceRange(edit.start, edit.end, edit.text);
      return true;
    }

    function handleNotebookEscape(event) {
      if (event.key !== 'Escape' || dialog.hidden) return false;
      event.preventDefault();
      event.stopPropagation();
      if (noteDrag) {
        finishNoteDrag({ cancel: true });
        return true;
      }
      if (!deleteConfirm.hidden) {
        closeDeleteConfirm(true);
        return true;
      }
      if (!helpPopover.hidden) {
        closeMindmapHelp(true);
        return true;
      }
      // Esc 是“退出工作区”而不是“返回触发按钮”：不把键盘焦点锁到
      // 顶栏的「笔记」或「工具」，让隐藏弹窗后的焦点自然回到画布环境。
      close(false);
      return true;
    }

    titleInput.addEventListener('input', () => {
      let note = currentNote();
      if (virtualNote && note === virtualNote) note = persistVirtual();
      if (!note) return;
      note.title = titleInput.value.slice(0, 120);
      touchNote(note);
      updateActiveNoteMeta();
      schedulePreview(false);
    });
    sourceInput.addEventListener('input', commitSourceInput);
    sourceInput.addEventListener('keydown', continueMarkdownList);
    mobileSelect.addEventListener('change', () => selectNote(mobileSelect.value));
    addButtons.forEach((button) => button.addEventListener('click', addNote));
    topbarToggle.addEventListener('change', () => {
      setNotebookTopbarShortcut(topbarToggle.checked);
    });
    topbarShortcut.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('editor:open-markdown-notebook', {
        detail: { returnFocus: topbarShortcut },
      }));
    });
    deleteButton.addEventListener('click', deleteNote);
    helpButton.addEventListener('click', toggleMindmapHelp);
    if (helpCloseButton) {
      helpCloseButton.addEventListener('click', () => closeMindmapHelp(true));
    }
    deleteCancelButton.addEventListener('click', () => closeDeleteConfirm(true));
    deleteConfirmButton.addEventListener('click', confirmDeleteNote);
    closeButton.addEventListener('click', () => close(true));
    appendButton.addEventListener('click', appendSelection);
    generateButton.addEventListener('click', generateMindmap);
    presetSelect.addEventListener('change', saveDefaults);
    layoutSelect.addEventListener('change', saveDefaults);
    paneButtons.forEach((button) => button.addEventListener('click', () => {
      split.dataset.activePane = button.dataset.notebookPane;
      paneButtons.forEach((item) => item.classList.toggle('active', item === button));
      animateNoteSwitch();
    }));
    dialog.addEventListener('mousedown', (event) => {
      if (event.target === deleteConfirm) {
        closeDeleteConfirm(true);
        return;
      }
      if (!helpPopover.hidden && event.target !== helpButton
          && !helpPopover.contains(event.target)) {
        closeMindmapHelp(false);
      }
      if (event.target === dialog) close(true);
    });
    dialog.addEventListener('keydown', (event) => {
      if (handleNotebookEscape(event)) return;
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusRoot = !deleteConfirm.hidden ? deleteConfirm : dialog;
      const focusable = [...focusRoot.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('keydown', handleNotebookEscape, true);
    document.addEventListener('editor:open-markdown-notebook', open);
    list.addEventListener('dragstart', (event) => event.preventDefault());
    window.addEventListener('blur', () => {
      if (noteDrag) finishNoteDrag({ cancel: true, immediate: true });
    });
    document.addEventListener('editor:languagechange', () => {
      dialog.lang = toolbarLanguage;
      if (!dialog.hidden) {
        if (noteDrag) finishNoteDrag({ cancel: true, immediate: true });
        renderList();
        captureCanvasSelection();
        const note = currentNote();
        if (!deleteConfirm.hidden && note && deleteConfirmTitle) {
          deleteConfirmTitle.textContent = copyWithTitle(
            'markdownNotebookDeleteTitle',
            noteTitle(note),
          );
        }
        schedulePreview();
      }
    });
    syncNotebookTopbarShortcut(notebookTopbarShortcutEnabled());
  })();

  // ── 镜头册：相机书签、跟随选区章节与只读演示 ──
  (function setupCanvasScenes() {
    const panel = document.querySelector('[data-role="canvas-scenes-panel"]');
    const panelHead = panel && panel.querySelector('.canvas-scenes-head');
    const list = panel && panel.querySelector('[data-role="canvas-scenes-list"]');
    const empty = panel && panel.querySelector('[data-role="canvas-scenes-empty"]');
    const count = panel && panel.querySelector('[data-role="canvas-scenes-count"]');
    const selectionStatus = panel && panel.querySelector('[data-role="canvas-scenes-selection-status"]');
    const message = panel && panel.querySelector('[data-role="canvas-scenes-message"]');
    const captureCameraButton = panel && panel.querySelector('[data-action="capture-camera-scene"]');
    const captureSelectionButton = panel && panel.querySelector('[data-action="capture-selection-scene"]');
    const captureGroupsButton = panel && panel.querySelector('[data-action="capture-group-scenes"]');
    const presentButton = panel && panel.querySelector('[data-action="present-canvas-scenes"]');
    const closeButton = panel && panel.querySelector('[data-action="close-canvas-scenes"]');
    const presentation = document.querySelector('[data-role="canvas-scenes-presentation"]');
    const presentationName = presentation
      && presentation.querySelector('[data-role="canvas-scenes-presentation-name"]');
    const presentationIndex = presentation
      && presentation.querySelector('[data-role="canvas-scenes-presentation-index"]');
    const restartButton = presentation
      && presentation.querySelector('[data-action="restart-canvas-scenes-presentation"]');
    const previousButton = presentation
      && presentation.querySelector('[data-action="previous-canvas-scene"]');
    const nextButton = presentation
      && presentation.querySelector('[data-action="next-canvas-scene"]');
    const exitButton = presentation
      && presentation.querySelector('[data-action="exit-canvas-scenes-presentation"]');
    const undoToast = document.querySelector('[data-role="canvas-scenes-undo"]');
    const undoButton = undoToast
      && undoToast.querySelector('[data-action="undo-delete-canvas-scene"]');
    const Scenes = window.RelatumCanvasScenes;
    if (!panel || !panelHead || !list || !empty || !presentation || !undoToast || !Scenes) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const PANEL_POSITION_KEY = 'canvas:sceneBookPanelPosition:v1';
    const PANEL_EDGE_GAP = 10;
    const PANEL_SNAP_DISTANCE = 24;
    let activeId = '';
    let presentationIndexValue = -1;
    let presenting = false;
    let closeTimer = 0;
    let messageTimer = 0;
    let geometryTimer = 0;
    let selectionTimer = 0;
    let undoTimer = 0;
    let undoState = null;
    let dragState = null;
    let panelDragState = null;
    let renameState = null;
    let hudTimer = 0;
    const sceneFlipAnimations = new Map();

    function api() {
      return window.CanvasModule || null;
    }

    function reducedMotion() {
      return !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function narrowSceneLayout() {
      return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
    }

    function readPanelPosition() {
      try {
        const parsed = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        const left = Number(parsed && parsed.left);
        const top = Number(parsed && parsed.top);
        return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
      } catch (error) {
        return null;
      }
    }

    function savePanelPosition(left, top) {
      try {
        localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left, top }));
      } catch (error) {}
    }

    function panelPositionLimits() {
      const rect = panel.getBoundingClientRect();
      return {
        minLeft: PANEL_EDGE_GAP,
        maxLeft: Math.max(PANEL_EDGE_GAP, window.innerWidth - rect.width - PANEL_EDGE_GAP),
        minTop: PANEL_EDGE_GAP,
        maxTop: Math.max(PANEL_EDGE_GAP, window.innerHeight - rect.height - PANEL_EDGE_GAP),
      };
    }

    function applyPanelPosition(left, top, persist, snapHorizontal) {
      if (narrowSceneLayout()) return null;
      const limits = panelPositionLimits();
      let nextLeft = Math.max(limits.minLeft, Math.min(limits.maxLeft, Number(left)));
      const nextTop = Math.max(limits.minTop, Math.min(limits.maxTop, Number(top)));
      if (!Number.isFinite(nextLeft) || !Number.isFinite(nextTop)) return null;
      if (snapHorizontal) {
        if (Math.abs(nextLeft - limits.minLeft) <= PANEL_SNAP_DISTANCE) {
          nextLeft = limits.minLeft;
        } else if (Math.abs(nextLeft - limits.maxLeft) <= PANEL_SNAP_DISTANCE) {
          nextLeft = limits.maxLeft;
        }
      }
      panel.style.setProperty('--canvas-scenes-left', nextLeft + 'px');
      panel.style.setProperty('--canvas-scenes-top', nextTop + 'px');
      if (persist) savePanelPosition(nextLeft, nextTop);
      return { left: nextLeft, top: nextTop };
    }

    function restorePanelPosition() {
      if (narrowSceneLayout()) return;
      const saved = readPanelPosition();
      if (saved) applyPanelPosition(saved.left, saved.top, false);
      else {
        panel.style.removeProperty('--canvas-scenes-left');
        panel.style.removeProperty('--canvas-scenes-top');
      }
    }

    function positionPanelDragFrame() {
      const state = panelDragState;
      if (!state || !state.active) return;
      state.frame = 0;
      applyPanelPosition(
        state.startLeft + state.pendingX - state.startX,
        state.startTop + state.pendingY - state.startY,
        false,
        true,
      );
    }

    function schedulePanelDragFrame(clientX, clientY) {
      if (!panelDragState) return;
      panelDragState.pendingX = clientX;
      panelDragState.pendingY = clientY;
      if (!panelDragState.frame) {
        panelDragState.frame = window.requestAnimationFrame(positionPanelDragFrame);
      }
    }

    function activatePanelDrag() {
      const state = panelDragState;
      if (!state || state.active) return;
      state.active = true;
      try { panelHead.setPointerCapture(state.pointerId); } catch (error) {}
      panel.classList.add('is-moving');
      document.body.classList.add('canvas-scenes-panel-moving');
    }

    function onPanelDragMove(event) {
      if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;
      const dx = event.clientX - panelDragState.startX;
      const dy = event.clientY - panelDragState.startY;
      if (!panelDragState.active) {
        if (Math.hypot(dx, dy) < 6) return;
        activatePanelDrag();
      }
      event.preventDefault();
      schedulePanelDragFrame(event.clientX, event.clientY);
    }

    function clearPanelDragListeners(state) {
      window.removeEventListener('pointermove', onPanelDragMove);
      window.removeEventListener('pointerup', onPanelDragEnd);
      window.removeEventListener('pointercancel', onPanelDragCancel);
      if (state && state.frame) window.cancelAnimationFrame(state.frame);
      if (state) state.frame = 0;
      try {
        if (state) panelHead.releasePointerCapture(state.pointerId);
      } catch (error) {}
    }

    function finishPanelDrag(cancel) {
      const state = panelDragState;
      if (!state) return false;
      panelDragState = null;
      clearPanelDragListeners(state);
      panel.classList.remove('is-moving');
      document.body.classList.remove('canvas-scenes-panel-moving');
      if (!state.active) return false;
      if (cancel) {
        applyPanelPosition(state.startLeft, state.startTop, false);
        return true;
      }
      const rect = panel.getBoundingClientRect();
      applyPanelPosition(rect.left, rect.top, true, true);
      return true;
    }

    function onPanelDragEnd(event) {
      if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;
      if (panelDragState.active) {
        if (panelDragState.frame) {
          window.cancelAnimationFrame(panelDragState.frame);
          panelDragState.frame = 0;
        }
        applyPanelPosition(
          panelDragState.startLeft + event.clientX - panelDragState.startX,
          panelDragState.startTop + event.clientY - panelDragState.startY,
          false,
          true,
        );
      }
      finishPanelDrag(false);
    }

    function onPanelDragCancel(event) {
      if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;
      finishPanelDrag(true);
    }

    function beginPanelDrag(event) {
      if (event.button !== 0 || narrowSceneLayout() || panelDragState || dragState) return;
      if (event.target.closest('button, input, textarea, select, a')) return;
      const rect = panel.getBoundingClientRect();
      panelDragState = {
        pointerId: event.pointerId,
        active: false,
        frame: 0,
        startX: event.clientX,
        startY: event.clientY,
        pendingX: event.clientX,
        pendingY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      window.addEventListener('pointermove', onPanelDragMove, { passive: false });
      window.addEventListener('pointerup', onPanelDragEnd);
      window.addEventListener('pointercancel', onPanelDragCancel);
    }

    function resetPanelPosition(event) {
      if (event && event.target.closest('button, input, textarea, select, a')) return;
      if (narrowSceneLayout() || panelDragState) return;
      try { localStorage.removeItem(PANEL_POSITION_KEY); } catch (error) {}
      panel.classList.add('is-resetting');
      panel.getBoundingClientRect();
      panel.style.removeProperty('--canvas-scenes-left');
      panel.style.removeProperty('--canvas-scenes-top');
      window.setTimeout(() => panel.classList.remove('is-resetting'), 230);
    }

    function copy(key, replacements) {
      let value = toolbarCopy(key);
      Object.keys(replacements || {}).forEach((name) => {
        value = value.replace('{' + name + '}', String(replacements[name]));
      });
      return value;
    }

    function currentBook() {
      if (!canvasData || typeof canvasData !== 'object') return Scenes.normalizeBook(null);
      return Scenes.normalizeBook(canvasData.sceneBook);
    }

    function commitBook(book) {
      if (!canvasData || typeof canvasData !== 'object') return false;
      const normalized = Scenes.normalizeBook(book);
      if (normalized.scenes.length) canvasData.sceneBook = normalized;
      else delete canvasData.sceneBook;
      markDirty();
      render();
      return true;
    }

    function sceneInsets() {
      if (!viewportEl || panel.hidden || presenting) {
        return { left: 0, right: 0, top: 0, bottom: 0 };
      }
      const viewportRect = viewportEl.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      if (narrowSceneLayout()) {
        return {
          left: 0,
          right: 0,
          top: 0,
          bottom: Math.max(0, viewportRect.bottom - panelRect.top + 12),
        };
      }
      const panelCenter = panelRect.left + panelRect.width / 2;
      const viewportCenter = viewportRect.left + viewportRect.width / 2;
      if (panelCenter <= viewportCenter) {
        return {
          left: Math.max(0, panelRect.right - viewportRect.left + 12),
          right: 0,
          top: 0,
          bottom: 0,
        };
      }
      return {
        left: 0,
        right: Math.max(0, viewportRect.right - panelRect.left + 12),
        top: 0,
        bottom: 0,
      };
    }

    function focusViewport() {
      if (!viewportEl) return;
      if (!viewportEl.hasAttribute('tabindex')) {
        viewportEl.setAttribute('tabindex', '-1');
        viewportEl.dataset.sceneFocusTarget = 'true';
      }
      try { viewportEl.focus({ preventScroll: true }); } catch (error) { viewportEl.focus(); }
    }

    function showMessage(text, tone) {
      if (!message) return;
      if (messageTimer) window.clearTimeout(messageTimer);
      message.textContent = text || '';
      message.dataset.tone = tone || '';
      if (!text) return;
      messageTimer = window.setTimeout(() => {
        messageTimer = 0;
        message.textContent = '';
        delete message.dataset.tone;
      }, 2600);
    }

    function defaultTitle(index) {
      return copy('canvasScenesDefaultName', { count: index + 1 });
    }

    function capture(source) {
      const canvasApi = api();
      if (!canvasApi || typeof canvasApi.captureScene !== 'function') return null;
      try {
        return canvasApi.captureScene({ source: source, insets: sceneInsets() });
      } catch (error) {
        console.warn('[Scenes] capture failed', error);
        return null;
      }
    }

    function createFromSeed(seed, title, book) {
      return Scenes.createScene({
        title: String(title || seed.titleHint || defaultTitle(book.scenes.length)).trim(),
        kind: seed.kind,
        camera: seed.camera,
        anchorNodeIds: seed.anchorNodeIds,
        anchorGroupIds: seed.anchorGroupIds,
      });
    }

    function createScene(source) {
      const seed = capture(source);
      if (!seed) {
        showMessage(copy('canvasScenesUnavailable'), 'error');
        return;
      }
      if (!seed.ok) {
        showMessage(copy('canvasScenesNoSelection'), 'error');
        refreshSelectionStatus();
        return;
      }
      const book = currentBook();
      const scene = createFromSeed(seed, seed.titleHint, book);
      book.scenes.push(scene);
      activeId = scene.id;
      commitBook(book);
      showMessage(copy('canvasScenesCreated'), 'success');
    }

    function createGroupScenes() {
      const canvasApi = api();
      if (!canvasApi || typeof canvasApi.captureSelectedGroupsAsScenes !== 'function') {
        showMessage(copy('canvasScenesUnavailable'), 'error');
        return;
      }
      let seeds = [];
      try {
        seeds = canvasApi.captureSelectedGroupsAsScenes({ insets: sceneInsets() }) || [];
      } catch (error) {
        console.warn('[Scenes] group capture failed', error);
      }
      if (!seeds.length) {
        showMessage(copy('canvasScenesNoGroups'), 'error');
        return;
      }
      const book = currentBook();
      seeds.forEach((seed) => {
        const scene = createFromSeed(seed, seed.titleHint, book);
        book.scenes.push(scene);
        activeId = scene.id;
      });
      commitBook(book);
      showMessage(copy('canvasScenesGroupsCreated', { count: seeds.length }), 'success');
    }

    function navigate(scene, options) {
      const canvasApi = api();
      if (!canvasApi || typeof canvasApi.navigateToScene !== 'function') return false;
      try {
        canvasApi.navigateToScene(scene, Object.assign({
          insets: presenting ? null : sceneInsets(),
        }, options || {}));
        activeId = scene.id;
        if (!presenting) renderActiveState();
        return true;
      } catch (error) {
        console.warn('[Scenes] navigation failed', error);
        return false;
      }
    }

    function previewGeometry(scene) {
      const canvasApi = api();
      if (!canvasApi || typeof canvasApi.getScenePreviewGeometry !== 'function') return null;
      try {
        return canvasApi.getScenePreviewGeometry(scene, { insets: sceneInsets() });
      } catch (error) {
        return null;
      }
    }

    function svgElement(name, attributes) {
      const element = document.createElementNS(SVG_NS, name);
      Object.keys(attributes || {}).forEach((key) => {
        element.setAttribute(key, String(attributes[key]));
      });
      return element;
    }

    function createThumbnail(scene, geometry) {
      const wrap = document.createElement('span');
      wrap.className = 'canvas-scene-thumb';
      wrap.setAttribute('aria-hidden', 'true');
      const svg = svgElement('svg', { viewBox: '0 0 168 94', preserveAspectRatio: 'xMidYMid meet' });
      wrap.appendChild(svg);
      if (!geometry || !geometry.bounds) return wrap;
      const bounds = geometry.bounds;
      const width = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
      const height = Math.max(1, Number(bounds.maxY) - Number(bounds.minY));
      const scale = Math.min(150 / width, 76 / height);
      const offsetX = 84 - width * scale / 2;
      const offsetY = 47 - height * scale / 2;
      const byId = new Map();
      (geometry.nodes || []).forEach((node) => byId.set(node.id, node));
      const point = (node) => ({
        x: offsetX + (node.x - bounds.minX + node.w / 2) * scale,
        y: offsetY + (node.y - bounds.minY + node.h / 2) * scale,
      });
      (geometry.edges || []).forEach((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return;
        const a = point(from);
        const b = point(to);
        svg.appendChild(svgElement('line', {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'canvas-scene-thumb-edge',
        }));
      });
      (geometry.nodes || []).forEach((node) => {
        const x = offsetX + (node.x - bounds.minX) * scale;
        const y = offsetY + (node.y - bounds.minY) * scale;
        svg.appendChild(svgElement('rect', {
          x: x,
          y: y,
          width: Math.max(3, node.w * scale),
          height: Math.max(2.4, node.h * scale),
          rx: Math.min(4, Math.max(1, 3 * scale)),
          class: node.group ? 'canvas-scene-thumb-group' : 'canvas-scene-thumb-node',
        }));
      });
      return wrap;
    }

    function sceneBadge(scene, geometry) {
      if (scene.kind !== 'selection') return copy('canvasScenesCamera');
      if (geometry && geometry.usedFallback) return copy('canvasScenesMissing');
      if (geometry && geometry.missingCount) return copy('canvasScenesPartialMissing');
      return copy('canvasScenesFollow');
    }

    function iconButton(action, label, path) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      button.setAttribute('aria-label', label);
      button.title = label;
      const svg = svgElement('svg', { viewBox: '0 0 18 18', 'aria-hidden': 'true' });
      svg.appendChild(svgElement('path', { d: path }));
      button.appendChild(svg);
      return button;
    }

    function sceneCard(scene, index) {
      const geometry = previewGeometry(scene);
      const card = document.createElement('article');
      card.className = 'canvas-scene-card';
      card.dataset.sceneId = scene.id;
      card.setAttribute('role', 'listitem');
      if (scene.id === activeId) card.classList.add('active');
      if (geometry && geometry.usedFallback) card.classList.add('is-missing');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'canvas-scene-main';
      main.dataset.action = 'navigate-canvas-scene';
      main.appendChild(createThumbnail(scene, geometry));

      const meta = document.createElement('span');
      meta.className = 'canvas-scene-meta';
      const heading = document.createElement('span');
      heading.className = 'canvas-scene-heading';
      const sequence = document.createElement('span');
      sequence.className = 'canvas-scene-sequence';
      sequence.setAttribute('aria-hidden', 'true');
      sequence.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('strong');
      title.className = 'canvas-scene-title';
      title.textContent = scene.title || copy('canvasScenesUntitled');
      const badge = document.createElement('span');
      badge.className = 'canvas-scene-badge';
      badge.textContent = sceneBadge(scene, geometry);
      heading.append(sequence, title);
      meta.append(heading, badge);
      main.appendChild(meta);
      if (scene.id === activeId) main.setAttribute('aria-current', 'true');

      const actions = document.createElement('div');
      actions.className = 'canvas-scene-actions';
      const grip = iconButton(
        'drag-canvas-scene',
        copy('canvasScenesList'),
        'M6 4.5h.01M6 9h.01M6 13.5h.01M12 4.5h.01M12 9h.01M12 13.5h.01',
      );
      grip.className = 'canvas-scene-grip';
      grip.dataset.sceneGrip = 'true';
      const update = iconButton(
        'update-canvas-scene',
        copy('canvasScenesUpdate'),
        'M14.2 6.5A5.6 5.6 0 1 0 15 10M14.2 3.5v3h-3',
      );
      const rename = iconButton(
        'rename-canvas-scene',
        copy('canvasScenesRename'),
        'm4 13.8.7-3.1 6.8-6.8 2.4 2.4-6.8 6.8zM10.7 4.7l2.4 2.4',
      );
      const remove = iconButton(
        'delete-canvas-scene',
        copy('canvasScenesDelete'),
        'M4.5 5.5h9M7 5.5v-2h4v2M6 7.5v6M9 7.5v6M12 7.5v6M5.3 5.5l.5 9h6.4l.5-9',
      );
      actions.append(grip, update, rename, remove);
      card.append(main, actions);
      return card;
    }

    function renderActiveState() {
      list.querySelectorAll('[data-scene-id]').forEach((card) => {
        const active = card.dataset.sceneId === activeId;
        card.classList.toggle('active', active);
        const main = card.querySelector('.canvas-scene-main');
        if (!main) return;
        if (active) main.setAttribute('aria-current', 'true');
        else main.removeAttribute('aria-current');
      });
    }

    function render() {
      if (panel.hidden || dragState || renameState) return;
      const book = currentBook();
      if (activeId && !book.scenes.some((scene) => scene.id === activeId)) activeId = '';
      const fragment = document.createDocumentFragment();
      book.scenes.forEach((scene, index) => fragment.appendChild(sceneCard(scene, index)));
      list.replaceChildren(fragment);
      empty.hidden = book.scenes.length > 0;
      list.hidden = book.scenes.length === 0;
      if (count) count.textContent = String(book.scenes.length);
      if (presentButton) presentButton.disabled = book.scenes.length === 0;
    }

    function refreshSelectionStatus() {
      if (panel.hidden || presenting) return;
      const seed = capture('selection');
      if (!seed || !seed.ok) {
        if (selectionStatus) selectionStatus.textContent = copy('canvasScenesSelectionHint');
        if (captureSelectionButton) captureSelectionButton.disabled = true;
        return;
      }
      const selectedCount = (seed.anchorNodeIds || []).length + (seed.anchorGroupIds || []).length;
      let label = copy('canvasScenesSelectionReady', { count: selectedCount });
      if (seed.ignoredCount) {
        label += copy('canvasScenesIgnored', { count: seed.ignoredCount });
      }
      if (selectionStatus) selectionStatus.textContent = label;
      if (captureSelectionButton) captureSelectionButton.disabled = false;
    }

    function scheduleSelectionRefresh() {
      if (selectionTimer) window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        selectionTimer = 0;
        refreshSelectionStatus();
      }, 40);
    }

    function scheduleGeometryRefresh() {
      if (geometryTimer) window.clearTimeout(geometryTimer);
      geometryTimer = window.setTimeout(() => {
        geometryTimer = 0;
        if (!panel.hidden && !presenting && !dragState && !renameState) render();
      }, 140);
    }

    function open() {
      if (closeTimer) {
        window.clearTimeout(closeTimer);
        closeTimer = 0;
      }
      panel.hidden = false;
      restorePanelPosition();
      panel.classList.remove('is-closing');
      document.body.classList.add('canvas-scenes-open');
      requestAnimationFrame(() => panel.classList.add('is-open'));
      render();
      scheduleSelectionRefresh();
    }

    function close(options) {
      const settings = options || {};
      if (presenting) exitPresentation({ focus: false });
      if (dragState) finishDrag({ cancel: true, immediate: true });
      if (panelDragState) finishPanelDrag(true);
      finishRename(false);
      document.body.classList.remove('canvas-scenes-open');
      panel.classList.remove('is-open');
      panel.classList.add('is-closing');
      const finish = () => {
        closeTimer = 0;
        panel.hidden = true;
        panel.classList.remove('is-closing');
        if (settings.focus !== false) focusViewport();
      };
      if (settings.immediate || reducedMotion()) finish();
      else closeTimer = window.setTimeout(finish, 170);
    }

    function sceneById(id) {
      return currentBook().scenes.find((scene) => scene.id === id) || null;
    }

    function updateScene(scene) {
      if (!scene) return;
      const source = scene.kind === 'selection' ? 'selection' : 'camera';
      const seed = capture(source);
      if (!seed || !seed.ok) {
        showMessage(source === 'selection'
          ? copy('canvasScenesNoSelection') : copy('canvasScenesUnavailable'), 'error');
        return;
      }
      const book = currentBook();
      const index = book.scenes.findIndex((item) => item.id === scene.id);
      if (index < 0) return;
      book.scenes[index] = Scenes.updateScene(scene, {
        kind: seed.kind,
        camera: seed.camera,
        anchorNodeIds: seed.anchorNodeIds,
        anchorGroupIds: seed.anchorGroupIds,
      });
      commitBook(book);
      showMessage(copy('canvasScenesUpdated'), 'success');
    }

    function beginRename(scene, card) {
      finishRename(false);
      const title = card && card.querySelector('.canvas-scene-title');
      if (!title) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 80;
      input.value = scene.title || '';
      input.className = 'canvas-scene-title-input';
      input.setAttribute('aria-label', copy('canvasScenesRename'));
      title.hidden = true;
      title.after(input);
      card.classList.add('is-renaming');
      renameState = { sceneId: scene.id, card: card, title: title, input: input };
      input.focus();
      input.select();
    }

    function finishRename(saveChange) {
      const state = renameState;
      if (!state) return;
      renameState = null;
      const value = state.input.value.trim();
      state.input.remove();
      state.title.hidden = false;
      state.card.classList.remove('is-renaming');
      if (!saveChange) return;
      const book = currentBook();
      const index = book.scenes.findIndex((scene) => scene.id === state.sceneId);
      if (index < 0) return;
      const previous = book.scenes[index];
      const nextTitle = value || copy('canvasScenesUntitled');
      if (nextTitle === previous.title) return;
      book.scenes[index] = Scenes.updateScene(previous, { title: nextTitle });
      commitBook(book);
    }

    function hideUndo() {
      if (undoTimer) window.clearTimeout(undoTimer);
      undoTimer = 0;
      undoState = null;
      undoToast.classList.remove('is-visible');
      const finish = () => { undoToast.hidden = true; };
      if (reducedMotion()) finish();
      else window.setTimeout(finish, 150);
    }

    function deleteScene(scene) {
      if (!scene) return;
      const book = currentBook();
      const index = book.scenes.findIndex((item) => item.id === scene.id);
      if (index < 0) return;
      undoState = { scene: book.scenes[index], index: index };
      book.scenes.splice(index, 1);
      if (activeId === scene.id) activeId = '';
      commitBook(book);
      undoToast.hidden = false;
      requestAnimationFrame(() => undoToast.classList.add('is-visible'));
      if (undoTimer) window.clearTimeout(undoTimer);
      undoTimer = window.setTimeout(hideUndo, 5200);
    }

    function undoDelete() {
      if (!undoState) return;
      const state = undoState;
      if (undoTimer) window.clearTimeout(undoTimer);
      undoTimer = 0;
      const book = currentBook();
      book.scenes.splice(Math.max(0, Math.min(state.index, book.scenes.length)), 0, state.scene);
      activeId = state.scene.id;
      undoState = null;
      undoToast.classList.remove('is-visible');
      undoToast.hidden = true;
      commitBook(book);
    }

    function sceneRows() {
      return [...list.querySelectorAll('.canvas-scene-card[data-scene-id]')];
    }

    function syncSceneSequenceLabels() {
      sceneRows().forEach((row, index) => {
        const sequence = row.querySelector('.canvas-scene-sequence');
        if (sequence) sequence.textContent = String(index + 1).padStart(2, '0');
      });
      if (dragState && dragState.ghost) {
        const source = dragState.row.querySelector('.canvas-scene-sequence');
        const ghost = dragState.ghost.querySelector('.canvas-scene-sequence');
        if (source && ghost) ghost.textContent = source.textContent;
      }
    }

    function stopSceneFlipAnimations() {
      sceneFlipAnimations.forEach((animation) => animation.cancel());
      sceneFlipAnimations.clear();
    }

    function flipSceneRows(mutate) {
      if (reducedMotion()) {
        mutate();
        return;
      }
      const rows = sceneRows();
      const before = new Map();
      rows.forEach((row) => before.set(row, row.getBoundingClientRect()));
      mutate();
      rows.forEach((row) => {
        const animation = sceneFlipAnimations.get(row);
        if (animation) animation.cancel();
      });
      rows.forEach((row) => {
        if (dragState && row === dragState.row) return;
        const oldRect = before.get(row);
        if (!oldRect) return;
        const nextRect = row.getBoundingClientRect();
        const dx = oldRect.left - nextRect.left;
        const dy = oldRect.top - nextRect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        const distance = Math.hypot(dx, dy);
        const animation = row.animate([
          { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
          { transform: 'translate3d(0,0,0)' },
        ], {
          duration: Math.max(170, Math.min(280, 160 + distance * 0.28)),
          easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)',
        });
        sceneFlipAnimations.set(row, animation);
        animation.finished.catch(() => undefined).then(() => {
          if (sceneFlipAnimations.get(row) === animation) sceneFlipAnimations.delete(row);
        });
      });
    }

    function clearTextSelection() {
      const selection = window.getSelection && window.getSelection();
      if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
    }

    function positionSceneDragGhost(state, clientX, clientY) {
      if (!state || !state.ghost) return;
      const left = clientX - state.offsetX;
      const top = clientY - state.offsetY;
      state.ghostLeft = left;
      state.ghostTop = top;
      state.ghost.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale(1.028)';
      state.ghost.dataset.dragLeft = String(left);
      state.ghost.dataset.dragTop = String(top);
    }

    function sceneInsertPoint(clientY) {
      if (!dragState) return null;
      const rows = sceneRows().filter((row) => row !== dragState.row);
      let beforeNode = null;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          beforeNode = row;
          break;
        }
      }
      return beforeNode;
    }

    function liveReorderScene(clientY) {
      if (!dragState) return;
      const beforeNode = sceneInsertPoint(clientY);
      if (dragState.row.nextElementSibling === beforeNode) return;
      flipSceneRows(() => {
        list.insertBefore(dragState.row, beforeNode);
        syncSceneSequenceLabels();
      });
    }

    function sceneEdgeScroll(clientY) {
      const rect = list.getBoundingClientRect();
      const edge = Math.min(42, Math.max(28, rect.height * 0.12));
      let velocity = 0;
      if (clientY < rect.top + edge) {
        velocity = -Math.ceil(10 * (rect.top + edge - clientY) / edge);
      } else if (clientY > rect.bottom - edge) {
        velocity = Math.ceil(10 * (clientY - (rect.bottom - edge)) / edge);
      }
      if (!velocity) return false;
      const previous = list.scrollTop;
      list.scrollTop += velocity;
      return Math.abs(list.scrollTop - previous) > 0.5;
    }

    function runSceneDragFrame() {
      const state = dragState;
      if (!state || !state.active) return;
      state.frame = 0;
      positionSceneDragGhost(state, state.pendingX, state.pendingY);
      const scrolled = sceneEdgeScroll(state.pendingY);
      liveReorderScene(state.pendingY);
      if (scrolled && dragState === state) {
        state.frame = window.requestAnimationFrame(runSceneDragFrame);
      }
    }

    function scheduleSceneDragFrame(clientX, clientY) {
      if (!dragState) return;
      dragState.pendingX = clientX;
      dragState.pendingY = clientY;
      if (!dragState.frame) {
        dragState.frame = window.requestAnimationFrame(runSceneDragFrame);
      }
    }

    function activateSceneDrag() {
      const state = dragState;
      if (!state || state.active) return;
      try { state.handle.setPointerCapture(state.pointerId); } catch (error) {}
      stopSceneFlipAnimations();
      clearTextSelection();
      const ghost = state.row.cloneNode(true);
      const rowStyle = window.getComputedStyle(state.row);
      const panelStyle = window.getComputedStyle(panel);
      ghost.classList.add('canvas-scene-drag-ghost');
      ghost.classList.remove('active', 'is-renaming', 'is-drag-placeholder', 'is-drag-handoff');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.tabIndex = -1;
      ghost.style.width = state.width + 'px';
      ghost.style.height = state.height + 'px';
      ghost.style.color = rowStyle.color;
      [
        '--scene-surface',
        '--scene-workbench',
        '--scene-hover',
        '--scene-text',
        '--scene-muted',
        '--scene-border',
        '--scene-border-strong',
      ].forEach((name) => {
        const value = panelStyle.getPropertyValue(name).trim();
        if (value) ghost.style.setProperty(name, value);
      });
      ghost.style.background = panelStyle.getPropertyValue('--scene-surface').trim()
        || rowStyle.backgroundColor;
      ghost.style.borderColor = rowStyle.borderColor;
      ghost.style.transition = 'none';
      ghost.style.animation = 'none';
      state.ghost = ghost;
      positionSceneDragGhost(state, state.startX, state.startY);
      document.body.appendChild(ghost);
      state.active = true;
      state.row.classList.add('is-drag-placeholder');
      document.body.classList.add('canvas-scene-dragging');
    }

    function onDragMove(event) {
      const state = dragState;
      if (!state || event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.active) {
        if (Math.hypot(dx, dy) < 6) return;
        activateSceneDrag();
      }
      event.preventDefault();
      scheduleSceneDragFrame(event.clientX, event.clientY);
    }

    function clearDragListeners(state) {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragCancel);
      if (state && state.frame) window.cancelAnimationFrame(state.frame);
      if (state) state.frame = 0;
      try {
        if (state) state.handle.releasePointerCapture(state.pointerId);
      } catch (error) {}
    }

    function revealSceneLanding(row, ghost, immediate) {
      if (!row) {
        if (ghost) ghost.remove();
        return;
      }
      const ghostStyle = ghost ? window.getComputedStyle(ghost) : null;
      row.classList.add('is-drag-handoff');
      if (ghostStyle) {
        row.style.backgroundColor = ghostStyle.backgroundColor;
        row.style.borderColor = ghostStyle.borderColor;
        row.style.boxShadow = ghostStyle.boxShadow;
        row.style.color = ghostStyle.color;
      }
      row.classList.remove('is-drag-placeholder');
      if (ghost) ghost.remove();
      if (immediate || reducedMotion()) {
        row.classList.remove('is-drag-handoff');
        row.style.removeProperty('background-color');
        row.style.removeProperty('border-color');
        row.style.removeProperty('box-shadow');
        row.style.removeProperty('color');
        return;
      }
      window.requestAnimationFrame(() => {
        if (!row.isConnected) return;
        row.classList.remove('is-drag-handoff');
        window.requestAnimationFrame(() => {
          if (!row.isConnected) return;
          row.style.removeProperty('background-color');
          row.style.removeProperty('border-color');
          row.style.removeProperty('box-shadow');
          row.style.removeProperty('color');
        });
      });
    }

    function flySceneGhostTo(ghost, row, done) {
      if (!ghost || !row || reducedMotion()) {
        if (done) done();
        return;
      }
      const target = row.getBoundingClientRect();
      const ghostRect = ghost.getBoundingClientRect();
      const fromLeft = Number(ghost.dataset.dragLeft);
      const fromTop = Number(ghost.dataset.dragTop);
      const startLeft = Number.isFinite(fromLeft) ? fromLeft : ghostRect.left;
      const startTop = Number.isFinite(fromTop) ? fromTop : ghostRect.top;
      const distance = Math.hypot(target.left - startLeft, target.top - startTop);
      const ghostStyle = window.getComputedStyle(ghost);
      const targetStyle = window.getComputedStyle(row);
      const duration = distance < 8
        ? 130
        : Math.max(300, Math.min(470, 270 + distance * 0.18));
      const animation = ghost.animate([
        {
          transform: 'translate3d(' + startLeft + 'px,' + startTop + 'px,0) scale(1.028)',
          opacity: 1,
          backgroundColor: ghostStyle.backgroundColor,
          borderColor: ghostStyle.borderColor,
          boxShadow: ghostStyle.boxShadow,
        },
        {
          transform: 'translate3d(' + target.left + 'px,' + target.top + 'px,0) scale(1)',
          opacity: 1,
          backgroundColor: targetStyle.backgroundColor,
          borderColor: targetStyle.borderColor,
          boxShadow: targetStyle.boxShadow,
        },
      ], {
        duration,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      });
      animation.finished.catch(() => undefined).then(() => {
        if (done) done();
      });
    }

    function restoreOrder(ids) {
      const rows = new Map(sceneRows().map((row) => [row.dataset.sceneId, row]));
      ids.forEach((id) => {
        const row = rows.get(id);
        if (row) list.appendChild(row);
      });
      syncSceneSequenceLabels();
    }

    function finishDrag(options) {
      options = options || {};
      const state = dragState;
      if (!state) return false;
      dragState = null;
      clearDragListeners(state);
      document.body.classList.remove('canvas-scene-dragging');
      if (!state.active) return false;

      if (options.cancel) {
        if (options.immediate || reducedMotion()) {
          stopSceneFlipAnimations();
          restoreOrder(state.originalIds);
        } else {
          flipSceneRows(() => restoreOrder(state.originalIds));
        }
      }

      const orderedIds = sceneRows().map((row) => row.dataset.sceneId);
      const changed = !options.cancel
        && orderedIds.some((id, index) => id !== state.originalIds[index]);
      if (changed) {
        const next = Scenes.reorderScenes(currentBook(), orderedIds);
        if (canvasData && typeof canvasData === 'object') {
          canvasData.sceneBook = next;
          markDirty();
        }
      }

      const landingRow = list.querySelector(
        '[data-scene-id="' + CSS.escape(state.sceneId) + '"]',
      );
      if (landingRow) landingRow.classList.add('is-drag-placeholder');
      if (options.immediate) {
        stopSceneFlipAnimations();
        revealSceneLanding(landingRow, state.ghost, true);
      } else {
        flySceneGhostTo(state.ghost, landingRow, () => {
          revealSceneLanding(landingRow, state.ghost);
        });
      }
      return true;
    }

    function onDragEnd(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (dragState.active) {
        event.preventDefault();
        if (dragState.frame) {
          window.cancelAnimationFrame(dragState.frame);
          dragState.frame = 0;
        }
        positionSceneDragGhost(dragState, event.clientX, event.clientY);
        sceneEdgeScroll(event.clientY);
        liveReorderScene(event.clientY);
      }
      finishDrag();
    }

    function onDragCancel(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      finishDrag({ cancel: true });
    }

    function beginDrag(event, row, handle) {
      if (event.button !== 0 || dragState || panelDragState || renameState) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      dragState = {
        sceneId: row.dataset.sceneId,
        pointerId: event.pointerId,
        row,
        handle,
        active: false,
        ghost: null,
        frame: 0,
        startX: event.clientX,
        startY: event.clientY,
        pendingX: event.clientX,
        pendingY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        originalIds: sceneRows().map((item) => item.dataset.sceneId),
      };
      window.addEventListener('pointermove', onDragMove, { passive: false });
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragCancel);
    }

    function showPresentationHud() {
      if (!presenting) return;
      presentation.classList.remove('is-quiet');
      if (hudTimer) window.clearTimeout(hudTimer);
      hudTimer = window.setTimeout(() => {
        hudTimer = 0;
        presentation.classList.add('is-quiet');
      }, 2200);
    }

    function goToPresentationScene(index) {
      const scenes = currentBook().scenes;
      if (!scenes.length) {
        exitPresentation();
        return;
      }
      presentationIndexValue = Math.max(0, Math.min(index, scenes.length - 1));
      const scene = scenes[presentationIndexValue];
      activeId = scene.id;
      navigate(scene, { insets: null });
      if (presentationName) presentationName.textContent = scene.title;
      if (presentationIndex) {
        presentationIndex.textContent = (presentationIndexValue + 1) + ' / ' + scenes.length;
      }
      if (restartButton) restartButton.disabled = presentationIndexValue === 0;
      if (previousButton) previousButton.disabled = presentationIndexValue === 0;
      if (nextButton) nextButton.disabled = presentationIndexValue === scenes.length - 1;
      showPresentationHud();
    }

    function startPresentation() {
      const scenes = currentBook().scenes;
      if (!scenes.length) return;
      presenting = true;
      const selectedIndex = scenes.findIndex((scene) => scene.id === activeId);
      presentationIndexValue = selectedIndex >= 0 ? selectedIndex : 0;
      const canvasApi = api();
      if (canvasApi && typeof canvasApi.setScenePresentationMode === 'function') {
        canvasApi.setScenePresentationMode(true);
      }
      document.body.classList.add('canvas-scenes-presenting');
      presentation.hidden = false;
      requestAnimationFrame(() => presentation.classList.add('is-visible'));
      goToPresentationScene(presentationIndexValue);
    }

    function exitPresentation(options) {
      if (!presenting) return;
      presenting = false;
      if (hudTimer) window.clearTimeout(hudTimer);
      hudTimer = 0;
      const canvasApi = api();
      if (canvasApi && typeof canvasApi.setScenePresentationMode === 'function') {
        canvasApi.setScenePresentationMode(false);
      }
      document.body.classList.remove('canvas-scenes-presenting');
      presentation.classList.remove('is-visible', 'is-quiet');
      const finish = () => { if (!presenting) presentation.hidden = true; };
      if (reducedMotion()) finish();
      else window.setTimeout(finish, 170);
      renderActiveState();
      if (!options || options.focus !== false) focusViewport();
    }

    function handlePresentationKey(event) {
      if (!presenting) return false;
      let next = null;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        exitPresentation();
        return true;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        next = presentationIndexValue - 1;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown'
          || event.key === 'PageDown' || event.key === ' ') {
        next = presentationIndexValue + 1;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = currentBook().scenes.length - 1;
      }
      if (next === null) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      goToPresentationScene(next);
      return true;
    }

    list.addEventListener('click', (event) => {
      const card = event.target.closest('[data-scene-id]');
      if (!card) return;
      const scene = sceneById(card.dataset.sceneId);
      if (!scene) return;
      const action = event.target.closest('[data-action]');
      if (!action || action.dataset.action === 'navigate-canvas-scene') {
        navigate(scene);
        return;
      }
      if (action.dataset.action === 'update-canvas-scene') updateScene(scene);
      else if (action.dataset.action === 'rename-canvas-scene') beginRename(scene, card);
      else if (action.dataset.action === 'delete-canvas-scene') deleteScene(scene);
    });
    list.addEventListener('pointerdown', (event) => {
      const grip = event.target.closest('[data-scene-grip]');
      const row = grip && grip.closest('[data-scene-id]');
      if (grip && row) beginDrag(event, row, grip);
    });
    panelHead.addEventListener('pointerdown', beginPanelDrag);
    panelHead.addEventListener('dblclick', resetPanelPosition);
    list.addEventListener('dragstart', (event) => event.preventDefault());
    list.addEventListener('keydown', (event) => {
      if (!renameState || event.target !== renameState.input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        finishRename(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finishRename(false);
      }
    });
    list.addEventListener('focusout', (event) => {
      if (!renameState || event.target !== renameState.input) return;
      window.setTimeout(() => {
        if (renameState && document.activeElement !== renameState.input) finishRename(true);
      }, 0);
    });
    if (captureCameraButton) captureCameraButton.addEventListener('click', () => createScene('camera'));
    if (captureSelectionButton) captureSelectionButton.addEventListener('click', () => createScene('selection'));
    if (captureGroupsButton) captureGroupsButton.addEventListener('click', createGroupScenes);
    if (presentButton) presentButton.addEventListener('click', startPresentation);
    if (closeButton) closeButton.addEventListener('click', () => close());
    if (undoButton) undoButton.addEventListener('click', undoDelete);
    if (restartButton) restartButton.addEventListener('click', () => {
      goToPresentationScene(0);
    });
    if (previousButton) previousButton.addEventListener('click', () => {
      goToPresentationScene(presentationIndexValue - 1);
    });
    if (nextButton) nextButton.addEventListener('click', () => {
      goToPresentationScene(presentationIndexValue + 1);
    });
    if (exitButton) exitButton.addEventListener('click', () => exitPresentation());

    document.addEventListener('editor:open-canvas-scenes', open);
    document.addEventListener('canvas:scene-geometry-change', scheduleGeometryRefresh);
    document.addEventListener('editor:canvasready', () => {
      if (!panel.hidden) {
        render();
        refreshSelectionStatus();
      }
    });
    document.addEventListener('editor:languagechange', () => {
      if (!panel.hidden) {
        finishRename(false);
        render();
        refreshSelectionStatus();
      }
      if (presenting) goToPresentationScene(presentationIndexValue);
    });
    document.addEventListener('pointerup', () => {
      if (!panel.hidden && !dragState) scheduleSelectionRefresh();
    }, true);
    document.addEventListener('keyup', () => {
      if (!panel.hidden && !presenting) scheduleSelectionRefresh();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (handlePresentationKey(event)) return;
      if (event.key !== 'Escape') return;
      if (panelDragState) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishPanelDrag(true);
        return;
      }
      if (dragState) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishDrag({ cancel: true });
        return;
      }
      if (!panel.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (renameState) finishRename(false);
        else close();
      }
    }, true);
    document.addEventListener('pointermove', showPresentationHud, { passive: true });
    window.addEventListener('blur', () => {
      if (panelDragState) finishPanelDrag(true);
      if (dragState) finishDrag({ cancel: true, immediate: true });
    });
    window.addEventListener('resize', () => {
      if (!panel.hidden) {
        if (panelDragState) finishPanelDrag(true);
        const rect = panel.getBoundingClientRect();
        applyPanelPosition(rect.left, rect.top, true);
        scheduleGeometryRefresh();
        if (activeId && !presenting) {
          const scene = sceneById(activeId);
          if (scene) navigate(scene, { immediate: true });
        }
      }
    });
  })();

  // ── 任务簿 V3：单列顶级任务库 + 无拖动的树内就地管理 ──
  (function setupTaskbookV3() {
    const library = document.querySelector('[data-role="canvas-taskbook-dialog"]');
    const manager = document.querySelector('[data-role="task-root-dialog"]');
    const topbarShortcut = document.querySelector('[data-action="taskbook-shortcut"]');
    const topbarToggle = library && library.querySelector('[data-role="taskbook-topbar-toggle"]');
    if (!library || !manager || !topbarShortcut || !topbarToggle) return;

    const TOPBAR_SHORTCUT_KEY = 'canvas:taskbookTopbarShortcut';
    const activeList = library.querySelector('[data-role="taskbook-active-list"]');
    const completedList = library.querySelector('[data-role="taskbook-completed-list"]');
    const activeCount = library.querySelector('[data-role="taskbook-active-count"]');
    const completedCount = library.querySelector('[data-role="taskbook-completed-count"]');
    const libraryEmpty = library.querySelector('[data-role="taskbook-library-empty"]');
    const libraryHelp = library.querySelector('[data-role="taskbook-help"]');
    const libraryHelpToggle = library.querySelector('[data-action="toggle-taskbook-help"]');
    const libraryMessage = library.querySelector('[data-role="canvas-taskbook-message"]');
    const libraryConfirm = library.querySelector('[data-role="canvas-taskbook-confirm"]');
    const libraryConfirmTitle = library.querySelector('[data-role="canvas-taskbook-confirm-title"]');
    const libraryConfirmCopy = library.querySelector('[data-role="canvas-taskbook-confirm-copy"]');
    const libraryConfirmAccept = library.querySelector('[data-action="accept-taskbook-confirm"]');

    const rootTitle = manager.querySelector('[data-role="task-root-title"]');
    const rootProgress = manager.querySelector('[data-role="task-root-progress"]');
    const rootTime = manager.querySelector('[data-role="task-root-time"]');
    const rootRun = manager.querySelector('[data-action="toggle-task-root-root"]');
    const tree = manager.querySelector('[data-role="task-root-tree"]');
    const detailForm = manager.querySelector('[data-role="task-root-detail-form"]');
    const detailPath = manager.querySelector('[data-role="task-root-task-path"]');
    const detailTitle = manager.querySelector('[data-role="task-root-task-title"]');
    const detailBody = manager.querySelector('[data-role="task-root-task-body"]');
    const detailTime = manager.querySelector('[data-role="task-root-task-time"]');
    const detailToggle = manager.querySelector('[data-action="toggle-task-root-task"]');
    const detailLocate = manager.querySelector('[data-action="locate-task-root-task"]');
    const detailArchive = manager.querySelector('[data-action="archive-current-task-root"]');
    const managerMessage = manager.querySelector('[data-role="task-root-message"]');
    const taskConfirm = manager.querySelector('[data-role="task-root-confirm"]');
    const taskConfirmTitle = manager.querySelector('[data-role="task-root-confirm-title"]');
    const taskConfirmCopy = manager.querySelector('[data-role="task-root-confirm-copy"]');
    const taskConfirmAccept = manager.querySelector('[data-action="accept-task-root-confirm"]');

    let activeRootId = '';
    let selectedTaskId = '';
    let editingRootId = '';
    let confirmAction = null;
    let archiveBusy = false;
    const archiveAttemptIds = new Map();

    function api() {
      return window.CanvasModule || null;
    }

    function t(zh, en) {
      return toolbarLanguage === 'en' ? en : zh;
    }

    function taskbookTopbarShortcutEnabled() {
      if (EMBED) return false;
      try { return localStorage.getItem(TOPBAR_SHORTCUT_KEY) === '1'; }
      catch (error) { return false; }
    }

    function syncTaskbookTopbarShortcut(enabled) {
      const visible = !EMBED && !!enabled;
      const dialogOpen = visible && !library.hidden
        && !library.classList.contains('tool-layer-leaving');
      topbarToggle.checked = visible;
      topbarShortcut.hidden = !visible;
      topbarShortcut.classList.toggle('open', dialogOpen);
      topbarShortcut.setAttribute('aria-expanded', dialogOpen ? 'true' : 'false');
    }

    function setTaskbookTopbarShortcut(enabled) {
      const visible = !EMBED && !!enabled;
      try {
        if (visible) localStorage.setItem(TOPBAR_SHORTCUT_KEY, '1');
        else localStorage.removeItem(TOPBAR_SHORTCUT_KEY);
      } catch (error) {}
      syncTaskbookTopbarShortcut(visible);
    }

    function snapshots() {
      const canvasApi = api();
      return canvasApi && typeof canvasApi.listTaskbooks === 'function'
        ? (canvasApi.listTaskbooks() || []) : [];
    }

    function snapshot(rootId) {
      const canvasApi = api();
      return canvasApi && typeof canvasApi.getTaskbookSnapshot === 'function'
        ? canvasApi.getTaskbookSnapshot(rootId) : null;
    }

    function formatTime(value) {
      const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const rest = seconds % 60;
      return hours
        ? String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
        : String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0');
    }

    function setExternalOverlay(open) {
      const canvasApi = api();
      if (canvasApi && typeof canvasApi.setExternalOverlayOpen === 'function') {
        canvasApi.setExternalOverlayOpen(!!open);
      }
    }

    function focusViewport() {
      if (!viewportEl) return;
      if (!viewportEl.hasAttribute('tabindex')) viewportEl.setAttribute('tabindex', '-1');
      try { viewportEl.focus({ preventScroll: true }); } catch (error) { viewportEl.focus(); }
    }

    function announce(element, value, kind) {
      if (!element) return;
      clearTimeout(element._taskbookTimer);
      element.textContent = value || '';
      element.dataset.kind = kind || '';
      if (value) {
        element._taskbookTimer = setTimeout(function () { element.textContent = ''; }, 2600);
      }
    }

    function localize() {
      const set = function (selector, zh, en) {
        const element = document.querySelector(selector);
        if (element) element.textContent = t(zh, en);
      };
      set('#canvas-taskbook-title', '任务簿', 'Taskbook');
      set('[data-role="taskbook-active-label"]', '进行中', 'In progress');
      set('[data-role="taskbook-completed-label"]', '已完成', 'Completed');
      set('[data-role="taskbook-library-empty"] strong', '还没有顶级任务', 'No top-level tasks yet');
      set('[data-role="taskbook-library-empty"] p', '按右上角“+”开始。任务不会自动放到画布。', 'Use “+” to begin. Tasks are not placed automatically.');
      set('[data-role="taskbook-help-title"]', '快速上手', 'Quick start');
      set('[data-role="taskbook-help-create"]', '点击右上角“+”新建顶级任务，再把它放到画布。', 'Use “+” to create a top-level task, then place it on the canvas.');
      set('[data-role="taskbook-help-connect"]', '从顶级任务或已有任务连向普通卡片，把卡片收为子任务。', 'Connect a top-level or existing task to a regular card to make it a subtask.');
      set('[data-role="taskbook-help-time"]', '悬停叶子任务，点击左侧“▶”开始计时；点击“Ⅱ”暂停。', 'Hover a leaf task and use the left “▶” to start timing; use “Ⅱ” to pause.');
      set('[data-role="taskbook-help-manage"]', '双击顶级任务，或选中后按 F，进入任务管理页；按 F 或 Esc 返回。', 'Double-click a top-level task, or select it and press F, to open task management; press F or Esc to return.');
      set('[data-role="taskbook-help-finish"]', '勾选叶子任务完成；全部完成后可以归档。画布上的“×”仅隐藏任务树，任务簿行内“×”才会删除顶级任务。', 'Check off leaf tasks; archive after all are done. The canvas “×” only hides the task tree, while the Taskbook row “×” deletes the top-level task.');
      set('.task-root-manager-title span', '顶级任务', 'Top-level task');
      set('.task-root-detail-form > label:not(.task-root-detail-body) > span', '任务名称', 'Task name');
      set('.task-root-detail-body > span', '附加说明 · Markdown', 'Notes · Markdown');
      set('.task-root-time-card span', '实际用时', 'Actual time');
      set('[data-action="locate-task-root-task"]', '定位到画布', 'Locate on canvas');
      set('[data-action="archive-current-task-root"]', '归档这个顶级任务', 'Archive this top-level task');
      set('[data-action="delete-current-task-root"]', '删除这个顶级任务', 'Delete this top-level task');
      set('[data-action="cancel-taskbook-confirm"]', '取消', 'Cancel');
      set('[data-action="cancel-task-root-confirm"]', '取消', 'Cancel');
      const kicker = library.querySelector('.canvas-taskbook-kicker');
      if (kicker) kicker.textContent = t('画布工具', 'CANVAS TOOL');
      if (libraryHelpToggle) {
        libraryHelpToggle.setAttribute('aria-label', t('任务簿使用说明', 'Taskbook help'));
      }
    }

    function setLibraryHelpOpen(open, restoreFocus) {
      if (!libraryHelp || !libraryHelpToggle) return;
      libraryHelp.hidden = !open;
      libraryHelpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open && restoreFocus) {
        try { libraryHelpToggle.focus({ preventScroll: true }); }
        catch (error) { libraryHelpToggle.focus(); }
      }
    }

    function progressLabel(item) {
      return item.doneLeaves + ' / ' + item.totalLeaves;
    }

    function commitInlineName(item, input) {
      const canvasApi = api();
      if (canvasApi && typeof canvasApi.updateTaskbook === 'function') {
        canvasApi.updateTaskbook(item.id, { title: input.value });
      }
      editingRootId = '';
      renderLibrary();
    }

    function makeRootRow(item) {
      const row = document.createElement('article');
      row.className = 'taskbook-root-row';
      row.dataset.rootId = item.id;
      row.dataset.completed = item.completed ? '1' : '0';
      row.setAttribute('role', 'listitem');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'taskbook-root-main';
      main.dataset.action = 'open-task-root';
      const title = document.createElement('strong');
      title.textContent = item.title || t('未命名任务', 'Untitled task');
      const meta = document.createElement('span');
      meta.textContent = progressLabel(item) + ' · ' + formatTime(item.actualMs);
      main.append(title, meta);

      if (editingRootId === item.id) {
        const input = document.createElement('input');
        input.className = 'taskbook-root-inline-name';
        input.type = 'text';
        input.maxLength = 240;
        input.value = item.title || '';
        input.setAttribute('aria-label', t('顶级任务名称', 'Top-level task name'));
        main.replaceChildren(input, meta);
        requestAnimationFrame(function () {
          input.focus();
          input.select();
        });
        input.addEventListener('click', function (event) { event.stopPropagation(); });
        input.addEventListener('blur', function () { commitInlineName(item, input); }, { once: true });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
          if (event.key === 'Escape') {
            event.preventDefault();
            input.value = item.title || '';
            input.blur();
          }
        });
      }

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'taskbook-root-canvas';
      if (item.completed) {
        action.dataset.action = 'archive-task-root';
        action.textContent = t('归档', 'Archive');
      } else {
        action.dataset.action = item.canvasPlaced ? 'locate-task-root' : 'place-task-root';
        action.textContent = item.canvasPlaced ? t('定位', 'Locate') : t('放到画布', 'Place');
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'taskbook-root-delete';
      remove.dataset.action = 'delete-task-root';
      remove.setAttribute('aria-label', t('删除顶级任务“' + item.title + '”', 'Delete top-level task “' + item.title + '”'));
      remove.textContent = '×';

      const actions = document.createElement('div');
      actions.className = 'taskbook-root-actions';
      actions.append(action, remove);
      row.append(main, actions);
      return row;
    }

    function renderLibrary() {
      const books = snapshots();
      const active = books.filter(function (item) { return !item.completed; });
      const completed = books.filter(function (item) { return item.completed; });
      activeList.replaceChildren.apply(activeList, active.map(makeRootRow));
      completedList.replaceChildren.apply(completedList, completed.map(makeRootRow));
      activeCount.textContent = String(active.length);
      completedCount.textContent = String(completed.length);
      libraryEmpty.hidden = books.length > 0;
      library.querySelector('.taskbook-library-completed').hidden = completed.length === 0;
    }

    function taskById(current, taskId) {
      return current && current.tasks.find(function (task) { return task.id === taskId; }) || null;
    }

    function makeTreeRow(current, task) {
      const isRoot = !task;
      const id = isRoot ? current.id : task.id;
      const depth = isRoot ? 0 : task.depth;
      const done = isRoot ? current.completed : task.done;
      const leaf = isRoot ? current.tasks.length === 0 : task.leaf;
      const row = document.createElement('div');
      row.className = 'task-root-tree-row' + (isRoot ? ' task-root-tree-root' : '');
      row.dataset.taskId = id;
      row.dataset.parentId = isRoot ? '' : (task.parentId || '');
      row.dataset.depth = String(depth);
      row.style.setProperty('--task-depth', String(Math.max(0, depth)));
      row.setAttribute('role', 'treeitem');
      row.tabIndex = 0;
      row.classList.toggle('selected', id === selectedTaskId);
      row.classList.toggle('done', !!done);

      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'task-root-tree-check';
      check.dataset.action = isRoot ? 'toggle-task-root-done' : 'toggle-task-root-done';
      check.disabled = !leaf;
      check.setAttribute('aria-label', done ? t('标记未完成', 'Mark incomplete') : t('标记完成', 'Mark complete'));
      check.textContent = done ? '✓' : '';

      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'task-root-tree-title';
      title.dataset.action = 'select-task-root-task';
      title.textContent = isRoot ? current.title : (task.title || t('未命名任务', 'Untitled task'));

      const time = document.createElement('span');
      time.className = 'task-root-tree-time';
      time.textContent = formatTime(isRoot ? current.actualMs : task.actualMs);

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'task-root-tree-add';
      add.dataset.action = 'add-task-root-child';
      add.setAttribute('aria-label', t('添加子任务', 'Add subtask'));
      add.textContent = '+';

      row.append(check, title, time, add);
      if (!isRoot) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'task-root-tree-remove';
        remove.dataset.action = 'delete-task-root-subtree';
        remove.setAttribute('aria-label', t('删除任务', 'Delete task'));
        remove.textContent = '×';
        row.append(remove);
      }
      return row;
    }

    function selectedEntity(current) {
      if (!current) return null;
      if (!selectedTaskId || selectedTaskId === current.id) {
        return {
          id: current.id,
          title: current.title,
          body: current.body || '',
          actualMs: current.actualMs,
          leaf: current.tasks.length === 0,
          done: current.completed,
          isRoot: true,
          canvasPlaced: current.canvasPlaced,
        };
      }
      const task = taskById(current, selectedTaskId);
      return task ? Object.assign({ isRoot: false, canvasPlaced: true }, task) : null;
    }

    function taskPath(current, entity) {
      if (!current || !entity) return '';
      if (entity.isRoot) return current.title;
      const labels = [];
      let cursor = entity;
      const seen = new Set();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        labels.unshift(cursor.title || t('未命名任务', 'Untitled task'));
        cursor = cursor.parentId ? taskById(current, cursor.parentId) : null;
      }
      labels.unshift(current.title);
      return labels.join(' / ');
    }

    function renderDetail(current) {
      const entity = selectedEntity(current);
      if (!entity) return;
      detailForm.hidden = false;
      detailForm.dataset.rootSelected = entity.isRoot ? '1' : '0';
      detailPath.textContent = taskPath(current, entity);
      if (document.activeElement !== detailTitle) detailTitle.value = entity.title || '';
      if (document.activeElement !== detailBody) detailBody.value = entity.body || '';
      detailTime.textContent = formatTime(entity.actualMs);
      detailToggle.textContent = current.runningTaskId === entity.id ? t('暂停', 'Pause') : t('开始', 'Start');
      detailToggle.disabled = !entity.leaf || !!entity.done;
      detailLocate.disabled = entity.isRoot ? !current.canvasPlaced : false;
      detailLocate.hidden = entity.isRoot && !current.canvasPlaced;
      detailArchive.hidden = !entity.isRoot || !current.completed;
      detailArchive.disabled = archiveBusy;
    }

    function renderManager() {
      const current = snapshot(activeRootId);
      if (!current) {
        closeManager(false);
        return;
      }
      if (!selectedTaskId || (selectedTaskId !== current.id && !taskById(current, selectedTaskId))) {
        selectedTaskId = current.id;
      }
      if (document.activeElement !== rootTitle) rootTitle.value = current.title || '';
      rootProgress.textContent = current.doneLeaves + ' / ' + current.totalLeaves;
      rootTime.textContent = formatTime(current.actualMs);
      rootRun.textContent = current.runningTaskId ? 'Ⅱ' : '▶';
      rootRun.disabled = !current.runningTaskId && !current.nextTaskId;
      tree.replaceChildren(
        makeTreeRow(current, null),
        ...current.tasks.map(function (task) { return makeTreeRow(current, task); }),
      );
      renderDetail(current);
    }

    function openLibrary() {
      localize();
      setLibraryHelpOpen(false);
      if (!manager.hidden) concealToolLayer(manager);
      revealToolLayer(library);
      document.body.classList.add('canvas-taskbook-open');
      if (!topbarShortcut.hidden) {
        topbarShortcut.classList.add('open');
        topbarShortcut.setAttribute('aria-expanded', 'true');
      }
      setExternalOverlay(true);
      renderLibrary();
      requestAnimationFrame(function () {
        const add = library.querySelector('[data-action="new-top-level-task"]');
        if (add) add.focus({ preventScroll: true });
      });
    }

    function closeLibrary(restoreFocus) {
      setLibraryHelpOpen(false);
      closeConfirm(libraryConfirm);
      concealToolLayer(library);
      document.body.classList.remove('canvas-taskbook-open');
      topbarShortcut.classList.remove('open');
      topbarShortcut.setAttribute('aria-expanded', 'false');
      if (manager.hidden) setExternalOverlay(false);
      if (restoreFocus !== false) requestAnimationFrame(focusViewport);
    }

    function openManager(rootId) {
      const current = snapshot(rootId);
      if (!current) return;
      setLibraryHelpOpen(false);
      localize();
      activeRootId = rootId;
      selectedTaskId = rootId;
      if (!library.hidden) {
        concealToolLayer(library);
        document.body.classList.remove('canvas-taskbook-open');
      }
      revealToolLayer(manager);
      document.body.classList.add('task-root-manager-open');
      setExternalOverlay(true);
      renderManager();
      requestAnimationFrame(function () {
        const row = tree.querySelector('.task-root-tree-root');
        if (row) row.focus({ preventScroll: true });
      });
    }

    function closeManager(openLibraryAfter) {
      closeConfirm(taskConfirm);
      concealToolLayer(manager);
      document.body.classList.remove('task-root-manager-open');
      if (openLibraryAfter) requestAnimationFrame(openLibrary);
      else {
        document.body.classList.remove('canvas-taskbook-open');
        topbarShortcut.classList.remove('open');
        topbarShortcut.setAttribute('aria-expanded', 'false');
        setExternalOverlay(false);
        requestAnimationFrame(focusViewport);
      }
    }

    function closeConfirm(layer) {
      if (!layer) return;
      layer.classList.remove('open');
      layer.hidden = true;
      confirmAction = null;
    }

    function openConfirm(layer, titleEl, copyEl, acceptEl, title, copy, accept, action) {
      confirmAction = action;
      titleEl.textContent = title;
      copyEl.textContent = copy;
      acceptEl.textContent = accept;
      layer.classList.remove('open');
      layer.hidden = false;
      requestAnimationFrame(function () {
        if (layer.hidden) return;
        layer.classList.add('open');
        const cancel = layer.querySelector('button:not(.danger)');
        if (cancel) cancel.focus({ preventScroll: true });
      });
    }

    function showRootDeleteConfirm(rootId, source) {
      const current = snapshot(rootId);
      if (!current) return;
      const fromLibrary = source === 'library';
      const confirmLayer = fromLibrary ? libraryConfirm : taskConfirm;
      const confirmTitle = fromLibrary ? libraryConfirmTitle : taskConfirmTitle;
      const confirmCopy = fromLibrary ? libraryConfirmCopy : taskConfirmCopy;
      const confirmAccept = fromLibrary ? libraryConfirmAccept : taskConfirmAccept;
      openConfirm(
        confirmLayer, confirmTitle, confirmCopy, confirmAccept,
        t('删除“' + current.title + '”？', 'Delete “' + current.title + '”?'),
        t('顶级任务会移除；普通任务节点将保留并解除管理。', 'The top-level task is removed; ordinary task nodes remain unlocked.'),
        t('删除', 'Delete'),
        function () {
          const canvasApi = api();
          if (canvasApi && typeof canvasApi.deleteTopLevelTask === 'function') {
            canvasApi.deleteTopLevelTask(rootId);
          }
          closeConfirm(confirmLayer);
          if (fromLibrary) renderLibrary();
          else closeManager(true);
        },
      );
    }

    function showTaskDeleteConfirm(taskId) {
      const current = snapshot(activeRootId);
      const task = taskById(current, taskId);
      if (!task) return;
      openConfirm(
        taskConfirm, taskConfirmTitle, taskConfirmCopy, taskConfirmAccept,
        t('删除“' + task.title + '”及其子任务？', 'Delete “' + task.title + '” and its subtasks?'),
        t(
          '对应画布节点和相关连线会一起删除；累计用时会保留在顶级任务中。',
          'Their canvas nodes and connected lines will be removed; tracked time remains in the top-level task.',
        ),
        t('删除', 'Delete'),
        function () {
          const canvasApi = api();
          if (canvasApi && typeof canvasApi.deleteTaskbookSubtree === 'function') {
            canvasApi.deleteTaskbookSubtree(activeRootId, taskId);
          }
          closeConfirm(taskConfirm);
          selectedTaskId = activeRootId;
          renderManager();
        },
      );
    }

    function archiveSnapshotEnabled() {
      try { return localStorage.getItem('canvas:taskbookArchiveSnapshotEnabled') !== '0'; }
      catch (error) { return true; }
    }

    async function archiveRoot(rootId, source) {
      if (archiveBusy) return;
      const current = snapshot(rootId);
      const canvasApi = api();
      if (!current || !current.completed || !canvasApi) return;
      const fromManager = source === 'manager';
      const confirmLayer = fromManager ? taskConfirm : libraryConfirm;
      const confirmAccept = fromManager ? taskConfirmAccept : libraryConfirmAccept;
      const messageTarget = fromManager ? managerMessage : libraryMessage;
      archiveBusy = true;
      confirmAccept.disabled = true;
      if (fromManager) renderManager();
      setState(t('归档中…', 'Archiving…'));
      try {
        if (typeof canvasApi.settleTaskbookForArchive === 'function') {
          const settled = await canvasApi.settleTaskbookForArchive(rootId);
          if (!settled || !settled.ok) throw new Error(t('专注记录尚未同步，请稍后重试', 'Focus records are not synced yet'));
        }
        if (!(await save())) throw new Error(t('当前画布尚未保存', 'The canvas is not saved'));
        const prepared = canvasApi.prepareTaskbookArchive(rootId, archiveSnapshotEnabled());
        if (!prepared || !prepared.ok) throw new Error(t('当前任务还不能归档', 'This task cannot be archived yet'));
        let archiveId = archiveAttemptIds.get(rootId);
        if (!archiveId) {
          archiveId = 'taskbook-archive-' + Date.now().toString(36)
            + '-' + Math.random().toString(36).slice(2, 10);
          archiveAttemptIds.set(rootId, archiveId);
        }
        const response = await fetch('/api/taskbook-archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: filePath,
            rootId: rootId,
            archiveId: archiveId,
            retainSnapshot: archiveSnapshotEnabled(),
            snapshotRootNodeId: prepared.archive.snapshotRootNodeId,
            data: prepared.data,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || t('归档失败', 'Archive failed'));
        archiveAttemptIds.delete(rootId);
        closeConfirm(confirmLayer);
        if (fromManager) closeManager(true);
        canvasApi.applyTaskbookArchive(prepared.data);
        if (result.savedAt) canvasData.updatedAt = result.savedAt;
        markClean(t('已归档', 'Archived'));
        renderLibrary();
        announce(libraryMessage, t('已归档“' + current.title + '”', 'Archived “' + current.title + '”'), 'success');
      } catch (error) {
        setState(dirty ? t('未保存', 'Unsaved') : t('已保存', 'Saved'));
        announce(messageTarget, error && error.message || t('归档失败', 'Archive failed'), 'error');
      } finally {
        archiveBusy = false;
        confirmAccept.disabled = false;
        if (fromManager && !manager.hidden) renderManager();
      }
    }

    function showArchiveConfirm(rootId, source) {
      const current = snapshot(rootId);
      if (!current || !current.completed) return;
      const fromManager = source === 'manager';
      openConfirm(
        fromManager ? taskConfirm : libraryConfirm,
        fromManager ? taskConfirmTitle : libraryConfirmTitle,
        fromManager ? taskConfirmCopy : libraryConfirmCopy,
        fromManager ? taskConfirmAccept : libraryConfirmAccept,
        t('归档“' + current.title + '”？', 'Archive “' + current.title + '”?'),
        t(
          '活动任务和原始任务节点会被彻底删除，不能通过画布撤销恢复。'
            + (archiveSnapshotEnabled() ? '画布会保留一份已完成的普通枝桠树副本。' : ''),
          'The active task and original nodes will be permanently removed and cannot be restored with Undo.'
            + (archiveSnapshotEnabled() ? ' A completed ordinary branch copy will remain on the canvas.' : ''),
        ),
        t('归档', 'Archive'),
        function () { archiveRoot(rootId, source); },
      );
    }

    function addTask(parentId) {
      const canvasApi = api();
      if (!canvasApi || typeof canvasApi.addTaskbookTask !== 'function') return;
      const result = canvasApi.addTaskbookTask(activeRootId, parentId || activeRootId, {
        title: t('未命名任务', 'Untitled task'),
      });
      if (result && result.ok) {
        selectedTaskId = result.id;
        renderManager();
        requestAnimationFrame(function () {
          detailTitle.focus();
          detailTitle.select();
        });
      }
    }

    function updateSelectedEntity(patch) {
      const canvasApi = api();
      if (!canvasApi) return;
      if (selectedTaskId === activeRootId) {
        if (typeof canvasApi.updateTaskbook === 'function') canvasApi.updateTaskbook(activeRootId, patch);
      } else if (selectedTaskId && typeof canvasApi.updateTaskbookTask === 'function') {
        canvasApi.updateTaskbookTask(activeRootId, selectedTaskId, patch);
      }
    }

    library.addEventListener('click', function (event) {
      const action = event.target.closest('[data-action]');
      if (!action) return;
      const row = action.closest('.taskbook-root-row');
      const rootId = row && row.dataset.rootId;
      const canvasApi = api();
      switch (action.dataset.action) {
        case 'toggle-taskbook-help':
          setLibraryHelpOpen(libraryHelp && libraryHelp.hidden);
          break;
        case 'new-top-level-task': {
          if (!canvasApi || typeof canvasApi.createTopLevelTask !== 'function') return;
          const result = canvasApi.createTopLevelTask({ title: t('未命名任务', 'Untitled task') });
          if (result && result.ok) {
            editingRootId = result.id;
            renderLibrary();
          }
          break;
        }
        case 'close-canvas-taskbook': closeLibrary(); break;
        case 'open-task-root': if (rootId) openManager(rootId); break;
        case 'place-task-root':
          if (canvasApi && typeof canvasApi.placeTaskRoot === 'function') canvasApi.placeTaskRoot(rootId);
          closeLibrary(false);
          requestAnimationFrame(focusViewport);
          break;
        case 'locate-task-root':
          if (canvasApi && typeof canvasApi.locateTaskRoot === 'function') canvasApi.locateTaskRoot(rootId);
          closeLibrary(false);
          requestAnimationFrame(focusViewport);
          break;
        case 'delete-task-root': if (rootId) showRootDeleteConfirm(rootId, 'library'); break;
        case 'archive-task-root': showArchiveConfirm(rootId); break;
        case 'cancel-taskbook-confirm':
          closeConfirm(libraryConfirm);
          break;
        case 'accept-taskbook-confirm':
          if (confirmAction) confirmAction();
          break;
      }
    });

    manager.addEventListener('click', function (event) {
      const action = event.target.closest('[data-action]');
      if (!action) return;
      const row = action.closest('.task-root-tree-row');
      const taskId = row && row.dataset.taskId;
      const canvasApi = api();
      switch (action.dataset.action) {
        case 'back-task-root': closeManager(true); break;
        case 'select-task-root-task':
          selectedTaskId = taskId;
          renderManager();
          break;
        case 'add-task-root-child': addTask(taskId); break;
        case 'delete-task-root-subtree': showTaskDeleteConfirm(taskId); break;
        case 'archive-current-task-root': showArchiveConfirm(activeRootId, 'manager'); break;
        case 'delete-current-task-root': showRootDeleteConfirm(activeRootId); break;
        case 'toggle-task-root-done': {
          const current = snapshot(activeRootId);
          if (!current) break;
          if (taskId === activeRootId) {
            if (!current.tasks.length && canvasApi && typeof canvasApi.updateTaskbook === 'function') {
              canvasApi.updateTaskbook(activeRootId, { completed: !current.completed });
            }
          } else {
            const task = taskById(current, taskId);
            if (task && task.leaf && canvasApi && typeof canvasApi.updateTaskbookTask === 'function') {
              canvasApi.updateTaskbookTask(activeRootId, taskId, { done: !task.done });
            }
          }
          renderManager();
          break;
        }
        case 'toggle-task-root-root': {
          const current = snapshot(activeRootId);
          const targetId = current && (current.runningTaskId || current.nextTaskId || current.id);
          if (targetId && canvasApi && typeof canvasApi.toggleTaskbookTask === 'function') {
            canvasApi.toggleTaskbookTask(activeRootId, targetId);
          }
          renderManager();
          break;
        }
        case 'toggle-task-root-task': {
          const current = snapshot(activeRootId);
          const entity = selectedEntity(current);
          if (entity && canvasApi && typeof canvasApi.toggleTaskbookTask === 'function') {
            canvasApi.toggleTaskbookTask(activeRootId, entity.id);
          }
          renderManager();
          break;
        }
        case 'locate-task-root-task':
          if (selectedTaskId && canvasApi && typeof canvasApi.locateTaskbookItem === 'function') {
            canvasApi.locateTaskbookItem(selectedTaskId);
          }
          closeManager(false);
          break;
        case 'cancel-task-root-confirm':
          closeConfirm(taskConfirm);
          break;
        case 'accept-task-root-confirm':
          if (confirmAction) confirmAction();
          break;
      }
    });

    rootTitle.addEventListener('change', function () {
      const canvasApi = api();
      if (canvasApi && typeof canvasApi.updateTaskbook === 'function') {
        canvasApi.updateTaskbook(activeRootId, { title: rootTitle.value });
      }
      renderManager();
    });
    detailTitle.addEventListener('change', function () {
      updateSelectedEntity({ title: detailTitle.value });
      renderManager();
    });
    detailBody.addEventListener('change', function () {
      updateSelectedEntity({ body: detailBody.value });
      renderManager();
    });

    tree.addEventListener('keydown', function (event) {
      const row = event.target.closest('.task-root-tree-row');
      if (!row || event.target.matches('button:not(.task-root-tree-title)')) return;
      const current = snapshot(activeRootId);
      const taskId = row.dataset.taskId;
      const task = taskById(current, taskId);
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        addTask(task ? (task.parentId || activeRootId) : activeRootId);
        return;
      }
      if (!task || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      const canvasApi = api();
      if (!canvasApi || typeof canvasApi.moveTaskbookTask !== 'function') return;
      if (event.shiftKey) {
        const parent = task.parentId ? taskById(current, task.parentId) : null;
        canvasApi.moveTaskbookTask(activeRootId, task.id, parent && parent.parentId || activeRootId, '');
      } else {
        const index = current.tasks.findIndex(function (item) { return item.id === task.id; });
        const previous = index > 0 ? current.tasks[index - 1] : null;
        if (previous) canvasApi.moveTaskbookTask(activeRootId, task.id, previous.id, '');
      }
      renderManager();
    });

    function trapKeys(event, host, confirmLayer, close) {
      if (host.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (host === library && libraryHelp && !libraryHelp.hidden) {
          setLibraryHelpOpen(false, true);
        } else if (!confirmLayer.hidden) {
          closeConfirm(confirmLayer);
        } else close();
        return;
      }
      if (event.key !== 'Tab') return;
      const scope = !confirmLayer.hidden ? confirmLayer : host.querySelector('[role="dialog"]');
      const focusable = [...scope.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(function (element) { return !element.hidden && element.offsetParent !== null; });
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    library.addEventListener('keydown', function (event) {
      trapKeys(event, library, libraryConfirm, closeLibrary);
    });
    manager.addEventListener('keydown', function (event) {
      const target = event.target;
      const isTextInput = target && target.closest
        && target.closest('input, textarea, [contenteditable="true"]');
      if ((event.key === 'f' || event.key === 'F')
          && !event.ctrlKey && !event.metaKey && !event.altKey
          && taskConfirm.hidden && !isTextInput) {
        event.preventDefault();
        event.stopPropagation();
        closeManager(false);
        return;
      }
      trapKeys(event, manager, taskConfirm, function () { closeManager(false); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!manager.hidden) {
        event.preventDefault();
        event.stopPropagation();
        if (!taskConfirm.hidden) {
          closeConfirm(taskConfirm);
        } else closeManager(false);
      } else if (!library.hidden) {
        event.preventDefault();
        event.stopPropagation();
        if (libraryHelp && !libraryHelp.hidden) {
          setLibraryHelpOpen(false, true);
        } else if (!libraryConfirm.hidden) {
          closeConfirm(libraryConfirm);
        } else closeLibrary();
      }
    }, true);

    library.addEventListener('mousedown', function (event) {
      if (libraryHelp && !libraryHelp.hidden
          && !libraryHelp.contains(event.target)
          && !libraryHelpToggle.contains(event.target)) {
        setLibraryHelpOpen(false);
      }
      if (event.target === library && libraryConfirm.hidden) closeLibrary();
    });
    manager.addEventListener('mousedown', function (event) {
      if (event.target === manager && taskConfirm.hidden) closeManager(false);
    });
    library.addEventListener('dragstart', function (event) { event.preventDefault(); });
    tree.addEventListener('dragstart', function (event) { event.preventDefault(); });
    topbarToggle.addEventListener('change', function () {
      setTaskbookTopbarShortcut(topbarToggle.checked);
    });
    topbarShortcut.addEventListener('click', function () {
      document.dispatchEvent(new CustomEvent('editor:open-taskbook'));
    });

    document.addEventListener('editor:open-taskbook', openLibrary);
    document.addEventListener('editor:open-task-root', function (event) {
      const detail = event && event.detail || {};
      if (detail.rootId) {
        openManager(detail.rootId);
        if (detail.taskId) {
          selectedTaskId = detail.taskId;
          renderManager();
        }
      }
    });
    document.addEventListener('canvas:taskbook-change', function () {
      if (!library.hidden) renderLibrary();
      if (!manager.hidden) renderManager();
    });
    document.addEventListener('canvas:taskbook-tick', function (event) {
      if (!library.hidden) renderLibrary();
      if (!manager.hidden && (!event.detail || event.detail.rootId === activeRootId)) renderManager();
    });
    document.addEventListener('editor:languagechange', function () {
      localize();
      if (!library.hidden) renderLibrary();
      if (!manager.hidden) renderManager();
    });
    syncTaskbookTopbarShortcut(taskbookTopbarShortcutEnabled());
  })();

  // ── 节点矩阵：只负责配置与预览，真实节点事务由 CanvasModule 提交 ──
  (function setupNodeMatrixDialog() {
    const dialog = document.querySelector('[data-role="node-matrix-dialog"]');
    const form = dialog && dialog.querySelector('[data-role="node-matrix-form"]');
    const rowsInput = dialog && dialog.querySelector('[data-role="node-matrix-rows"]');
    const columnsInput = dialog && dialog.querySelector('[data-role="node-matrix-columns"]');
    const countOutput = dialog && dialog.querySelector('[data-role="node-matrix-count"]');
    const startInput = dialog && dialog.querySelector('[data-role="node-matrix-start"]');
    const prefixInput = dialog && dialog.querySelector('[data-role="node-matrix-prefix"]');
    const suffixInput = dialog && dialog.querySelector('[data-role="node-matrix-suffix"]');
    const sequencePanel = dialog && dialog.querySelector('[data-role="node-matrix-sequence-panel"]');
    const pastePanel = dialog && dialog.querySelector('[data-role="node-matrix-paste-panel"]');
    const pasteInput = dialog && dialog.querySelector('[data-role="node-matrix-paste-text"]');
    const customGap = dialog && dialog.querySelector('[data-role="node-matrix-custom-gap"]');
    const gapXInput = dialog && dialog.querySelector('[data-role="node-matrix-gap-x"]');
    const gapYInput = dialog && dialog.querySelector('[data-role="node-matrix-gap-y"]');
    const widthWrap = dialog && dialog.querySelector('[data-role="node-matrix-width-wrap"]');
    const widthInput = dialog && dialog.querySelector('[data-role="node-matrix-width-value"]');
    const previewGrid = dialog && dialog.querySelector('[data-role="node-matrix-preview-grid"]');
    const previewSummary = dialog && dialog.querySelector('[data-role="node-matrix-preview-summary"]');
    const footerCount = dialog && dialog.querySelector('[data-role="node-matrix-footer-count"]');
    const errorEl = dialog && dialog.querySelector('[data-role="node-matrix-error"]');
    const submitButton = dialog && dialog.querySelector('[data-action="create-node-matrix"]');
    const closeButton = dialog && dialog.querySelector('[data-action="close-node-matrix"]');
    const cancelButton = dialog && dialog.querySelector('[data-action="cancel-node-matrix"]');
    if (!dialog || !form || !rowsInput || !columnsInput || !previewGrid || !submitButton) return;

    const STORAGE_KEY = 'canvas:nodeMatrixDefaults:v1';
    const TYPE_MIN_WIDTH = { card: 80, sticky: 150, index: 80, preview: 168, code: 248 };
    let busy = false;
    let returnFocus = null;

    function selectedValue(name, fallback) {
      const selected = form.querySelector('input[name="' + name + '"]:checked');
      return selected ? selected.value : fallback;
    }

    function selectValue(name, value, fallback) {
      const input = form.querySelector(
        'input[name="' + name + '"][value="' + String(value || '') + '"]',
      ) || form.querySelector(
        'input[name="' + name + '"][value="' + String(fallback || '') + '"]',
      );
      if (input) input.checked = true;
    }

    function matrixText(zh, en) {
      return toolbarLanguage === 'en' ? en : zh;
    }

    function formatCount(count, prefix) {
      if (toolbarLanguage === 'en') {
        return (prefix ? toolbarCopy('nodeMatrixWillCreate') + ' ' : '')
          + count + ' ' + toolbarCopy('nodeMatrixNodes');
      }
      return (prefix ? toolbarCopy('nodeMatrixWillCreate') + ' ' : '')
        + count + ' ' + toolbarCopy('nodeMatrixNodes');
    }

    function setError(message) {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }

    function matrixErrorMessage(error) {
      const code = error && error.code;
      if (code === 'INVALID_ROWS') return matrixText('行数必须是 1–20 之间的整数。', 'Rows must be an integer from 1 to 20.');
      if (code === 'INVALID_COLUMNS') return matrixText('列数必须是 1–20 之间的整数。', 'Columns must be an integer from 1 to 20.');
      if (code === 'TOO_MANY_CELLS') return matrixText('一次最多生成 100 个节点。', 'You can create at most 100 nodes at once.');
      if (code === 'GRID_TOO_LARGE') return matrixText('粘贴内容最多支持 20 行、20 列。', 'Pasted content supports at most 20 rows and 20 columns.');
      if (code === 'EMPTY_PASTE') return matrixText('请先粘贴至少一个单元格。', 'Paste at least one cell first.');
      if (code === 'INVALID_START') return matrixText('起始编号必须是整数。', 'The starting number must be an integer.');
      if (code === 'AFFIX_TOO_LONG') return matrixText('编号前缀和后缀最多各 40 个字符。', 'Prefix and suffix can contain at most 40 characters each.');
      if (code === 'INVALID_GAP_X' || code === 'INVALID_GAP_Y') {
        return matrixText('节点间距必须是 0–400 之间的整数。', 'Node spacing must be an integer from 0 to 400.');
      }
      if (code === 'INVALID_WIDTH') return matrixText('节点宽度超出允许范围。', 'Node width is outside the allowed range.');
      if (code === 'MATRIX_UNAVAILABLE') {
        return matrixText('节点矩阵当前不可用，请回到主编辑器后重试。', 'Node Matrix is unavailable here. Return to the main editor and try again.');
      }
      return error && error.message ? error.message : toolbarCopy('nodeMatrixInvalid');
    }

    function collectConfig() {
      return {
        rows: Number(rowsInput.value),
        columns: Number(columnsInput.value),
        kind: selectedValue('node-matrix-kind', 'card'),
        contentMode: selectedValue('node-matrix-content', 'sequence'),
        start: Number(startInput.value),
        prefix: prefixInput.value,
        suffix: suffixInput.value,
        order: selectedValue('node-matrix-order', 'row'),
        pasteText: pasteInput.value,
        gapPreset: selectedValue('node-matrix-gap', 'standard'),
        gapX: Number(gapXInput.value),
        gapY: Number(gapYInput.value),
        widthMode: selectedValue('node-matrix-width-mode', 'auto'),
        width: Number(widthInput.value),
      };
    }

    function loadSettings() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
      catch (error) { saved = {}; }
      rowsInput.value = Number.isInteger(Number(saved.rows)) ? saved.rows : 3;
      columnsInput.value = Number.isInteger(Number(saved.columns)) ? saved.columns : 3;
      startInput.value = Number.isSafeInteger(Number(saved.start)) ? saved.start : 1;
      prefixInput.value = typeof saved.prefix === 'string' ? saved.prefix.slice(0, 40) : '';
      suffixInput.value = typeof saved.suffix === 'string' ? saved.suffix.slice(0, 40) : '.';
      gapXInput.value = Number.isInteger(Number(saved.gapX)) ? saved.gapX : 48;
      gapYInput.value = Number.isInteger(Number(saved.gapY)) ? saved.gapY : 36;
      widthInput.value = Number.isInteger(Number(saved.width)) ? saved.width : 160;
      pasteInput.value = '';
      selectValue('node-matrix-kind', saved.kind, 'card');
      selectValue('node-matrix-content', saved.contentMode, 'sequence');
      selectValue('node-matrix-order', saved.order, 'row');
      selectValue('node-matrix-gap', saved.gapPreset, 'standard');
      selectValue('node-matrix-width-mode', saved.widthMode, 'auto');
    }

    function saveSettings(config) {
      const saved = {
        rows: config.rows,
        columns: config.columns,
        kind: config.kind,
        contentMode: config.contentMode,
        start: config.start,
        prefix: config.prefix,
        suffix: config.suffix,
        order: config.order,
        gapPreset: config.gapPreset,
        gapX: config.gapX,
        gapY: config.gapY,
        widthMode: config.widthMode,
        width: config.width,
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (error) {}
    }

    function syncPasteDimensions() {
      if (selectedValue('node-matrix-content', 'sequence') !== 'paste') return;
      const Matrix = window.RelatumNodeMatrix;
      if (!Matrix || typeof Matrix.parsePastedGrid !== 'function') return;
      const parsed = Matrix.parsePastedGrid(pasteInput.value);
      if (parsed.rows && parsed.columns) {
        rowsInput.value = parsed.rows;
        columnsInput.value = parsed.columns;
      }
    }

    function renderPreview() {
      const Matrix = window.RelatumNodeMatrix;
      const contentMode = selectedValue('node-matrix-content', 'sequence');
      const gapPreset = selectedValue('node-matrix-gap', 'standard');
      const widthMode = selectedValue('node-matrix-width-mode', 'auto');
      const kind = selectedValue('node-matrix-kind', 'card');
      sequencePanel.hidden = contentMode !== 'sequence';
      pastePanel.hidden = contentMode !== 'paste';
      rowsInput.disabled = contentMode === 'paste';
      columnsInput.disabled = contentMode === 'paste';
      customGap.hidden = gapPreset !== 'custom';
      widthWrap.hidden = widthMode !== 'custom';
      widthInput.min = String(TYPE_MIN_WIDTH[kind] || 80);
      if (widthMode === 'custom' && Number(widthInput.value) < Number(widthInput.min)) {
        widthInput.value = widthInput.min;
      }

      previewGrid.innerHTML = '';
      let built = null;
      let validationError = null;
      try {
        if (!Matrix || typeof Matrix.buildCells !== 'function') {
          const error = new Error('');
          error.code = 'MATRIX_UNAVAILABLE';
          throw error;
        }
        built = Matrix.buildCells(collectConfig());
      } catch (error) {
        validationError = error;
      }

      const rows = built ? built.config.rows : Math.max(0, Number(rowsInput.value) || 0);
      const columns = built ? built.config.columns : Math.max(0, Number(columnsInput.value) || 0);
      const count = built ? built.config.count : rows * columns;
      countOutput.value = String(count);
      countOutput.textContent = count + ' / 100';
      previewSummary.textContent = rows + ' × ' + columns + ' · ' + formatCount(count, false);
      footerCount.textContent = formatCount(count, true);
      submitButton.disabled = busy || !!validationError;
      form.dataset.valid = validationError ? 'false' : 'true';
      previewGrid.style.gridTemplateColumns = 'repeat(' + Math.max(1, columns) + ', minmax(6px, 1fr))';

      if (built) {
        previewGrid.style.setProperty(
          '--node-matrix-preview-gap-x',
          Math.max(2, Math.min(8, built.config.gapX / 10)) + 'px',
        );
        previewGrid.style.setProperty(
          '--node-matrix-preview-gap-y',
          Math.max(2, Math.min(8, built.config.gapY / 8)) + 'px',
        );
        built.cells.forEach((cell) => {
          const item = document.createElement('span');
          item.className = 'node-matrix-preview-cell';
          item.dataset.kind = built.config.kind;
          item.textContent = cell.text;
          item.setAttribute('aria-hidden', 'true');
          previewGrid.appendChild(item);
        });
      }
      return { built: built, error: validationError };
    }

    function refresh() {
      syncPasteDimensions();
      renderPreview();
    }

    function setBusy(next) {
      busy = !!next;
      dialog.dataset.busy = busy ? 'true' : 'false';
      renderPreview();
    }

    function close(restoreFocus) {
      if (busy || dialog.hidden || dialog.classList.contains('tool-layer-leaving')) return false;
      const focusTarget = restoreFocus !== false && returnFocus && returnFocus.isConnected
        ? returnFocus : null;
      if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
        window.CanvasModule.setExternalOverlayOpen(false);
      }
      return concealToolLayer(dialog, () => {
        dialog.removeAttribute('data-busy');
        setError('');
        if (focusTarget) focusTarget.focus();
        returnFocus = null;
      }, 220);
    }

    function open() {
      if (EMBED || !dialog.hidden) return;
      returnFocus = document.querySelector('[data-action="node-matrix"]')
        || document.querySelector('[data-action="tools"]');
      loadSettings();
      setError('');
      revealToolLayer(dialog);
      dialog.lang = toolbarLanguage;
      if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
        window.CanvasModule.setExternalOverlayOpen(true);
      }
      refresh();
      requestAnimationFrame(() => rowsInput.focus());
    }

    function submit() {
      if (busy) return;
      setError('');
      const result = renderPreview();
      if (!result.built) {
        setError(matrixErrorMessage(result.error));
        return;
      }
      setBusy(true);
      try {
        if (!window.CanvasModule || typeof window.CanvasModule.createNodeMatrix !== 'function') {
          const error = new Error('');
          error.code = 'MATRIX_UNAVAILABLE';
          throw error;
        }
        window.CanvasModule.createNodeMatrix(collectConfig());
        if (window.EditorShell && typeof window.EditorShell.setMode === 'function') {
          window.EditorShell.setMode('normal');
        }
        saveSettings(result.built.config);
        setBusy(false);
        close(false);
      } catch (error) {
        setBusy(false);
        setError(matrixErrorMessage(error));
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    function handleConfigChange() {
      if (!busy) setError('');
      refresh();
    }
    form.addEventListener('input', handleConfigChange);
    form.addEventListener('change', handleConfigChange);
    pasteInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });
    if (closeButton) closeButton.addEventListener('click', () => close(true));
    if (cancelButton) cancelButton.addEventListener('click', () => close(true));
    dialog.addEventListener('mousedown', (event) => {
      if (event.target === dialog) close(true);
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!busy) {
          event.preventDefault();
          close(true);
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), '
        + '[tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('editor:open-node-matrix', open);
    document.addEventListener('editor:languagechange', () => {
      dialog.lang = toolbarLanguage;
      if (!dialog.hidden) refresh();
    });
  })();

  // ── 倒计时 / 正计时：面板只收集配置，计时与画布事务由 CanvasModule 管理 ──
  (function setupCanvasTimerDialog() {
    const dialog = document.querySelector('[data-role="canvas-timer-dialog"]');
    const form = dialog && dialog.querySelector('[data-role="canvas-timer-form"]');
    const title = dialog && dialog.querySelector('[data-role="canvas-timer-dialog-title"]');
    const labelInput = dialog && dialog.querySelector('[data-role="canvas-timer-label"]');
    const durationSection = dialog && dialog.querySelector('[data-role="canvas-timer-duration-section"]');
    const hoursInput = dialog && dialog.querySelector('[data-role="canvas-timer-hours"]');
    const minutesInput = dialog && dialog.querySelector('[data-role="canvas-timer-minutes"]');
    const secondsInput = dialog && dialog.querySelector('[data-role="canvas-timer-seconds"]');
    const errorEl = dialog && dialog.querySelector('[data-role="canvas-timer-error"]');
    const submitButton = dialog && dialog.querySelector('[data-role="canvas-timer-submit"]');
    const closeButton = dialog && dialog.querySelector('[data-action="close-canvas-timer"]');
    const cancelButton = dialog && dialog.querySelector('[data-action="cancel-canvas-timer"]');
    if (!dialog || !form || !labelInput || !hoursInput || !minutesInput
        || !secondsInput || !submitButton) return;

    let editingTimer = null;
    let returnFocus = null;
    let busy = false;

    function selectedMode() {
      const checked = form.querySelector('input[name="canvas-timer-mode"]:checked');
      return checked ? checked.value : 'countdown';
    }

    function setMode(mode) {
      const input = form.querySelector('input[name="canvas-timer-mode"][value="' + mode + '"]')
        || form.querySelector('input[name="canvas-timer-mode"][value="countdown"]');
      if (input) input.checked = true;
    }

    function setError(message) {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }

    function readDuration() {
      const api = window.RelatumCanvasTimer;
      if (!api || typeof api.durationFromParts !== 'function') return null;
      return api.durationFromParts(
        Number(hoursInput.value),
        Number(minutesInput.value),
        Number(secondsInput.value),
      );
    }

    function writeDuration(durationMs) {
      const api = window.RelatumCanvasTimer;
      const parts = api && typeof api.durationParts === 'function'
        ? api.durationParts(durationMs)
        : { hours: 0, minutes: 25, seconds: 0 };
      hoursInput.value = parts.hours;
      minutesInput.value = parts.minutes;
      secondsInput.value = parts.seconds;
    }

    function syncPreset() {
      const duration = readDuration();
      dialog.querySelectorAll('[data-timer-minutes]').forEach((button) => {
        button.classList.toggle(
          'active',
          duration === Number(button.dataset.timerMinutes) * 60 * 1000,
        );
      });
    }

    function structuralEdit() {
      if (!editingTimer) return false;
      const mode = selectedMode();
      if (mode !== editingTimer.mode) return true;
      return mode === 'countdown' && readDuration() !== editingTimer.durationMs;
    }

    function syncCopy() {
      const editing = !!editingTimer;
      title.textContent = toolbarCopy(editing ? 'canvasTimerEditTitle' : 'canvasTimerCreateTitle');
      submitButton.textContent = toolbarCopy(
        editing ? (structuralEdit() ? 'canvasTimerResetSave' : 'canvasTimerSave') : 'canvasTimerCreate',
      );
      dialog.querySelectorAll('[data-timer-minutes]').forEach((button) => {
        const minutes = button.dataset.timerMinutes;
        button.textContent = toolbarLanguage === 'en' ? (minutes + ' min') : (minutes + ' 分');
      });
      durationSection.hidden = selectedMode() !== 'countdown';
      syncPreset();
    }

    function close(restoreFocus) {
      if (busy || dialog.hidden || dialog.classList.contains('tool-layer-leaving')) return false;
      const focusTarget = restoreFocus !== false && returnFocus && returnFocus.isConnected
        ? returnFocus : null;
      if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
        window.CanvasModule.setExternalOverlayOpen(false);
      }
      return concealToolLayer(dialog, () => {
        editingTimer = null;
        setError('');
        if (focusTarget) focusTarget.focus();
        returnFocus = null;
      }, 210);
    }

    function open(timer) {
      if (EMBED || !dialog.hidden) return;
      editingTimer = timer && typeof timer === 'object' ? timer : null;
      returnFocus = document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : (document.querySelector('[data-action="canvas-timer"]')
          || document.querySelector('[data-action="tools"]'));
      setMode(editingTimer ? editingTimer.mode : 'countdown');
      labelInput.value = editingTimer ? editingTimer.label || '' : '';
      writeDuration(editingTimer && editingTimer.mode === 'countdown'
        ? editingTimer.durationMs
        : 25 * 60 * 1000);
      setError('');
      revealToolLayer(dialog);
      dialog.lang = toolbarLanguage;
      if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
        window.CanvasModule.setExternalOverlayOpen(true);
      }
      syncCopy();
      requestAnimationFrame(() => labelInput.focus());
    }

    function submit() {
      if (busy) return;
      const mode = selectedMode();
      const durationMs = mode === 'countdown' ? readDuration() : undefined;
      if (mode === 'countdown' && durationMs === null) {
        setError(toolbarCopy('canvasTimerInvalidDuration'));
        return;
      }
      if (!window.CanvasModule) return;
      const config = {
        mode: mode,
        label: labelInput.value,
        durationMs: durationMs,
      };
      busy = true;
      submitButton.disabled = true;
      try {
        const result = editingTimer
          ? window.CanvasModule.updateCanvasTimer(editingTimer.id, config)
          : window.CanvasModule.createCanvasTimer(config);
        if (!result || !result.ok) throw new Error('Timer unavailable');
        if (!editingTimer && window.EditorShell && typeof window.EditorShell.setMode === 'function') {
          window.EditorShell.setMode('normal');
        }
        busy = false;
        submitButton.disabled = false;
        close(false);
      } catch (error) {
        busy = false;
        submitButton.disabled = false;
        setError(toolbarLanguage === 'en'
          ? 'The timer could not be saved.'
          : '计时器保存失败，请重试。');
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    form.addEventListener('input', () => {
      if (!busy) setError('');
      syncCopy();
    });
    form.addEventListener('change', syncCopy);
    dialog.querySelectorAll('[data-timer-minutes]').forEach((button) => {
      button.addEventListener('click', () => {
        writeDuration(Number(button.dataset.timerMinutes) * 60 * 1000);
        setError('');
        syncCopy();
      });
    });
    if (closeButton) closeButton.addEventListener('click', () => close(true));
    if (cancelButton) cancelButton.addEventListener('click', () => close(true));
    dialog.addEventListener('mousedown', (event) => {
      if (event.target === dialog) close(true);
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!busy) {
          event.preventDefault();
          close(true);
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('editor:open-canvas-timer', () => open(null));
    document.addEventListener('editor:edit-canvas-timer', (event) => {
      open(event.detail && event.detail.timer);
    });
    document.addEventListener('editor:modechange', () => {
      if (!dialog.hidden) close(false);
    });
    document.addEventListener('editor:languagechange', () => {
      dialog.lang = toolbarLanguage;
      if (!dialog.hidden) syncCopy();
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
    let closing = false;
    let closeTimer = null;
    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}

    const syncScrolledState = () => {
      pop.classList.toggle('is-scrolled', pop.scrollTop > 4);
    };
    const finishClose = () => {
      if (!closing) return;
      closing = false;
      if (closeTimer) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
      pop.removeEventListener('animationend', onCloseAnimationEnd);
      pop.classList.remove('is-closing', 'is-scrolled');
      pop.hidden = true;
    };
    const onCloseAnimationEnd = (event) => {
      if (event.target === pop && event.animationName === 'settings-panel-out') {
        finishClose();
      }
    };
    const close = () => {
      btn.setAttribute('aria-expanded', 'false');
      document.dispatchEvent(new CustomEvent('editor:settings-reset-cancel'));
      if (pop.hidden || closing) return;
      closing = true;
      if (reduceMotion) {
        finishClose();
        return;
      }
      pop.classList.add('is-closing');
      pop.addEventListener('animationend', onCloseAnimationEnd);
      closeTimer = window.setTimeout(finishClose, 190);
    };
    const open = () => {
      if (closeTimer) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
      pop.removeEventListener('animationend', onCloseAnimationEnd);
      closing = false;
      pop.classList.remove('is-closing');
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(syncScrolledState);
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.hidden || closing) open();
      else close();
    });
    // 面板自己处理滚动，避免 wheel 冒泡到画布后触发缩放。
    pop.addEventListener('wheel', (event) => {
      event.stopPropagation();
    }, { passive: true });
    pop.addEventListener('scroll', syncScrolledState, { passive: true });
    document.addEventListener('mousedown', (e) => {
      if (pop.hidden || closing) return;
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (pop.hidden || closing || e.key !== 'Escape') return;
      const resetConfirm = pop.querySelector('[data-role="settings-reset-confirm"]');
      if (resetConfirm && !resetConfirm.hidden) {
        document.dispatchEvent(new CustomEvent('editor:settings-reset-cancel', {
          detail: { restoreFocus: true },
        }));
        return;
      }
      close();
      btn.focus();
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

  // 脑图分支入口默认保持安静，需要时可从齿轮里恢复显示。
  (function setupNodeAssistVisibility() {
    [
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

  // 任务簿完成归档：默认在画布留下脱离任务管理的普通枝桠树副本。
  (function setupTaskbookArchiveSnapshotToggle() {
    const cb = document.querySelector('[data-role="taskbook-archive-snapshot"]');
    if (!cb) return;
    const KEY = 'canvas:taskbookArchiveSnapshotEnabled';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    cb.checked = on;
    cb.addEventListener('change', () => {
      try { localStorage.setItem(KEY, cb.checked ? '1' : '0'); } catch (e) {}
    });
  })();

  // 任务簿叶子计时入口：默认开启，只控制画布节点左侧的悬停按钮。
  (function setupTaskbookLeafTimerButtonsToggle() {
    const cb = document.querySelector('[data-role="taskbook-leaf-timer-buttons"]');
    if (!cb) return;
    const KEY = 'canvas:taskbookLeafTimerButtonsEnabled';
    let on = true;
    try { on = localStorage.getItem(KEY) !== '0'; } catch (e) {}
    const apply = (enabled) => {
      cb.checked = enabled;
      document.dispatchEvent(new CustomEvent('canvas:taskbook-leaf-timer-buttons-enabled', {
        detail: enabled,
      }));
    };
    apply(on);
    cb.addEventListener('change', () => {
      apply(cb.checked);
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

  // 齿轮面板恢复默认：只重置当前面板管理的浏览器偏好，保留语言、画布数据和引导记录。
  // 先通过既有控件事件即时同步运行态，再删除显式存储值，让后续版本仍可继承新的出厂默认。
  (function setupSettingsReset() {
    const area = document.querySelector('[data-role="settings-reset-area"]');
    if (!area) return;
    const openBtn = area.querySelector('[data-role="settings-reset-open"]');
    const confirmBox = area.querySelector('[data-role="settings-reset-confirm"]');
    const cancelBtn = area.querySelector('[data-role="settings-reset-cancel"]');
    const acceptBtn = area.querySelector('[data-role="settings-reset-accept"]');
    const statusEl = area.querySelector('[data-role="settings-reset-status"]');
    const settingsPanel = area.closest('[data-role="settings-pop"]');
    if (!openBtn || !confirmBox || !cancelBtn || !acceptBtn) return;

    const preferences = [
      { role: 'pan-speed', value: '8', event: 'input', key: 'canvas:panSpeed' },
      { role: 'pan-inertia', value: '0.15', event: 'input', key: 'canvas:panInertia' },
      { role: 'zoom-speed', value: '1', event: 'input', key: 'canvas:zoomSpeed' },
      { role: 'mindmap-hover-delay', value: '500', event: 'input', key: 'canvas:mindmapHoverDelay' },
      { role: 'index-hover-delay', value: '400', event: 'input', key: 'canvas:indexHoverDelay' },
      { role: 'tooltip-hover-delay', value: '3500', event: 'input', key: 'canvas:tooltipHoverDelay' },
      { role: 'tooltip-hide-delay', value: '70', event: 'input', key: 'canvas:tooltipHideDelay' },
      { role: 'code-default-language', value: 'c', event: 'change', key: 'canvas:codeDefaultLanguage' },
      { role: 'pen-pressure', checked: true, event: 'change', key: 'canvas:penPressure' },
      { role: 'enable-text-snap', checked: false, event: 'change', key: 'canvas:textSnapEnabled' },
      { role: 'show-mindmap-folds', checked: false, event: 'change', key: 'canvas:showMindmapFolds' },
      { role: 'enable-inspector', checked: true, event: 'change', key: 'canvas:inspectorEnabled' },
      { role: 'enable-mindmap-inspector', checked: false, event: 'change', key: 'canvas:mindmapInspectorEnabled' },
      { role: 'enable-decor-inspector', checked: true, event: 'change', key: 'canvas:decorInspectorEnabled' },
      { role: 'enable-index-hover', checked: true, event: 'change', key: 'canvas:indexHoverEnabled' },
      { role: 'enable-box-create', checked: true, event: 'change', key: 'canvas:boxCreateEnabled' },
      { role: 'enable-group-create', checked: true, event: 'change', key: 'canvas:groupCreateEnabled' },
      { role: 'taskbook-archive-snapshot', checked: true, event: 'change', key: 'canvas:taskbookArchiveSnapshotEnabled' },
      { role: 'taskbook-leaf-timer-buttons', checked: true, event: 'change', key: 'canvas:taskbookLeafTimerButtonsEnabled' },
      { role: 'enable-gen-index', checked: false, event: 'change', key: 'canvas:genIndexEnabled' },
      { role: 'enable-dark-edge-optimization', checked: true, event: 'change', key: 'canvas:darkEdgeOptimization' },
      { role: 'enable-dark-semantic-ui', checked: true, event: 'change', key: 'canvas:darkSemanticUiOptimization' },
      { role: 'enable-autosave', checked: true, event: 'change', key: 'canvas:autosaveEnabled' },
      { role: 'enable-space-locate', checked: false, event: 'change', key: 'canvas:spaceLocateEnabled' },
    ];
    let statusTimer = null;
    let statusClearTimer = null;
    let confirmHideTimer = null;
    let confirming = false;
    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}

    function focusWithoutScroll(element) {
      const previousScrollTop = settingsPanel ? settingsPanel.scrollTop : 0;
      try { element.focus({ preventScroll: true }); }
      catch (e) { element.focus(); }
      if (!settingsPanel) return;
      settingsPanel.scrollTop = previousScrollTop;
      window.requestAnimationFrame(() => {
        settingsPanel.scrollTop = previousScrollTop;
      });
    }

    function setConfirming(nextConfirming, restoreFocus) {
      if (confirmHideTimer) {
        window.clearTimeout(confirmHideTimer);
        confirmHideTimer = null;
      }
      confirming = !!nextConfirming;
      if (confirming) {
        if (statusTimer) {
          window.clearTimeout(statusTimer);
          statusTimer = null;
        }
        if (statusClearTimer) {
          window.clearTimeout(statusClearTimer);
          statusClearTimer = null;
        }
        area.classList.remove('is-restored');
        if (statusEl) statusEl.textContent = '';
        confirmBox.hidden = false;
        openBtn.setAttribute('aria-expanded', 'true');
        area.classList.add('is-confirming');
        window.requestAnimationFrame(() => confirmBox.classList.add('is-visible'));
        focusWithoutScroll(cancelBtn);
        return;
      }

      openBtn.setAttribute('aria-expanded', 'false');
      area.classList.remove('is-confirming');
      confirmBox.classList.remove('is-visible');
      const finishHide = () => {
        if (confirming) return;
        confirmBox.hidden = true;
        confirmHideTimer = null;
      };
      if (reduceMotion || confirmBox.hidden) finishHide();
      else confirmHideTimer = window.setTimeout(finishHide, 150);
      if (restoreFocus) focusWithoutScroll(openBtn);
    }

    function resetPreferences() {
      preferences.forEach((preference) => {
        const control = document.querySelector('[data-role="' + preference.role + '"]');
        if (!control) return;
        if (Object.prototype.hasOwnProperty.call(preference, 'checked')) {
          control.checked = preference.checked;
        } else {
          control.value = preference.value;
        }
        control.dispatchEvent(new Event(preference.event, { bubbles: true }));
      });
      try {
        preferences.forEach((preference) => localStorage.removeItem(preference.key));
      } catch (e) {}
    }

    // 鼠标按下默认会先把吸顶按钮的 DOM 原位滚回视口；拦下这一步，再由确认层接管焦点。
    openBtn.addEventListener('mousedown', (event) => event.preventDefault());
    openBtn.addEventListener('click', () => setConfirming(!confirming, false));
    cancelBtn.addEventListener('click', () => setConfirming(false, true));
    acceptBtn.addEventListener('click', () => {
      resetPreferences();
      setConfirming(false, true);
      if (!statusEl) return;
      if (statusTimer) window.clearTimeout(statusTimer);
      if (statusClearTimer) window.clearTimeout(statusClearTimer);
      statusEl.textContent = toolbarCopy('settingsResetDone');
      area.classList.add('is-restored');
      statusTimer = window.setTimeout(() => {
        area.classList.remove('is-restored');
        statusTimer = null;
        statusClearTimer = window.setTimeout(() => {
          statusEl.textContent = '';
          statusClearTimer = null;
        }, reduceMotion ? 0 : 180);
      }, 1700);
    });
    document.addEventListener('editor:settings-reset-cancel', (event) => {
      if (!confirming && confirmBox.hidden) return;
      setConfirming(false, !!(event.detail && event.detail.restoreFocus));
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
  let canvasActivityReady = false;
  let canvasActivityActive = false;
  let canvasActivityLastCapturedAt = 0;
  let canvasActivityHeartbeat = 0;
  let canvasActivitySending = null;
  const canvasActivityPending = [];
  const canvasActivitySessionId = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : 'canvas-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

  function captureCanvasActivity(endAt) {
    if (!canvasActivityActive || !canvasActivityLastCapturedAt) return;
    const endedAt = Math.max(canvasActivityLastCapturedAt, Number(endAt) || Date.now());
    let cursor = canvasActivityLastCapturedAt;
    while (endedAt - cursor >= 250) {
      const chunkEnd = Math.min(endedAt, cursor + 9 * 60 * 1000);
      canvasActivityPending.push({ startedAt: cursor, endedAt: chunkEnd });
      cursor = chunkEnd;
    }
    canvasActivityLastCapturedAt = endedAt;
  }

  function sendNextCanvasActivity(keepalive) {
    if (canvasActivitySending || !canvasActivityPending.length || !filePath) return;
    const interval = canvasActivityPending[0];
    canvasActivitySending = interval;
    postCanvasActivity(interval, keepalive)
      .then(({ response, json }) => {
        if (!response.ok) throw new Error(json.error || 'canvas activity failed');
        const index = canvasActivityPending.indexOf(interval);
        if (index >= 0) canvasActivityPending.splice(index, 1);
      })
      .catch((error) => {
        console.warn('[画布] 前台时间暂未写入，将稍后重试', error);
      })
      .finally(() => {
        if (canvasActivitySending === interval) canvasActivitySending = null;
        if (canvasActivityPending.length && canvasActivityActive) {
          window.setTimeout(() => sendNextCanvasActivity(false), 1200);
        }
      });
  }

  function postCanvasActivity(interval, keepalive) {
    return fetch('/api/canvas-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: !!keepalive,
      body: JSON.stringify({
        path: filePath,
        sessionId: canvasActivitySessionId,
        startedAt: new Date(interval.startedAt).toISOString(),
        endedAt: new Date(interval.endedAt).toISOString(),
      }),
    }).then((response) => response.json().then((json) => ({ response, json })));
  }

  function flushCanvasActivityKeepalive() {
    canvasActivityPending.slice().forEach((interval) => {
      postCanvasActivity(interval, true)
      .then(({ response, json }) => {
        if (!response.ok) throw new Error(json.error || 'canvas activity failed');
        const index = canvasActivityPending.indexOf(interval);
        if (index >= 0) canvasActivityPending.splice(index, 1);
      })
      .catch(() => {});
    });
  }

  function pauseCanvasActivity(keepalive) {
    if (!canvasActivityActive) return;
    captureCanvasActivity(Date.now());
    canvasActivityActive = false;
    canvasActivityLastCapturedAt = 0;
    if (canvasActivityHeartbeat) window.clearInterval(canvasActivityHeartbeat);
    canvasActivityHeartbeat = 0;
    if (keepalive) flushCanvasActivityKeepalive();
    else sendNextCanvasActivity(false);
  }

  function resumeCanvasActivity() {
    if (!canvasActivityReady || canvasActivityActive || document.hidden || !document.hasFocus()) return;
    canvasActivityActive = true;
    canvasActivityLastCapturedAt = Date.now();
    if (canvasActivityHeartbeat) window.clearInterval(canvasActivityHeartbeat);
    canvasActivityHeartbeat = window.setInterval(() => {
      captureCanvasActivity(Date.now());
      sendNextCanvasActivity(false);
    }, 30000);
    sendNextCanvasActivity(false);
  }

  function startCanvasActivityTracker() {
    canvasActivityReady = true;
    window.addEventListener('focus', resumeCanvasActivity);
    window.addEventListener('blur', () => pauseCanvasActivity(true));
    window.addEventListener('pagehide', () => pauseCanvasActivity(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseCanvasActivity(true);
      else resumeCanvasActivity();
    });
    window.requestAnimationFrame(resumeCanvasActivity);
  }

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
          shortcutsOverlay: document.querySelector('[data-role="shortcuts"]'),
          shortcutsClose: document.querySelector('[data-role="shortcuts-close"]'),
          helpBtn: document.querySelector('[data-role="help-btn"]'),
          onboardingHint: document.querySelector('[data-role="first-open-hint"]'),
          // 完整的新手引导由 editor-onboarding.js 接管；旧的定时文字胶囊仅保留兼容数据，不再由新建画布触发。
          onboardingReset: null,
          fresh: false,
          rulerMenu: document.querySelector('[data-role="ruler-angle-menu"]'),
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
          embed: EMBED,
          readonly: READONLY,
          data: canvasData,
          initialViewport: json.viewport,
          onViewportChange: queueViewportSave,
          onChange: markDirty,
        });
        document.dispatchEvent(new CustomEvent('editor:canvasready'));
        startCanvasActivityTracker(json.canvasActivity || {});
        if ((LOCATE_NODE || LOCATE_TASK_ROOT) && typeof window.CanvasModule.revealNode === 'function') {
          window.setTimeout(() => {
            let located = false;
            if (LOCATE_NODE) {
              try { located = !!window.CanvasModule.revealNode(LOCATE_NODE); } catch (e) {}
            }
            if (!located && LOCATE_TASK_ROOT) {
              document.dispatchEvent(new CustomEvent('editor:open-task-root', {
                detail: { rootId: LOCATE_TASK_ROOT },
              }));
            }
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

  window.EditorShell = window.EditorShell || {};
  window.EditorShell.saveNow = save;
  window.EditorShell.getFilePath = function () { return filePath; };

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
      const noteCount = Number(json.noteCount) || 0;
      const nodeCount = Number(json.nodeCount);
      window.alert(toolbarLanguage === 'en'
        ? ('Exported ' + json.count + ' Markdown files'
          + (Number.isFinite(nodeCount) ? ' (' + nodeCount + ' nodes, ' + noteCount + ' notes)' : '')
          + '\n\n' + json.path)
        : ('导出完成：' + json.count + ' 个 Markdown 文件'
          + (Number.isFinite(nodeCount) ? '（' + nodeCount + ' 个节点，' + noteCount + ' 篇笔记）' : '')
          + '\n\n' + json.path));
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
