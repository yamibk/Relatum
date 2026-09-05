(function () {
  'use strict';

  const STORAGE_KEY = 'canvas:toolbarLanguage';
  const EN = {
    '\u5728\u6240\u9009\u4f4d\u7f6e\u63d2\u5165\u6216\u5220\u9664\u884c\u5217': 'Insert or delete rows and columns at the selection',
    '\u7528\u952e\u76d8\u6253\u5f00\u540c\u4e00\u884c\u5217\u83dc\u5355': 'Open the same row and column menu from the keyboard',
    '\u5de5\u4f5c\u5ba4\u201c\u5c3a\u5bf8\u201d': 'Table Studio “Size”',
    '\u5c55\u5f00\u7701\u7565\u5185\u5bb9\u3001\u5168\u90e8\u9002\u5bbd\u3001\u5217\u7b49\u5bbd\u6216\u6062\u590d\u9ed8\u8ba4\u5c3a\u5bf8': 'Expand truncated content, fit all columns, equalize columns, or reset sizes',
    '\u77e9\u9635\u5de5\u4f5c\u5ba4\u201c\u8f6c\u7f6e\u201d': 'Matrix Studio “Transpose”',
    '\u4ea4\u6362\u6574\u5f20\u77e9\u9635\u7684\u884c\u4e0e\u5217\uff0c\u5e76\u6062\u590d\u5408\u9002\u7684\u9ed8\u8ba4\u5c3a\u5bf8': 'Swap matrix rows and columns, then restore suitable default sizes',
    '起步页': 'Home', '最近': 'Recent', '收藏': 'Favorite', '分组': 'Groups',
    '复习': 'Review', '日历': 'Calendar', '速记': 'Notes', '活跃': 'Activity', '树状': 'Tree',
    '复': 'Review', '学': 'Study', '专': 'Focus',
    'spineReviewGlyph': 'R', 'spineCalendarGlyph': 'C', 'spineStudyGlyph': 'S',
    '学习': 'Study', '专注': 'Focus', '画布': 'Canvas', '导图': 'Mind Map', '图案': 'Shapes', '工具': 'Tools',
    '笔记': 'Notes', '生涯': 'Career', '工作区': 'Workspace', 'Markdown 笔记库': 'Markdown notes library',
    '笔记文件树': 'Notes tree', '笔记库': 'Notes Library', '刷新笔记库': 'Refresh notes library',
    '新建笔记': 'New note', '新建文件夹': 'New folder', '本地目录 · notes/': 'Local folder · notes/',
    '在资源管理器中打开': 'Open in File Explorer', '选择一篇笔记': 'Select a note',
    '编辑模式': 'Editing mode', '书写': 'Write', '阅读': 'Read',
    '显示笔记目录': 'Show notes tree', '显示链接面板': 'Show links panel', '当前笔记菜单': 'Current note menu',
    'Markdown 源码编辑器': 'Markdown source editor', 'Markdown 源码降级编辑器': 'Markdown fallback source editor', '开始书写 Markdown…': 'Start writing Markdown…',
    '从第一行开始': 'Begin with the first line', '笔记就是 notes/ 里的 Markdown 文件。': 'Notes are simply Markdown files inside notes/.',
    '笔记链接': 'Note links', '链接': 'Links', '关闭链接面板': 'Close links panel',
    '链接到的笔记': 'Outgoing links', '反向链接': 'Backlinks', '复制内容': 'Copy content', '恢复此版本': 'Restore version',
    '生涯使用报告': 'Career usage report', '查看我的使用报告': 'View my usage report',
    '统计画布、笔记、学习、专注与完成记录。': 'Canvas, Notes, Study, Focus, and completion records.',
    '全部计算在本机完成。': 'Everything is calculated on this device.',
    '正在生成报告': 'Generating report', '正在读取本地记录…': 'Reading local records…',
    '任务簿': 'Taskbook', '打开完成分组': 'Open completed group',
    '普通': 'Standard', '专业': 'Professional', '编辑': 'Edit', '完整界面': 'Full interface',
    '加载中…': 'Loading…', '加载中...': 'Loading…', '帮助': 'Help', '设置': 'Settings',
    '选择表格工具；双击画布空白处创建': 'Select the table tool, then double-click empty canvas space to create.',
    '新建分组': 'New group', '打开起步页使用指引': 'Open the getting-started guide',
    '查看本地数据与空间管理说明': 'View the local data and storage guide',
    '关闭本地数据说明': 'Close the local data guide',
    '数据说明翻页': 'Local data guide page navigation', '数据说明目录': 'Local data guide contents',
    'Relatum · 本地数据说明': 'Relatum · Local Data Guide',
    '删除前先看': 'Before deleting', 'canvases 与 notes': 'canvases and notes',
    'canvases 文件夹': 'canvases folder', 'data 文件夹': 'data folder',
    '本机偏好': 'On-device preferences',
    '先退出 Relatum，再在资源管理器中整理文件 · 按': 'Quit Relatum before managing files in File Explorer · Press',
    '或': 'or', '上一页': 'Previous page', '下一页': 'Next page',
    '切换为浅色起始页': 'Switch to light theme', '切换为深色起始页': 'Switch to dark theme',
    '调整翻页速度': 'Adjust page motion', '分组导航': 'Page navigation',
    '主页背景风格': 'Home background style', '速记便签墙': 'Notes', '页面便签': 'Page sticky note', '活跃热力图': 'Activity',
    '学习页': 'Study page', '树状页': 'Tree page', '活跃热力图页': 'Activity page', '速记便签墙页': 'Notes page',
    '日历与日记页': 'Calendar and journal page', '复习卡片页': 'Review page', '专注钟页': 'Focus page',
    '打开文件': 'Open file', '打开已有文件': 'Open an existing file', '新建画布': 'New canvas',
    '导入画布': 'Import canvas', '导入已有画布': 'Import an existing canvas',
    '导入文件夹': 'Import folder', '导入画布文件夹': 'Import canvas folder',
    '扫描画布文件夹': 'Scan canvas folder',
    '扫描 canvases 文件夹，补充新画布并清理失效登记': 'Scan the canvases folder, add new canvases, and clean up missing entries',
    '导入 MD': 'Import MD', '导入 MD 文件夹': 'Import MD folder', '进入学习页': 'Go to Study',
    '右上角可以新建空白画布，也可以把外部': 'Use the upper-right actions to create a blank canvas or copy an external',
    '、整个画布文件夹或 Markdown 文件夹复制导入本项目。': ', a full canvas folder, or a Markdown folder into this project.',
    '复制一张': 'Copy one', '和同名素材目录，然后打开项目内副本。': 'with its matching assets, then open the managed copy.',
    '严格检查并整批导入顶层画布与同名素材。': 'Strictly validate and batch-import top-level canvases with matching assets.',
    '开始你的第一张画布': 'Begin with your first canvas',
    '为想法、规划、知识网络准备一块空白': 'A quiet space for ideas, plans, and connected knowledge.',
    '回收站': 'Trash', '任务回收站': 'Task Trash', '清空回收站': 'Empty Trash',
    '客户端设置': 'Desktop Settings', 'DESKTOP CLIENT': 'DESKTOP CLIENT',
    '设置窗口从最大化恢复后使用的大小。标题栏的最小化按钮仍会将窗口收进任务栏。': 'Choose the window size used after leaving maximized view. Minimize still sends the app to the taskbar.',
    '紧凑': 'Compact', '均衡': 'Balanced', '宽敞': 'Spacious', '宽度': 'Width', '高度': 'Height',
    '应用': 'Apply', '可选范围会按当前显示器自动调整': 'Available sizes adapt to the current display.',
    '界面语言': 'Interface language', '中文': 'Chinese', '英文': 'English',
    '笔记正文字号': 'Note text size', '100% 对应 16px，只缩放 Markdown 正文与行内标题': '100% equals 16px and scales only Markdown text and the inline title',
    '起始页、专注、学习与画布使用同一种语言': 'Use one language across Home, Focus, Study, and Canvas.',
    '翻页速度': 'Page motion', '快': 'Fast', '慢': 'Slow', '生涯滚动手感': 'Career scroll feel', '生涯揭示等待': 'Career reveal delay',
    '生涯滚轮力度': 'Career wheel strength', '生涯惯性滑行': 'Career scroll inertia', '生涯连滚加速': 'Career repeated-wheel acceleration',
    '生涯滚动速度上限': 'Career scroll speed limit', '滚轮力度': 'Wheel strength', '惯性滑行': 'Scroll inertia',
    '连滚加速': 'Repeated-wheel acceleration', '速度上限': 'Speed limit', '揭示等待': 'Reveal delay',
    '滚动时暂停揭示': 'Pause reveals while scrolling', '速记页设置': 'Quick Notes settings',
    '拖拽惯性': 'Drag inertia', '稳': 'Steady', '滑': 'Fluid',
    '叠放展开延迟': 'Stack expansion delay', '瞬发': 'Instant', '长按': 'Long press',
    '速记控制台': 'Quick Notes controls', '打开速记控制台': 'Open Quick Notes controls',
    '生成颜色': 'Generated colors', '新建与随机换色从选中色中抽取': 'New notes and random recoloring use the selected colors.',
    '新建与随机换色从选中色中抽取；未选中任何颜色时，仍使用全部颜色。': 'New notes and random recoloring use the selected colors; when none are selected, all colors remain available.',
    '参与随机生成的便签颜色': 'Sticky note colors used for random generation',
    '交互手感': 'Interaction feel', '视野': 'View', '总览便签': 'Fit notes', '重置视野': 'Reset view',
    '恢复默认': 'Reset', '已恢复': 'Restored', '全选': 'Select all', '取消全选': 'Clear all',
    '打开速记快捷键说明': 'Open Quick Notes keyboard shortcuts', '速记快捷键': 'Quick Notes shortcuts',
    '创建与连接': 'Create & connect', '浏览与搜索': 'Browse & search', '编辑便签': 'Edit notes', '视野与历史': 'View & history',
    '在鼠标位置或视野中心新建便签': 'Create a note at the pointer or view center',
    '在当前便签右侧新建': 'Create to the right of the current note',
    '在当前便签下方新建': 'Create below the current note',
    '在右侧新建并连线': 'Create to the right and connect it',
    '在下方新建并连线': 'Create below and connect it',
    '依次切换便签': 'Move through notes', '搜索便签': 'Search notes',
    '退出搜索或取消键盘浏览': 'Exit search or keyboard browsing',
    '随机换色': 'Randomly recolor', '随机旋转': 'Randomly rotate',
    '端正当前便签': 'Straighten the current note', '复制当前便签': 'Duplicate the current note',
    '以鼠标位置为中心缩放视野': 'Zoom the view around the pointer',
    '按住后拖动视野': 'Hold, then drag the view', '平移视野': 'Pan the view',
    '快速平移视野': 'Pan the view faster', '总览全部便签': 'Fit all notes',
    '定位当前便签': 'Focus the current note', '撤销': 'Undo', '重做': 'Redo',
    '速记墙可以像画布一样平移、缩放和惯性滑行。鼠标移到速记页右缘中央的小签附近才会浮现控制台入口，其中的「拖拽惯性」同时控制便签与整面墙的滑行强度。': 'Pan, zoom, and glide across Quick Notes like a canvas. Move the pointer near the small tab at the center of the right edge to reveal its controls; Drag inertia affects both notes and the whole wall.',
    '右缘中央小签': 'Center-right control tab', '选择随机生成颜色、调整手感、总览或重置视野。': 'Choose generated colors, tune the feel, fit notes, or reset the view.',
    '从控制台启用的颜色中随机更换当前便签颜色。': 'Randomly recolor the current note using colors enabled in the controls.',
    '主页背景': 'Home background', '简洁': 'Minimal', '沉浸': 'Immersive',
    '足迹星图动画': 'Activity constellation motion', '重置': 'Reset', '生长时长': 'Growth duration',
    '错峰间隔': 'Stagger', '入场力度': 'Entrance force', '阻尼': 'Damping', '速度上限': 'Speed limit',
    '结束后自动取景': 'Reframe after motion', '关闭时镜头不再补移动': 'When off, the camera stays where the motion ends.',
    '日历倒数日': 'Calendar countdown', '在日历页显示目标日期': 'Show target dates on Calendar.',
    '学习、树状、速记计时': 'Study, Tree, and Quick Notes timing',
    '开启后记录这三页的前台使用时长': 'When enabled, foreground time on these three pages is recorded.',
    '显示三页统计数字': 'Show three-page statistics',
    '在活跃页显示绿色附加统计': 'Show the green add-on statistics in Activity.',
    '打开翻页时钟': 'Open flip clock', '翻页时钟': 'Flip clock',
    '关闭翻页时钟': 'Close flip clock', '倒数事件列表': 'Countdown events',
    '倒数事件': 'Countdown events', '关闭事件列表': 'Close event list',
    '编辑倒数事件': 'Edit countdown', '删除倒数事件': 'Delete countdown',
    '新建倒数日': 'New countdown', '创建第一个倒数日': 'Create first countdown',
    '返回日历': 'Back to Calendar', '事件名称': 'Event name', '目标日期': 'Target date',
    '准备迎接什么？': 'What are you counting down to?', '至少保留一个倒数日': 'Keep at least one countdown.',
    '倒数日进度': 'Countdown progress', '设置倒数日进度区间': 'Set countdown progress range',
    '长度': 'Length', '长度需要是 1 到 9999 之间的整数': 'Length must be an integer from 1 to 9999',
    '开始日期': 'Start date', '编辑倒数日进度的方式': 'Countdown progress editing method',
    '请选择有效的开始日期': 'Choose a valid start date.',
    '开始日期必须早于截止日期': 'The start date must be before the deadline.',
    '进度区间最多为 9999 天': 'The progress range cannot exceed 9999 days.',
    '截止': 'Deadline', '尚未设置进度区间': 'Progress range not set',
    '请先创建倒数日': 'Create a countdown first',
    '时': 'hr', '秒': 'sec',
    '隐藏特殊页': 'Hide utility pages',
    '收起复习/日历/速记/活跃/树状/学习/专注，只留最近·收藏·分组': 'Hide Review, Calendar, Notes, Activity, Tree, Study, and Focus; keep Recent, Favorites, and Groups.',
    '精简目标树编辑': 'Simplify Goal Tree editing',
    '强制按解锁顺序': 'Enforce unlock order',
    '开启后，完成前项才能勾选或推进后项': 'When enabled, finish prerequisites before completing or advancing later tasks.',
    '隐藏高级解锁编辑，已有路线与解锁关系不受影响': 'Hide advanced unlock editing without changing existing routes or unlock relationships.',
    '隐藏根节点标题': 'Hide root title',
    '树状页黑色根节点只显示进度百分比': 'Show only the progress percentage on the black Tree root node.',
    '根节点标题字号': 'Root title size', '小': 'Small', '大': 'Large',

    '新建任务': 'New task', '任务': 'Tasks', '任务详情': 'Task details', '任务画布': 'Task canvas',
    '今日': 'Today', '今日任务': 'Today tasks', '待办': 'To do', '进行中': 'In progress',
    '未完成': 'Active', '已完成': 'Completed', '归档': 'Archive', '归档已完成任务': 'Archive completed tasks', '都带到今天': 'Move all to today', '不用了': 'Not now',
    '添加今日任务': 'Add today’s task', '开始专注': 'Start focus', '专注投入': 'Focus time',
    '尚无记录': 'No sessions yet', '状态': 'Status', '标题': 'Title', '备注': 'Notes',
    '学习任务': 'Study tasks', '学习任务进度': 'Study task progress', '任务清单': 'Task list',
    '学习任务页切换': 'Switch study task page', '学习任务页说明': 'Study task page note',
    '临时任务': 'Temporary tasks', '打开临时任务': 'Open temporary tasks', '收起临时任务': 'Close temporary tasks',
    '加入临时任务': 'Add to temporary tasks', '移出临时任务': 'Remove from temporary tasks',
    '把未完成任务拖到屏幕最右侧，或从任务设置中加入。': 'Drag an active task to the far right, or add it from task settings.',
    '新建学习任务': 'New study task', '学习任务标题': 'Study task title',
    '设置目标': 'Set goal', '目标总量': 'Goal total', '单位': 'Unit', '任务长度': 'Task length',
'请先设置任务长度': 'Please set a target first',
'任务点位置必须在 1 到任务长度之间': 'Milestone position must be between 1 and the target',
'把任务长度拆成有名字的任务点。达成状态会根据当前进度自动点亮。': 'Break the target into named milestones. Status lights up automatically as you progress.',
    '任务点': 'Milestones', '添加任务点': 'Add milestone',
    '任务点名称': 'Milestone name', '任务点位置': 'Milestone position',
    '第': 'At', '点': 'units', '已到达': 'Reached',
    '写下一个学习任务…': 'Write a study task…', '添加': 'Add',
    '目标树': 'Goal Tree', '打开目标树': 'Open Goal Tree', '目标树使用教程': 'Goal Tree tutorial', '我的学习路线': 'My learning route',
    '目标树是一棵固定的总路线：根目标下面可以建立多级分支，也可以让任务接在另一任务或具体任务点后；进度和完成状态与学习页共用同一份数据。': 'Goal Tree is one master route: build nested branches below the root, or connect a task after another task or a milestone. Progress and completion stay shared with Study.',
    '节点上的 ＋': 'Node +',
    '在根目标或分支下新建分支、新建任务或选择已有任务；任务节点上的 ＋ 可建立后续任务。': 'Create a branch or task, or choose an existing task below the root or a branch. Use + on a task to create its next task.',
    '任务圆点与 − / ＋': 'Task circle and − / +',
    '圆点负责完成或恢复；− / ＋ 直接推进数值进度，路线上的任务点会随进度点亮。': 'The circle completes or restores a task. − / + changes numeric progress directly, and route milestones light up as you reach them.',
    '节点「…」': 'Node “…”',
    '只保留改名、设置进度、接入后续任务、移出路线或删除分支等必要操作。': 'Only essential actions remain: rename, set progress, attach a following task, remove from route, or delete a branch.',
    '拖动节点': 'Drag nodes',
    '整棵子树跟随指针移动；松手时才排序。拖到根的左侧或右侧可换边，也可把任务接到分支、任务末尾或具体任务点。': 'The whole subtree follows the pointer and reorders only on release. Drop on either side of the root to switch sides, or attach a task to a branch, another task, or a milestone.',
    '双击名称': 'Double-click a name',
    '直接打开轻量改名弹层。': 'Open the lightweight rename popover directly.',
    '适应 / 滚轮 / 拖动空白': 'Fit / wheel / drag empty space',
    '路线按左右自由导图排列；适应按钮恢复全景，滚轮连续缩放，拖动空白平移。': 'The route uses a free left/right mind-map layout. Fit restores the overview, the wheel zooms continuously, and dragging empty space pans.',
    '项任务': 'tasks', '添加': 'Add', '更多': 'More', '适应': 'Fit',
    '新建分支': 'New stage', '新建阶段': 'New stage', '新建任务': 'New task', '选择已有任务': 'Choose an existing task',
    '新建后续任务': 'New following task', '新建后续阶段': 'New following stage', '接入已有任务': 'Attach existing task',
    '改名': 'Rename', '设置进度': 'Set progress', '取消进度条': 'Remove progress bar', '移出路线': 'Remove from route', '删除分支': 'Delete stage', '删除阶段': 'Delete stage',
    '分支名称': 'Stage name', '阶段名称': 'Stage name', '添加分支': 'Add stage', '添加阶段': 'Add stage', '任务名称': 'Task name', '创建任务': 'Create task',
    '加入路线': 'Add to route', '没有可加入的学习任务': 'No available study task', '名称': 'Name',
    '当前进度': 'Current progress', '请稍候': 'Please wait', '已移除任务': 'Removed task',
    '请求超时，请重试': 'Request timed out, please retry',
    '从路线移出任务？': 'Remove this task from the route?', '任务仍会保留在学习页。': 'The task will remain on the Study page.',
    '删除这个分支？': 'Delete this stage?', '删除这个阶段？': 'Delete this stage?',
    '整段分支会从路线移除，其中的学习任务仍保留在学习页。': 'The whole stage will leave the route; its study tasks will remain.',
    '整个阶段会从路线移除，其中的学习任务仍保留在学习页。': 'The whole stage will leave the route; its study tasks will remain.',
    '解锁条件': 'Unlock conditions', '主路线条件': 'Primary route condition', '附加条件': 'Additional conditions',
    '无主路线条件': 'No primary route condition', '无附加条件': 'No additional conditions',
    '添加解锁条件': 'Add unlock condition', '管理解锁条件': 'Manage unlock conditions',
    '移除': 'Remove', '管理': 'Manage', '定位来源': 'Locate source', '达到任务点': 'Reach milestone',
    '等待解锁': 'Waiting to unlock', '全部条件满足后才可推进。': 'You can progress after every condition is met.',
    '继承自所属阶段': 'Inherited from its stage',
    '进度明细': 'Progress details', '任务进度总和': 'Task progress total', '项': 'items',
    '未设置进度': 'No progress target', '尚无参与统计的任务': 'No tasks are included in this calculation.',
    '仅展示前 50 项，公式仍按全部任务计算': 'Showing the first 50 tasks; the formula still uses all tasks.',
    '阶段只汇总包含的任务；解锁关系不会改变进度归属。': 'A stage only aggregates contained tasks; unlock relationships do not change progress ownership.',
    '一分钟开始使用': 'Start in one minute', '下一步做什么': 'What to do next',
    '阶段与进度': 'Stages and progress', '箭头、解锁与高级编辑': 'Arrows, unlocking, and advanced editing',
    '目标树最重要的用途，是把学习任务排成一条看得见的路线。': 'The main purpose of Goal Tree is to arrange study tasks into a route you can see.',
    '点击根目标或阶段右侧的“＋”，新建任务或接入已有任务。': 'Use + on the root goal or a stage to create a task or attach an existing one.',
    '任务与学习页共用数据：在任一处完成或修改进度，另一处会同步。': 'Tasks share data with the Study page. Completing a task or changing progress in either place updates the other.',
    '先放入当前真正要做的任务，不必一开始就规划完整棵树。': 'Start with the tasks you actually need now; you do not have to plan the entire tree at once.',
    '点击顶部的“下一步”，目标树会定位到当前可以开始的任务；再点一次会查看下一个候选。': 'Click Next at the top to locate a task you can start now. Click again to see the next candidate.',
    '点击任务圆点，可以完成或恢复任务。': 'Click a task circle to complete or reopen the task.',
    '有数量目标时，用“− / ＋”推进；“设置进度”可修改当前值和总量。': 'For a numeric goal, use − / + to make progress. Set progress changes the current value and total.',
    '拖动卡片可调整路线；阶段右上角的箭头可收起或展开内容。': 'Drag cards to adjust the route. Use the arrow at a stage’s top right to collapse or expand its contents.',
    '阶段只是一组任务的收纳夹，不需要手动设置进度。': 'A stage is simply a folder for a group of tasks; it does not need manual progress.',
    '已完成任务记为 100%；有总量时按“当前 ÷ 总量”；未设总量且未完成时记为 0%。': 'A completed task is 100%. A task with a total uses current ÷ total. An incomplete task without a total is 0%.',
    '阶段平均它收纳的任务，根目标平均整棵树中的任务。': 'A stage averages the tasks it contains; the root goal averages the tasks in the whole tree.',
    '点击进度文字可查看每项任务和计算公式；需要另一套路线时，从左侧编号栏新建目标树。': 'Click progress text to see every task and the formula. Use the numbered rail on the left to create another route.',
    '只有需要“做完 A 才能做 B”时，才需要关心解锁条件。': 'You only need unlock conditions when B must wait until A is done.',
    '浅灰无箭头线表示“收纳在某阶段”；深色箭头线表示“完成后解锁下一项”。': 'A light gray line without an arrow means contained in a stage. A dark arrow means completing one item unlocks the next.',
    '虚线是附加条件；有多个条件时，必须全部满足才能推进。': 'A dashed line is an extra condition. When several conditions exist, all must be met before progress is allowed.',
    '被锁定的任务可改名、查看条件或移出路线，但不能修改进度。': 'A locked task can be renamed, inspected, or removed from the route, but its progress cannot change.',
    '默认只把解锁关系作为路线提示，任务仍可自由完成和修改进度；在起步页齿轮开启“强制按解锁顺序”后，未解锁任务才会被限制。': 'By default, unlock links only guide the route, and tasks may still be completed or updated freely. Turn on Enforce unlock order in Home settings to restrict locked tasks.',
    '如需添加附加解锁条件，请在起步页齿轮中关闭“精简目标树编辑”；这不会修改已有路线。': 'To add extra unlock conditions, turn off Simplify Goal Tree editing in Home settings. Existing routes are not changed.',
    '进度需要满足 0 ≤ 当前进度 ≤ 目标总量 ≤ 9999': 'Progress must satisfy 0 ≤ current ≤ target ≤ 9999',
    '当前进度和目标总量都需要是 0–9999 的整数': 'Current progress and goal total must both be integers from 0 to 9999.',
    '适应目标树；滚轮缩放，拖动画布平移': 'Fit Goal Tree; use the wheel to zoom and drag the canvas to pan',
    '适应目标树 · 滚轮缩放 · 拖动画布平移': 'Fit Goal Tree · Wheel to zoom · Drag to pan',
    '目标已达': 'Goal reached', '目标已达成，可以手动标记完成': 'Goal reached · You can mark it complete',
    '还没有学习任务，点击右上角的 ＋ 开始。': 'No study tasks yet · use + in the top right to begin.',
    '当前没有未完成任务。': 'There are no active tasks right now.',
'还没有已完成的任务。': 'No completed tasks yet.',
    '恢复任务': 'Restore task', '标记完成': 'Mark complete', '编辑任务': 'Edit task',
    '进度减一': 'Decrease progress by one', '进度加一': 'Increase progress by one',
    '圆角卡': 'Rounded card',
    '矩形': 'Rectangle', '胶囊': 'Pill', '菱形': 'Diamond', '圆形': 'Circle',
    '树状页画布': 'Tree page canvas',
    '树切换': 'Switch trees', '新建树': 'New tree', '适应整棵树': 'Fit the whole tree',
    '任务已移到回收站': 'Task moved to Trash',
    '已完成这一列还是空的': 'There are no completed tasks to archive.',
    '永久移除这条任务？此操作不可恢复。': 'Permanently remove this task? This cannot be undone.',
    '取消': 'Cancel', '保存': 'Save', '移到回收站': 'Move to Trash',
    '暂无任务': 'No tasks', '删除任务': 'Delete task',
    '删除这个任务？': 'Delete this task?',
    '任务及相关解锁条件都会永久删除。': 'The task and related unlock conditions will be permanently deleted.',
    '阶段、其中的全部任务与解锁条件都会永久删除。': 'The stage and all of its tasks and unlock conditions will be permanently deleted.',
    '删除这棵树？': 'Delete this tree?',
    '其中的全部阶段、任务与解锁条件都会永久删除。': 'All stages, tasks, and unlock conditions in it will be permanently deleted.',
    '还没有每日任务 · 点右上角“＋”加一件想每天坚持的事': 'No daily tasks yet · use “+” to add one small thing to repeat each day.',
    '未命名任务': 'Untitled task', '未命名分组': 'Untitled group', '（不分组）': '(No group)',
    '子分组': 'Subgroup', '在此加任务': 'Add task here', '空': 'Empty',
    '已绑定本段': 'Bound to session', '设为本段专注': 'Focus on this', '添加分组': 'Add group',
    '取消今日打卡': 'Undo today', '今日打卡': 'Check in today', '还没有历史打卡': 'No check-ins yet',

    '复习卡片': 'Review Cards', '待复习': 'Due', '今日复习': 'Reviewed today', '更新': 'Refresh',
    '复习统计': 'Review summary', '复习页面': 'Review views', '卡片库': 'Card library',
    '计划复习': 'Scheduled', '自由复习': 'Free review',
    '新建卡片': 'New card', '编辑卡片': 'Edit card', '基础卡片': 'Basic card',
    '还没有复习卡片': 'No review cards yet', '还没有正在复习的卡片': 'No active review cards',
    '从一个真正想记住的问题开始，不需要先创建画布。': 'Start with something you truly want to remember. No canvas required.',
    '直接在这里创建卡片，不需要先创建画布。': 'Create cards here directly. No canvas required.',
    '创建第一张卡片': 'Create your first card', '尚未复习': 'Not reviewed yet',
    '未命名问题': 'Untitled question', '先在心里回答，再查看背面的答案。': 'Recall the answer first, then reveal the back.',
    '想好后可以直接评分，也可以查看答案再核对。': 'Rate it right away, or reveal the answer to check yourself.',
    '可选的临时自测草稿，不会保存。': 'Optional scratch answer. It will not be saved.',
    '查看答案': 'Reveal answer', '收起答案': 'Hide answer', '记得': 'Remembered', '模糊': 'Vague', '不会': 'Forgot',
    '选择记忆程度': 'Choose recall level',
    '再来一张': 'Next card', '下一张': 'Next card',
    '复习范围': 'Review scope', '选择复习范围': 'Choose review scope', '全部卡组': 'All decks',
    '本轮': 'Session', '本轮 0 / 0': 'Session 0 / 0', '复习说明': 'Review guide',
    '范围卡片': 'Cards in scope', '自由浏览': 'Viewed freely', '随机 · 无限': 'Random · unlimited',
    '查看答案后，再选择记得程度': 'Reveal the answer before rating your recall.',
    '✦ 随机无限 · 不计进度、不改间隔': '✦ Random and unlimited · progress and intervals stay unchanged',
    '想好后查看答案核对，或直接换到下一张。': 'Reveal the answer to check yourself, or move straight to the next card.',
    '这个范围没有可自由复习的卡片': 'No cards are available for free review in this scope',
    '换一个复习范围，或到卡片库恢复一些卡片。': 'Choose another scope or resume some cards in the library.',
    '进入自由复习 →': 'Open free review →',
    '都按计划复习过了；自由复习仍可随时随机练习。': 'Everything is on schedule; Free review is always available for random practice.',
    '管理卡片': 'Manage cards', '张卡片 · 内容与复习进度独立保存': 'cards · content and progress are stored independently',
    '搜索问题、答案或说明': 'Search questions, answers, or notes',
    '搜索问题、答案、说明或标签': 'Search questions, answers, notes, or tags', '筛选卡片状态': 'Filter card status',
    '全部': 'All', '全部状态': 'All statuses', '复习中': 'Active', '已暂停': 'Paused', '已归档': 'Archived',
    '全部卡片': 'All cards', '未分类': 'Unfiled', '全部标签': 'All tags', '筛选卡片标签': 'Filter card tags',
    '筛选卡片卡组': 'Filter card deck', '卡组设置': 'Deck settings',
    '批量整理': 'Organize', '完成整理': 'Done', '修改状态…': 'Change status…',
    '批量修改状态': 'Change selected status', '恢复复习': 'Resume review',
    '按卡组筛选': 'Filter by deck', '新建卡组': 'New deck', '编辑卡组': 'Edit deck', '管理卡组': 'Manage deck',
    '全选当前结果': 'Select current results', '张已选': 'selected', '移动到卡组…': 'Move to deck…',
    '批量移动到卡组': 'Move selected to deck', '标签，用逗号分隔': 'Tags, separated by commas',
    '批量标签': 'Batch tags', '添加标签': 'Add tags', '移除标签': 'Remove tags', '删除所选': 'Delete selected',
    '选择卡片': 'Select card', '卡组': 'Deck', '卡组（可选）': 'Deck (optional)',
    '未分类 / 输入卡组': 'Unfiled / enter a deck', '已有': 'Existing', '新建': 'New',
    '已有卡组': 'Existing deck', '保存卡片时创建': 'Create when the card is saved', '留空保存': 'Save without a deck',
    '最多 12 个': 'Up to 12', '重点，考试，公式': 'core, exam, formula',
    '卡组名称': 'Deck name', '例如：高等数学': 'For example: Calculus',
    '删除卡组不会删除卡片，卡片会回到“未分类”。': 'Deleting a deck keeps its cards and moves them to Unfiled.',
    '删除卡组': 'Delete deck', '保存卡组': 'Save deck',
    '暂停复习': 'Pause review', '归档': 'Archive',
    '没有符合条件的卡片': 'No matching cards', '调整筛选条件，或者创建一张新卡片。': 'Adjust the filters or create a new card.',
    '问题': 'Question', '卡片正面': 'Card front', '写下一个清楚、可以作答的问题': 'Write a clear, answerable question',
    '答案': 'Answer', '支持 Markdown 与公式': 'Supports Markdown and math', '写下用于核对的答案': 'Write the answer you will check against',
    '补充说明': 'Notes', '可选，不作为答案的一部分': 'Optional context, separate from the answer',
    '背景、线索或延伸阅读': 'Context, hints, or further reading', '删除卡片': 'Delete card', '保存卡片': 'Save card',
    '更多选项': 'More options', '复习设置': 'Review settings', '每轮卡片': 'Cards per session',
    '10 张': '10 cards', '20 张': '20 cards', '50 张': '50 cards',
    '出题顺序': 'Card order', '到期优先': 'Due first', '随机': 'Random', '薄弱优先': 'Weakest first',
    '查看答案后再评分': 'Rate after revealing the answer',
    '避免没核对答案就误点记得。': 'Prevents rating a card before checking the answer.',
    '保存设置': 'Save settings', '怎么复习': 'How to review',
    '先选择要复习的卡组。': 'Choose the deck you want to review.',
    '在心里作答，需要时写一点临时草稿。': 'Recall the answer and use the scratch area if helpful.',
    '查看答案，再选择“记得、模糊、不会”。': 'Reveal the answer, then choose Remembered, Vague, or Forgot.',
    '直接选择记忆程度；需要核对时再查看答案。': 'Choose your recall level directly; reveal the answer only when you want to check.',
    '草稿不会保存；评分只会调整下次复习时间。': 'Scratch text is not saved; ratings only adjust the next review date.',
    '选择范围后，系统会把其中正在复习的卡片随机打乱。': 'Choose a scope and its active cards will be shuffled.',
    '每张卡只用于练习；不会改变熟练度、到期日或今日统计。': 'Each card is practice only; mastery, due dates, and today’s stats stay unchanged.',
    '一轮看完会自动重新洗牌，可以一直复习下去。': 'After every pass, the cards reshuffle automatically so you can continue indefinitely.',
    '自由复习没有每轮数量和出题顺序设置。': 'Free review has no session limit or card-order settings.',
    '自由复习快捷键': 'Free-review shortcuts',
    '复习快捷键': 'Review shortcuts', '知道了': 'Got it',
    '卡片库说明': 'Card library guide', '卡片库与推送规则': 'Card library & scheduling',
    '一句话：': 'In short:',
    '只有处于“复习中”、位于当前复习范围，并且已经到期的卡片，才会进入《计划复习》。': 'Only active cards in the current review scope that are due will appear in Scheduled review.',
    '卡片怎样进入《计划复习》': 'How cards enter Scheduled review',
    '新建卡片会在创建当天进入待复习。': 'New cards become due on the day they are created.',
    '范围可以是全部卡组、未分类或一个卡组；每轮最多取设置中的 10 / 20 / 50 张。': 'The scope can be all decks, Unfiled, or one deck; each session takes up to the configured 10, 20, or 50 cards.',
    '没有到期的卡片不会因为切换出题顺序而提前出现。': 'Cards that are not due will not appear early when you change the order.',
    '评分怎样改变下次日期': 'How ratings change the next date',
    '升一级，依次在 1、3、7、16、35 天后再见。': 'Move up one level, then return after 1, 3, 7, 16, or 35 days.',
    '不升级，沿用当前级别的间隔；新卡至少隔天再见。': 'Stay at the same level and keep its interval; a new card returns no sooner than tomorrow.',
    '回到初始级并继续算作今天到期；本轮先移出，再开一轮可再次出现。': 'Return to the initial level and remain due today; it leaves this session but can reappear in another one.',
    '顺序与熟练度': 'Order & mastery',
    '到期日最早的先出现。': 'The earliest due date appears first.',
    '把已经到期的卡片随机排列。': 'Shuffle the cards that are already due.',
    '在到期卡片中，从较低熟练度开始。': 'Start with the lowest-mastery cards among those due.',
    '“生”是初始级，“疑”是第 1–2 级，“熟”是第 3–5 级。': 'New is the initial level, Learning covers levels 1–2, and Mature covers levels 3–5.',
    '暂停、归档与删除': 'Pause, archive & delete',
    '到期后正常进入《计划复习》。': 'Enter Scheduled review normally when due.',
    '临时停止推送，内容、进度和下次日期都保留。': 'Temporarily stop scheduling while keeping the content, progress, and next date.',
    '长期收起、不再推送，也可重新恢复为复习中。': 'Put away long-term and stop scheduling; it can still be restored to Active.',
    '暂停和归档在推送上都等于“不出现”，区别只是管理用途。': 'Paused and Archived are both excluded from scheduling; the difference is how you organize them.',
    '卡组只决定筛选与复习范围，标签只用于搜索，都不会改变复习日期。删除卡组时卡片会回到“未分类”；删除卡片后内容无法恢复，但已有的复习统计仍会保留。“再来一张”只会跳过当前卡，自由复习不会改变进度或间隔。': 'Decks only control filtering and review scope, while tags are only for search; neither changes review dates. Deleting a deck moves its cards to Unfiled. Deleting a card cannot be undone, but existing review statistics remain. Next card only skips the current card, and free review does not change progress or intervals.',
    '还没有填写答案或说明': 'No answer or notes yet', '今天到期': 'Due today', '下次': 'Next', '未安排': 'Not scheduled',
    '暂停': 'Pause', '恢复': 'Resume', '卡片已创建': 'Card created', '卡片已更新': 'Card updated',
    '卡片已删除': 'Card deleted', '卡片已暂停': 'Card paused', '卡片已恢复复习': 'Card resumed',
    '卡组已创建': 'Deck created', '卡组已更新': 'Deck updated', '卡组已删除，卡片已移到未分类': 'Deck deleted; cards moved to Unfiled',
    '卡片状态已批量更新': 'Card statuses updated', '卡片已移动到新卡组': 'Cards moved to the new deck',
    '已批量添加标签': 'Tags added', '已批量移除标签': 'Tags removed', '所选卡片已删除': 'Selected cards deleted',
    '先输入要处理的标签': 'Enter tags first', '删除卡组后，卡片会回到未分类': 'Cards will move to Unfiled after deleting this deck',
    '确定永久删除这张复习卡片吗？': 'Permanently delete this review card?',
    '再次点击确认删除': 'Select again to delete', '删除后无法恢复，再点击一次确认': 'This cannot be undone. Select delete again to confirm.',
    '这一轮完成了': 'Session complete', '再来一轮': 'Start another session',
    '还有 {count} 张到期卡片，可以休息一下，也可以再开一轮。': '{count} due cards remain. Take a break or start another session.',
    '请先查看答案': 'Reveal the answer first', '复习设置已保存': 'Review settings saved',
    '复习范围已切换': 'Review scope changed',

    '专注钟': 'Focus Timer', '今日段数': 'Sessions today', '今日专注': 'Focus today',
    '今日专注统计': 'Today’s focus summary', '专注设置': 'Focus settings',
    '专注页使用帮助': 'Focus help', '重新读取专注数据': 'Refresh focus data',
    '准备开始': 'Ready when you are', '番茄钟': 'Pomodoro', '正计时': 'Open timer',
    '番茄钟 · 专注 25 / 休息 5 分': 'Pomodoro · 25 focus / 5 rest', '准备这一段': 'Prepare this session',
    '专注于': 'Focus on', '不绑定 · 只是专注': 'No task · just focus', '本段目标': 'Session intention',
    '开始前写下这一段准备完成什么；运行中也可点座舱目标行随时补改。': 'Write down what this session should accomplish. You can refine it while the timer is running.',
    '这一段准备完成什么？（可选）': 'What will you accomplish this session? (optional)',
    '绑定每日任务': 'Link a daily task', '计时模式': 'Timer mode',
    '双击修改专注时长': 'Double-click to change focus length',
    '开始或暂停': 'Start or pause', '开始': 'Start', '暂停': 'Pause', '完成本段': 'Finish session',
    '退出深度专注': 'Exit deep focus', '深度专注': 'Deep focus', '今日足迹': 'Today’s trail',
    '今天还没有专注记录 · 开始第一段吧': 'No focus sessions yet · begin the first one.',
    '今日没有专注记录': 'No focus sessions today',
    '补一句实际成果，再继续、收工或明确完成任务。': 'Capture the outcome, then continue, stop, or complete the task.',
    '实际完成': 'Outcome', '保存并继续': 'Save & continue', '保存并收工': 'Save & finish',
    '保存并完成任务': 'Save & complete task', '专注记录': 'Focus session', '编辑这一段': 'Edit session',
    '目标': 'Intention', '成果': 'Outcome', '删除记录': 'Delete session', '保存修改': 'Save changes',
    '专注（分）': 'Focus (min)', '休息（分）': 'Break (min)', '长休（分）': 'Long break (min)',
    '几段后长休': 'Sessions before long break', '结束提示音': 'Completion sound',
    '柔和噪音 · 专注时': 'Soft noise while focusing', '噪音音量': 'Noise volume',
    '怎么使用': 'How it works', '双击时间': 'Double-click time',
    '修改番茄钟的专注分钟数；运行中不可修改。': 'Change focus minutes before the timer starts.',
    '选择任务': 'Choose a task', '这一段可以计入所选的每日任务。': 'This session can count toward the selected daily task.',
    '每日任务': 'Daily tasks', '深度专注': 'Deep focus',
    '每日任务视图': 'Daily tasks view', '新增每日任务或分组': 'Add a daily task or group',
    '再次点击左侧“专”进入完整清单：勾选完成、管理分组，并回看累计天数与专注分钟。': 'Select Focus again in the left spine to open the full list, manage groups, and review check-ins and focus minutes.',
    '运行时点 ⛶ 或按 Z 进入全屏极简，Esc 退出。': 'While running, select ⛶ or press Z for a minimal full-screen view. Press Esc to leave.',
    '学习页记录长期进度，专注页负责执行，日历负责回看。': 'Track long-term progress in Study, do the work in Focus, and look back in Calendar.',
    '今日清单已全部完成': "Today's list is complete.", '回顾今日': 'Review today',
    '正在做': 'Now doing', '自由专注': 'Open focus', '＋ 为这一段写个目标': '+ Add an intention',
    '继续': 'Continue', '跳过休息': 'Skip break', '保存并完成这件每日任务': 'Save & complete daily task',
    '本段将计入': 'This session counts toward',

    '年度足迹': 'Annual Activity', '完成': 'Completed', '静': 'Quiet', '丰': 'Full',
    '画布星图': 'Canvas Constellation', '本月画布时间': 'Canvas time this month',
    '累计画布时间': 'Total canvas time', '活跃画布': 'Active canvases',
    '连续活跃': 'Active streak', '历史记录': 'Historical record',
    '历史时长无法还原': 'Historical time unavailable', '修改': 'Edited',
    '不足 1 分钟': 'Under 1 min',
    '画布使用时间星图': 'Canvas time constellation',
    '使用过的画布，会在这里连成一片星图。': 'Used canvases gather here as a constellation.',
    '年度足迹与画布活跃': 'Annual activity and canvas usage',
    '画布时间统计': 'Canvas time summary', '新建': 'Created',
    '学习、树状、速记合计': 'Study, Tree, and Quick Notes combined',
    '最长连续': 'Longest streak', '当年画布时间': 'Canvas time this year',
    '悬停回望，点击展开当天画布': 'Hover to look back; select a day to open its canvases.',
    '这一天还没有画布使用记录。': 'No canvas activity was recorded this day.',
    '今天还没有打开画布。': 'No canvas has been opened today.',
    '有历史画布记录，时长无法还原': 'Historical canvas record; time unavailable',
    '未使用画布': 'No canvas use', '未命名画布': 'Untitled canvas',
    '打开画布': 'Open canvas', '这里会慢慢长出你的节奏。': 'Your rhythm will gradually take shape here.',
    '手动重新读取活跃数据（包括画布、学习、树状、速记、完成任务和专注）': 'Manually refresh activity data, including Canvas, Study, Tree, Quick Notes, completed work, and Focus.',
    '足迹浓度从静到丰': 'Activity intensity from quiet to full', '热力图查看': 'Activity view',
    '足迹星图': 'Activity Constellation', '最近完成': 'Recent Completions',
    '活跃统计': 'Activity summary', '专注时间统计': 'Focus summary',
    '安静的一天': 'A quiet day', '归档过的任务，会安静地留在这里。': 'Archived work stays here as a quiet record.',
    '重新读取活跃数据': 'Refresh activity data', '活跃年份翻页': 'Activity years',
    '已完成任务 · 一年活跃': 'Completed work · annual activity',
    '今天': 'Today', '尚未到来': 'Upcoming', '暂无记录': 'No activity',
    '悬停回望，点击展开当天成果': 'Hover to look back; select a day to open its outcomes.',
    '今天仍是一张等待落笔的纸。': 'Today is still a blank page waiting to be written.',
    '今天仍是一张等待续写的纸。': 'Today is still a page waiting to continue.',
    '本月完成': 'Completed this month', '连续推进': 'Current streak',
    '累计归档': 'Archived total', '累计完成': 'Completed total',
    '星图查看模式': 'Constellation view', '正常': 'Normal', '总览': 'Overview',
    '未专注': 'No focus', '今天还没有开始专注。': 'No focus session has started today.',
    '这一天还在前方。': 'This day is still ahead.', '共': 'Total', '段专注': 'focus sessions',
    '今日专注': 'Focus today', '本月专注': 'Focus this month',
    '今年专注': 'Focus this year', '累计专注': 'All-time focus',
    '分钟': 'min', '小时': 'hr', '分': 'min', '天': ' days',

    'AI 助手': 'AI Assistant', '图谱': 'Graph', '背景': 'Background', '模板': 'Templates',
    '对话 · 受控画布计划': 'Chat · controlled canvas plans',
    '六种操作': 'Six actions', '目标范围': 'Target scope',
    '操作': 'Action', '整张画布': 'Entire canvas',
    '发送消息': 'Send message', '生成预览': 'Generate preview',
    '聊天': 'Chat', '生成卡片网络': 'Create Graph', '生成导图': 'Create Mind Map',
    '扩展导图分支': 'Extend Branch', '基于画布补充': 'Supplement', '整理精炼': 'Refine',
    '聊点什么，或先生成一份画布预览': 'Chat, or generate a canvas preview',
    '从一个想法开始': 'Start with an idea',
    '聊天会直接回复；画布操作会先生成预览，确认后才应用。': 'Chat replies directly. Canvas actions show a preview before anything is applied.',
    '首次使用请先在右上角设置 API Key。': 'First time here? Set your API key from the top-right corner.',
    '灵感起点': 'Starting points',
    '牛顿定律': 'Newton’s law',
    'C 指针': 'C pointers',
    '研究计划': 'Research plan',
    '发送': 'Send',
    '（→）只用于聊天；六种操作中的画布动作会先生成可勾选预览，确认后才改动画布。':
      '(→) is for chat only. Canvas actions first create an itemized preview and change the canvas only after confirmation.',
    '第一次用请先点右上角齿轮填入 API Key。':
      'Before first use, add your API key from Settings in the upper-right corner.',
    '试试 · 点一下填进输入框，再选择「生成卡片网络」或「生成导图」':
      'Try one · fill the input, then choose Create Graph or Create Mind Map',
    '这里控制右侧聊天历史是否随下一次请求发给 AI；画布内容仅在生成计划时按目标范围另行发送。':
      'This controls whether panel history is sent with the next request. Canvas content is sent separately only when generating a plan, using the chosen target.',
    'Enter / → 发送聊天': 'Enter / → sends chat',
    '发送聊天（Enter）': 'Send chat (Enter)', '发送聊天': 'Send chat',
    '画布目标范围': 'Canvas target scope', 'AI 操作': 'AI actions',
    '3 步上手': '3-step start', '六个按钮': 'Six actions',
    '选区与预览': 'Scope & preview', '设置与排错': 'Setup & help',
    '对话上下文': 'Chat context', '连续对话': 'Continuous', '单次请求': 'Single request',
    '清空上下文': 'Clear context', '管理 AI 对话上下文': 'Manage AI chat context',
    '模型名字': 'Model', '接口地址': 'API endpoint', '测试连接': 'Test connection',
    '清除我的 Key': 'Clear my key',
    '连接设置': 'Connection settings',
    '本机保存 · 下一条请求生效': 'Saved locally · applies to the next request',
    '调整 AI 助手宽度': 'Resize AI Assistant',
    '拖动调整宽度，双击恢复默认': 'Drag to resize. Double-click to restore the default width.',
    '粘贴 DeepSeek API Key（留空=不修改）': 'Paste a DeepSeek API key (leave blank to keep the current key)',
    'Key 只存在本机 data/ai.json，不写入笔记、不上传别处。模型改动保存后对下一条消息生效。':
      'The key stays in local data/ai.json; it is not written into notes or uploaded elsewhere. Model changes apply to the next request.',
    '输入消息，Enter 发送，Shift+Enter 换行': 'Type a message. Enter to send; Shift+Enter for a new line.',
    '关闭（Esc）': 'Close (Esc)', '关闭 AI 助手': 'Close AI Assistant',
    'AI 助手使用指南': 'AI Assistant guide', 'AI 助手操作速查': 'AI Assistant quick guide',
    'AI 操作速查目录': 'AI action guide', 'AI 操作速查翻页': 'AI action guide pages',
    '上一步': 'Back', '下一步': 'Next', '收起教程': 'Close guide',
    '⚡ 牛顿第二定律 · 复习卡组': '⚡ Newton’s second law · revision set',
    '🧩 C 指针 · 知识网络': '🧩 C pointers · knowledge graph',
    '🔬 科研想法 · 研究计划': '🔬 Research idea · research plan',
    '整理牛顿第二定律：生成定义、公式 F=ma、变量含义、生活例子、典型题、易错点，连成一张知识网络。':
      'Organize Newton’s second law into a knowledge graph with its definition, F=ma, variables, everyday examples, typical problems, and common mistakes.',
    '系统讲解 C 语言指针，做成一张知识网络画布：基本概念、取地址与解引用、指针与数组、指针与函数、多级指针、动态内存、常见错误。':
      'Explain C pointers as a knowledge graph: fundamentals, address-of and dereference, arrays, functions, multi-level pointers, dynamic memory, and common mistakes.',
    '围绕一个研究想法，生成一张研究计划画布：研究问题、假设、现有证据、实验设计、风险、下一步。':
      'Turn a research idea into a plan covering the question, hypothesis, current evidence, experiment design, risks, and next steps.',
    '导出 MD': 'Export MD', '导出 PNG': 'Export PNG', '转为任务': 'Turn into Tasks',
    '确认转为任务': 'Confirm Tasks', '确认归档划线节点': 'Confirm Archive',
    '已保存': 'Saved', '保存中…': 'Saving…', '未保存': 'Unsaved', '顶栏语言': 'Interface language',
    '（这里没有未分组的画布）': 'No ungrouped canvases yet.',
    '（还没有收藏的画布）': 'No favorite canvases yet.',
    '（空 — 拖文件进来，或右键画布选「移动到」）': 'Empty — drag a file here, or right-click a canvas and choose Move to.',
    '搜索范围': 'Search scope', '当前': 'Current', '全部': 'All',
    '搜索画布名称': 'Search canvas names', '清除搜索': 'Clear search',
    '画布名称搜索': 'Canvas name search',
    '在画布列表显示“当前 / 全部”搜索工具': 'Show Current / All search tools in canvas lists',
    '(未命名)': 'Untitled', '文件已不在': 'File missing',
    '收藏': 'Favorite', '取消收藏': 'Remove from Favorites',
    '已收藏': 'Added to Favorites', '已取消收藏': 'Removed from Favorites',
    '先用 ↑↓ 选中一个画布': 'Use ↑↓ to select a canvas first.',
    '已移到回收站': 'Moved to Trash', '重命名': 'Rename',
    '在文件资源管理器打开': 'Show in File Explorer', '从列表移除': 'Remove from list',
    '移动到': 'Move to', '（还没有分组，先在左栏新建一个）': 'No groups yet. Create one in the sidebar first.',
    '重命名分组': 'Rename group', '删除分组': 'Delete group', '分组名称': 'Group name',
    '重命名失败': 'Rename failed', '新建分组失败': 'Could not create group',
    '只能拖入 .canvas 画布文件': 'Only .canvas files can be dropped here.',
    '导入失败': 'Import failed',
    '我的模板': 'My Templates', '模板列表': 'Template list',
    '还没有模板。用左侧「套索」圈出一组节点，点「保存到模板」就能存到这里。': 'No templates yet. Use the Lasso tool to select a group of nodes, then choose Save as Template.',
    '拖动模板卡片到画布即可放置；卡片右上角 × 删除模板。': 'Drag a template card onto the canvas to place it. Use × in the upper-right corner to delete it.',
    '拖动模板卡片到画布即可放置；卡片右上角': 'Drag a template card onto the canvas to place it. Use',
    '删除模板。': 'in the upper-right corner to delete it.',
    '拖到画布放置': 'Drag onto the canvas to place', '未命名模板': 'Untitled template',
    '删除模板': 'Delete template', '删除？': 'Delete?',

    '画布背景': 'Canvas background', '全局背景': 'Global Background',
    '关闭背景设置': 'Close background settings', '恢复默认纸白': 'Restore Paper White',
    '柔和纯色': 'Soft Solids', '暖米': 'Warm Rice', '雾青': 'Mist Green',
    '灰蓝': 'Slate Blue', '砂粉': 'Sand Rose', '月灰': 'Moon Gray',
    '自定义纯色': 'Custom Color', '柔和渐变': 'Soft Gradients',
    '晨雾': 'Morning Mist', '象牙光': 'Ivory Light', '松烟': 'Pine Haze',
    '雨后': 'After Rain', '暮砂': 'Dusk Sand', '月白': 'Moon White',
    '辅助底纹': 'Guide pattern', '辅助底纹（可叠加）': 'Guide Patterns · Overlay',
    '无底纹': 'None', '横线纸': 'Ruled', '点格纸': 'Dot Grid',
    '方格纸': 'Square Grid', '主次方格': 'Major Grid',
    '随画布移动和缩放，可与任意背景同时使用。': 'Moves and scales with the canvas. Works with any background.',
    '沉浸预设（浅色）': 'Immersive Presets · Light',
    '清晨': 'Dawn', '云湖': 'Cloud Lake', '雪岭': 'Snow Ridge',
    '杏光': 'Almond Light', '竹雾': 'Bamboo Mist', '珠雾': 'Pearl Haze',
    '雨玻': 'Rain Glass', '云霞': 'Rose Cloud', '天青': 'Sky Azure',
    '薄荷': 'Mint', '薰衣': 'Lavender', '藕荷': 'Lotus Haze', '宣纸': 'Rice Paper',
    '沉浸预设（深色）': 'Immersive Presets · Dark',
    '北极光': 'Aurora', '极冕': 'Aurora Corona', '雪山极光': 'Snow Aurora',
    '星峦': 'Star Peaks', '皓月': 'Full Moon', '孤月': 'Lone Moon',
    '新月': 'Crescent', '暮湖': 'Dusk Lake', '虹桥': 'Dusk Bridge',
    '暮途': 'Dusk Road', '晚照': 'Evening Glow', '幽林': 'Deep Forest', '夜泊': 'Night Harbor',
    '标题栏': 'Top Bar', '背景展示范围': 'Background Coverage',
    '全屏沉浸': 'Full Immersion', '柔和工具栏': 'Soft Toolbar',
    '背景语义': 'Background Tone',
    '全屏沉浸时影响标题栏文字颜色；本地图片默认浅色。': 'Controls top-bar text color in Full Immersion. Local images default to Light.',
    '标题栏可读性保护': 'Top-Bar Readability', '轻': 'Light',
    'backgroundReadabilityMedium': 'Medium',
    '全屏沉浸时有效，仅在标题栏覆盖极淡保护层。': 'Available in Full Immersion; adds only a subtle protective layer behind the top bar.',
    '本地图片': 'Local Image', '选择图片': 'Choose Image', '尚未选择图片': 'No image selected',
    '拖动调整背景图片构图': 'Drag to reframe the background image', '标题栏区域': 'Top-bar area',
    '拖动调整构图中心': 'Drag to adjust focal point', '图片透明度': 'Image opacity',
    '图片缩放': 'Image scale', '水平位置': 'Horizontal position', '垂直位置': 'Vertical position',
    '恢复默认构图': 'Reset framing', '移除图片并恢复默认': 'Remove image & restore default',
    '设置对所有画布生效；图片只记录本地绝对路径，移动文件后会回退为默认背景。': 'These settings apply to every canvas. Images store only their local absolute path; moving the file restores the default background.',

    '编辑颜色或尺寸会转为手工值；恢复后会继续跟随脑图分支和层级。': 'Editing color or size creates a custom value. Restore it to follow the mind-map branch and level again.',
    '转换会保留标题；索引按连接关系自动生成目录，卡片正文常驻显示，预览悬停展开，代码只做语法着色。': 'Conversion keeps the title. Index builds an outline from links; Card keeps its body visible; Preview expands on hover; Code adds syntax color only.',
    '仅保留标题，正文会在确认后清除。': 'Keeps the title only; the body is cleared after confirmation.',
    '当前内容会完整保存为正文，首行成为可见标题，可撤销。': 'Keeps the full content as the body and uses its first line as the visible title. This can be undone.',
    '只影响当前代码节点的着色；代码不会执行，也不会解析 Markdown 或数学公式。': 'Changes syntax coloring for this code node only. Code is never executed or parsed as Markdown or math.',
    '选中文字可添加高光、字色或字号；回到画布后按 F 阅读。': 'Select text to add highlights, text color, or size. Press F on the canvas to read.',
    '改动作用于当前选中的内容节点或连线；多选会批量应用，创建操作仍可正常使用。': 'Changes apply to the selected content nodes or edges. Multiple selections update together, while creation tools remain available.',
    '只影响简洁画布模式中之后新建的节点与连线。': 'Applies only to nodes and edges created later in Quiet Canvas mode.',
    '路径与箭头': 'Paths & Arrowheads', '恢复简洁默认': 'Restore Quiet Defaults',
    '类型与轮廓': 'Type & Outline', '边框': 'Border',
    '当前节点': 'Current node', '脑图节点': 'Mind-map node',
    '当前连线': 'Current edge', '脑图连线': 'Mind-map edge', '单选': 'Single selection',
    '思维导图样式': 'Mind Map Style', '跟随预设': 'Follow Preset',
    '混合选择': 'Mixed selection', '手工配色与尺寸': 'Custom colors & size',
    '手工配色': 'Custom colors', '手工尺寸': 'Custom size',
    '恢复预设配色': 'Restore Preset Colors', '恢复自动尺寸': 'Restore Auto Size',
    '阅读（F）': 'Read (F)',
    '转换为索引节点': 'Convert to Index Node', '转换为预览节点': 'Convert to Preview Node',
    '转换为卡片节点': 'Convert to Card Node', '转换为代码节点': 'Convert to Code Node',
    '转换为普通节点': 'Convert to Standard Node', '整体缩放': 'Overall Scale',
    '文字与轮廓': 'Text & Outline', '正文': 'Body', '默认': 'Default',
    '只在阅读窗口显示': 'Shown in reader only',
    '整块只按代码渲染': 'Rendered entirely as code', '整块即正文，常驻显示': 'Body always shown in the node',
    '常驻显示在卡片上': 'Always shown on the card', '悬停节点时展开': 'Expands on hover',
    '自动读取相连节点生成目录': 'Builds an outline from connected nodes',
    '保留空格、换行和缩进；不会解析 Markdown、链接或数学公式。': 'Preserves spaces, line breaks, and indentation. Markdown, links, and math are not parsed.',
    '选中文字可添加高光、字色或字号；正文会直接显示在便签上，支持 Markdown / 公式 / 代码块。': 'Select text to add highlights, color, or size. The body stays visible on the sticky note and supports Markdown, math, and code blocks.',
    '选中文字可添加高光、字色或字号；正文会直接显示在卡片上。': 'Select text to add highlights, color, or size. The body stays visible on the card.',
    '选中文字可添加高光、字色或字号；回到画布后悬停预览。': 'Select text to add highlights, color, or size. Hover over the node on the canvas to preview it.',
    '选中文字可添加高光、字色或字号；回到画布后按 F 阅读索引正文。': 'Select text to add highlights, color, or size. Press F on the canvas to read the index body.',
    '把长文本粘贴到这里。支持 Markdown、数学公式与选区标注。': 'Paste long-form text here. Supports Markdown, math, and selection annotations.',
    '直接输入代码。Tab 缩进，Shift+Tab 减少缩进。': 'Enter code directly. Tab indents; Shift+Tab outdents.',
    '恢复所选节点外观': 'Restore Selected Node Appearance',
    '代码节点': 'Code node', '便签节点': 'Sticky node', '代码语言': 'Code language',
    '批量编辑': 'Batch edit', '混合节点批量编辑': 'Mixed-node batch edit',
    '脑图连线批量编辑': 'Mind-map edge batch edit', '混合连线批量编辑': 'Mixed-edge batch edit',
    '混合': 'Mixed', '建立分组': 'Create Group', '编辑选中对象': 'Edit selected objects',
    '代码节点语言': 'Code node language', '默认色': 'Default color',
    '清除所有拐点': 'Clear all bend points', '恢复所选连线样式': 'Restore Selected Edge Style',

    '当前画布图谱': 'Current canvas graph', '关系视图': 'Relationship View',
    '调节悬浮窗透明度': 'Adjust window opacity', '重新舒展图谱布局': 'Relax graph layout',
    '恢复图谱视野': 'Reset graph view', '复位': 'Reset', '关闭图谱': 'Close graph',
    '当前节点之间还没有连线': 'The current nodes are not connected yet.',
    '当前画布还没有内容节点': 'This canvas has no content nodes yet.',
    '连线': 'Edges', '索引节点': 'Index node', '预览节点': 'Preview node',
    '卡片节点': 'Card node', 'PDF 附件': 'PDF attachment',
    'Markdown 附件': 'Markdown attachment', '普通节点': 'Node', '未命名节点': 'Untitled node',
    '当前画布': 'Current canvas',
    '橡皮 · 局部擦': 'Eraser · Area', '橡皮 · 整笔擦': 'Eraser · Stroke',
    '已恢复预设配色': 'Preset colors restored',
    '已恢复自动文字尺寸': 'Automatic text sizing restored',
    '已恢复所选节点外观': 'Selected node appearance restored',
    '已恢复所选连线样式': 'Selected edge style restored',
    '已粘贴为卡片': 'Pasted as a card',
    '已粘贴为卡片（按 F 可阅读全文）': 'Pasted as a card · press F to read the full text',
    '已退出配色刷': 'Color brush closed',
    '已吸取节点配色，点击另一个节点应用': 'Node colors picked. Select another node to apply them.',
    '请选择另一个节点': 'Select another node', '已复制节点配色': 'Node colors copied',
    '已匹配父分支配色': 'Matched parent-branch colors',
    '已统一所选节点配色': 'Selected node colors unified',
    '已转为导图子节点': 'Converted to a Mind Map child node',
    '已解除文本框跟随': 'Text box no longer follows a node',
    '文本框已改为跟随所选节点': 'Text box now follows the selected node',
    '文本框将跟随所选节点': 'Text box will follow the selected node',
    '这次移动会产生无效结构': 'This move would create an invalid structure',
    '这组节点含有交叉连接，暂不能自动排序': 'These nodes contain cross-links and cannot be arranged automatically yet.',
    '放射布局暂不支持拖动排序': 'Radial layout does not support drag sorting yet.',
    '没有落入可排序的位置': 'No valid sorting position',
    '套索里没有可保存到模板的内容': 'The lasso contains nothing that can be saved as a template.',
    '保存模板失败了，请重试': 'Could not save the template. Please try again.',
    '分组已折叠': 'Group collapsed', '分组已展开': 'Group expanded',
    '橡皮擦': 'Eraser', '画笔': 'Pen', '文字': 'Text', '选择': 'Select', '文本框': 'Text box',
    '新建 · 卡片': 'New · Card', '新建 · 便签': 'New · Sticky', '新建 · 索引': 'New · Index',
    '新建 · 预览': 'New · Preview', '新建 · 代码': 'New · Code',
    '逆时针箭头': 'Counterclockwise Arrow', '顺时针箭头': 'Clockwise Arrow',
    '直线箭头': 'Straight Arrow', '直线 / 箭头': 'Line / Arrow', '纯直线': 'Straight Line', '工具': 'Tool',
    '同一层级至少需要两个节点': 'At least two nodes are required on the same level.',
    '已统一同级节点宽度': 'Node widths unified on this level',
    '已整理重叠节点': 'Overlapping nodes arranged', '当前没有重叠节点': 'No overlapping nodes',
    '画布名称没有改动': 'Canvas name unchanged', '知道了': 'Got it',
    '永久清空任务回收站': 'Permanently empty Task Trash',
    '当前显示器可用区域不足': 'Not enough usable space on this display',
    '调整窗口大小失败，请重试。': 'Could not resize the window. Please try again.',
    '配色': 'Color', '排版': 'Layout', '方向': 'Direction', '跟随分支': 'Follow branch',
    '向右': 'Right', '向左': 'Left', '向下': 'Down', '放射': 'Radial', '密度': 'Density',
    '舒展': 'Relaxed', '节点尺寸': 'Node size', '自动适配文字': 'Fit to text',
    '中心节点': 'Center node', '一级分支': 'First-level branches', '二级及以后': 'Level 2 and deeper', '恢复自动': 'Auto size',
    '同级等宽': 'Equal width', '整理重叠': 'Fix overlaps', '未选择': 'Nothing selected',
    '先选中一个节点': 'Select a node first', '配色刷': 'Color brush', '匹配父分支': 'Match parent branch',
    '思维导图模式': 'Mind Map Mode',
    '将整理与此节点相连的整张结构': 'The whole structure connected to this node will be arranged.',
    '经典枝桠': 'Classic Branches', '学术曲线': 'Academic Curves',
    '中心聚焦': 'Focused Center', '圆角树枝': 'Rounded Branches',
    '柔彩自然': 'Soft Organic', '黑白直线': 'Monochrome Lines',
    '层级标题': 'Tiered Titles', '蓝图 S 线': 'Blueprint S',
    '高对比折线': 'High-Contrast Elbow', '杂志弧线': 'Editorial Arcs',
    '应用并整理': 'Apply & arrange',
    '经典枝桠：通用圆润分支，适合大多数脑图': 'Classic Branches: rounded, versatile branches for most mind maps.',
    '中心聚焦：深色中心、浅色一级与透明叶节点': 'Focused Center: a dark center, soft first-level cards, and transparent leaves.',
    '圆角树枝：柔和卡片与连续圆角转折': 'Rounded Branches: soft cards with continuous rounded turns.',
    '学术曲线：低饱和配色与规整贝塞尔曲线': 'Academic Curves: muted colors with orderly Bézier curves.',
    '柔彩自然：轻柔配色与不对称自然曲线': 'Soft Organic: gentle colors with asymmetric natural curves.',
    '黑白直线：克制单色与利落直线': 'Monochrome Lines: restrained tones with crisp straight lines.',
    '层级标题：醒目的分支标题与紧凑叶节点': 'Tiered Titles: prominent branch headings with compact leaves.',
    '蓝图 S 线：冷色主调与流动 S 曲线': 'Blueprint S: cool tones with flowing S curves.',
    '高对比折线：明亮配色与清晰阶梯结构': 'High-Contrast Elbow: bright colors with a clear stepped structure.',
    '杂志弧线：克制配色与醒目的拱形连接': 'Editorial Arcs: restrained colors with bold arched connections.',
    '配色刷只复制节点颜色；右键或 Esc 退出。': 'The color brush copies node colors only. Right-click or press Esc to exit.',
    '短标题保持紧凑，长标题自动换行；左右边缘调宽，角点调宽与留白，双击恢复自动。': 'Short titles stay compact; long titles wrap. Drag side handles to resize width, corner handles for width and padding, and double-click to restore automatic sizing.',
    '随预设': 'Use preset', '层距': 'Level spacing', '分支距': 'Branch spacing',
    '放射半径': 'Radial spacing', '应用预设并整理': 'Apply preset & arrange',
    '仅对齐层级': 'Align levels only', '只套用样式': 'Style only',
    'Tab 建子节点，Enter 建同级节点；新节点会继承当前脑图样式。': 'Tab creates a child; Enter creates a sibling. New nodes inherit the current mind-map style.',
    '单选会整理与该节点相连的整张结构；多选只整理所选节点。“仅对齐层级”不会改变上下顺序。': 'With one node selected, the whole connected map is arranged. With multiple nodes, only the selection is arranged. Align levels only preserves vertical order.',
    '清除手工宽度，恢复文字自动适配': 'Clear manual width and fit to text',
    '让同一层级节点使用相同宽度': 'Give nodes on the same level equal width',
    '只整理发生重叠的分支': 'Arrange overlapping branches only',
    '吸取所选节点的填充、边框与透明度': 'Pick fill, border, and opacity from the selected node',
    '恢复为当前父分支的自动配色': 'Restore automatic color from the current parent branch',
    '画布工具': 'Canvas tools', '选择 / 移动': 'Select / Move',
    '点击重命名': 'Click to rename',
    '套索：圈出一组节点，存成模板': 'Lasso a group of nodes and save it as a template',
    '画笔 · 自由书写；再次点击设置，长按恢复默认': 'Pen · draw freely; click again for settings, hold to reset',
    '笔': 'Pen', '笔型': 'Pen type', '钢笔': 'Pen', '马克笔': 'Marker', '荧光笔': 'Highlighter',
    '粗细': 'Thickness', '不透明度': 'Opacity', '稳定器': 'Stabilizer', '顺滑度': 'Smoothing',
    '压感': 'Pressure', '压感曲线': 'Pressure curve', '软': 'Soft', '正常': 'Normal', '硬': 'Hard',
    '笔锋渐细': 'Taper strokes', '书法笔锋': 'Calligraphic nib', '笔尖角度': 'Nib angle',
    '示例文字': 'Sample text',

    // 编辑器右下角“？”· 快捷键速查
    '快捷键速查': 'Keyboard Shortcuts',
    '重新学习画布编辑器': 'Replay the Canvas Tutorial',
    '10 个动画演示 · 随时重新上手': '10 animated demos · Replay anytime',
    '最先记住这 5 个': 'Start with these 5',
    '从空白画布到第一组结构，先记住这些。': 'These take you from a blank canvas to your first connected structure.',
    '双击空白': 'Double-click empty space', '写想法': 'Write an idea', '拖': 'Drag',
    '节点间连线': 'Connect nodes', '子节点': 'Child node', '同级节点': 'Sibling node',
    '空格': 'Space', '平移': 'Pan', '/ 无选中时': '/ with nothing selected',
    '在画布 / 导图中新建内容节点': 'Create a content node in Canvas / Mind Map',
    '双击节点': 'Double-click a node', '编辑文字': 'Edit text',
    '选中内容节点后': 'With a content node selected', '直接打字': 'Start typing',
    '替换标题并进入编辑': 'Replace the title and start editing',
    '在下方建兄弟节点': 'Create a sibling below', '在上方插入兄弟节点': 'Insert a sibling above',
    '沿当前分支方向建子节点 + 连线': 'Create and connect a child along the current branch',
    '导图节点提升一级': 'Promote a Mind Map node one level', '复制选中节点': 'Duplicate selected nodes',
    '删除选中的节点 / 连线 / 图案': 'Delete selected nodes / lines / shapes',
    '右键节点': 'Right-click a node', '快速换色 / 复制 / 删除': 'Quickly recolor / duplicate / delete',
    '正文节点 · 阅读 · 批注': 'Content Nodes · Reading · Annotation',
    '画布·简洁 / 完整': 'Canvas · Minimal / Full',
    '统一切换接下来新建卡片 / 便签 / 索引 / 预览 / 代码': 'Choose Card / Sticky / Index / Preview / Code for new nodes in either mode',
    '索引/预览/卡片/便签 +': 'Index / Preview / Card / Sticky +',
    '放大阅读并编辑正文': 'Open the reader and edit the body', '代码节点 +': 'Code node +',
    '放大读写代码（只着色，不批注）': 'Open the code reader/editor (syntax color only; no annotation)',
    'PDF / Markdown 附件 +': 'PDF / Markdown attachment +', '打开放大阅读与附件批注': 'Open the attachment reader and annotation tools',
    '正文 / Markdown 阅读层': 'Body / Markdown reader', '钢笔 / 盒子 / 橡皮': 'Pen / Box / Eraser',
    'PDF 阅读层': 'PDF reader', '高亮 / 下划线 / 钢笔 / 荧光笔 / 盒子 / 便签 / 橡皮': 'Highlight / Underline / Pen / Highlighter / Box / Note / Eraser',
    '代码节点内': 'Inside a code node', '增加 / 减少缩进': 'Increase / decrease indentation',
    '正文编辑内': 'While editing body text', '插入 Markdown 代码块': 'Insert a Markdown code block',
    '独立表格': 'Standalone Table', '右键表格单元格': 'Right-click a table cell',
    '打开“删除所选行 / 删除所选列”菜单': 'Open the “Delete selected rows / Delete selected columns” menu',
    '表格内': 'Inside a table', '用键盘打开同一删除菜单': 'Open the same delete menu from the keyboard',
    '只清空所选内容，不删除行列': 'Clear selected content without deleting rows or columns',
    '方向键': 'Arrow key', '扩展单元格选择范围': 'Extend the cell selection',
    '选中表格后拖动内部竖线': 'Drag an inner vertical divider on a selected table',
    '调整这一列宽度；双击按内容自动适宽': 'Resize that column; double-click to fit its content',
    '选中表格后拖动内部横线': 'Drag an inner horizontal divider on a selected table',
    '调整这一行高度；双击恢复默认行高': 'Resize that row; double-click to restore its default height',
    '选中表格 +': 'Selected table +', '打开表格工作室，集中编辑与设置外观': 'Open Table Studio to edit the grid and appearance',
    '思维导图': 'Mind Map', '单选节点 +': 'One selected node +', '整理整条相连结构': 'Arrange the entire connected structure',
    '多选节点 +': 'Multiple selected nodes +', '只整理所选节点': 'Arrange selected nodes only',
    '拉齐层级，保留同层顺序': 'Align levels while preserving order within each level',
    '左侧继续向左，右侧继续向右': 'Continue outward: left branches left, right branches right',
    '拖动同级节点': 'Drag a sibling node', '调整顺序并自动整理所在分支': 'Reorder it and automatically arrange its branch',
    '拖到另一个节点上': 'Drop onto another node', '整棵分支改为它的子节点': 'Reparent the entire branch under that node',
    '复制节点配色，不改变尺寸与连线': 'Copy node colors without changing size or lines',
    '恢复所选节点的自动分支配色': 'Restore automatic branch colors for selected nodes',
    '预设右上角': 'Preset upper-right corner', '立即套用该预设并整理结构': 'Apply the preset and arrange immediately',
    '三档节点尺寸滑条': 'Three-level node size sliders', '分别调整中心、一级分支与二级及以后节点尺寸': 'Resize the center, first-level branches, and level-2-or-deeper nodes separately',
    '拖动节点左右边缘': 'Drag a node\'s side edge', '手工设置宽度；双击边缘恢复自动': 'Set a custom width; double-click the edge to restore automatic sizing',
    '拖动节点角点': 'Drag a node corner', '自由调整宽度与最小高度，文字不会被裁切': 'Adjust width and minimum height without clipping text',
    '只重新排布发生碰撞的分支': 'Rearrange only colliding branches', '一级分支越过中心': 'Drag a first-level branch across the center',
    '整条分支切换到另一侧': 'Move the entire branch to the other side', '拖动中心节点': 'Drag the center node',
    '移动整张思维导图': 'Move the entire Mind Map',
    '按住': 'Hold', '，从一个节点拖到另一个': 'and drag from one node to another', '创建节点间连线': 'Create a connection between nodes',
    '双击连线': 'Double-click a line', '给连线写文字': 'Label the line', '+点击': '+ click',
    'shortcutsSelectionHeading': 'Selection', 'shortcutsDragAction': 'drag',
    '加选 / 减选': 'Add to / remove from selection', '空白处': 'On empty canvas,', '框选': 'Marquee select',
    '全选所有节点': 'Select all nodes', '图片 · 分组 · 图案': 'Images · Groups · Shapes',
    '拖入图片文件': 'Drop an image file', '导入到鼠标落点（任意模式可拖动 / 删除）': 'Import at the pointer (move / delete in any mode)',
    '框选一组节点 →': 'Marquee-select a group of nodes →', '原地建立语义分组，不打乱节点位置': 'Create a semantic group without moving its nodes',
    '框选空白区域 →': 'Marquee-select an empty area →', '按选框大小生成带标题的分区盒子': 'Create a titled box matching the selection',
    '画布空白处': 'On empty canvas', '右键拖动': 'Right-drag', '在任意模式按拖拽范围创建纯色色块': 'Create a solid color block from the dragged area in any mode',
    '右键单击': 'Right-click', '退出绘制并切回「选择」工具': 'Exit drawing and return to the Select tool',
    '界面 / 工具': 'Interface / Tools', '鼠标移到': 'Move the pointer to', '画布左缘': 'the left edge of the canvas',
    '浮现左侧手写工具栏（笔 / 橡皮 / 文字 / 箭头 / 手绘图形）': 'Reveal the drawing toolbar (pen / eraser / text / arrows / sketch shapes)',
    '选择；': 'Select;', '文本框；': 'Text box;', '画笔，再按一次切到橡皮（反复按': 'Pen; press again for Eraser (keep pressing',
    '在画笔 ↔ 橡皮间切换）': 'to toggle Pen ↔ Eraser)', '再点': 'Click the', '图标': 'icon again',
    '弹出画笔配置（笔型 / 粗细 / 压感 / 书法笔锋…逐项见下表）': 'Open pen settings (type / thickness / pressure / calligraphic nib… see below)',
    '橡皮': 'Eraser', '在「整笔擦 / 局部擦」间切换；局部擦只擦圆圈内一段，其余保留': 'Toggle Stroke / Partial erasing; Partial removes only the segment inside the circle',
    '画笔 / 箭头': 'Pen / Arrow', '恢复该工具默认设置；按钮轻弹表示已生效': 'Restore the tool defaults; a quick bounce confirms the reset',
    '左侧手绘图形': 'Left-side sketch shape', '点按': 'Click', '放小图标；拖动则按框定尺寸': 'Place a small shape; drag to set its size',
    '重复点击当前': 'Click the current', '画布 / 导图 / 图案': 'Canvas / Mind Map / Shapes',
    '切换该模式自己的「简洁 / 完整」状态': 'Toggle that mode between Minimal / Full',
    '工具 → 尺子': 'Tools → Ruler',
    '临时放置一把可移动、旋转的尺子；它不属于第四种工作模式': 'Place a movable, rotatable ruler temporarily; it is not a fourth workspace mode',
    '工具 → 导入画布': 'Tools → Import Canvas',
    '从 Relatum 画布库选择来源，把内容与原始素材复制到当前可见区域中心': 'Choose a source from the Relatum canvas library and copy its content and original assets into the center of the current view',
    '工具 → 节点矩阵': 'Tools → Node Matrix',
    '按行列批量生成独立节点；支持编号、二维粘贴、间距与统一宽度': 'Generate independent nodes in rows and columns, with numbering, grid paste, spacing, and uniform width',
    '工具 → 倒计时 / 正计时': 'Tools → Countdown / Stopwatch',
    '创建独立计时器；框选多个后可切换状态、全部复位或删除': 'Create independent timers; select several to toggle states, reset all, or delete all',
    '拖动简单节点碰到尺边': 'Drag a simple node into a ruler edge',
    '节点会停止穿越并可沿边滑动；拖动途中按': 'The node stops crossing and can slide along the edge; during the drag, press',
    '可在本次手势中穿过': 'to bypass it for this gesture',
    '画笔起笔或书写中靠近尺子长边': 'Start or continue a pen stroke near a long ruler edge',
    '接触后沿最近尺边绘制到抬笔；拖中央角度环旋转，按': 'After contact, draw along the nearest edge until lift-off; drag the center angle ring to rotate, and hold',
    '以 15° 吸附': 'to snap by 15°',
    '右键尺身': 'Right-click the ruler',
    '选择常用预设，或输入任意整数角度': 'Choose a common preset or enter any integer angle',
    '导图 / 图案或画布·简洁中，无选中时': 'With nothing selected in Mind Map / Shapes or Canvas · Minimal',
    '临时收起 / 展开当前右侧面板': 'Temporarily collapse / expand the current right panel',
    '完整状态下选中对象': 'Select an object in Full mode', '自动打开对应属性检查器（可在设置中分别关闭）': 'Open its inspector automatically (each can be disabled in Settings)',
    '右下': 'Bottom right', '语言、速度与延迟、三个检查器、深色优化、压感和自动保存等': 'Language, speeds and delays, three inspectors, dark-mode optimization, pressure, autosave, and more',
    '打开本速查；顶部绿色按钮可重学完整新手引导': 'Open this reference; use the green button above to replay the full tutorial',
    '画笔配置（再点': 'Pen Settings (click the', '图标弹出）': 'icon again)',
    '钢笔（实色）/ 马克笔（更粗）/ 荧光笔（半透明，盖在字上仍可读）': 'Pen (solid) / Marker (thicker) / Highlighter (translucent; text remains readable)',
    '线条的宽度与透明度': 'Stroke width and opacity', '越高越抗抖，但笔迹更慢跟手；写字建议低到中': 'Higher values reduce shake but add lag; use low to medium for handwriting',
    '越高越把折点修成圆滑曲线；写小字别开太高': 'Higher values smooth corners into curves; keep it lower for small writing',
    '手写笔按下笔力度自动变粗细（鼠标无效）；总开关在右下': 'Pen pressure changes stroke width (not available with a mouse); the master switch is at bottom right',
    '软＝轻轻一碰就变粗 · 正常 · 硬＝要用力才变粗': 'Soft = thickens with a light touch · Normal · Hard = needs more pressure',
    '笔画两端自动收尖；没压感的笔也有手写味': 'Automatically taper both ends, even without pressure input',
    '横细竖粗的书法 / 钢笔体；配下面的「笔尖角度」一起用': 'Calligraphic strokes with thin horizontals and thick verticals; use with Nib angle',
    '书法笔尖的朝向（45° 最常用）；支持倾斜的手写笔躺下去会更粗': 'Calligraphic nib direction (45° is common); supported styluses draw thicker when tilted',
    '画布导航': 'Canvas Navigation', '滚轮': 'Mouse wheel', '以鼠标为中心缩放': 'Zoom around the pointer', '+拖动': '+ drag',
    '平移画布': 'Pan the canvas', '短按': 'Tap', '定位最近新建的节点': 'Go to the most recently created node',
    '持续平移画布（单选内容节点时字母优先进入编辑）': 'Continuously pan (with one content node selected, letter keys start editing instead)',
    '重置到 100%': 'Reset to 100%', '缩放到容纳全部': 'Zoom to fit all', '搜索节点（Enter 跳下一个）': 'Search nodes (Enter finds next)',
    '文件 / 历史': 'File / History', '立即保存（默认开自动保存，改完约 1.5 秒自动写盘）': 'Save now (autosave is on by default and writes about 1.5 seconds after changes)',
    '顶栏': 'Top bar', '把整张画布导出为 PNG 图片': 'Export the full canvas as a PNG image',
    '清理附件': 'Clean Assets', '删除 .assets 里未被引用的图片 / 附件': 'Delete unreferenced images / attachments from .assets',
    '编辑节点时': 'While Editing a Node', '提交': 'Commit', '换行': 'New line', '取消修改': 'Cancel changes',
    '文字格式（Markdown / 公式）': 'Text Formatting (Markdown / Math)', '## 标题': '## Heading', '二级标题（### 三级）': 'Level 2 heading (### is level 3)',
    '**加粗**': '**bold**', '加粗': 'Bold', '*斜体*': '*italic*', '斜体': 'Italic', '- 列表项': '- List item',
    '无序列表（1. 有序）': 'Bulleted list (1. for numbered)', '`代码`': '`code`', '行内代码': 'Inline code',
    '行内公式（$$…$$ 块级）': 'Inline math ($$…$$ for display math)', '==高光==': '==highlight==', '选中文字后可在工具栏换色': 'Select text, then choose a color in the toolbar',
    '{tc:red|文字}': '{tc:red|Text}', '文字颜色（工具栏彩色 A）': 'Text color (colored A in the toolbar)',
    '{fs:lg|文字}': '{fs:lg|Text}', '文字字号（小 / 默认 / 大 / 特大）': 'Text size (small / default / large / extra large)',
    '右下角': 'Bottom right', '公式 / 符号面板，向正在编辑处插入 LaTeX 片段': 'Math / symbol panel; insert a LaTeX snippet at the editing point',
    '选中文字框': 'Select a text box', '放大 / 缩小 / 还原文字框字号': 'Increase / decrease / reset the text-box font size',
    '同一正文内点击公式引用，跳转并闪烁目标': 'Click an equation reference in the same body to jump to and flash its target',
    '看不到更新 / 页面不对劲？': 'Updates missing or page behaving strangely?',
    '强制刷新清缓存——改了东西没生效时先按这个': 'Hard-refresh and clear cache—try this first when changes do not appear',
    '强刷还不行 → 开无痕窗口访问同一地址，绕开一切缓存': 'If that fails, open the same address in a private window to bypass all caches',
    '“文件已不在”': '“File no longer exists”', '起步页带此标签的是已删除/移动的文件，点它可从列表移除': 'This Home label marks a deleted or moved file; click it to remove the entry',
    'shortcutsPress': 'Press', 'shortcutsOr': 'or', 'shortcutsCloseSuffix': 'to close',
    '最先记住的五个操作': 'Five essential actions',
    '逆时针箭头': 'Counterclockwise Arrow', '顺时针箭头': 'Clockwise Arrow',
    '弯曲幅度': 'Curve amount', '直线箭头': 'Straight Arrow', '转折': 'Bend',
    '直线转折': 'Straight bend', '曲线转折': 'Curved bend',
    '橡皮擦除': 'Eraser', '添加文字': 'Add text', '连接锚点': 'Connection anchor',
    '重点便签 · 拖到画布创建，点击设置': 'Emphasis Note · drag to canvas to create, click for settings',
    '拖到画布创建固定大小便签': 'Drag onto the canvas to create a fixed-size note',
    '恢复暖金纸默认': 'Restore Warm Gold Paper',
    '连接锚点：双击空白放置，拖动空白框选，拖动锚点移动，按住 Alt 拖出连线': 'Connection anchor: double-click empty canvas to place, drag empty canvas to select, drag an anchor to move, hold Alt and drag to connect',
    '左侧工具栏': 'Left toolbar',
    '双击空白放置；拖动空白框选；选中后按住': 'Double-click empty canvas to place; drag empty canvas to select; when selected, hold',
    '拖动连线，按': 'and drag to connect; press', '即可删除': 'to remove it',
    '添加逆时针箭头；再次点击设置，长按恢复默认': 'Add counterclockwise arrow; click again for settings',
    '添加顺时针箭头；再次点击设置，长按恢复默认': 'Add clockwise arrow; click again for settings',
    '绘制纯直线或直线箭头（选中后可加转折点）；再次点击设置，长按恢复默认': 'Draw a straight line or straight arrow; select it to add bends; click again for settings, hold to reset',
    '手绘圆角矩形': 'Sketch rounded rectangle', '手绘菱形': 'Sketch diamond', '手绘椭圆': 'Sketch ellipse',
    '撤销': 'Undo', '重做': 'Redo', '未命名': 'Untitled',
    '小地图：点击跳转 / 拖动取景框平移': 'Minimap · click to jump / drag to pan',
    '双击空白处，写下第一个想法': 'Double-click anywhere to begin with an idea',
    '新建默认样式': 'New default styles', '熄灭面板': 'Dim panel', '类型': 'Type',
    '索引': 'Index', '预览': 'Preview', '卡片': 'Card', '便签': 'Sticky', '代码': 'Code',
    '形状': 'Shape', '矩形': 'Rectangle', '正方': 'Square', '圆形': 'Circle',
    '图案': 'Shape', '图案与图片': 'Shapes and images', '图案模式': 'Shapes Mode',
    '圆角矩形': 'Rounded Rectangle', '椭圆': 'Ellipse', '正三角形': 'Triangle',
    '菱形': 'Diamond', '滑条': 'Slider', '盒子': 'Box', '纯色色块': 'Color Block',
    '箭头图案': 'Arrow',
    '虚线框': 'Dashed Box', '分隔线': 'Divider',
    '胶囊标签': 'Pill Label', '角标框': 'Corner Frame', '括号标记': 'Bracket',
    '问号': 'Question', '重点便签': 'Emphasis Note', '旁注框': 'Side Note',
    '文字框': 'Text Box', '图片': 'Image', '颜色': 'Color', '预设': 'Preset',
    '选择颜色': 'Choose a color', '图例色': 'Legend color', '颜色图例': 'Color legend',
    '插入图案': 'Insert Shapes', '插入本地图片': 'Insert Local Image',
    '插入 PDF / Markdown 附件': 'Insert PDF / Markdown',
    '盒子 / 分组预设': 'Box / Group Presets', '全局默认': 'Global Default',
    '样式预设': 'Style Presets',
    '盒子与分组预设': 'Box and group presets',
    '也可以直接把本地图片 / PDF / Markdown 文件拖进画布；图片存到 <画布名>.assets/images/，附件存到 .assets/attachments/（同一文档按内容去重只存一份）。附件可任意模式拖动（拖标题栏）、正文区滚动，图案模式可调大小。': 'You can also drop local images, PDFs, or Markdown files onto the canvas. Images are stored in <canvas>.assets/images/ and attachments in .assets/attachments/ with duplicate content stored only once. Attachments can be moved by dragging their title bar, scrolled in the body, and resized in Shapes mode.',
    '点击预设会应用到当前盒子或分组，并成为所有画布之后拖拽新建时的默认样式；拖拽尺寸不会被改动。': 'Selecting a preset applies it to the current box or group and makes it the default for newly dragged groups across all canvases. Existing dimensions are preserved.',
    '选中一个图案或图片后，可调整外观、尺寸与图层。': 'Select a shape or image to adjust its appearance, size, and layer.',
    '宽度': 'Width', '高度': 'Height', '字号': 'Font size', '旋转角度': 'Rotation',
    '双线': 'Double', '边框粗细': 'Border weight', '填充颜色': 'Fill color',
    '文字颜色': 'Text color', '预设颜色': 'Preset colors', '填充': 'Fill',
    '淡': 'Tint', '实': 'Solid', '重置默认填充颜色': 'Reset default fill color',
    '标题文字语义': 'Title contrast', '浅色': 'Light', '深色': 'Dark',
    '浅色字适合较深的标题底色；深色字适合柠檬黄等明亮标题底色。': 'Light text suits dark title fills; dark text suits bright fills such as lemon yellow.',
    '滑条进度': 'Slider progress', '透明度': 'Opacity', '显示图层': 'Layer',
    '底层': 'Behind', '顶层': 'Front',
    '底层被文字节点覆盖；顶层覆盖文字。只有图案模式可选中装饰对象。': 'Behind sits under text nodes; Front sits above them. Decorative objects can only be selected in Shapes mode.',
    '叠放顺序': 'Stacking order', '移到底部': 'Send to bottom', '下移一层': 'Move backward',
    '上移一层': 'Move forward', '移到顶部': 'Bring to top',
    '只调整所选图案在当前显示图层内的先后顺序。': 'Only changes the selected decorations\' order within their current layer.',
    '选中一个或多个图案后，可调整叠放顺序。': 'Select one or more decorations to change their stacking order.',
    '重置为默认设置': 'Reset to defaults', '重置新建预设': 'Reset creation preset',
    '应用新建预设': 'Apply creation preset', '应用预设颜色': 'Apply preset colors',
    '删除此装饰对象': 'Delete decoration',
    '新建预设': 'Creation preset', '应用到选中': 'Apply to selection',
    '没有选中盒子或分组时，点击只修改之后新建的默认样式。': 'With no box or group selected, clicking only changes the style for future creations.',
    '点击只应用到当前选中的盒子或分组，不修改新建预设。': 'Clicking only applies to the selected boxes or groups and does not change the creation preset.',
    '图案、文字装饰与图片不会成为正文节点，也不会进入 Markdown 导出内容。': 'Shapes, decorative text, and images remain outside document nodes and Markdown exports.',
    '读取图片失败': 'Could not read the image', '读取文件失败': 'Could not read the file',
    '插入图片失败': 'Could not insert the image', '插入附件失败': 'Could not insert the attachment',
    '双击 PDF，或按 <kbd>F</kbd>，进入阅读与批注': 'Double-click the PDF or press <kbd>F</kbd> to read and annotate.',
    '暖金': 'Warm Gold', '雾蓝': 'Mist Blue', '草木绿': 'Sage Green',
    '藕粉': 'Dusty Rose', '墨白': 'Ink White', '湖水青': 'Lake Teal',
    '杏橙': 'Apricot', '柠檬黄': 'Lemon', '天空蓝': 'Sky Blue',
    '薄荷绿': 'Mint', '珊瑚红': 'Coral', '淡紫': 'Lavender',
    '咖啡棕': 'Coffee', '透明灰': 'Clear Gray',
    '写下重点': 'Write a key point', '写下旁注': 'Write a side note',
    '文本框与便签': 'Text boxes and notes', '新建对象': 'Create object',
    '新建便签': 'Create note', '新建文本框': 'Create text box', '对象颜色': 'Object color', '对象字号': 'Object font size',
    '展开工具栏': 'Expand toolbar', '收起工具栏': 'Collapse toolbar', '清除空白对象': 'Remove blank objects',
    '便签 · 拖到树状页创建，或点击后在树状页放置': 'Note · Drag onto the Tree page, or click then place',
    '文本框 · 拖到树状页创建，或点击后在树状页放置': 'Text box · Drag onto the Tree page, or click then place',
    '柔和黄': 'Soft yellow', '柔和橙': 'Soft orange', '柔和红': 'Soft red', '柔和紫': 'Soft purple',
    '柔和蓝': 'Soft blue', '柔和青': 'Soft cyan', '柔和绿': 'Soft green', '柔和灰': 'Soft gray', '暖白': 'Warm white', '黑色': 'Black',
    '小字号': 'Small text', '默认字号': 'Default text', '大字号': 'Large text', '特大字号': 'Extra-large text',
    '暖金纸': 'Warm Gold Paper', '象牙纸': 'Ivory Paper', '陶粉纸': 'Peach Paper',
    '藕荷纸': 'Dusty Rose Paper', '灰紫纸': 'Muted Violet Paper', '雾蓝纸': 'Mist Blue Paper',
    '鼠尾草': 'Sage', '原色纸': 'Natural Paper', '墨线留白': 'Ink Outline',
    '雾蓝细框': 'Mist Blue Outline', '灰绿虚线': 'Sage Dash', '藕粉点线': 'Rose Dots',
    '赭金粗框': 'Ochre Bold', '灰紫双线': 'Violet Double', '苔灰短线': 'Moss Dash',
    '石墨点线': 'Graphite Dots',
    '边框颜色': 'Border color', '背景颜色': 'Background color', '背景透明度': 'Background opacity',
    '隐藏节点背景': 'Hide node background', '圆角': 'Corner radius', '字重': 'Weight',
    '文字比例': 'Text scale', '文字对齐': 'Text alignment', '左': 'Left', '中': 'Center', '右': 'Right',
    '线型': 'Path', '曲线': 'Curve', '直线': 'Straight', '折线': 'Elbow', '圆角折线': 'Rounded elbow',
    'S 曲线': 'S curve', '平滑曲线': 'Smooth curve', '枝桠曲线': 'Branch curve',
    '弧线': 'Arc', '自然曲线': 'Organic curve', '线条样式': 'Line style',
    '实线': 'Solid', '虚线': 'Dashed', '点线': 'Dotted', '柔线': 'Soft', '荧光': 'Glow',
    '线条颜色': 'Line color', '箭头': 'Arrowheads', '无': 'None', '单向': 'One way', '双向': 'Two way',
    '线条粗细': 'Line weight', '箭头大小': 'Arrow size', '全部重置为朴素默认': 'Reset all to clean defaults',
    '只影响之后新建的节点与连线；选中对象时会自动显示属性检查器。': 'Applies to new nodes and lines. Selecting an object opens its inspector.',
    '新建代码节点默认语言': 'Default language for new code nodes',
    '默认 8': 'Default 8', '默认 15%': 'Default 15%', '默认 1×': 'Default 1×',
    '默认 0.5s': 'Default 0.5s', '默认 0.4s': 'Default 0.4s',
    '默认 3.5s': 'Default 3.5s', '默认 70ms': 'Default 70ms', '默认 100%': 'Default 100%',
    '默认 10px': 'Default 10px', '默认 400': 'Default 400', '默认 1.5': 'Default 1.5', '默认 12': 'Default 12',
    '偏好缩放比例（25-400%；点击修改，Enter 保存）': 'Preferred zoom (25–400%; select to edit, Enter to save)',
    '空格 + 左键拖动画布松手后的滑行动量（最左=关闭惯性）': 'Momentum after Space + drag (far left turns it off)',
    '鼠标滚轮缩放速度': 'Mouse-wheel zoom speed',
    '悬停已收起的脑图节点多久后临时展开分支（最左=瞬发）': 'Delay before a collapsed branch previews on hover',
    '鼠标悬停索引节点多久后，在其左侧弹出目录预览（最左=瞬发）': 'Delay before an index preview appears on hover',
    '在有子节点的节点右侧显示收起 / 展开按钮': 'Show collapse controls on nodes with children',
    '控制「画布」完整状态下选中节点或连线时是否打开属性检查器；简洁状态始终禁用': 'Open the inspector for selected nodes or lines in full Canvas view',
    '控制思维导图模式、图案模式完整状态下选中对象时是否打开属性检查器；各模式的排版或新建预设面板仍会保留': 'Open object inspectors in full Mind Map and Shapes modes; layout and new-item preset panels remain available',
    '关闭后，空格仍可按住拖动画布，但松开空格不再自动定位最近节点': 'Space still pans the canvas, but no longer returns to the latest node.',
    '日记': 'Journal', '书写': 'Write', '阅读': 'Read', '展开书写': 'Open editor', '收起': 'Collapse',
    '上一篇': 'Previous', '下一篇': 'Next', '等待书写': 'Ready to write', '正在保存': 'Saving',
    '保存失败 · 点击重试': 'Save failed · click to retry', '正在记录…': 'Writing…',
    '今天，发生了什么？': 'What happened today?', '标签，用逗号分隔': 'Tags, separated by commas',
    '删除这篇': 'Delete entry',
    '当天成果': 'Daily outcomes', '查看活跃': 'View Activity', '自由专注': 'Open focus',
    '画布活动': 'Canvas activity',
    '这一天还没有画布活动。': 'No canvas activity was recorded this day.',
    '每日打卡': 'Daily check-in', '已打卡': 'Checked in', '未打卡': 'Not checked',
    '完成于': 'Completed at',
    '这一天还没有打卡。': 'No check-ins were recorded this day.',
    '这一天没有完成学习任务。': 'No study tasks were completed this day.',
    '这一天还没有专注记录。': 'No focus sessions were recorded this day.',
    '这一天没有归档成果。': 'No outcomes were archived this day.',
    '搜索日记标题、标签或正文摘要': 'Search journal titles, tags, or excerpts',
    '日历与记账页': 'Calendar and ledger', '记账': 'Ledger', '结余': 'Balance', '收入': 'Income', '支出': 'Expense',
    '本月汇总': 'Monthly summary', '本月收支相抵': 'Income minus expenses',
    '笔记录': 'records', '账本月份': 'Ledger month', '记一笔': 'Add entry',
    '账本页面切换': 'Ledger page navigation', '账本第 {page} 页': 'Ledger page {page}',
    '设置当前页金额单位': 'Set this page’s amount unit', '当前页金额单位': 'Amount unit for this page',
    '设置当前账本页': 'Set up this ledger page', '当前账本页设置': 'Ledger page settings',
    '视图': 'View', '账本视图': 'Ledger view', '月份': 'Monthly', '累计': 'Cumulative',
    '金额显示': 'Amount display', '金额小数': 'Amount decimals', '含小数': 'With decimals', '隐藏小数': 'Hide decimals',
    '默认记录': 'Default entry', '默认收支类型': 'Default entry type',
    '累计汇总': 'Cumulative summary', '总结余': 'Total balance', '总收入': 'Total income', '总支出': 'Total expenses',
    '单位': 'Unit', '留空使用人民币': 'Leave blank to use RMB',
    '金额单位最多 12 个字符': 'The amount unit can contain up to 12 characters.',
    '收支类型': 'Entry type', '金额': 'Amount', '倍率': 'Multiplier', '日期': 'Date', '可选': 'Optional',
    '这个月还没有账目': 'No entries this month', '这一页还没有账目': 'No entries on this page yet',
    '点击右上角记下第一笔收支。': 'Use the upper-right button to add the first entry.',
    '笔': 'entries', '确认删除': 'Confirm delete', '待填写的账目': 'Entry to complete',
    '本地草稿': 'Local draft', '账目选项': 'Entry options', '新账目': 'New entry', '编辑账目': 'Edit entry',
    '请输入有效金额，最多两位小数': 'Enter a valid amount with up to two decimal places.',
    '请输入大于零的有效金额': 'Enter a valid amount greater than zero.',
    '请输入有效倍率，最多四位小数': 'Enter a valid multiplier with up to four decimal places.',
    '倍率必须大于零且不超过 1000000': 'The multiplier must be greater than zero and no more than 1000000.',
    '应用倍率后的金额超出有效范围': 'The multiplied amount is outside the valid range.',
    '请选择有效日期': 'Choose a valid date.', '账本同步失败': 'Ledger sync failed',
    'weekdayMon': 'Mon', 'weekdayTue': 'Tue', 'weekdayWed': 'Wed', 'weekdayThu': 'Thu',
    'weekdayFri': 'Fri', 'weekdaySat': 'Sat', 'weekdaySun': 'Sun',
    '距离': 'Until', '还有': 'in', '已经过去': 'was',
    '双击编辑目标事件': 'Double-click to edit the target event',
    '双击编辑目标日期': 'Double-click to edit the target date',
    '支持 Markdown。这里适合留下当天的思考、过程和结论。': 'Markdown supported. Capture the day’s thoughts, process, and conclusions here.',
    '方向键平移速度': 'Arrow-key pan speed',
    '总开关：同时控制左侧画布手写笔，以及 PDF / Markdown / 正文阅读批注里的压感钢笔；关掉则全部不随力度变粗细。左侧画布笔还需在左侧「画笔」配置里单独勾选「压感」才生效。': 'Master pressure control for the canvas pen and PDF, Markdown, and document annotation pens. When off, pressure no longer changes stroke width. The canvas pen also needs Pressure enabled in its own settings.',
    '拖动单个文本框靠近内容节点时显示绿色对齐线并自动吸附；默认关闭。': 'Show green alignment guides and snap automatically when a single text box is dragged near a content node. Off by default.',
    '鼠标悬停索引节点时，在其左侧弹出只读目录预览（默认开启；出现快慢见上方「目录出现延迟」）': 'Show a read-only outline beside index nodes on hover. The delay is controlled by Index preview delay above.',
    '框选多个节点后浮出「生成索引」小按钮，一键收成目录卡（默认关闭）': 'Offer a Generate Index action after selecting multiple nodes to collect them into an outline card.',
    '左键框选空白区域后浮出「+ 盒子」按钮（默认开启）': 'Show a "+ Box" action after dragging over an empty area (enabled by default).',
    '左键框选节点后浮出「+ 分组」按钮（默认开启）': 'Show a "+ Group" action after dragging over nodes (enabled by default).',
    '背景语义为深色时，把画布连线临时按荧光样式显示；只改变视觉，不修改线条原始样式或 .canvas 数据。': 'On dark backgrounds, preview canvas lines with a glow treatment without changing their saved style or canvas data.',
    '背景语义为深色时，让思维导图、专业、编辑、图案、图谱、背景、脑图和模板使用深色界面；关闭后恢复原来的浅色界面': 'Use dark semantic styling for Mind Map, Shapes, Graph, Background, and Templates on dark canvases. Turn this off to keep the light interface.',
    '改动后自动保存到 .canvas 文件（默认开启）；关掉则回到手动 Ctrl+S': 'Automatically save changes to the canvas file. Turn this off to use Ctrl+S manually.',
    '已沉淀进活跃足迹': 'Added to your activity trail',
    '上个月': 'Previous month', '下个月': 'Next month', '移除便签': 'Remove note',
    '归档过的完成任务，会在这里连成一片星图。': 'Archived work gathers here as a living constellation.',
    '我': 'Me', '未命名': 'Untitled', '已完成任务足迹星图': 'Constellation of completed work',
    '今天的复习做完了': 'Today’s review is complete',
    '今天没有到期的卡片': 'No cards are due today', '收起答案': 'Hide answer',
    '拖动调节宽度': 'Drag to resize',
    '关闭': 'Close', '确认': 'Confirm', '删除': 'Delete', '完成': 'Done',

    '+ 盒子': '+ Box', '+ 分组': '+ Group',
    '建立分组后可命名、折叠并整体移动': 'Name, collapse, and move the group as a whole',
    '可以把空白选区变成一个盒子': 'Turn an empty selection into a box',

    // ── 专注页 · 每日任务独立视图 ──
    '添加一件今天想坚持的事…': 'Add one thing to repeat today…',
    '新增每日任务': 'Add daily task',
    '添加每日任务': 'Add daily task',
    '新增类型': 'Add type',
    '新建分组名称…': 'New group name…',
    '＋ 子分组': '+ Subgroup',
    '＋ 在此加任务': '+ Add task here',
    '今日进度': 'Progress today',
    '最近打卡': 'Recent check-ins',
    '未分组': 'Ungrouped',
    '今日目标': 'Daily goal',
    '累计目标': 'Cumulative goal',
    '累计打卡目标': 'Cumulative check-in goal',
    '累计打卡目标天数': 'Cumulative check-in goal in days',
    '高级设置': 'Advanced settings',
    '设置累计小目标': 'Set cumulative milestones',
    '请先设置累计目标': 'Set a cumulative goal first',
    '请先移除小目标，再清除累计目标': 'Remove the milestones before clearing the cumulative goal',
    '不能超过累计目标': ' cannot exceed the cumulative goal',
    '小目标名称': 'Milestone name',
    '累计天数': 'Cumulative days',
    '删除这个小目标': 'Delete this milestone',
    '添加小目标': 'Add milestone',
    '已达到 50 个安全上限': 'Safety limit of 50 reached',
    '关闭高级设置': 'Close advanced settings',
    '确定': 'Done',
    '已达成': 'Reached',
    '未达成': 'Upcoming',
    '请填写小目标名称': 'Enter a milestone name',
    '小目标名称不能超过 40 个字符': 'Milestone names can contain at most 40 characters',
    '小目标天数必须在 1 到累计目标之间': 'Milestone days must be between 1 and the cumulative goal',
    '同一天只能设置一个小目标': 'Only one milestone can be set on the same day',
    '把累计目标拆成有名字的小目标。达成状态会根据累计打卡天数自动点亮。': 'Split the cumulative goal into named milestones. Each milestone lights up automatically when its day is reached.',
    '分钟 · 可选': 'Minutes · optional',
    '天 · 可选': 'Days · optional',
    '每日任务名称': 'Daily task name',
    '关闭每日任务详情': 'Close daily task details',
    '今天还没开始': 'Not started today',
    '已达标': 'Goal met',
    '今天还没有专注分钟': 'No focus minutes today',
    '完成第一次打卡后，这里会开始沉淀它的日历轨迹。': 'After the first check-in, its calendar trail will begin to form here.',
    '件全部完成': 'all complete',
    '明天见': 'See you tomorrow',
    '已打卡': 'Checked in',
    '连续': 'Streak',
    '累计': 'Total',
    '最佳': 'Best',
    '名称不能为空': 'Name cannot be empty.',
    '分组名不能为空': 'Group name cannot be empty.',
    '已删除分组': 'Group deleted',
    '专注数据已更新': 'Focus data refreshed',
    '专注记录已更新': 'Session updated',
    '专注记录已删除': 'Session deleted',
    '专注记录未保存': 'Session not saved',
    '已删除': 'Deleted',
    '记录': 'Record',

    // ── 专注页 · 计时器状态 ──
    '等待收尾': 'Wrap up',
    '已暂停': 'Paused',
    '专注中': 'Focusing',
    '休息（暂停）': 'Break (paused)',
    '休息一下': 'Take a break',
    '正计时 · 自由专注，按「完成」记一段': 'Open timer · focus freely, then press Finish to log.',
    '正计时从 00:00 开始，不需要设定结束时间': 'Open timer starts at 00:00 — no end time needed.',
    '计时运行中不能修改时长': 'Cannot change duration while the timer is running.',
    '正计时从 00:00 开始': 'Open timer starts at 00:00',
    '这一段没有填写目标。': 'No intention was set for this session.',
    '为这一段写个目标': 'Add an intention for this session',

    // ── 专注页 · 收尾 / 记录编辑 ──
    '本段完成': 'Session complete',
    '可选：留下结果、进度或下一步。': 'Optional: record outcomes, progress, or next steps.',
    '请先完成或重置当前专注段': 'Please finish or reset the current session first.',
    '请先完成收尾或重置当前专注段，再查看每日任务': 'Finish the wrap-up or reset the current session before opening daily tasks.',

    // ── 专注页 · 设置 / 帮助 / 提示 ──
    '重新读取任务/每日/记录（平时翻进来用上次结果；在别处改了，点这里才更新）': 'Refresh tasks, daily items, and records. (Uses cached data; click after making changes elsewhere.)',
    '进入深度专注（Z）': 'Enter deep focus (Z)',
    '结束收尾': 'Wrap up',
    '点击圆点可查看、修改或删除一段记录。': 'Click a dot to view, edit, or delete a session.',
    '删除这段专注记录？当天与长期统计会同步扣除。': 'Delete this session? Daily and long-term stats will be updated accordingly.',
    '上次离开时，这段专注已经走完。要进入收尾并记下这一段吗？': 'This session had finished when you left. Wrap up and log it?',
    '上次休息已经结束，可以开始下一段': 'The last break has ended. Ready for the next session.',
    '重置当前计时？未满一段的时间不会记入记录。': 'Reset the current timer? Unfinished time will not be logged.',
    '移动失败': 'Move failed',

    // ── 专注页 · 键盘提示 ──
    'Space 暂停　Esc 退出深度专注': 'Space Pause  Esc Exit deep focus',
    '开始 / 暂停': 'Start / Pause',
    '关闭 / 退出': 'Close / Exit',

    // ── 星期标签 ──
    '一': 'Mon', '二': 'Tue', '三': 'Wed', '四': 'Thu', '五': 'Fri', '六': 'Sat', '日': 'Sun',

    // ── 每日任务 aria 前缀（用于拼接后匹配）──
    '取消完成 · ': 'Undo · ',
    '标记完成 · ': 'Mark done · ',
    '查看任务详情 · ': 'View task details · ',
    '任务选项 · ': 'Task options · ',
    '分组选项 · ': 'Group options · ',
    '展开分组 · ': 'Expand group · ',
    '折叠分组 · ': 'Collapse group · ',
    '段数': 'Sessions',
    '段': 'sessions',
    '，打开记录': ', open record',
    '没有专注记录': 'no focus sessions',
    '点击圆点可回看': 'click a dot to review',
    '专注': 'Focus',
    '目标：': 'Intention: ',
    '番茄轮次': 'Pomodoro round',
    '［每日］': '[Daily]',
    '［今日］': '[Today]',
    '［进行中］': '[In progress]',
    '学习任务': 'Study tasks'
  };

  const AUTO_EXCLUDE = [
    '[contenteditable]', 'input', 'textarea', '.notes-surface', '.review-body',
    '.calendar-diary-preview', '.study-task-title',
    '.focus-daily-name', '.template-card-name', '[data-role="graph-title"]',
    '.background-image-name', '.canvas', '.node', '[data-user-content]', '[data-i18n-managed]',
    '.canvas-edges-layer', '.canvas-edge-label', '.canvas-ink-layer', '.minimap-node'
  ].join(',');
  const LANGUAGE_CONTROLS = '[data-role="ui-language"], [data-role="toolbar-language"]';
  const languageControls = new Set();
  const ATTRS = ['title', 'aria-label', 'placeholder'];
  const textSources = new WeakMap();
  let language = readLanguage();
  let applying = false;
  const listeners = new Set();

  function readLanguage() {
    try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'; }
    catch (error) { return 'zh-CN'; }
  }

  function interpolate(value, vars) {
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (_, key) => vars[key] == null ? '' : String(vars[key]));
  }

  function translateDynamic(source) {
    let match = source.match(/^专注了\s*(\d+)\s*分钟$/);
    if (match) return `Focused for ${match[1]} minutes`;
    match = source.match(/^已复习\s*(\d+)\s*次$/);
    if (match) return `Reviewed ${match[1]} ${match[1] === '1' ? 'time' : 'times'}`;
    match = source.match(/^复习\s*(\d+)\s*次$/);
    if (match) return `${match[1]} ${match[1] === '1' ? 'review' : 'reviews'}`;
    match = source.match(/^下次\s+(\d{4}-\d{2}-\d{2})$/);
    if (match) return `Next ${match[1]}`;
    match = source.match(/^今天复习了\s*(\d+)\s*张\s*✦\s*想继续练习，可以切到自由复习。$/);
    if (match) return `${match[1]} reviewed today ✦ Switch to Free review if you want to keep practicing.`;
    match = source.match(/^专注\s*(\d+)\s*分钟$/);
    if (match) return `${match[1]} min focused`;
    match = source.match(/^(\d+)\s*项后代任务$/);
    if (match) return `${match[1]} descendant ${match[1] === '1' ? 'task' : 'tasks'}`;
    match = source.match(/^(\d+)%\s*·\s*(\d+)\s*项$/);
    if (match) return `${match[1]}% · ${match[2]} ${match[2] === '1' ? 'task' : 'tasks'}`;
    match = source.match(/^休息\s*(\d+)\s*分钟$/);
    if (match) return `${match[1]} min break`;
    match = source.match(/^今日\s*(\d+)\s*项$/);
    if (match) return `${match[1]} today`;
    match = source.match(/^已完成\s*(\d+)\s*项$/);
    if (match) return `${match[1]} completed`;
    match = source.match(/^已归档\s*(\d+)\s*项已完成任务$/);
    if (match) return `Archived ${match[1]} completed ${match[1] === '1' ? 'task' : 'tasks'}`;
    match = source.match(/^第\s*(\d+)\s*段$/);
    if (match) return `Session ${match[1]}`;
    match = source.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月$/);
    if (match) {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return `${months[Number(match[2]) - 1]} ${match[1]}`;
    }
    match = source.match(/^(\d{4})\s*年$/);
    if (match) return match[1];
    match = source.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*·\s*周([日一二三四五六])$/);
    if (match) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const days = { 日: 'Sun', 一: 'Mon', 二: 'Tue', 三: 'Wed', 四: 'Thu', 五: 'Fri', 六: 'Sat' };
      return `${days[match[3]]} · ${months[Number(match[1]) - 1]} ${Number(match[2])}`;
    }
    match = source.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*·\s*周([日一二三四五六])$/);
    if (match) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const days = { 日: 'Sun', 一: 'Mon', 二: 'Tue', 三: 'Wed', 四: 'Thu', 五: 'Fri', 六: 'Sat' };
      return `${days[match[4]]} · ${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
    }
    match = source.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*·\s*周([日一二三四五六])\s*·\s*(暂无记录|尚未到来|未专注|完成\s*\d+\s*项|专注\s*.+)$/);
    if (match) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const days = { 日: 'Sun', 一: 'Mon', 二: 'Tue', 三: 'Wed', 四: 'Thu', 五: 'Fri', 六: 'Sat' };
      return `${days[match[3]]} · ${months[Number(match[1]) - 1]} ${Number(match[2])} · ${EN[match[4]] || translateDynamic(match[4])}`;
    }
    match = source.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*·\s*周([日一二三四五六])\s*·\s*(画布\s*.+|有历史画布记录，时长无法还原|未使用画布)$/);
    if (match) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const days = { 日: 'Sun', 一: 'Mon', 二: 'Tue', 三: 'Wed', 四: 'Thu', 五: 'Fri', 六: 'Sat' };
      const status = match[4].startsWith('画布 ')
        ? `Canvas ${EN[match[4].slice(3)] || translateDynamic(match[4].slice(3))}`
        : (EN[match[4]] || match[4]);
      return `${days[match[3]]} · ${months[Number(match[1]) - 1]} ${Number(match[2])} · ${status}`;
    }
    match = source.match(/^(\d{1,2})\s*月$/);
    if (match) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[Number(match[1]) - 1];
    }
    match = source.match(/^完成\s*(\d+)\s*项$/);
    if (match) return `${match[1]} completed`;
    match = source.match(/^留下\s*(\d+)\s*道足迹$/);
    if (match) return `${match[1]} ${match[1] === '1' ? 'mark' : 'marks'} made`;
    match = source.match(/^(\d+)\s*段\s*·\s*(.+)$/);
    if (match) return `${match[1]} sessions · ${EN[match[2]] || translateDynamic(match[2])}`;
    match = source.match(/^共\s*(\d+)\s*段专注$/);
    if (match) return `${match[1]} focus ${match[1] === '1' ? 'session' : 'sessions'}`;
    match = source.match(/^使用\s*(\d+)\s*张画布(?:\s*·\s*(.+))?$/);
    if (match) return `${match[1]} ${match[1] === '1' ? 'canvas' : 'canvases'} used`
      + (match[2] ? ` · ${EN[match[2]] || translateDynamic(match[2])}` : '');
    match = source.match(/^(\d+)\s*分(?:钟)?$/);
    if (match) return `${match[1]} min`;
    match = source.match(/^(\d+(?:\.\d+)?)\s*小时(?:\s*(\d+)\s*分)?$/);
    if (match) return `${match[1]} hr${match[2] ? ` ${match[2]} min` : ''}`;
    match = source.match(/^累计\s*(\d+)\s*件$/);
    if (match) return `${match[1]} total`;
    match = source.match(/^查看\s*(\d{4})\s*年$/);
    if (match) return `View ${match[1]}`;
    match = source.match(/^(\d{4})\s*年逐日已完成任务热力图$/);
    if (match) return `Daily completed-work activity for ${match[1]}`;
    match = source.match(/^(\d{4})\s*年逐日画布使用时长热力图$/);
    if (match) return `Daily canvas time for ${match[1]}`;
    match = source.match(/^(\d{4})\s*年逐日专注时长热力图$/);
    if (match) return `Daily focus time for ${match[1]}`;
    match = source.match(/^(\d+)\s*天$/);
    if (match) return `${match[1]} ${match[1] === '1' ? 'day' : 'days'}`;
    match = source.match(/^自动保存到\s*(.+)$/);
    if (match) return `Autosaved to ${match[1]}`;
    match = source.match(/^应用(.+)并整理$/);
    if (match) return `Apply ${EN[match[1]] || translateDynamic(match[1])} & arrange`;
    match = source.match(/^应用(.+)并设为全局默认$/);
    if (match) return `Apply ${EN[match[1]] || translateDynamic(match[1])} and set as global default`;
    match = source.match(/^(\d+)\s*个元素(?:\s*·\s*(\d+)\s*条连线)?$/);
    if (match) return `${match[1]} ${match[1] === '1' ? 'element' : 'elements'}`
      + (match[2] ? ` · ${match[2]} ${match[2] === '1' ? 'edge' : 'edges'}` : '');
    match = source.match(/^(.+)\s*·\s*(\d+)\s*元素$/);
    if (match) return `${match[1]} · ${match[2]} ${match[2] === '1' ? 'element' : 'elements'}`;
    match = source.match(/^(.+)\s*\/\s*(索引节点|预览节点|卡片节点|PDF 附件|Markdown 附件|普通节点)$/);
    if (match) return `${match[1]} / ${EN[match[2]] || match[2]}`;
    match = source.match(/^(最近|收藏)\s+(\d+)$/);
    if (match) return `${EN[match[1]] || match[1]}  ${match[2]}`;
    match = source.match(/^没有第\s*(\d+)\s*个分组$/);
    if (match) return `Group ${match[1]} does not exist.`;
    match = source.match(/^已经在「(.+)」$/);
    if (match) return `Already in “${match[1]}”`;
    match = source.match(/^已移到「(.+)」$/);
    if (match) return `Moved to “${match[1]}”`;
    match = source.match(/^已移回「(.+)」$/);
    if (match) return `Moved back to “${match[1]}”`;
    match = source.match(/^读取「(.+)」失败$/);
    if (match) return `Could not read “${match[1]}”.`;
    match = source.match(/^「(.+)」不是有效的画布文件$/);
    if (match) return `“${match[1]}” is not a valid canvas file.`;
    match = source.match(/^(重命名失败|导入失败)：(.+)$/);
    if (match) return `${EN[match[1]] || match[1]}: ${match[2]}`;
    match = source.match(/^已选\s*(\d+)\s*个节点，改动会应用到全部。$/);
    if (match) return `${match[1]} nodes selected. Changes apply to all.`;
    match = source.match(/^已选\s*(\d+)\s*条连线，改动会应用到全部。$/);
    if (match) return `${match[1]} edges selected. Changes apply to all.`;
    match = source.match(/^(\d+)\s*个$/);
    if (match) return `${match[1]} selected`;
    match = source.match(/^(\d+)\s*条$/);
    if (match) return `${match[1]} selected`;
    match = source.match(/^当前显示器可选范围：(.+)$/);
    if (match) return `Available range on this display: ${match[1]}`;
    match = source.match(/^将只整理已选中的\s*(\d+)\s*个节点$/);
    if (match) return `Only the ${match[1]} selected nodes will be arranged.`;
    match = source.match(/^(.+)\s*·\s*(?:预设|Preset)$/);
    if (match) return `${EN[match[1]] || translateDynamic(match[1])} · Preset`;
    match = source.match(/^分组\s*·\s*(\d+)\s*个节点$/);
    if (match) return `Group · ${match[1]} ${match[1] === '1' ? 'node' : 'nodes'}`;
    match = source.match(/^(.+)已恢复默认设置$/);
    if (match) return `${EN[match[1]] || translateDynamic(match[1])} defaults restored`;
    match = source.match(/^未找到《(.+)》$/);
    if (match) return `Could not find “${match[1]}”`;
    match = source.match(/^已应用“(.+)”并设为全局默认$/);
    if (match) return `Applied “${EN[match[1]] || translateDynamic(match[1])}” and set it as the global default`;
    match = source.match(/^已将“(.+)”应用到选中盒子\s*\/\s*分组$/);
    if (match) return `Applied “${EN[match[1]] || translateDynamic(match[1])}” to the selected boxes or groups`;
    match = source.match(/^“(.+)”已设为盒子\s*\/\s*分组新建预设$/);
    if (match) return `“${EN[match[1]] || translateDynamic(match[1])}” is now the creation preset for boxes and groups`;
    match = source.match(/^将(.+)应用到选中$/);
    if (match) return `Apply ${EN[match[1]] || translateDynamic(match[1])} to selection`;
    match = source.match(/^将(.+)设为新建预设$/);
    if (match) return `Use ${EN[match[1]] || translateDynamic(match[1])} as creation preset`;
    match = source.match(/^应用(.+)并设为全局默认$/);
    if (match) return `Apply ${EN[match[1]] || translateDynamic(match[1])} and set as global default`;
    match = source.match(/^“(.+)”已设为盒子\s*\/\s*分组全局默认$/);
    if (match) return `“${EN[match[1]] || translateDynamic(match[1])}” is now the global default for boxes and groups`;
    match = source.match(/^已建立分组\s*·\s*(\d+)\s*个节点$/);
    if (match) return `Group created · ${match[1]} ${match[1] === '1' ? 'node' : 'nodes'}`;
    match = source.match(/^已移到「(.+)」下$/);
    if (match) return `Moved under “${match[1] || 'Untitled'}”`;
    match = source.match(/^已存为模板「(.+)」\s*·\s*(\d+)\s*个元素$/);
    if (match) return `Saved as template “${match[1]}” · ${match[2]} ${match[2] === '1' ? 'element' : 'elements'}`;
    match = source.match(/^新建\s*·\s*(.+)$/);
    if (match) return `New · ${EN[match[1]] || translateDynamic(match[1])}`;
    match = source.match(/^([一二三四五六七八九十]+月)，你完成了\s*(\d+)\s*件事。最常在周([日一二三四五六])留下痕迹。$/);
    if (match) {
      const months = { 一月:'January', 二月:'February', 三月:'March', 四月:'April', 五月:'May', 六月:'June', 七月:'July', 八月:'August', 九月:'September', 十月:'October', 十一月:'November', 十二月:'December' };
      const days = { 日:'Sunday', 一:'Monday', 二:'Tuesday', 三:'Wednesday', 四:'Thursday', 五:'Friday', 六:'Saturday' };
      return `You completed ${match[2]} items in ${months[match[1]] || match[1]}, most often on ${days[match[3]]}.`;
    }
    match = source.match(/^(\d+)\s*分钟前$/);
    if (match) return `${match[1]} min ago`;
    match = source.match(/^(\d+)\s*小时前$/);
    if (match) return `${match[1]} hr ago`;
    match = source.match(/^(\d+)\s*天前$/);
    if (match) return `${match[1]} days ago`;
    match = source.match(/^(\d+)\s*个节点\s*·\s*(.+)$/);
    if (match) return `${match[1]} ${match[1] === '1' ? 'node' : 'nodes'} · ${match[2]}`;
    if (source === '刚刚') return 'Just now';
    if (source === '昨天') return 'Yesterday';
    if (source === '文件已不在') return 'File missing';

    // ── 专注页 · 每日任务统计 ──
    match = source.match(/^连续\s*(\d+)\s*天$/);
    if (match) return `${match[1]}-day streak`;
    match = source.match(/^共\s*(\d+)\s*天$/);
    if (match) return `${match[1]} days total`;
    match = source.match(/^累计\s*(\d+)\s*分$/);
    if (match) return `${match[1]} min total`;
    match = source.match(/^累计不足\s*1\s*分钟$/);
    if (match) return 'Under 1 min total';
    match = source.match(/^累计\s*(\d+)\s*分钟$/);
    if (match) return `${match[1]} min total`;
    match = source.match(/^累计\s*(\d+)\s*小时(?:\s*(\d+)\s*分)?$/);
    if (match) return `${match[1]} hr${match[2] ? ` ${match[2]} min` : ''} total`;
    match = source.match(/^今天\s*(\d+)\s*分$/);
    if (match) return `${match[1]} min today`;
    match = source.match(/^累计\s*(\d+)\s*\/\s*(\d+)\s*天\s*·\s*已达成$/);
    if (match) return `${match[1]} / ${match[2]} days total · goal met`;
    match = source.match(/^累计\s*(\d+)\s*\/\s*(\d+)\s*天$/);
    if (match) return `${match[1]} / ${match[2]} days total`;
    match = source.match(/^今天做完了\s*(\d+)\s*件事(?:\s*·\s*专注\s*(\d+)\s*分钟)?$/);
    if (match) {
      const noun = match[1] === '1' ? 'thing' : 'things';
      return `Finished ${match[1]} ${noun} today${match[2] ? ` · ${match[2]} min focused` : ''}`;
    }
    match = source.match(/^(\d+)\s*件全部完成\s*·\s*专注\s*(\d+)\s*分钟\s*·\s*明天见$/);
    if (match) return `${match[1]} all complete · ${match[2]} min focused · See you tomorrow`;
    match = source.match(/^(\d+)\s*件全部完成\s*·\s*明天见$/);
    if (match) return `${match[1]} all complete · See you tomorrow`;
    match = source.match(/^已记录\s*(\d+)\s*个打卡日，最近一次是\s*(.+)。$/);
    if (match) return `${match[1]} check-in days recorded. Last was ${match[2]}.`;
    match = source.match(/^今天\s*(\d+)\s*\/\s*(\d+)\s*完成$/);
    if (match) return `${match[1]} / ${match[2]} done today`;
    match = source.match(/^今天\s*(\d+)\s*\/\s*(\d+)\s*完成\s*·\s*今日已专注\s*(\d+)\s*分$/);
    if (match) return `${match[1]} / ${match[2]} done today · ${match[3]} min focused`;
    match = source.match(/^今日已专注\s*(\d+)\s*分$/);
    if (match) return `${match[1]} min focused today`;
    match = source.match(/^已打卡\s*(\d+)\s*天$/);
    if (match) return `${match[1]} days checked in`;
    match = source.match(/^最佳连续\s*(\d+)\s*天$/);
    if (match) return `Best streak: ${match[1]} days`;
    match = source.match(/^今天\s*(\d+)\s*\/\s*(\d+)\s*分\s*·\s*达标\s*✦$/);
    if (match) return `Today ${match[1]} / ${match[2]} min · goal met ✦`;
    match = source.match(/^今天\s*(\d+)\s*\/\s*(\d+)\s*分$/);
    if (match) return `Today ${match[1]} / ${match[2]} min`;
    match = source.match(/^今天已专注\s*(\d+)\s*分钟$/);
    if (match) return `${match[1]} min focused today`;
    match = source.match(/^(\d+)\s*\/\s*(\d+)\s*分钟\s*·\s*已达标$/);
    if (match) return `${match[1]} / ${match[2]} min · goal met`;
    match = source.match(/^(\d+)\s*\/\s*(\d+)\s*分钟$/);
    if (match) return `${match[1]} / ${match[2]} min`;

    // ── 专注页 · 计时器动态文本 ──
    match = source.match(/^专注\s*·\s*第\s*(\d+)\s*段$/);
    if (match) return `Focus · Session ${match[1]}`;
    match = source.match(/^番茄钟\s*·\s*专注\s*(\d+)\s*\/\s*休息\s*(\d+)\s*分$/);
    if (match) return `Pomodoro · ${match[1]} focus / ${match[2]} rest`;
    match = source.match(/^番茄轮次\s+第\s*(\d+)\s*\/\s*(\d+)\s*段$/);
    if (match) return `Pomodoro round ${match[1]} / ${match[2]}`;
    match = source.match(/^(\d+)\s*段\s*·\s*(.+)$/);
    if (match) return `${match[1]} sessions · ${EN[match[2]] || translateDynamic(match[2])}`;

    // ── 专注页 · Toast 消息 ──
    match = source.match(/^已保存专注记录，并完成今天的「(.+)」$/);
    if (match) return `Session logged and today's "${match[1]}" completed`;
    match = source.match(/^专注\s*(\d+)\s*分\s*·\s*(.+)\s*✦\s*已记下$/);
    if (match) return `${match[1]} min focused · ${match[2]} ✦ logged`;
    match = source.match(/^专注\s*(\d+)\s*分\s*✦\s*已记下$/);
    if (match) return `${match[1]} min focused ✦ logged`;
    match = source.match(/^专注记录已保存，每日任务未更新\s*·\s*(.+)$/);
    if (match) return `Session logged; daily task update failed · ${match[1]}`;
    match = source.match(/^专注记录已保存，任务状态未更新\s*·\s*(.+)$/);
    if (match) return `Session logged; task status update failed · ${match[1]}`;
    match = source.match(/^已保存专注记录，并完成任务\s*·\s*(.+)$/);
    if (match) return `Session logged and task completed · ${match[1]}`;

    // ── 专注页 · 每日任务动态 placeholder ──
    match = source.match(/^在「(.+)」下添加任务…$/);
    if (match) return `Add task under "${match[1]}"…`;
    match = source.match(/^在「(.+)」下新建子分组…$/);
    if (match) return `New subgroup under "${match[1]}"…`;

    // ── 专注页 · 删除确认动态文本 ──
    match = source.match(/^删除「(.+)」？它的累计天数与分钟会一起清掉。$/);
    if (match) return `Delete "${match[1]}"? Its accumulated days and minutes will be cleared.`;
    match = source.match(/^删除分组「(.+)」？里面的任务和子分组会移到上一层，不会被删除。$/);
    if (match) return `Delete group "${match[1]}"? Tasks and subgroups will move up one level.`;

    // ── 专注页 · 足迹（今日专用，匹配在通用模式之前）──
    match = source.match(/^今日\s+(\d+)\s+段\s*·\s*(\d+)\s*分钟\s*·\s*点击圆点可回看$/);
    if (match) return `Today ${match[1]} sessions · ${match[2]} min · click a dot to review`;
    match = source.match(/^今日\s+(\d+)\s+段\s*·\s*(\d+)\s*小时\s*(\d+)\s*分\s*·\s*点击圆点可回看$/);
    if (match) return `Today ${match[1]} sessions · ${match[2]} hr ${match[3]} min · click a dot to review`;
    match = source.match(/^今日\s+(\d+)\s+段\s*·\s*(\d+)\s*小时\s*·\s*点击圆点可回看$/);
    if (match) return `Today ${match[1]} sessions · ${match[2]} hr · click a dot to review`;
    match = source.match(/^今日没有专注记录$/);
    if (match) return 'Today no focus sessions';
    // ── 足迹（通用，非今日）──
    match = source.match(/^(.+)\s+(\d+)\s+段\s*·\s*(.+)\s*·\s*点击圆点可回看$/);
    if (match) return `${match[1]} ${match[2]} sessions · ${match[3]} · click a dot to review`;
    match = source.match(/^(.+)没有专注记录$/);
    if (match) return `${match[1]}no focus sessions`;

    // ── 专注页 · 座舱动态 ──
    match = source.match(/^本段将计入「(.+)」$/);
    if (match) return `This session counts toward "${match[1]}"`;
    match = source.match(/^目标\s*·\s*(.+)$/);
    if (match) return `Intention · ${match[1]}`;
    match = source.match(/^累计\s*(\d+)\s*天$/);
    if (match) return `${match[1]} days total`;

    // ── 每日任务 aria 动态文本 ──
    match = source.match(/^取消完成\s*·\s*(.+)$/);
    if (match) return 'Undo · ' + match[1];
    match = source.match(/^标记完成\s*·\s*(.+)$/);
    if (match) return 'Mark done · ' + match[1];
    match = source.match(/^查看任务详情\s*·\s*(.+)$/);
    if (match) return 'View task details · ' + match[1];
    match = source.match(/^任务选项\s*·\s*(.+)$/);
    if (match) return 'Task options · ' + match[1];
    match = source.match(/^分组选项\s*·\s*(.+)$/);
    if (match) return 'Group options · ' + match[1];
    match = source.match(/^展开分组\s*·\s*(.+)$/);
    if (match) return 'Expand group · ' + match[1];
    match = source.match(/^折叠分组\s*·\s*(.+)$/);
    if (match) return 'Collapse group · ' + match[1];
    match = source.match(/^学习任务第\s*(\d+)\s*页$/);
    if (match) return 'Study task page ' + match[1];

    return source;
  }

  function t(source, vars) {
    if (source == null) return '';
    const raw = String(source);
    if (language !== 'en') return interpolate(raw, vars);
    return interpolate(EN[raw] || translateDynamic(raw), vars);
  }

  function isExcluded(element) {
    return !!(element.closest && element.closest(AUTO_EXCLUDE));
  }

  function applyElement(element) {
    if (!(element instanceof Element)) return;
    if (isExcluded(element) && !element.matches('input, textarea')) return;
    const key = element.getAttribute('data-i18n');
    if (key) {
      const source = element.getAttribute('data-i18n-zh') || key;
      const target = language === 'en' ? (EN[key] || key) : source;
      if (element.textContent !== target) element.textContent = target;
    } else if (element.childElementCount === 0) {
      const visible = element.textContent.trim();
      let source = element.dataset.i18nSourceText || '';
      if (language === 'en') {
        if (source && visible !== (EN[source] || translateDynamic(source))) source = '';
        if (!source && (EN[visible] || translateDynamic(visible) !== visible)) {
          source = visible;
          element.dataset.i18nSourceText = source;
        }
        if (source) {
          const target = EN[source] || translateDynamic(source);
          if (visible !== target) element.textContent = target;
        }
      } else if (source) {
        if (visible !== source) element.textContent = source;
      }
    }

    ATTRS.forEach((attr) => {
      if (!element.hasAttribute(attr)) return;
      const dataName = `i18nSource${attr.replace(/(^|-)(\w)/g, (_, __, char) => char.toUpperCase())}`;
      const visible = element.getAttribute(attr) || '';
      let source = element.dataset[dataName] || '';
      if (language === 'en') {
        if (!source && (EN[visible] || translateDynamic(visible) !== visible)) {
          source = visible;
          element.dataset[dataName] = source;
        }
        if (source) {
          const target = EN[source] || translateDynamic(source);
          if (visible !== target) element.setAttribute(attr, target);
        }
      } else if (source) {
        if (visible !== source) element.setAttribute(attr, source);
      }
    });

    if (element.childElementCount > 0) {
      element.childNodes.forEach((node) => {
        if (node.nodeType !== Node.TEXT_NODE) return;
        const visible = node.nodeValue.trim();
        let source = textSources.get(node) || '';
        if (language === 'en') {
          if (source && visible !== (EN[source] || translateDynamic(source))) source = '';
          if (!source && (EN[visible] || translateDynamic(visible) !== visible)) {
            source = visible;
            textSources.set(node, source);
          }
          if (source) {
            const target = EN[source] || translateDynamic(source);
            if (visible !== target) node.nodeValue = node.nodeValue.replace(visible, target);
          }
        } else if (source && visible !== source) {
          node.nodeValue = node.nodeValue.replace(visible, source);
        }
      });
    }
  }

  function apply(root) {
    if (!root || applying) return;
    // 动态插入一张画布节点/Markdown 正文时，整棵子树都是用户内容；逐后代 closest()
    // 扫描不仅无意义，还会在批量建卡时放大成明显卡顿。输入框例外，仍需翻译 placeholder。
    if (root instanceof Element && isExcluded(root) && !root.matches('input, textarea')) return;
    applying = true;
    try {
      if (root instanceof Element) applyElement(root);
      // Prune user content and geometry as whole subtrees, including during a language switch.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(element) {
          return isExcluded(element) && !element.matches('input, textarea')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) applyElement(walker.currentNode);
      // 被裁掉的用户区仍可能嵌有真正的 UI 输入框；只翻译它们的提示，不读取 value。
      root.querySelectorAll('input, textarea').forEach(function (input) {
        if (input.parentElement && isExcluded(input.parentElement)) applyElement(input);
      });
    } finally {
      applying = false;
    }
  }

  function syncLanguageState() {
    // Writing lang invalidates language-dependent styles across the document. Never do this
    // for every inserted path/minimap dot: only initialization and actual language changes.
    if (document.documentElement.lang !== language) document.documentElement.lang = language;
    if (document.documentElement.dataset.uiLanguage !== language) document.documentElement.dataset.uiLanguage = language;
    if (document.body && document.body.dataset.uiLanguage !== language) document.body.dataset.uiLanguage = language;
    languageControls.forEach((select) => {
      if (!select.isConnected) languageControls.delete(select);
      else if (select.value !== language) select.value = language;
    });
  }

  function setLanguage(next, persist = true) {
    const normalized = next === 'en' ? 'en' : 'zh-CN';
    language = normalized;
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, normalized); } catch (error) {}
    }
    syncLanguageState();
    apply(document);
    listeners.forEach((listener) => listener(normalized));
    document.dispatchEvent(new CustomEvent('relatum:languagechange', { detail: { language: normalized } }));
  }

  function bindLanguageControls(root) {
    const bind = (select) => {
      languageControls.add(select);
      if (select.dataset.i18nBound === '1') return;
      select.dataset.i18nBound = '1';
      select.value = language;
      select.addEventListener('change', () => setLanguage(select.value, true));
    };
    const scope = root || document;
    if (scope instanceof Element && scope.matches(LANGUAGE_CONTROLS)) bind(scope);
    scope.querySelectorAll(LANGUAGE_CONTROLS).forEach(bind);
  }

  const observer = new MutationObserver((records) => {
    if (applying) return;
    const roots = new Set();
    const elements = new Set();
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 3) {
          if (node.parentElement) elements.add(node.parentElement);
          return;
        }
        if (node.nodeType !== 1) return;
        if (isExcluded(node) && !node.matches('input, textarea')) return;
        roots.add(node);
      });
      if (record.type === 'characterData' && record.target.parentElement) elements.add(record.target.parentElement);
      if (record.type === 'attributes' && record.target instanceof Element) elements.add(record.target);
    });
    const hasQueuedAncestor = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (roots.has(parent)) return true;
      }
      return false;
    };
    roots.forEach((root) => {
      if (!root.isConnected || hasQueuedAncestor(root)) return;
      bindLanguageControls(root);
      apply(root);
    });
    elements.forEach((element) => {
      if (element.isConnected && !roots.has(element) && !hasQueuedAncestor(element)) applyElement(element);
    });
  });

  window.RelatumI18n = {
    get language() { return language; },
    t,
    apply,
    setLanguage,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };

  function start() {
    bindLanguageControls(document);
    syncLanguageState();
    apply(document);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
