function page(id, chapter, kicker, title, lead, sections = [], extra = {}) {
  return Object.freeze({ id, chapter, kicker, title, lead, sections, ...extra });
}

function nodePage(id, kicker, title, lead, ports, settings, realExample, pitfalls) {
  return page(id, 'nodes', kicker, title, lead, [], {
    nodeType: id.replace(/^node-/, ''), ports, settings, realExample, pitfalls,
  });
}

const intro = [
  page('intro-purpose', 'intro', '01 · 研究工作区', '它不是普通流程图，而是一张可执行的知识画布',
    '研究工作区把“解释关系”和“可计算关系”放在同一张无限画布上：笔记与关系线负责表达含义，类型化节点与导线负责得到可验证的结果。', [
      { title: '两层结构', body: '知识层由 Note 与关系线组成，适合写假设、证据和结论；计算层由值、Pulse、状态节点和导线组成，适合计算、计时、数字逻辑与可重复实验。两层可以相邻摆放，但只有导线会进入执行图。' },
      { title: '什么时候使用', body: '当一个问题需要明确输入、转换、状态和输出，并希望每一步都能被观察时使用研究工作区。只想自由记录长文或整理卡片时，笔记与普通画布更合适。' },
      { title: '可信边界', body: '节点只执行内建语义，不运行脚本、不访问网络，也不会偷偷读取整页。标题和空间位置只帮助阅读，不决定执行顺序。' },
    ]),
  page('intro-operation', 'intro', '02 · 基本操作', '从添加节点到检查属性',
    '先在左侧“添加”面板单击一种节点，再双击稳定空白处放置；单击节点查看属性，双击节点只编辑标题。', [
      { title: '选择与移动', body: '普通左键负责选择和拖动。拖空白框选多个节点；Ctrl/Cmd+A 全选；Delete 或 Backspace 删除选区；Ctrl/Cmd+Z 与 Ctrl/Cmd+Shift+Z 撤销、重做。' },
      { title: '画布与面板', body: '按住 Space 或中键拖动画布，滚轮以指针为中心缩放。Tab 收起或恢复左侧统一面板；左下角比例可恢复 100%，小地图用于远距离定位。' },
      { title: '先改标题还是配置', body: '标题只是给人看的标签。数学运算、位宽、初始值和计时长度必须在属性面板修改，改标题不会改变行为。' },
    ]),
  page('intro-connections', 'intro', '03 · 两种连线', '关系线表达“有关”，导线表达“把值或事件送过去”',
    '底栏只记忆下一次 Alt 拖拽要创建的连线种类；普通左键始终保留为选择和移动。', [
      { title: '关系线', body: '选择“关系线”，按住 Alt 从一个节点主体拖到另一个节点主体。它没有方向和端口类型，不参与计算，适合连接问题、证据、反例和结论。' },
      { title: '导线', body: '选择“导线”，按住 Alt 从真实端口拖到兼容端口。可以从输入端反向起线，系统会整理为输出到输入。值输入只允许一条来源，Pulse 输入允许多个来源。' },
      { title: '红色预览', body: '红色活动线表示通道、类型、位宽或占用冲突；松手后不会写入模型或历史。不要靠节点摆放顺序猜执行关系，只有成功建立的导线才算依赖。' },
    ]),
  page('intro-values', 'intro', '04 · 稳定值', 'number、boolean、string、time 与 Bits 是五种明确的数据',
    '稳定值会在配置或上游结果变化后自动传播，不需要按“运行”。类型不匹配时必须经过 Convert，系统不会做隐式猜测。', [
      { title: 'number / boolean / string', body: 'number 是有限浮点数；boolean 只有 true/false；string 是文本。比较、选择和逻辑节点要求输入类型明确且匹配。' },
      { title: 'time', body: 'time 是毫秒时间戳，用于 Current Time 与截止时间比较。它不是“持续了多少毫秒”；时长通常使用 number。' },
      { title: 'Bits<1–64>', body: 'Bits 是固定宽度的无符号位向量。数学运算按位宽回绕，Logic 逐位计算；不同位宽不能直接混用，先用 Bits Resize 或 Convert 明确位宽。' },
    ]),
  page('intro-pulse', 'intro', '05 · Pulse 事件', 'Pulse 是发生过一次，而不是持续为 true',
    'Button、Clock、Timer done 和 Edge Detector 输出瞬时 Pulse。Pulse 只在运行时存在，用来触发 Register、Counter、Timer 等状态节点。', [
      { title: '值与事件的区别', body: '稳定值适合表达“现在是多少”；Pulse 适合表达“刚刚发生”。把 boolean 当作触发器会重复或丢失语义，把 Pulse 接到值端口则会被拒绝。' },
      { title: '同一时刻的批次', body: '同一仿真时刻到达的 Pulse 先读取旧状态，再统一提交状态更新，因此多个 Register 可以同步采样，不会因为画布位置或连线顺序得到随机结果。' },
      { title: '如何观察', body: '把 Pulse 接到 Probe 的 pulse 输入。Probe 会记录仿真时间、递增序号以及来源节点/端口，比只看节点闪动更适合排错。' },
    ]),
  page('intro-simulation', 'intro', '06 · 自动计算与运行栏', '组合结果自动更新；运行栏只推进时间与事件',
    'Constant、Math、Logic、Compare、Select、Convert 和 Bits 在连接完整后立即计算。Run、Pause、Step、Reset 与倍率控制的是 Clock、Timer 和 Pulse 驱动的状态。', [
      { title: 'Run / Pause / Step', body: 'Run 连续推进仿真时间；Pause 冻结它；Step 跳到下一个 Clock 或 Timer 边界并完整处理该时刻事件。Button 即使暂停也会立即执行一个事件批次。' },
      { title: 'Reset 与倍率', body: 'Reset 把状态恢复到配置初值并清空 Probe 轨迹。0.25×–4× 只改变仿真时间相对现实时间的速度，不改变 Current Time 的墙上时间。' },
      { title: '错误与缺输入', body: '尚未接完的节点保持安静；输入齐全后出现的红色结果才是真实错误，例如除零、类型不符、位范围越界或无状态边界的组合环。' },
    ]),
];

