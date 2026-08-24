// 迷你 Markdown 解析器 — 阶段 3 A/B 轮 + STEM 增强轮
// 供画布节点正文与 MD 附件共用，故意写得小、零依赖：
//   块级：#–###### 标题、可嵌套的无序/有序/任务列表、空行分段、普通行 → 段落、
//        ``` / ~~~ 围栏代码块（带轻量语法高亮）、$$…$$ 块级公式、> 引用、
//        > [!type] Obsidian Callout、| | 表格、--- 分隔线
//   行内：**加粗** *斜体* _斜体_ __加粗__ `代码`、$…$ 公式、链接、高光、文字颜色、字号
//   不支持：图片
//
// 安全：所有用户文本经 escapeHtml 再进 DOM，杜绝 HTML 注入。
//
// 顺序很重要：先把 ```代码块``` / $$块公式$$ / $行内公式$ / 链接 抠成占位符（避免被
// markdown 行内规则破坏），再做块解析，最后回填。占位符用 ASCII 控制字符，markdown
// 规则不会碰到。
//
// 对外接口：window.MarkdownMini.render(src) → 一段 HTML 字串；
//           window.MarkdownMini.renderResult(src) → HTML + Math/Mermaid 特征。

(function (global) {
  'use strict';

  // Shared, DOM-free line grammar. The renderer and Notebook outline parser
  // deliberately consume the same recognizers so an incomplete construct can
  // never be accepted by one layer and rejected by the other.
  function normalizeSource(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  }

  function indentWidth(raw) {
    let width = 0;
    const value = String(raw || '');
    for (let i = 0; i < value.length; i++) width += value.charAt(i) === '\t' ? 4 : 1;
    return width;
  }

  function parseHeadingLine(line) {
    const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(String(line || ''));
    if (!match) return null;
    const content = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (!content) return null;
    return { level: match[1].length, text: content };
  }

  function parseListMarker(line) {
    const match = /^([ \t]*)([-+*]|(\d+)([.)]))(?:[ \t]+|$)(.*)$/.exec(String(line || ''));
    if (!match) return null;
    const content = match[5] || '';
    const taskMatch = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(content);
    const taskText = taskMatch ? (taskMatch[2] || '') : '';
    return {
      indentRaw: match[1],
      indent: indentWidth(match[1]),
      marker: match[2],
      ordered: !!match[3],
      number: match[3] ? Number(match[3]) : null,
      delimiter: match[4] || '',
      content: content,
      task: taskMatch ? taskMatch[1].toLowerCase() === 'x' : null,
      taskText: taskText,
      empty: taskMatch ? !taskText.trim() : !content.trim(),
    };
  }

  function parseFenceLine(line) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(String(line || ''));
    if (!match) return null;
    const marker = match[1];
    const info = (match[2] || '').trim();
    if (marker.charAt(0) === '`' && info.indexOf('`') >= 0) return null;
    return {
      marker: marker,
      char: marker.charAt(0),
      length: marker.length,
      info: info,
      language: (info.split(/\s+/, 1)[0] || '').toLowerCase(),
    };
  }

  function isFenceClose(line, fence) {
    if (!fence) return false;
    const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(String(line || ''));
    return !!(match
      && match[1].charAt(0) === fence.char
      && match[1].length >= fence.length);
  }

  function classifyLine(line) {
    const raw = String(line || '');
    const trimmed = raw.trim();
    if (!trimmed) return { type: 'blank' };
    const fence = parseFenceLine(raw);
    if (fence) return { type: 'fence', fence: fence };
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return { type: 'hr' };
    const heading = parseHeadingLine(raw);
    if (heading) return { type: 'heading', heading: heading };
    if (/^[ \t]{0,3}>\s?/.test(raw)) return { type: 'quote' };
    const list = parseListMarker(raw);
    if (list) return { type: list.empty ? 'incomplete-list' : 'list', list: list };
    if (/^\$\$(?:\s|$)/.test(trimmed)) return { type: 'math' };
    return { type: 'text' };
  }

  function scanFeatures(value) {
    const source = normalizeSource(value);
    const lines = source.split('\n');
    let mermaid = false;
    const visibleLines = [];
    for (let i = 0; i < lines.length; i++) {
      const fence = parseFenceLine(lines[i]);
      if (fence) {
        let close = i + 1;
        while (close < lines.length && !isFenceClose(lines[close], fence)) close++;
        if (close < lines.length) {
          if (/^(?:mermaid|flowchart|graph|flow|sequence|sequencediagram|timeline|gantt|class|classdiagram|state|statediagram|er|erdiagram|mindmap)$/.test(fence.language)) {
            mermaid = true;
          }
          for (let pad = i; pad <= close; pad++) visibleLines.push('');
          i = close;
          continue;
        }
      }
      visibleLines.push(lines[i].replace(/`+[^`]*`+/g, ''));
    }
    const visible = visibleLines.join('\n');
    const math = /\\\[[\s\S]+?\\\]/.test(visible)
      || /\\\([^\n]+?\\\)/.test(visible)
      || /(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$/.test(visible)
      || /(^|[^\\])\$[^$\n]+?(?<!\\)\$/m.test(visible)
      || /\\begin\{([^{}\s]+)\}[\s\S]+?\\end\{\1\}/.test(visible)
      || /\\(?:ref|eqref)\{[^{}\n]+\}/.test(visible);
    return { math: math, mermaid: mermaid };
  }

  const structure = {
    normalizeSource: normalizeSource,
    indentWidth: indentWidth,
    parseHeading: parseHeadingLine,
    parseListMarker: parseListMarker,
    parseFence: parseFenceLine,
    isFenceClose: isFenceClose,
    classifyLine: classifyLine,
    scanFeatures: scanFeatures,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 行内处理：顺序很重要——先 code（避免 ** 在反引号里被错误识别），再 bold，再 italic
  // 注意：输入 s 已经被 escapeHtml 过，里面没有真正的 < >
  function renderInline(s) {
    // 行内代码：`xxx` → <code>xxx</code>
    s = s.replace(/`([^`\n]+)`/g, function (_, m) {
      return '<code>' + m + '</code>';
    });
    // 删除线：~~xxx~~
    s = s.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    // 加粗：**xxx** 或 __xxx__（惰性匹配 → 允许里面再嵌一层斜体）
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
    // 斜体：*xxx* 或 _xxx_（避开已经被 strong 处理掉的连续星号）
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    // 高光（荧光笔）：==文字== 默认黄；彩色高光用 {hl:red|文字}。
    // 放在最后处理，可包住前面已生成的 <strong>/<em>/<code>（它们不含 = 号）。
    s = s.replace(/==([^=\n]+?)==/g, '<mark data-hl="yellow">$1</mark>');
    // 增强样式显式带命名空间：{hl:red|...} / {tc:red|...} / {fs:lg|...}。
    // 支持嵌套；逐轮从最内层向外包，工具栏规范顺序为 hl > tc > fs。
    for (let pass = 0; pass < 6; pass++) {
      const before = s;
      s = s.replace(/\{fs:(sm|lg|xl)\|([^{}\n]+?)\}/g, function (_, size, txt) {
        return '<span class="md-size" data-fs="' + size + '">' + txt + '</span>';
      });
      s = s.replace(/\{tc:(yellow|orange|red|purple|blue|cyan|green|gray|white)\|([^{}\n]+?)\}/g, function (_, color, txt) {
        return '<span class="md-color" data-tc="' + color + '">' + txt + '</span>';
      });
      s = s.replace(/\{hl:(yellow|orange|red|purple|blue|cyan|green|gray)\|([^{}\n]+?)\}/g, function (_, color, txt) {
        return '<mark data-hl="' + color + '">' + txt + '</mark>';
      });
      if (s === before) break;
    }
    return s;
  }

  // 给画布上的轻量文字框复用同一套安全行内语法。内部 renderInline 接收的是
  // 已转义文本；对外包装必须先 escape，不能让文字框绕过 MarkdownMini 的安全边界。
  function renderInlineSafe(src) {
    return renderInline(escapeHtml(String(src == null ? '' : src)));
  }

  // ── 围栏代码块 ``` ───────────────────────────────
  // 已知会着色的语言；text/plain/output/无语言 → 只等宽渲染，不着色（尊重用户的 ```text 图解块）。
  const CODE_LANGS = {};
  ('c h cpp c++ cc cxx hpp hxx java js javascript jsx mjs ts typescript tsx '
    + 'py python cs csharp go golang rs rust php swift kotlin kt scala m objc dart '
    + 'matlab octave').split(' ').forEach(function (k) { CODE_LANGS[k] = true; });
  const CODE_KW = {};
  ('if else for while do switch case default break continue return goto sizeof typedef '
    + 'static const volatile extern register inline auto include define ifdef ifndef undef endif pragma '
    + 'new delete class public private protected virtual override template typename namespace using friend operator '
    + 'try catch throw import from as def lambda pass elif in is and or not with yield async await '
    + 'func package var let fn match impl trait mut where move ref interface implements extends '
    + 'struct union enum '
    // MATLAB / Octave
    + 'function end elseif otherwise global persistent endfunction endif endfor endwhile '
    // Python 补充
    + 'nonlocal raise except finally assert del print').split(' ').forEach(function (k) { CODE_KW[k] = true; });
  const CODE_TYPE = {};
  ('int char float double long short unsigned signed bool void string size_t ssize_t ptrdiff_t '
    + 'wchar_t FILE int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t '
    + 'boolean byte object String Boolean Integer Double Float Number self this super '
    + 'nullptr NULL null true false True False None nil undefined').split(' ').forEach(function (k) { CODE_TYPE[k] = true; });

  // 轻量语法高亮：对原始代码做一次扫描（注释 / 字符串 / 数字 / 标识符），逐段 escape 后着色。
  // 在原始码上 tokenize（而非已 escape 的串），避免引号被转成 &quot; 干扰字符串匹配。
  // 注释风格按语言区分：MATLAB/Octave 用 %（含 %{ %} 块）；其余（C/Java/Python/JS…）用 // /* */ #。
  const RE_TOK_DEFAULT = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\w.]*\b)|([A-Za-z_]\w*)/g;
  const RE_TOK_MATLAB = /(%\{[\s\S]*?%\}|%[^\n]*)|("(?:[^"\n])*"|'(?:[^'\n])*')|(\b\d[\w.]*\b)|([A-Za-z_]\w*)/g;
  function highlightCode(code, lang) {
    const matlab = lang === 'matlab' || lang === 'octave' || lang === 'm';
    const re = matlab ? RE_TOK_MATLAB : RE_TOK_DEFAULT;
    re.lastIndex = 0;
    let out = '', last = 0, m;
    while ((m = re.exec(code)) !== null) {
      out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += '<span class="tok-com">' + escapeHtml(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tok-str">' + escapeHtml(m[2]) + '</span>';
      else if (m[3]) out += '<span class="tok-num">' + escapeHtml(m[3]) + '</span>';
      else {
        const w = m[4];
        const cls = CODE_KW[w] ? 'tok-kw' : (CODE_TYPE[w] ? 'tok-typ' : null);
        out += cls ? ('<span class="' + cls + '">' + escapeHtml(w) + '</span>') : escapeHtml(w);
      }
      last = re.lastIndex;
      if (m.index === re.lastIndex) re.lastIndex++;   // 防空匹配死循环
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function protectCode(src) {
    const codes = [];
    const lines = normalizeSource(src).split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
      const fence = parseFenceLine(lines[i]);
      if (!fence) {
        output.push(lines[i]);
        continue;
      }
      let close = i + 1;
      while (close < lines.length && !isFenceClose(lines[close], fence)) close++;
      // An unfinished fence is editable plain text, never a block that consumes
      // the rest of the document.
      if (close >= lines.length) {
        output.push(lines[i]);
        continue;
      }
      codes.push({ lang: fence.language, code: lines.slice(i + 1, close).join('\n') });
      output.push('\x00CODE' + (codes.length - 1) + '\x00');
      for (let pad = i + 1; pad <= close; pad++) output.push('');
      i = close;
    }
    return { protected: output.join('\n'), codes: codes };
  }
  function restoreCode(html, codes) {
    if (!codes.length) return html;
    return html.replace(/\x00CODE(\d+)\x00/g, function (_, idx) {
      const b = codes[+idx];
      if (!b) return '';
      if (b.lang === 'derive') return renderDerive(b.code);   // 推导链围栏
      // Mermaid 围栏只产出安全的源码容器；统一渲染器负责补全简写、排队和错误展示。
      // template 让源码随批注净快照保存但不进入正文字符偏移；pre 是渲染器启动前的可见兜底。
      if (/^(?:mermaid|flowchart|graph|flow|sequence|sequencediagram|timeline|gantt|class|classdiagram|state|statediagram|er|erdiagram|mindmap)$/.test(b.lang)) {
        return '<div class="mermaid-diagram" data-mermaid-lang="' + escapeHtml(b.lang) + '">'
          + '<template class="mermaid-source">' + escapeHtml(b.code) + '</template>'
          + '<pre class="mermaid-fallback">' + escapeHtml(b.code) + '</pre></div>';
      }
      const inner = CODE_LANGS[b.lang] ? highlightCode(b.code, b.lang) : escapeHtml(b.code);
      const label = b.lang ? ' data-lang="' + escapeHtml(b.lang) + '"' : '';
      return '<pre class="md-code"' + label + '><code>' + inner + '</code></pre>';
    });
  }

  // 推导链 ```derive：每行「公式 || 说明」（分隔符认 || 或 ‖），渲染成竖排——
  // 左侧步号、中间公式（\displaystyle 行内公式，由节点 typesetMath 排版）、右侧步骤说明，步骤间 ↓ 连接。
  // 是纯渲染层语法：源码仍是普通 Markdown 围栏块，可正常导出、向后兼容（旧版当代码块显示也不崩）。
  function renderDerive(code) {
    const steps = [];
    String(code).split('\n').forEach(function (raw) {
      if (raw.trim() === '') return;
      const parts = raw.split(/\s*(?:‖|\|\|)\s*/);   // ‖ 或 ||
      const expr = (parts[0] || '').trim();
      const note = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
      steps.push({ expr: expr, note: note });
    });
    if (!steps.length) return '';
    let html = '<div class="md-derive">';
    steps.forEach(function (s, idx) {
      html += '<div class="md-derive-step">'
        + '<span class="md-derive-num">' + (idx + 1) + '</span>'
        + '<span class="md-derive-eq">' + (s.expr ? '\\(\\displaystyle ' + escapeHtml(s.expr) + '\\)' : '') + '</span>'
        + (s.note ? '<span class="md-derive-note">' + renderInline(escapeHtml(s.note)) + '</span>' : '')
        + '</div>';
    });
    return html + '</div>';
  }

  // ── 数学公式：先抠 $$块$$ 再抠 $行内$（占位符回填时再 escape，MathJax 读 textContent 会 decode）──
  function protectMath(src) {
    const maths = [];
    let s = src.replace(/\\\[([\s\S]+?)\\\]/g, function (m, content) {
      maths.push({ content: content, delimiter: 'bracket-block' });
      const nl = (m.match(/\n/g) || []).length;
      return '\x00DMATH' + (maths.length - 1) + '\x00' + (nl ? '\n'.repeat(nl) : '');
    });
    s = s.replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, function (m, content) {
      maths.push({ content: content, delimiter: 'dollar-block' });
      // 同 protectCode：占位符补足等量换行，保住多行 $$…$$ 之后内容的源码行号（修点击定位错位）
      const nl = (m.match(/\n/g) || []).length;
      return '\x00DMATH' + (maths.length - 1) + '\x00' + (nl ? '\n'.repeat(nl) : '');   // 块级（独占一行 → 居中展示）
    });
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, function (_, content) {
      maths.push({ content: content, delimiter: 'paren-inline' });
      return '\x00MATH' + (maths.length - 1) + '\x00';
    });
    s = s.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, function (_, content) {
      maths.push({ content: content, delimiter: 'dollar-inline' });
      return '\x00MATH' + (maths.length - 1) + '\x00';     // 行内
    });
    return { protected: s, maths: maths };
  }
  function restoreMath(html, maths) {
    if (maths.length === 0) return html;
    html = html.replace(/\x00DMATH(\d+)\x00/g, function (_, idx) {
      const item = maths[+idx];
      if (!item) return '';
      const content = escapeHtml(item.content);
      return '<div class="md-math-block">'
        + (item.delimiter === 'bracket-block' ? '\\[' + content + '\\]' : '$$' + content + '$$')
        + '</div>';
    });
    return html.replace(/\x00MATH(\d+)\x00/g, function (_, idx) {
      const item = maths[+idx];
      if (!item) return '';
      const content = escapeHtml(item.content);
      return item.delimiter === 'paren-inline' ? '\\(' + content + '\\)' : '$' + content + '$';
    });
  }

  function protectEscapes(src) {
    const chars = [];
    const protectedSource = String(src || '').replace(/\\([\\`*${}\[\]()#+\-.!_>~|])/g, function (_, char) {
      chars.push(char);
      return '\x00ESC' + (chars.length - 1) + '\x00';
    });
    return { protected: protectedSource, chars: chars };
  }

  function restoreEscapes(html, chars) {
    if (!chars.length) return html;
    return html.replace(/\x00ESC(\d+)\x00/g, function (_, idx) {
      return escapeHtml(chars[+idx] || '');
    });
  }

  // ── C2 轮：外部链接 ─────────────────────────────
  // 功能性小图标（非装饰）：url=外链箭头，file=文档。currentColor 跟随文字色。
  const LINK_ICON_URL = '<svg class="node-link-icon" viewBox="0 0 16 16" width="11" height="11"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 3h4v4M13 3l-6 6M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5"/></svg>';
  const LINK_ICON_FILE = '<svg class="node-link-icon" viewBox="0 0 16 16" width="11" height="11"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/>'
    + '<path d="M9 2v4h4"/></svg>';

  // 抠出链接：markdown [文字](目标) + 裸 http(s):// URL → \x00LINK<N>\x00 占位符。
  function protectLinks(src) {
    const links = [];
    let s = src.replace(/(^|[^\\])\[([^\]\n]+)\]\(([^)\n]+)\)/g, function (_, prefix, text, target) {
      links.push({ text: text.trim(), target: target.trim() });
      return prefix + '\x00LINK' + (links.length - 1) + '\x00';
    });
    s = s.replace(/https?:\/\/[\w\-._~:/?#@!$&'()*+,;=%\[\]]+/g, function (url) {
      links.push({ text: url, target: url });
      return '\x00LINK' + (links.length - 1) + '\x00';
    });
    return { protected: s, links: links };
  }
  function restoreLinks(html, links) {
    if (links.length === 0) return html;
    return html.replace(/\x00LINK(\d+)\x00/g, function (_, idx) {
      const link = links[+idx];
      const isUrl = /^https?:\/\//i.test(link.target);
      const icon = isUrl ? LINK_ICON_URL : LINK_ICON_FILE;
      return '<a class="node-link" data-kind="' + (isUrl ? 'url' : 'file') + '"'
        + ' data-href="' + escapeHtml(link.target) + '"'
        + ' title="' + escapeHtml(link.target) + '">'
        + icon + '<span class="node-link-text">' + escapeHtml(link.text) + '</span></a>';
    });
  }

  // 笔记工作区显式启用的本地图片占位。这里绝不写入 src，也不解析远程 URL；
  // 调用方必须把 data-note-image 交给受后端路径沙箱保护的本地图片接口。
  // 其它 Markdown 消费者不传 localImages，继续保持原先“不生成 img”的安全行为。
  function protectLocalImages(src, enabled) {
    const images = [];
    if (!enabled) return { protected: src, images: images };
    let s = src.replace(/!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, function (_, target, alias) {
      images.push({ target: target.trim(), alt: (alias || '').trim() });
      return '\x00NIMAGE' + (images.length - 1) + '\x00';
    });
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, function (_, alt, rawTarget) {
      let target = rawTarget.trim();
      if (target.charAt(0) === '<' && target.charAt(target.length - 1) === '>') {
        target = target.slice(1, -1).trim();
      }
      // 当前笔记上传器生成不含空格的相对路径；兼容常见的可选图片 title。
      const titled = /^(\S+)[ \t]+(?:"[^"]*"|'[^']*')$/.exec(target);
      if (titled) target = titled[1];
      images.push({ target: target, alt: alt.trim() });
      return '\x00NIMAGE' + (images.length - 1) + '\x00';
    });
    return { protected: s, images: images };
  }

  function restoreLocalImages(html, images) {
    if (!images.length) return html;
    return html.replace(/\x00NIMAGE(\d+)\x00/g, function (_, idx) {
      const item = images[+idx];
      if (!item) return '';
      const target = escapeHtml(item.target);
      const alt = escapeHtml(item.alt || item.target.split('/').pop() || '');
      return '<span class="md-local-image" data-note-image-wrap="' + target + '">'
        + '<img data-note-image="' + target + '" alt="' + alt + '" loading="lazy" decoding="async">'
        + '<span class="md-local-image-fallback">' + alt + '</span></span>';
    });
  }

  // ── 双链 [[名字]] / [[名字|别名]]：画布内跳转（实际解析在 canvas.js，这里只渲染成可点链接）──
  const LINK_ICON_WIKI = '<svg class="node-link-icon" viewBox="0 0 16 16" width="11" height="11"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M6 3.5H4.2A1.7 1.7 0 0 0 2.5 5.2v5.6A1.7 1.7 0 0 0 4.2 12.5H6M10 3.5h1.8A1.7 1.7 0 0 1 13.5 5.2v5.6a1.7 1.7 0 0 1-1.7 1.7H10"/></svg>';
  function protectWikiLinks(src) {
    const wikis = [];
    const s = src.replace(/(^|[^\\])\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, function (_, prefix, name, alias) {
      wikis.push({ name: name.trim(), alias: (alias || '').trim() });
      return prefix + '\x00WIKI' + (wikis.length - 1) + '\x00';
    });
    return { protected: s, wikis: wikis };
  }
  function restoreWikiLinks(html, wikis) {
    if (!wikis.length) return html;
    return html.replace(/\x00WIKI(\d+)\x00/g, function (_, idx) {
      const w = wikis[+idx];
      if (!w) return '';
      const label = w.alias || w.name;
      return '<a class="node-wikilink" data-wikilink="' + escapeHtml(w.name) + '"'
        + ' title="跳转到《' + escapeHtml(w.name) + '》">'
        + LINK_ICON_WIKI + '<span class="node-link-text">' + escapeHtml(label) + '</span></a>';
    });
  }

  // ── Obsidian Callout 图标（功能性小图标）──────────
  const CALLOUT_ICONS = {
    note: 'M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z|M9 2v4h4|M6 9h4M6 11h3',
    info: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M8 7v4|M8 5h0.01',
    tip: 'M8 1.5a4.5 4.5 0 0 1 2.7 8.1V11a1 1 0 0 1-1 1H6.3a1 1 0 0 1-1-1V9.6A4.5 4.5 0 0 1 8 1.5z|M6.5 14h3',
    warning: 'M8 2 1.5 13.5h13L8 2z|M8 6.5v3.5|M8 12h0.01',
    danger: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M5.5 5.5l5 5M10.5 5.5l-5 5',
    success: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M5 8l2 2 4-4',
    question: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.5-.7 1.1|M8 11.5h0.01',
    quote: 'M5 5H3.5A1.5 1.5 0 0 0 2 6.5v3A1.5 1.5 0 0 0 3.5 11H5l-1.5 2.5|M12.5 5H11a1.5 1.5 0 0 0-1.5 1.5v3A1.5 1.5 0 0 0 11 11h1.5L11 13.5',
    example: 'M4 2h6l3 3v9H4z|M10 2v3h3|M6 8.5h5M6 11h5',
    bug: 'M5 6a3 3 0 0 1 6 0v3a3 3 0 0 1-6 0z|M8 3.5V2M2.5 7H5M11 7h2.5M2.5 11H5M11 11h2.5',
    abstract: 'M4 2h8v12H4z|M6 5.5h4M6 8h4M6 10.5h2.5',
  };
  // Obsidian 别名 → 标准类型
  const CALLOUT_ALIAS = {
    summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', faq: 'question',
    help: 'question', check: 'success', done: 'success', caution: 'warning', attention: 'warning',
    fail: 'danger', failure: 'danger', missing: 'danger', error: 'danger', cite: 'quote',
    todo: 'info', infobox: 'info',
  };
  const CALLOUT_LABEL = {
    note: '笔记', info: '信息', tip: '提示', warning: '注意', danger: '危险', success: '成功',
    question: '疑问', quote: '引用', example: '示例', bug: '缺陷', abstract: '摘要',
  };
  function calloutIcon(type) {
    const paths = (CALLOUT_ICONS[type] || CALLOUT_ICONS.note).split('|');
    const body = paths.map(function (d) { return '<path d="' + d + '"/>'; }).join('');
    return '<svg class="md-callout-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"'
      + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true">' + body + '</svg>';
  }

  // ── 表格 ───────────────────────────────
  function splitTableRow(line) {
    if (global.MarkdownTable && typeof global.MarkdownTable.splitRow === 'function') {
      return global.MarkdownTable.splitRow(line);
    }
    let t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map(function (c) { return c.trim(); });
  }
  function isTableSep(line) {
    if (global.MarkdownTable && typeof global.MarkdownTable.isSeparatorLine === 'function') {
      return global.MarkdownTable.isSeparatorLine(line);
    }
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
  }
  function tableAlign(cell) {
    const l = cell.charAt(0) === ':';
    const r = cell.charAt(cell.length - 1) === ':';
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  }

  // 大纲常用 2 或 4 空格缩进。按相对缩进建树，不锁死空格数，
  // 同时允许有序、无序与任务列表在不同层级混用。
  function parseListBlock(lines, start, topLevel) {
    const root = { children: [] };
    const stack = [];
    let i = start;
    while (i < lines.length) {
      const marker = parseListMarker(lines[i]);
      if (!marker || marker.empty) break;
      const indent = marker.indent;
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      let parent = root;
      if (stack.length) {
        const tail = stack[stack.length - 1];
        if (tail.indent < indent) parent = tail.item;
        else stack.pop();
      }
      if (parent === root && stack.length) parent = stack[stack.length - 1].item;
      const item = {
        ordered: marker.ordered,
        text: marker.task == null ? marker.content : marker.taskText,
        task: marker.task,
        line: i,
        children: [],
      };
      parent.children.push(item);
      stack.push({ indent: indent, item: item });
      i++;
    }

    function renderChildren(items) {
      let html = '';
      let index = 0;
      while (index < items.length) {
        const ordered = items[index].ordered;
        const tag = ordered ? 'ol' : 'ul';
        html += '<' + tag + '>';
        while (index < items.length && items[index].ordered === ordered) {
          const item = items[index++];
          const lineAttr = topLevel ? (' data-ln="' + item.line + '"') : '';
          const taskClass = item.task == null ? '' : ' class="md-task-item"';
          const taskBox = item.task == null ? ''
            : ('<span class="md-task-box" aria-hidden="true">' + (item.task ? '✓' : '') + '</span>');
          html += '<li' + taskClass + lineAttr + '>' + taskBox
            + renderInline(escapeHtml(item.text))
            + (item.children.length ? renderChildren(item.children) : '')
            + '</li>';
        }
        html += '</' + tag + '>';
      }
      return html;
    }

    return { html: renderChildren(root.children), end: i };
  }

  function renderParagraphLines(lines) {
    let html = '';
    lines.forEach(function (raw, index) {
      let value = String(raw || '');
      const hardBreak = /(?: {2,}|\\)$/.test(value);
      if (hardBreak) value = value.replace(/(?: {2,}|\\)$/, '');
      html += renderInline(escapeHtml(value));
      if (index < lines.length - 1) html += hardBreak ? '<br>' : '\n';
    });
    return html;
  }

  // ── 块解析：在"已抠占位符"的文本上做行级解析，返回带占位符的 HTML（占位符在最外层统一回填）──
  // topLevel=true 时给块加 data-ln（源码行号，供节点阅读浮层反查）；递归（引用/callout 内）不加。
  function parseBlocks(text, topLevel) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    let previousIndex = -1;
    let iterations = 0;
    const maxIterations = Math.max(64, lines.length * 4 + 16);
    const ln = function (n) { return topLevel ? (' data-ln="' + n + '"') : ''; };

    while (i < lines.length) {
      if (++iterations > maxIterations) {
        while (i < lines.length) {
          out.push('<p' + ln(i) + ' class="md-parse-fallback">'
            + renderInline(escapeHtml(lines[i])) + '</p>');
          i++;
        }
        break;
      }
      if (i === previousIndex) {
        out.push('<p' + ln(i) + ' class="md-parse-fallback">'
          + renderInline(escapeHtml(lines[i])) + '</p>');
        i++;
        previousIndex = -1;
        continue;
      }
      previousIndex = i;
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === '') { i++; continue; }

      // 代码块占位符（独占一行）→ 直接透传，最外层 restoreCode 换成 <pre>
      if (/^\x00CODE\d+\x00$/.test(trimmed)) { out.push(trimmed); i++; continue; }
      // 块级公式占位符（独占一行）→ 居中块
      if (/^\x00DMATH\d+\x00$/.test(trimmed)) { out.push(trimmed); i++; continue; }

      // 分隔线：--- *** ___（整行）
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push('<hr class="md-hr">'); i++; continue; }

      // 标题 #–######：保留真实 h1–h6 语义，紧凑程度交由容器 CSS 变量控制。
      let m;
      const heading = parseHeadingLine(line);
      if (heading) {
        const tag = 'h' + heading.level;
        out.push('<' + tag + ln(i) + '>' + renderInline(escapeHtml(heading.text)) + '</' + tag + '>');
        i++;
        continue;
      }

      // 引用 / Callout：连续的 > 行
      if (/^>\s?/.test(trimmed)) {
        const buf = [];
        const startLn = i;
        while (i < lines.length && /^\s*>\s?/.test(lines[i]) && lines[i].trim() !== '') {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const head = /^\[!(\w+)\]([+-]?)\s*(.*)$/.exec(buf[0] || '');
        if (head) {
          let type = head[1].toLowerCase();
          type = CALLOUT_ALIAS[type] || (CALLOUT_ICONS[type] ? type : 'note');
          const title = head[3].trim() || CALLOUT_LABEL[type] || head[1];
          const bodyHtml = parseBlocks(buf.slice(1).join('\n'), false);
          out.push('<div class="md-callout" data-callout="' + type + '"' + ln(startLn) + '>'
            + '<div class="md-callout-title">' + calloutIcon(type)
            + '<span>' + renderInline(escapeHtml(title)) + '</span></div>'
            + (bodyHtml ? '<div class="md-callout-body">' + bodyHtml + '</div>' : '')
            + '</div>');
        } else {
          out.push('<blockquote' + ln(startLn) + '>' + parseBlocks(buf.join('\n'), false) + '</blockquote>');
        }
        continue;
      }

      // 表格：当前行含 | 且下一行是分隔行
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const tableStartLine = i;
        const parsed = global.MarkdownTable && typeof global.MarkdownTable.parseLines === 'function'
          ? global.MarkdownTable.parseLines(lines, i, { ensureBodyRow: false })
          : null;
        const header = parsed && parsed.ok ? parsed.model.header : splitTableRow(lines[i]);
        const aligns = parsed && parsed.ok
          ? parsed.model.align
          : splitTableRow(lines[i + 1]).map(tableAlign);
        let bodyRows;
        if (parsed && parsed.ok) {
          bodyRows = parsed.model.rows;
          i = parsed.endLine;
        } else {
          i += 2;
          bodyRows = [];
          while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0
                 && !/^\x00(CODE|DMATH)\d+\x00$/.test(lines[i].trim())) {
            bodyRows.push(splitTableRow(lines[i]));
            i++;
          }
        }
        const cellStyle = function (idx) { return aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : ''; };
        let html = '<div class="md-scroll-x" data-md-table-ln="' + tableStartLine
          + '"><table class="md-table"><thead><tr>';
        header.forEach(function (c, idx) { html += '<th' + cellStyle(idx) + '>' + renderInline(escapeHtml(c)) + '</th>'; });
        html += '</tr></thead><tbody>';
        bodyRows.forEach(function (row) {
          html += '<tr>';
          for (let k = 0; k < header.length; k++) {
            html += '<td' + cellStyle(k) + '>' + renderInline(escapeHtml(row[k] || '')) + '</td>';
          }
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }

      // 有序 / 无序 / 任务列表：连续缩进行组成一棵安全的嵌套列表。
      const listMarker = parseListMarker(line);
      if (listMarker && !listMarker.empty) {
        const parsedList = parseListBlock(lines, i, topLevel);
        if (parsedList.end > i) {
          out.push(parsedList.html);
          i = parsedList.end;
          continue;
        }
      }

      // 段落：吃掉连续的非空、非块级行；普通换行保留源码换行，双空格或反斜杠才是硬换行。
      const paraStart = i;
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])
             && !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) out.push('<p' + ln(paraStart) + '>' + renderParagraphLines(para) + '</p>');
    }
    return out.join('');
  }

  function isBlockStart(line) {
    const t = line.trim();
    if (/^\x00(CODE|DMATH)\d+\x00$/.test(t)) return true;
    const kind = classifyLine(line).type;
    return kind === 'heading'
      || kind === 'list'
      || kind === 'quote'
      || kind === 'hr'
      || kind === 'fence'
      || kind === 'math';
  }

  function renderResult(src) {
    const source = normalizeSource(src);
    if (!source) return { html: '', features: { math: false, mermaid: false }, error: false };
    const features = scanFeatures(source);
    const options = arguments.length > 1 ? arguments[1] : null;
    const opts = options && typeof options === 'object' ? options : {};
    try {
      const codeGuard = protectCode(source);
      const imageGuard = protectLocalImages(codeGuard.protected, opts.localImages === true);
      const wikiGuard = protectWikiLinks(imageGuard.protected);   // 先抠 [[双链]]（早于 [文字](url)）
      const linkGuard = protectLinks(wikiGuard.protected);
      const mathGuard = protectMath(linkGuard.protected);
      const escapeGuard = protectEscapes(mathGuard.protected);
      let html = parseBlocks(escapeGuard.protected, true);
      html = restoreMath(html, mathGuard.maths);
      html = restoreLinks(html, linkGuard.links);
      html = restoreWikiLinks(html, wikiGuard.wikis);
      html = restoreLocalImages(html, imageGuard.images);
      html = restoreEscapes(html, escapeGuard.chars);
      html = restoreCode(html, codeGuard.codes);
      return { html: html, features: features, error: false };
    } catch (error) {
      return {
        html: '<p class="md-parse-fallback">' + escapeHtml(source).replace(/\n/g, '<br>') + '</p>',
        features: features,
        error: true,
      };
    }
  }

  function render(src, options) {
    return renderResult(src, options).html;
  }

  // ── Y2 轮：标记符号区间（给编辑态实时高亮用）────────────
  // 在原始源码上算出"应该变浅灰的标记符号"的字符区间 [start, end)（end 不含）。
  // 偏移基于原始 text 的字符位置（含 \n），和 contenteditable 的 textContent 偏移一致。
  // 只标"定界符本身"，中间内容保持原色。
  function markIntervals(text) {
    const out = [];
    const lines = String(text).split('\n');
    let base = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // 行首标题 #{1,6}+空格
      let m = /^(#{1,6})\s/.exec(line);
      if (m) out.push([base, base + m[1].length]);
      // 行首无序列表 - * +（允许前导空格）
      m = /^(\s*)([-*+])\s/.exec(line);
      if (m) {
        const p = base + m[1].length;
        out.push([p, p + 1]);
      }
      // 行首有序列表 1. 2. …
      m = /^(\s*)(\d+[.)])\s/.exec(line);
      if (m) {
        const p = base + m[1].length;
        out.push([p, p + m[2].length]);
      }
      // 行内成对定界符：**bold**、`code`、$math$
      collectPair(line, base, /\*\*([^*\n]+?)\*\*/g, 2, out);
      collectPair(line, base, /`([^`\n]+?)`/g, 1, out);
      collectPair(line, base, /\$([^$\n]+?)\$/g, 1, out);
      // 行内高光 ==文字==：淡化开头与结尾 ==
      let hm; const hre = /==([^=\n]+?)==/g; hre.lastIndex = 0;
      while ((hm = hre.exec(line)) !== null) {
        const sAbs = base + hm.index;
        const eAbs = sAbs + hm[0].length;
        out.push([sAbs, sAbs + 2]);
        out.push([eAbs - 2, eAbs]);
        if (hm.index === hre.lastIndex) hre.lastIndex++;
      }
      // 高光 / 文字颜色 / 字号：支持标记互相嵌套，淡化每一层开头与配对的结尾。
      collectStyledTags(line, base, out);
      base += line.length + 1; // +1 = 这一行末尾的 \n
    }
    return out;
  }

  // 把成对定界符（长 markLen，如 ** 是 2、` 是 1）的两端区间塞进 out
  function collectPair(line, base, re, markLen, out) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const startAbs = base + m.index;
      const endAbs = startAbs + m[0].length;
      out.push([startAbs, startAbs + markLen]);     // 前定界符
      out.push([endAbs - markLen, endAbs]);          // 后定界符
      if (m.index === re.lastIndex) re.lastIndex++;  // 防空匹配死循环
    }
  }

  function collectStyledTags(line, base, out) {
    const re = /\{(?:hl:(?:yellow|orange|red|purple|blue|cyan|green|gray)|tc:(?:yellow|orange|red|purple|blue|cyan|green|gray|white)|fs:(?:sm|lg|xl))\|/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      let depth = 1;
      for (let i = re.lastIndex; i < line.length; i++) {
        if (line[i] === '{') depth++;
        else if (line[i] === '}') {
          depth--;
          if (depth === 0) {
            out.push([base + m.index, base + m.index + m[0].length]);
            out.push([base + i, base + i + 1]);
            break;
          }
        }
      }
    }
  }

  global.MarkdownMini = {
    render: render,
    renderResult: renderResult,
    renderInline: renderInlineSafe,
    escapeHtml: escapeHtml,
    highlightCode: highlightCode,
    markIntervals: markIntervals,
    structure: structure,
  };
})(window);
