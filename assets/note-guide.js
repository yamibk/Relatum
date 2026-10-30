// On-demand syntax reference. It never edits a note or loads remote resources.
(function () {
  'use strict';
  let mermaidLoader = null;
  function loadMermaid() {
    if (window.RelatumNoteMermaid) return Promise.resolve(window.RelatumNoteMermaid);
    if (!mermaidLoader) mermaidLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'note-mermaid.js';
      const timer = setTimeout(() => finish(new Error('timeout')), 10000);
      function finish(error) {
        clearTimeout(timer); script.onload = script.onerror = null;
        if (error || !window.RelatumNoteMermaid) { script.remove(); reject(error || new Error('Mermaid unavailable')); }
        else resolve(window.RelatumNoteMermaid);
      }
      script.onload = () => finish(); script.onerror = () => finish(new Error('Mermaid unavailable')); document.head.append(script);
    }).catch(error => { mermaidLoader = null; throw error; });
    return mermaidLoader;
  }
  function create(options) {
    const { host } = options, positions = new Map();
    host.dataset.i18nManaged = 'true';
    let topic = '', renderedLanguage = '', active = false, sequence = 0, diagrams = null, quizzes = null, cardsControl = null, feedbackTimer = 0;
    const english = () => options.language() === 'en';
    const text = (zh, en) => english() ? en : zh;
    const current = () => active && options.isCurrent();
    const mermaidEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.mermaid');
    const quizEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.quiz');
    function heading(zh, en) { const title = document.createElement('h3'); title.textContent = text(zh, en); host.append(title); }
    function example(source, preview = source, detail = '', image = false) {
      const item = document.createElement('div'); item.className = 'note-guide-example';
      if (preview !== null) {
        const content = document.createElement('div'); content.className = 'node-text'; content.dataset.noteGuidePreview = 'true';
        if (image) {
          content.innerHTML = '<svg viewBox="0 0 260 90" role="img" aria-label="' + text('图片示例', 'Image example') + '" style="width:100%;border-radius:9px;background:rgba(128,128,128,.08)"><path d="m0 90 80-60 50 40 45-30 85 50" fill="currentColor" opacity=".16"/><circle cx="204" cy="23" r="10" fill="currentColor" opacity=".25"/></svg>';
        } else content.innerHTML = window.MarkdownMini.renderResult(preview, { noteBlocks: true, noteSyntax: true, localImages: true, mermaid: mermaidEnabled(), renderFence: options.renderFence || options.quizFence }).html;
        item.append(content);
      }
      if (detail) { const small = document.createElement('small'); small.textContent = detail; item.append(small); }
      const code = document.createElement('pre'); code.textContent = source;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-guide-copy';
      const label = text('复制语法', 'Copy syntax'); button.setAttribute('aria-label', label); button.dataset.uiTooltip = label;
      button.innerHTML = '<svg class="note-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#note-icon-copy"/></svg>';
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', async () => {
        let copied = false;
        try { await navigator.clipboard.writeText(source); copied = true; } catch (_) {
          await options.whenSettled?.();
          if (!current() || !button.isConnected) return;
          const focused = document.activeElement, selection = window.getSelection();
          const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
          const inputSelection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
          const area = document.createElement('textarea'); area.value = source; area.readOnly = true; area.style.cssText = 'position:fixed;left:-9999px;opacity:0'; document.body.append(area); area.select();
          try { copied = !!document.execCommand('copy'); } catch (_) {} area.remove();
          if (current()) {
            focused?.focus({ preventScroll: true });
            if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
            if (inputSelection) focused.setSelectionRange(...inputSelection);
          }
        }
        if (!current() || !button.isConnected) return;
        const feedback = copied ? text('语法已复制', 'Syntax copied') : text('语法复制失败', 'Could not copy syntax');
        button.setAttribute('aria-label', feedback); button.dataset.uiTooltip = feedback;
        clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { if (button.isConnected) { button.setAttribute('aria-label', label); button.dataset.uiTooltip = label; } }, 1800);
        options.notify?.(feedback, copied ? undefined : 'error');
      });
      item.append(code, button); host.append(item);
    }
    function callouts() {
      const catalog = window.MarkdownMini.noteBlockCatalog, body = text('Callout 正文。', 'Callout content.');
      const study = { definition: ['定义', 'Definition'], theorem: ['定理', 'Theorem'], proof: ['证明', 'Proof'], answer: ['答案', 'Answer'] };
      heading('Callout 与别名', 'Callouts and aliases');
      catalog.types.forEach(type => {
        const source = '> [!' + type.name + ']\n> ' + body;
        example(source, source, type.aliases.length ? text('别名：', 'Aliases: ') + type.aliases.join(', ') : study[type.name]?.[english() ? 1 : 0] || '');
      });
      heading('标题与折叠', 'Titles and folding');
      example('> [!gray] # 123\n> # 123', undefined, text('标记同一行是标题，只支持行内格式；下一行正文的 # 才是 Markdown 标题。', 'The marker line is an inline-formatted title; a heading belongs on a following body line.'));
      example('> [!note] ' + text('自定义标题', 'Custom title') + '\n> ' + body);
      ['+', '-'].forEach(suffix => example('> [!' + (suffix === '+' ? 'tip' : 'warning') + ']' + suffix + ' ' + (suffix === '+' ? text('默认展开', 'Expanded by default') : text('默认折叠', 'Collapsed by default')) + '\n> ' + body));
      heading('学习组合', 'Study combinations');
      example(text('> [!stone] 题干\n> 在这里填写题目。\n>\n> > [!answer]- 答案\n> > 在这里填写答案。', '> [!stone] Question\n> Write the question here.\n>\n> > [!answer]- Answer\n> > Write the answer here.'));
      const proof = text('> [!theorem] 定理\n> 在这里填写定理。\n>\n> > [!proof]- 证明\n> > 在这里填写证明。', '> [!theorem] Theorem\n> Write the theorem here.\n>\n> > [!proof]- Proof\n> > Write the proof here.');
      example(proof, proof, text('每嵌套一层，多写一个 > 前缀。', 'Each nested level adds another > prefix.'));
      heading('块公式', 'Display math');
      ['> [!info]\n> $$a^2+b^2$$\n> ' + body, '> [!info]\n> $$\n> a^2+b^2\n> $$\n> ' + body, '> [!info]\n> \\[\n> E=mc^2\n> \\]\n> ' + body].forEach(source => example(source, null));
      heading('纯色块', 'Color blocks');
      const colorBody = text('纯色块正文。', 'Color block content.');
      example('> [!white]\n> # ' + text('白色卡片', 'White card') + '\n>\n> **' + text('正文', 'Content') + '**', undefined, text('白底细边框，深色随主题适配；没有默认标题或图标。', 'White with a fine border; adapts to the dark theme, without a default title or icon.'));
      example('> [!white]\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |', undefined, text('表格每行保留 > 前缀，编辑仍属于当前色块。', 'Keep the > prefix on every table row; edits stay inside the color block.'));
      const titled = '> [!Lavender] ' + text('自定义标题', 'Custom title') + '\n> ' + colorBody;
      example(titled, titled, text('颜色名不区分大小写；没有 + 或 - 时不可折叠。', 'Color names are case-insensitive. Without + or -, blocks do not fold.'));
      ['+', '-'].forEach(suffix => {
        example('> [!blue]' + suffix + ' ' + (suffix === '+' ? text('默认展开', 'Expanded by default') : text('默认折叠', 'Collapsed by default')) + '\n> ' + colorBody);
        const source = '> [!blue]' + suffix + '\n> ' + colorBody;
        example(source, source, text('可折叠色块未写标题时显示颜色名；普通 [!blue] 仍然没有标题。', 'Foldable blocks without a title use the color name. Plain [!blue] remains titleless.'));
      });
      Object.entries({ cool: ['冷色', 'Cool'], green: ['绿色', 'Green'], warm: ['暖色', 'Warm'], pink: ['粉紫', 'Pink and purple'], neutral: ['中性', 'Neutral'] }).forEach(([group, names]) => {
        heading(...names); catalog.colors.filter(color => color.group === group).forEach(color => example('> [!' + color.name + ']\n> ' + colorBody));
      });
    }
    function markdown() {
      const samples = [
        ['标题', 'Headings', '# ' + text('一级标题', 'Heading one') + '\n\n## ' + text('二级标题', 'Heading two'), text('使用 1–6 个 #，后面留一个空格。', 'Use one to six # characters followed by a space.')],
        ['强调与标记', 'Emphasis and marks', text('**粗体** · *斜体* · ~~删除线~~ · ==高亮==', '**Bold** · *Italic* · ~~Deleted~~ · ==Highlight==')],
        ['彩色高亮', 'Highlight colors', text('==默认== · ==🔴红色== · ==🟠橙色== · ==🟡黄色== · ==🟢绿色== · ==🔵蓝色== · ==🟣紫色==', '==Default== · ==🔴Red== · ==🟠Orange== · ==🟡Yellow== · ==🟢Green== · ==🔵Blue== · ==🟣Purple==')],
        ['列表与任务', 'Lists and tasks', text('- 第一项\n- 第二项\n\n1. 有序项目\n2. 下一项\n\n- [ ] 待完成\n- [x] 已完成', '- First item\n- Second item\n\n1. Ordered item\n2. Next item\n\n- [ ] To do\n- [x] Completed')],
        ['引用', 'Quotes', '> ' + text('引用一段文字。', 'A quoted paragraph.')],
        ['链接与双链', 'Links and wiki links', text('[链接文字](https://example.com)\n\n[[笔记名称]]\n\n[[笔记名称#标题|显示名称]]', '[Link text](https://example.com)\n\n[[Note name]]\n\n[[Note name#Heading|Display name]]'), text('双链指向库内笔记；这里的预览只用于展示。', 'Wiki links point to notes in your library. This preview is only an example.')],
        ['图片', 'Images', text('![图片说明](图片.png)', '![Image description](image.png)'), text('相对路径从当前笔记所在目录查找。', 'Relative paths start in the current note’s folder.')],
        ['行内代码与代码块', 'Inline code and code blocks', '`const value = 1`\n\n```javascript\nconst value = 1;\n```'],
        ['表格', 'Tables', text('| 名称 | 说明 |\n| --- | --- |\n| Markdown | 笔记语法 |', '| Name | Description |\n| --- | --- |\n| Markdown | Note syntax |')],
        ['分隔线', 'Horizontal rules', text('上方内容\n\n---\n\n下方内容', 'Content above\n\n---\n\nContent below')],
        ['转义', 'Escaping', '\\*' + text('显示星号', 'Literal asterisks') + '\\*', text('在语法符号前加反斜杠，将它作为普通文字显示。', 'Add a backslash before a syntax character to display it as text.')],
      ];
      samples.forEach(([zh, en, source, detail]) => { heading(zh, en); example(source, source, detail, zh === '图片'); });
    }
    function mermaid() {
      const intro = document.createElement('p'); intro.textContent = text('将图表源码写在 mermaid 代码围栏内。复制后可直接粘贴到笔记。', 'Write diagrams inside a mermaid code fence. Copy an example and paste it into a note.'); host.append(intro);
      if (!mermaidEnabled()) { const notice = document.createElement('p'); notice.dataset.guideMermaidDisabled = 'true'; notice.textContent = text('本次启动未启用图表预览，仍可查看和复制源码。', 'Diagram previews are disabled for this session. You can still read and copy the source.'); host.append(notice); }
      const samples = [
        ['流程图', 'Flowchart', text('flowchart LR\n A[开始] --> B{完成了吗?}\n B -->|是| C[结束]\n B -->|否| A', 'flowchart LR\n A[Start] --> B{Done?}\n B -->|Yes| C[End]\n B -->|No| A')],
        ['时序图', 'Sequence diagram', text('sequenceDiagram\n participant A as 用户\n participant B as 笔记\n A->>B: 输入内容\n B-->>A: 保存完成', 'sequenceDiagram\n participant A as User\n participant B as Note\n A->>B: Write content\n B-->>A: Saved')],
        ['状态图', 'State diagram', 'stateDiagram-v2\n [*] --> Ready\n Ready --> Writing: start\n Writing --> Saved: save\n Saved --> [*]'],
        ['类图', 'Class diagram', 'classDiagram\n class Note {\n +String title\n +save()\n }\n Notebook "1" --> "*" Note'],
        ['关系图', 'Entity relationship diagram', 'erDiagram\n NOTEBOOK ||--o{ NOTE : contains\n NOTE {\n string title\n }'],
        ['甘特图', 'Gantt chart', text('gantt\n title 学习计划\n dateFormat YYYY-MM-DD\n section 阅读\n 基础 :a1, 2026-01-01, 3d\n 练习 :after a1, 2d', 'gantt\n title Study plan\n dateFormat YYYY-MM-DD\n section Reading\n Basics :a1, 2026-01-01, 3d\n Practice :after a1, 2d')],
        ['饼图', 'Pie chart', text('pie title 时间分配\n "阅读" : 40\n "练习" : 60', 'pie title Study time\n "Reading" : 40\n "Practice" : 60')],
        ['思维导图', 'Mind map', text('mindmap\n root((学习))\n  阅读\n   整理笔记\n  练习\n   复习', 'mindmap\n root((Study))\n  Reading\n   Notes\n  Practice\n   Review')],
      ];
      samples.forEach(([zh, en, source]) => { heading(zh, en); const fenced = '```mermaid\n' + source + '\n```'; example(fenced, mermaidEnabled() ? fenced : null); });
    }
    async function attachDiagrams() {
      if (!current() || topic !== 'mermaid' || !mermaidEnabled() || diagrams) return;
      const ticket = sequence;
      try {
        const adapter = await loadMermaid();
        if (ticket !== sequence || !current() || diagrams) return;
        diagrams = adapter.attach(host, { mode: 'reading', isCurrent: () => current() && topic === 'mermaid', whenSettled: options.whenSettled });
      } catch (_) {
        if (ticket !== sequence || !current()) return;
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'note-guide-retry'; retry.textContent = text('图表加载失败，点击重试', 'Diagram loading failed. Retry');
        retry.addEventListener('click', () => { retry.remove(); attachDiagrams(); }); host.prepend(retry);
      }
    }
    function quiz() {
      const intro = document.createElement('p'); intro.textContent = text('在 quiz 围栏中填写题干和选项。[x] 声明唯一正确答案，与普通任务列表不同：作答不会修改 Markdown。选择后显示答案和解析，可改选或重做。', 'Write a question and options inside a quiz fence. [x] declares the single correct answer. Unlike a task list, answering does not edit Markdown. Choose an option to see the answer and explanation, then change your answer or try again.'); host.append(intro);
      if (!quizEnabled()) { const notice = document.createElement('p'); notice.dataset.guideQuizDisabled = 'true'; notice.textContent = text('本次启动未启用选择题，仍可查看和复制源码。', 'Quizzes are disabled for this session. You can still read and copy the source.'); host.append(notice); }
      const samples = [
        ['基本单选题', 'Single choice', text('以下哪个数是偶数？\n\n- [ ] 3\n- [x] 4\n- [ ] 5\n\n---\n4 可以被 2 整除。', 'Which number is even?\n\n- [ ] 3\n- [x] 4\n- [ ] 5\n\n---\n4 is divisible by 2.')],
        ['公式与解析', 'Math and explanations', text('电压为 $12\\,V$、电阻为 $2\\,k\\Omega$ 时，电流是多少？\n\n- [ ] 0 mA\n- [x] 6 mA\n- [ ] 12 mA\n\n---\n由 $I=U/R=12/2000=0.006\\,A$ 得到。', 'With $12\\,V$ across a $2\\,k\\Omega$ resistor, what is the current?\n\n- [ ] 0 mA\n- [x] 6 mA\n- [ ] 12 mA\n\n---\n$I=U/R=12/2000=0.006\\,A$.')],
      ];
      samples.forEach(([zh, en, body]) => { heading(zh, en); const source = '```quiz\n' + body + '\n```'; example(source, quizEnabled() ? source : null); });
    }
    function attachQuizzes() {
      if (!current() || topic !== 'quiz' || !quizEnabled() || quizzes || !options.attachQuiz) return;
      quizzes = options.attachQuiz(host, { isolated: true, notePath: 'guide:quiz', isCurrent: () => current() && topic === 'quiz', whenSettled: options.whenSettled });
    }
    function cards() {
      const intro = document.createElement('p'); intro.textContent = text('在 cards 围栏中用 ### 写卡片标题，用独立一行 --- 分隔卡片。单击选中整组，双击或 Enter 编辑源码，Esc 收起；宽处两列，窄处一列。', 'Inside a cards fence, start each card with ### and separate cards with a line containing ---. Click to select, double-click or Enter to edit, and Esc to close. Cards use two columns when space allows.'); host.append(intro);
      heading('概念卡片', 'Concept cards');
      example('```cards\n' + text('### [book] 整理学习笔记\n用自己的话概括**核心概念**，记录疑问与实例。\n\n---\n\n### [target] 推进工作任务\n明确**下一步行动**，记录截止时间与预期成果。', '### [book] Organize study notes\nSummarize **key concepts** in your own words, and record questions and examples.\n\n---\n\n### [target] Move work forward\nDefine the **next action**, deadline and expected outcome.') + '\n```');
      heading('列表与公式', 'Lists and math');
      example('```cards\n' + text('### 本周计划\n- 阅读并整理一篇资料\n- 完成一项重要任务\n- 留出时间回顾与复盘\n\n完成进度：$3/5=60\\%$。\n\n[参考资料](https://example.com)', '### Weekly plan\n- Read and summarize one resource\n- Complete one important task\n- Set aside time to review and reflect\n\nProgress: $3/5=60\\%$.\n\n[Reference](https://example.com)') + '\n```');
      heading('可选图标', 'Optional icons');
      const names = document.createElement('p'); names.textContent = window.RelatumNoteCards.icons.join(' · '); host.append(names);
      const detail = document.createElement('p'); detail.textContent = text('标题前写 [图标名]，省略时不占位；未知名称显示为标题文字。支持段落、列表、强调、行内代码、普通链接和行内公式；不支持图片、表格、块公式或嵌套卡片。', 'Add [icon-name] before a title, or omit it. Unknown names remain title text. Supports paragraphs, lists, emphasis, inline code, regular links and inline math; images, tables, display math and nested cards are not supported.'); host.append(detail);
    }
    function suspend() { active = false; sequence++; clearTimeout(feedbackTimer); diagrams?.destroy(); diagrams = null; quizzes?.destroy(); quizzes = null; cardsControl?.destroy(); cardsControl = null; }
    function show(next) {
      active = true;
      const lang = options.language();
      if (topic !== next || renderedLanguage !== lang) {
        if (topic) positions.set(topic, host.scrollTop);
        sequence++; diagrams?.destroy(); diagrams = null; quizzes?.destroy(); quizzes = null; cardsControl?.destroy(); cardsControl = null; clearTimeout(feedbackTimer);
        topic = next; renderedLanguage = lang; host.replaceChildren(); host.dataset.language = lang; host.dataset.guideTopic = topic;
        const head = document.createElement('header'); head.className = 'note-guide-topic-head';
        const title = document.createElement('h3'); title.textContent = { callout: 'Callout', markdown: 'Markdown', mermaid: 'Mermaid', quiz: 'Quiz', cards: 'Cards' }[topic];
        const settings = document.createElement('button'); settings.type = 'button'; settings.dataset.noteAction = 'guide-settings'; settings.textContent = text('切换内容', 'Change topic'); head.append(title, settings); host.append(head);
        if (topic === 'markdown') markdown(); else if (topic === 'mermaid') mermaid(); else if (topic === 'quiz') quiz(); else if (topic === 'cards') cards(); else callouts();
        host.scrollTop = positions.get(topic) || 0;
      }
      attachDiagrams(); attachQuizzes();
      if (topic === 'cards' && !cardsControl && options.attachCards) cardsControl = options.attachCards(host, { isCurrent: () => current() && topic === 'cards', whenSettled: options.whenSettled });
    }
    function onClick(event) {
      // A tutorial never opens links or creates missing wiki-linked notes.
      if (event.target.closest('a, input[type="checkbox"]')) event.preventDefault();
      const button = event.target.closest('.note-callout-fold');
      if (button) { const body = button.closest('.md-callout').querySelector(':scope > .md-callout-body'); const collapsed = button.getAttribute('aria-expanded') === 'true'; if (body) body.hidden = collapsed; button.setAttribute('aria-expanded', String(!collapsed)); button.setAttribute('aria-label', collapsed ? text('展开', 'Expand') : text('折叠', 'Collapse')); }
    }
    host.addEventListener('click', onClick);
    return { show, suspend, destroy() { suspend(); host.removeEventListener('click', onClick); host.replaceChildren(); positions.clear(); } };
  }
  window.RelatumNoteGuide = Object.freeze({ create });
})();