const nodes = [
  nodePage('node-note', '07 · 知识', 'Note · 笔记', '只承载说明、假设、证据或结论，不进入计算图。',
    [], ['无计算配置；双击节点编辑标题和正文标签。'],
    '在一个截止时间电路旁放置 Note，写清“灯亮表示仍在期限内”，再用关系线连接到相关节点。',
    ['不要用 Note 假装输入值；标题里的数字不会被计算。', 'Note 只能使用关系线，不能连接导线端口。']),
  nodePage('node-constant', '08 · 输入', 'Constant · 常量', '提供一个明确类型的固定值，是绝大多数组合电路的起点。',
    [['out', '输出', 'value · any', '输出属性面板配置的真实类型值。']],
    ['值：number、boolean、string、time 或 Bits；Bits 还需 1–64 位位宽。'],
    '把单价 129 与数量 3 分别设为 number，接入 Math multiply，得到小计 387。',
    ['两个看起来相同的文本与数字类型不同。', 'Bits 值会按位宽截断；需要更宽结果时先调整位宽。']),
  nodePage('node-button', '09 · 输入', 'Button · 按钮', '每次点击产生一个 Pulse，适合人工触发一次动作。',
    [['fire', '输出', 'event · Pulse', '每次点击恰好发出一个事件。']], ['无配置。'],
    '把 fire 接到 Counter.inc，每点击一次计数加一；再接 Probe.pulse 可以看到每次点击的序号。',
    ['Button 不是 boolean，不能接 Lamp 或 Math。', '暂停时点击仍会立即执行，这是手动事件而非仿真时钟。']),
  nodePage('node-toggle', '10 · 输入', 'Toggle · 开关', '提供可交互的持续 boolean，点击后保持新状态。',
    [['out', '输出', 'value · boolean', '持续输出当前开关状态。']], ['初始状态：false 或 true。', '状态策略：默认重开后复位，也可显式保留。'],
    '把开关接到 Lamp 观察当前状态，再接 Edge Detector，把每次开关变化转换为 Pulse。',
    ['需要“一次触发”时使用 Button，而不是 Toggle。', '切换后输出会持续保持，不会自动弹回。']),
  nodePage('node-current-time', '11 · 输入', 'Current Time · 当前时间', '输出真实墙上时间，适合期限、日期与时间窗口判断。',
    [['out', '输出', 'value · time', '输出按精度取整后的毫秒时间戳。']], ['刷新精度：250–60000 ms；越小更新越频繁。'],
    '将当前时间与 time 类型的截止常量接入 Compare less，得到“是否仍未到期”。',
    ['Current Time 不受仿真倍率控制。', '不要把 number 时长直接和 time 时间戳比较。']),
  nodePage('node-clock', '12 · 输入', 'Clock · 时钟', '按仿真时间周期发出 Pulse，是连续状态机的节拍源。',
    [['enabled', '输入', 'value · boolean · 可选', '未连接或 true 时启用。'], ['tick', '输出', 'event · Pulse', '每个周期边界发出一次。']],
    ['周期：16–3600000 ms。', '状态策略可决定重开后是否保留距离下一次 tick 的剩余时间。'],
    '把 tick 同时接到 Register.write 与 Counter.inc，单步一次就能观察同步采样和计数。',
    ['Clock 只有在 Run 或 Step 时推进。', '过短周期加上巨大扇出可能触发安全预算。']),
  nodePage('node-math', '13 · 组合', 'Math · 数学', '对两个同类型 number 或同位宽 Bits 执行算术。',
    [['a', '输入', 'value · number/Bits · 必需', '左操作数。'], ['b', '输入', 'value · number/Bits · 必需', '右操作数。'], ['out', '输出', 'value · number/Bits', '结果类型跟随输入。']],
    ['运算：add、subtract、multiply、divide、modulo。'],
    'number 的 129 × 3 得到 387；4 位 Bits 的 0xF + 0x1 会回绕为 0x0。',
    ['a 与 b 必须同类型，Bits 还要同位宽。', '除零和取模零会给出红色错误。']),
  nodePage('node-logic', '14 · 组合', 'Logic · 逻辑', '对 boolean 做逻辑判断，或对同位宽 Bits 做逐位运算。',
    [['a', '输入', 'value · boolean/Bits · 必需', '第一输入。'], ['b', '输入', 'value · boolean/Bits', 'NOT 时不需要，其余运算必需。'], ['out', '输出', 'value · boolean/Bits', '逻辑结果。']],
    ['运算：and、or、xor、not。'],
    '全加器用 XOR 计算和位，用 AND 与 OR 计算进位；对 Bits 使用时每一位独立计算。',
    ['NOT 只读取 a。', 'boolean 与 Bits<1>语义相近但类型不同，不能直接混接。']),
  nodePage('node-compare', '15 · 组合', 'Compare · 比较', '比较两个同类型值并输出 boolean。',
    [['a', '输入', 'value · number/boolean/string/time/Bits · 必需', '左侧值。'], ['b', '输入', '同 a · 必需', '右侧值。'], ['out', '输出', 'value · boolean', '比较结果。']],
    ['比较：equal、not-equal、less、less-equal、greater、greater-equal。'],
    '比较小计是否大于等于满减门槛，再把结果交给 Select 选择原价或折后价。',
    ['两侧必须同类型；Bits 必须同位宽。', '字符串大小比较与数值比较不同，不要用字符串保存金额。']),
  nodePage('node-select', '16 · 组合', 'Select · 选择', '根据一个 boolean 条件，在两路同类型值中选择一路。',
    [['condition', '输入', 'value · boolean · 必需', 'true 选择 whenTrue。'], ['whenTrue', '输入', 'value · any · 必需', '真分支。'], ['whenFalse', '输入', 'value · any · 必需', '假分支。'], ['out', '输出', 'value · any', '被选择的值。']],
    ['无配置。'],
    '期限内输出“仍在期限内”，否则输出“已经到期”；两条文本都使用 string 常量。',
    ['两个分支必须同类型、同 Bits 位宽。', 'Select 不执行分支节点，它只选择已经得到的值。']),
  nodePage('node-convert', '17 · 组合', 'Convert · 转换', '显式改变值类型，避免系统猜测转换意图。',
    [['in', '输入', 'value · any · 必需', '待转换值。'], ['out', '输出', 'value · 目标类型', '按配置输出。']],
    ['目标类型：number、boolean、string、bits。', '位宽：目标为 bits 时使用 1–64。'],
    '把 number 15 转成 Bits<8> 后再进入 8 位 ALU，输出为 0x0f。',
    ['转换失败会明确报错。', '改变 Bits 位宽时要考虑截断；精细位操作优先使用 Bits 节点。']),
  nodePage('node-bits', '18 · 组合', 'Bits · 位向量操作', '对固定宽度位向量进行移位、拼接、切片和改宽。',
    [['a', '输入', 'value · Bits · 必需', '主位向量。'], ['b', '输入', 'Bits/number', '移位量或 concat 的第二段。'], ['out', '输出', 'value · Bits', '处理后的位向量。']],
    ['操作：shift-left、shift-right、concat、slice、resize。', '起始位：slice 使用。', '输出位宽：slice 与 resize 使用。'],
    '从 8 位指令中 slice 出低 4 位，或把两个 4 位字段 concat 成一个 8 位值。',
    ['切片范围不能越过输入位宽。', '逻辑移位丢弃移出的位；resize 变窄会截断高位。']),
  nodePage('node-register', '19 · 状态', 'Register · 寄存器', '在 write Pulse 到来时同步采样 data，并持续输出最近一次保存的值。',
    [['data', '输入', 'value · any · 必需', '待采样值。'], ['write', '输入', 'event · Pulse · 多来源', '触发采样。'], ['reset', '输入', 'event · Pulse · 多来源', '恢复初始值。'], ['out', '输出', 'value · 初始值类型', '当前保存值。']],
    ['初始值：决定初始类型与 Bits 位宽。', '状态策略：reset 或 persist。'],
    '把 out 加一后反馈到 data，每个 Clock.tick 接 write，形成同步累加器。',
    ['data 类型必须匹配初始值。', '反馈必须经过 Register；纯组合反馈会形成非法循环。']),
  nodePage('node-counter', '20 · 状态', 'Counter · 计数器', '用 Pulse 对 number 或 Bits 状态执行加一、减一、装载和复位。',
    [['loadValue', '输入', 'value · number/Bits', 'load 时采样。'], ['inc / dec', '输入', 'event · Pulse · 多来源', '加一或减一。'], ['reset / load', '输入', 'event · Pulse · 多来源', '复位或装载。'], ['out', '输出', 'value · 初始值类型', '当前计数。']],
    ['初始值：number 或 Bits。', '溢出：wrap 回绕，saturate 停在边界。'],
    'Button.fire 接 inc 做人工计数；Clock.tick 接 inc 做程序计数器。',
    ['Bits Counter 按位宽决定上限。', 'loadValue 只有在 load Pulse 到来时才会写入。']),
  nodePage('node-edge-detector', '21 · 状态', 'Edge Detector · 边沿检测', '把持续 boolean 或 Bits<1> 的变化转换成精确 Pulse。',
    [['in', '输入', 'value · boolean/Bits<1> · 必需', '被观察状态。'], ['rise', '输出', 'event · Pulse', 'false→true。'], ['fall', '输出', 'event · Pulse', 'true→false。'], ['change', '输出', 'event · Pulse', '任意变化。']],
    ['无配置；可选择是否保留上次状态。'],
    '门窗 Toggle 从关闭变为打开时，rise 触发警报计数；change 接 Probe 留下所有变化记录。',
    ['初始化不会伪造边沿。', '多位 Bits 不能接入，先明确缩减为 Bits<1> 或 boolean。']),
  nodePage('node-timer', '22 · 状态', 'Timer · 计时器', '由 Pulse 控制正计时或倒计时，并输出时间、运行状态和完成事件。',
    [['preset', '输入', 'value · number', 'start 时覆盖本轮时长。'], ['start / pause / reset', '输入', 'event · Pulse · 多来源', '控制计时。'], ['time', '输出', 'value · number', '毫秒值。'], ['running', '输出', 'value · boolean', '是否运行。'], ['done', '输出', 'event · Pulse', '到达终点时一次触发。']],
    ['模式：countdown 或 countup。', '时长：1–359999000 ms。', '显示精度：16–60000 ms。'],
    '三个 Button 控制专注计时；running 接 Lamp，time 接 Monitor，done 接 Counter 统计完成轮数。',
    ['Timer 需要 Run 或 Step 推进。', '精度控制显示与边界，不应设得比实际需求更细。']),
  nodePage('node-monitor', '23 · 显示', 'Monitor · 监视器', '持续醒目显示一路稳定值，适合呈现最终结果。',
    [['in', '输入', 'value · any · 必需', '要显示的稳定值。']], ['无配置。'],
    '把 Select.out 接到 Monitor，直接显示折扣后的应付金额。',
    ['Monitor 不保存历史，也不能接 Pulse。', '需要逐次变化和事件来源时使用 Probe。']),
  nodePage('node-probe', '24 · 显示', 'Probe · 探针', '记录稳定值变化和多路 Pulse，提供有界运行轨迹。',
    [['value', '输入', 'value · any · 可选', '只在值真实变化时记录。'], ['pulse', '输入', 'event · Pulse · 可选 · 多来源', '每个事件都记录。']],
    ['轨迹上限：16–256，默认 64。', '轨迹只存在于运行时，不写入研究文档。'],
    '同时观察 Counter.out 与 Clock.tick，就能把数值变化和触发它的节拍对齐。',
    ['清空轨迹不改变电路，也不进入撤销历史。', '复位会清空轨迹并重建 t=0 值基线。']),
  nodePage('node-lamp', '25 · 显示', 'Lamp · 指示灯', '把 boolean 或 Bits 的真假状态变成一眼可见的亮灭反馈。',
    [['in', '输入', 'value · boolean/Bits · 必需', '零/false 熄灭，非零/true 点亮。']], ['无配置。'],
    'Compare 输出“仍未到期”接 Lamp，灯亮代表条件成立。',
    ['Lamp 只表达当前状态，不记录变化。', 'Pulse 不能直接点灯；先用 Counter、Register 或 Toggle 保存状态。']),
  nodePage('node-subcircuit', '26 · 模块', 'Subcircuit · 子电路', '把一组选中的节点封装为可复用、固定修订的模块实例。',
    [['动态端口', '输入/输出', 'value 或 Pulse', '由封装时跨越选区边界的导线生成。']],
    ['实例固定 definitionId 与 revision；端口来自该修订。', '只有连线仍兼容时才能手动升级到最新修订。'],
    '把一位全加器封装为 Full Adder，再放置多个实例搭建多位加法器；每个实例的内部状态相互隔离。',
    ['发布新修订不会自动改变旧实例。', '定义依赖必须无环且最多嵌套 32 层；删除仍被引用的修订会被拒绝。']),
];

const cases = [
  page('case-price-discount', 'cases', '27 · 实战', '价格与折扣计算', '用 Math 得到小计，用 Compare 判断门槛，再由 Select 选择原价或折后价。', [
    { title: '观察重点', body: '组合节点不需要 Run。修改单价、数量或门槛后，应付金额会立即更新。Select 的两个分支都保持 number，避免类型冲突。' },
    { title: '试验建议', body: '把数量从 3 改为 1，观察 Compare 从 true 变为 false，并确认 Monitor 回到未折扣小计。' },
  ], { exampleId: 'price-discount' }),
  page('case-deadline-reminder', 'cases', '28 · 实战', '截止时间提醒', 'Current Time 与动态生成的一小时后截止时间比较，Lamp 显示是否仍在期限内，Monitor 给出文本提示。', [
    { title: '观察重点', body: 'time 表示绝对时间戳。生成示例时截止值按当下时间计算，不会把教程编写时的旧日期写进画布。' },
    { title: '试验建议', body: '把截止常量改为早于当前时间，灯会熄灭，文本从“仍在期限内”切换为“已经到期”。' },
  ], { exampleId: 'deadline-reminder' }),
  page('case-click-counter', 'cases', '29 · 实战', '点击计数器', 'Button.fire 驱动 Counter.inc，另一个按钮负责 reset；Monitor 看结果，Probe 对齐点击与数值变化。', [
    { title: '观察重点', body: '即使页面暂停，Button 仍会完成一个事件批次。Counter 的变化是状态提交，不依赖节点摆放先后。' },
    { title: '试验建议', body: '连续点击“记一次”三次，再选中 Probe 查看三次 Pulse 和 0→1→2→3 的值轨迹。' },
  ], { exampleId: 'click-counter' }),
  page('case-change-tracker', 'cases', '30 · 实战', '状态变化记录', 'Toggle 表示当前门窗状态，Edge Detector 把每次开关变化转换为 Pulse，再交给 Counter 和 Probe。', [
    { title: '观察重点', body: '持续状态与瞬时事件各司其职：Lamp 直接看 Toggle，Counter 只接 change Pulse。' },
    { title: '试验建议', body: '来回切换四次，当前状态可能回到初始值，但变化次数会保留为 4。' },
  ], { exampleId: 'change-tracker' }),
  page('case-focus-timer', 'cases', '31 · 实战', '番茄计时器', '三个按钮控制 Timer，Lamp 表示运行中，Monitor 显示剩余毫秒，done Pulse 累加完成轮数。', [
    { title: '观察重点', body: '示例使用 10 秒便于验证；真实番茄钟可把 durationMs 改为 1500000。点击 Run 后时间才连续推进。' },
    { title: '试验建议', body: '开始后暂停，再用 Step 推进到下一个时间边界；完成时 Probe 应出现一条 done 事件。' },
  ], { exampleId: 'focus-timer' }),
  page('case-full-adder', 'cases', '32 · 实战', '一位全加器', '三个 boolean 输入经过 XOR、AND、OR 组合得到 SUM 与 CARRY，是理解组合逻辑的标准案例。', [
    { title: '观察重点', body: 'A、B、Cin 都为 true 时，SUM 为 true，CARRY 为 true。整个电路不含状态节点，因此输入变化会立即传播。' },
    { title: '试验建议', body: '逐个修改三个 Constant 的 boolean，核对八种输入组合的和位与进位。' },
  ], { exampleId: 'full-adder' }),
  page('case-alu', 'cases', '33 · 实战', '8 位 ALU', '同一对 Bits 输入同时执行加法与 XOR，再用 Compare 结果控制 Select 选择输出。', [
    { title: '观察重点', body: 'Math 与 Logic 都保持 Bits<8>；Compare 输出 boolean；Select 的两条数据分支仍是同位宽 Bits。默认 A > B，因此选择 ADD 分支，结果是 0x10（十进制 16）。' },
    { title: '试验建议', body: '交换 A、B 的大小，观察 Select 从 ADD 分支切到 XOR 分支。' },
  ], { exampleId: 'alu-8bit' }),
  page('case-program-counter', 'cases', '34 · 实战', '4 位累加器与程序计数器', 'Clock.tick 同步驱动 Register.write 与 Counter.inc，展示状态边界、反馈和同批提交。', [
    { title: '观察重点', body: 'Register.out 经过 Math +1 反馈到 data，但只有 tick 到来才写入；Counter 独立按 4 位回绕。' },
    { title: '试验建议', body: '保持暂停并反复点 Step。每步两个输出都增加一；从 0xF 再前进一步会回到 0x0。' },
  ], { exampleId: 'program-counter' }),
];

const advanced = [
  page('advanced-state', 'advanced', '35 · 进阶', '同步状态、反馈与执行顺序', '组合图按依赖拓扑计算；状态节点把上一时刻与下一时刻分开，使反馈既合法又确定。', [
    { title: '组合反馈为何报错', body: 'Math.out 直接回到自己的输入没有旧状态可读，会形成无法排序的组合环。把反馈穿过 Register，当前批次读取旧 out，批次末尾再提交新值。' },
    { title: '同步批次', body: '同一时刻多个 Pulse 先读取所有旧状态，再统一写入。不要用画布上的左右位置推测谁先执行；若需要先后时刻，应由不同 Clock/Timer 边界显式表达。' },
  ]),
  page('advanced-debug', 'advanced', '36 · 进阶', '用 Probe 和错误投影排查电路', '先确定错误属于缺输入、类型、拓扑、事件还是时间，再沿导线向上游缩小范围。', [
    { title: '稳定值排查', body: '在关键中间输出接 Probe.value，确认第一处偏离预期的值。缺输入保持 idle；真正错误会显示红色结果和原因。' },
    { title: '事件排查', body: '把多个 Pulse 来源接到 Probe.pulse，利用来源端口、仿真时间和序号判断事件是否发出、是否同批、是否送错状态端口。' },
    { title: '最小化问题', body: '暂停仿真，复位后用 Step 重现；暂时断开不相关分支，但不要把关系线误当作执行依赖。' },
  ]),
  page('advanced-persistence', 'advanced', '37 · 进阶', '状态保留与复位不是一回事', '状态节点默认在重开后恢复配置初值；只有显式选择 persist 才把离散状态写入研究文档。', [
    { title: '适合保留', body: '长期人工计数、跨会话进度或需要继续的计时器可以保留。纯实验电路通常使用 reset，保证每次打开从可重复初态开始。' },
    { title: '全局复位', body: 'Reset 无视保留策略，立即恢复所有初值，并让下一次保存覆盖旧 savedState。Probe 轨迹不持久化，复位后重建 t=0 基线。' },
  ]),
  page('advanced-subcircuits', 'advanced', '38 · 进阶', '子电路定义、修订与实例隔离', '封装会根据跨越选区边界的导线生成公开端口；实例固定到不可变修订，避免底层定义变化悄悄改变旧页面。', [
    { title: '发布与升级', body: '可以新建定义，也可以向现有定义发布新修订。旧实例不会自动升级；只有所有已连接端口仍兼容时，属性面板才允许手动升级。' },
    { title: '嵌套与状态', body: '子电路可以包含固定修订的其他实例，最多 32 层且依赖无环。每个实例拥有独立内部状态、事件、Probe 与持久状态树。' },
    { title: '删除规则', body: '页面或其他定义仍引用的修订不能删除。撤销页面上的“封装替换”会恢复原节点，但已发布定义仍会保留。' },
  ]),
  page('advanced-limits', 'advanced', '39 · 进阶', '安全预算与大型电路组织', '运行时限制单批 Pulse 和节点求值次数，目的是让错误反馈环停止在研究工作区内，而不是拖垮整个应用。', [
    { title: '预算', body: '每批最多处理 1000 个 Pulse、10000 次节点求值；超过后仿真暂停并给出可定位错误。连续仿真的画面更新会分帧合并，但模型与事件批次仍保持确定。' },
    { title: '组织大型电路', body: '先用 Probe 验证小块，再封装为子电路；让 Clock 周期和 Timer 精度符合真实需求；避免无意义的高频时钟与巨大扇出。' },
    { title: '性能不是执行语义', body: '缩放、页面切换和节点布局只影响显示。优化画面不会改变拓扑顺序、Pulse 顺序或状态提交结果。' },
  ]),
];

export const RESEARCH_TUTORIAL_CHAPTERS = Object.freeze([
  { id: 'intro', label: '入门', description: '先建立值、事件与运行控制的共同语言。' },
  { id: 'nodes', label: '节点', description: '逐一理解 20 种内建节点。' },
  { id: 'cases', label: '实战', description: '生成并拆解 8 套可运行节点群。' },
  { id: 'advanced', label: '进阶', description: '处理反馈、调试、持久状态与大型电路。' },
]);

export const RESEARCH_TUTORIAL_PAGES = Object.freeze([...intro, ...nodes, ...cases, ...advanced]);
