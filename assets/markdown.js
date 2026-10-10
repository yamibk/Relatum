// 迷你 Markdown 解析器 — 阶段 3 A/B 轮 + STEM 增强轮
// 供画布节点正文与 MD 附件共用，故意写得小、零依赖：
//   块级：#–###### 标题、可嵌套的无序/有序/任务列表、空行分段、普通行 → 段落、
//        ``` / ~~~ 围栏代码块（带轻量语法高亮）、$$…$$ 块级公式、> 引用、
//        > [!type] Obsidian Callout、| | 表格、--- 分隔线
//   行内：**加粗** *斜体* _斜体_ __加粗__ `代码`、$…$ 公式、链接、高光、文字颜色、字号
//   图片：仅在调用方显式传入 localImages:true 时生成受控的本地图片占位。
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

  function frontmatter(source) {
    const opener = /^\uFEFF?---\r?\n/.exec(source);
    if (!opener) return null;
    const close = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(source.slice(opener[0].length, 65536));
    return close ? { from: 0, to: opener[0].length + close.index + close[0].length } : null;
  }

  function tagRanges(source) {
    const text = String(source || '');
    const blocked = [];
    const header = frontmatter(text);
    if (header) blocked.push(header);
    let fence = null, offset = 0;
    text.split('\n').forEach((line) => {
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        blocked.push({ from: offset, to: offset + line.length });
        if (new RegExp('^[ \\t]{0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*\\r?$').test(line)) fence = null;
      } else if (marker) { fence = marker[1]; blocked.push({ from: offset, to: offset + line.length }); }
      else if (/^(?: {4}|\t)/.test(line)) blocked.push({ from: offset, to: offset + line.length });
      offset += line.length + 1;
    });
    // Mask before recognizing the next construct: comment/formula markers in
    // code must never pair with unrelated markers in the following prose.
    const mask = (value, ranges) => {
      let cursor = 0; const parts = [];
      ranges.sort((a, b) => a.from - b.from).forEach((range) => {
        if (range.to <= cursor) return;
        const from = Math.max(cursor, range.from);
        parts.push(value.slice(cursor, from), value.slice(from, range.to).replace(/[^\r\n]/g, ' ')); cursor = range.to;
      });
      parts.push(value.slice(cursor)); return parts.join('');
    };
    let visible = mask(text, blocked);
    const guard = (regex) => { visible = visible.replace(regex, (match) => match.replace(/[^\r\n]/g, ' ')); };
    guard(/(`+)[^`\n]*\1/g);
    guard(/<!--[\s\S]*?(?:-->|(?![\s\S]))|%%[\s\S]*?(?:%%|(?![\s\S]))/g);
    visible = mask(visible, mathRanges(visible));
    guard(/<[^>\n]*>|!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\((?:\\.|[^()\n]|\([^()]*\))*\)|https?:\/\/\S+|^[ \t]{0,3}\[[^\]\n]+\]:.*/gm);
    const result = [];
    for (const match of visible.matchAll(/#([\p{L}\p{M}\p{N}\p{So}\p{Sk}_/\-\u200d]+)/gu)) {
      const from = match.index, to = from + match[0].length;
      const before = visible[from - 1] || '';
      if (/[\p{L}\p{M}\p{N}_/#!]/u.test(before) || escapedAtSource(visible, from)) continue;
      const tag = match[1].normalize('NFC');
      if (/^\p{Nd}+$/u.test(tag) || tag.split('/').some((part) => !part)) continue;
      result.push({ from, to, tag });
    }
    return result;
  }

  function mathRanges(source) {
    const result = [];
    const regex = /\\\[([\s\S]+?)\\\]|(?<!\$)\$\$([\s\S]+?)\$\$(?!\$)|\\\(([^\n]+?)\\\)|(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
    for (const match of String(source || '').matchAll(regex)) {
      if (escapedAtSource(source, match.index)) continue;
      const display = match[1] != null || match[2] != null;
      const open = match[0].slice(0, display || match[3] != null ? 2 : 1);
      const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
      const end = match.index + match[0].length;
      if (escapedAtSource(source, end - close.length)) continue;
      result.push({ from: match.index, to: end, body: match[1] ?? match[2] ?? match[3] ?? match[4], display, open, close });
    }
    return result;
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
      const quote = quoteLine(lines[i]);
      const fence = parseFenceLine(quote.text);
      if (fence) {
        let close = i + 1;
        while (close < lines.length && quoteLine(lines[close]).depth >= quote.depth && !isFenceClose(stripQuote(lines[close], quote.depth), fence)) close++;
        if (close < lines.length && isFenceClose(stripQuote(lines[close], quote.depth), fence)) {
          if (/^(?:mermaid|flowchart|graph|flow|sequence|sequencediagram|timeline|gantt|class|classdiagram|state|statediagram|er|erdiagram|mindmap)$/.test(fence.language)) {
            mermaid = true;
          }
          for (let pad = i; pad <= close; pad++) visibleLines.push('');
          i = close;
          continue;
        }
        break; // An unfinished code fence remains code while typing.
      }
      visibleLines.push(/^(?: {4}|\t)/.test(quote.text) ? '' : lines[i].replace(/`+[^`]*`+/g, ''));
    }
    const visible = visibleLines.join('\n').replace(/<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?(?:%%|$)/g, '');
    const math = mathRanges(visible).length > 0
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

  const MAX_IMAGE_DIMENSION = 8192;
  const IMAGE_TEXT_PREFIX = '<!--relatum:image-text:v';
  const IMAGE_TEXT_SUFFIX = '-->';
  const IMAGE_TEXT_VERSION = 1;
  const MAX_IMAGE_TEXT_ITEMS = 64;
  const MAX_IMAGE_TEXT_LENGTH = 1000;
  const MAX_IMAGE_TEXT_BYTES = 48 * 1024;
  const IMAGE_TEXT_SIZES = new Set(['sm', 'md', 'lg', 'xl', 'xxl', 'xxxl']);
  const IMAGE_TEXT_COLORS = new Set([
    'black', 'white', 'yellow', 'orange', 'red', 'purple', 'blue', 'cyan', 'green', 'gray',
  ]);
  const IMAGE_TEXT_COMMENT_RE = /[ \t]+<!--relatum:image-text:v(\d+):([A-Za-z0-9_-]+)-->[ \t]*$/;

  function isRemoteImageTarget(target) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(target || '').trim());
  }

  function closingBracket(text, start, open, close) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === '\\') { index += 1; continue; }
      if (text[index] === open) depth += 1;
      else if (text[index] === close) {
        depth -= 1;
        if (!depth) return index;
      }
    }
    return -1;
  }

  function escapedAtSource(text, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
    return slashes % 2 === 1;
  }

  function parseImageDimensions(value) {
    const match = /^([1-9]\d*)(?:[xX]([1-9]\d*))?$/.exec(String(value || '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = match[2] ? Number(match[2]) : null;
    if (!Number.isSafeInteger(width) || width > MAX_IMAGE_DIMENSION
        || (height != null && (!Number.isSafeInteger(height) || height > MAX_IMAGE_DIMENSION))) return null;
    return { width: width, height: height };
  }

  function splitImageLabel(rawLabel) {
    const value = String(rawLabel || '');
    const pipe = value.lastIndexOf('|');
    if (pipe >= 0) {
      const dimensions = parseImageDimensions(value.slice(pipe + 1));
      if (dimensions) return { rawAlt: value.slice(0, pipe).trim(), dimensions: dimensions };
    }
    const dimensions = parseImageDimensions(value);
    return dimensions ? { rawAlt: '', dimensions: dimensions } : { rawAlt: value.trim(), dimensions: null };
  }

  function parseImageDestination(rawDestination) {
    const source = String(rawDestination || '').trim();
    const angle = /^<([^>\n]+)>(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?$/.exec(source);
    if (angle) return { target: angle[1].trim(), title: angle[2] != null ? angle[2] : (angle[3] || '') };
    const titled = /^(\S+)[ \t]+(?:"([^"]*)"|'([^']*)')$/.exec(source);
    if (titled) return { target: titled[1], title: titled[2] != null ? titled[2] : (titled[3] || '') };
    return { target: source, title: '' };
  }

  // Parse one complete image token (optional surrounding horizontal whitespace included).
  // Numeric labels follow Obsidian's pixel sizing convention; non-numeric pipes remain alt text.
  function parseImage(source) {
    const value = String(source || '');
    const leading = /^[ \t]*/.exec(value)[0];
    const trailing = /[ \t]*$/.exec(value)[0];
    const token = value.slice(leading.length, value.length - trailing.length);
    if (token.indexOf('\n') >= 0) return null;

    if (token.startsWith('![[') && token.endsWith(']]')) {
      const inner = token.slice(3, -2);
      const pipe = inner.indexOf('|');
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      if (!target) return null;
      const label = splitImageLabel(pipe >= 0 ? inner.slice(pipe + 1) : '');
      return {
        source: value, syntax: 'wiki', leading: leading, trailing: trailing,
        target: target, rawAlt: label.rawAlt,
        alt: label.rawAlt.replace(/\\([\\\[\]])/g, '$1').trim(),
        title: '', rawDestination: '',
        width: label.dimensions ? label.dimensions.width : null,
        height: label.dimensions ? label.dimensions.height : null,
      };
    }

    if (!token.startsWith('![')) return null;
    const labelEnd = closingBracket(token, 1, '[', ']');
    if (labelEnd < 0 || token[labelEnd + 1] !== '(') return null;
    const targetEnd = closingBracket(token, labelEnd + 1, '(', ')');
    if (targetEnd < 0 || token.slice(targetEnd + 1).trim()) return null;
    const label = splitImageLabel(token.slice(2, labelEnd));
    const destination = parseImageDestination(token.slice(labelEnd + 2, targetEnd));
    if (!destination.target) return null;
    return {
      source: value, syntax: 'markdown', leading: leading, trailing: trailing,
      target: destination.target, rawAlt: label.rawAlt,
      alt: label.rawAlt.replace(/\\([\\\[\]])/g, '$1').trim(),
      title: destination.title, rawDestination: token.slice(labelEnd + 2, targetEnd),
      width: label.dimensions ? label.dimensions.width : null,
      height: label.dimensions ? label.dimensions.height : null,
    };
  }

  function markdownImageDestination(target) {
    const value = String(target || '');
    return /[\s()]/.test(value) ? '<' + value + '>' : value;
  }

  // Type recognition belongs to the existing Markdown layer, so a disabled
  // canvas can remain literal without loading any optional script or asset.
  function isCanvasImage(parsed) {
    if (!parsed || parsed.syntax !== 'markdown') return false;
    try { return /\.canvas$/i.test(decodeURIComponent(parsed.target)); } catch (_) { return false; }
  }
  function canvasTarget(note, target) {
    try {
      const value = decodeURIComponent(target).normalize('NFC');
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(value) || value.includes('\\')) return '';
      const parts = note.split('/').slice(0, -1);
      for (const part of value.split('/')) { if (part === '..') { if (!parts.length) return ''; parts.pop(); } else if (part && part !== '.') parts.push(part); }
      return parts.length === 2 && parts[0].toLowerCase() === 'canvases' && /\.canvas$/i.test(parts[1]) ? 'canvases/' + parts[1] : '';
    } catch (_) { return ''; }
  }
  function canvasReferences(source) {
    const refs = [], header = frontmatter(String(source)); let fence = '', html = false, htmlComment = false, percentComment = false, offset = 0;
    String(source).split(/(?<=\n)/).forEach((original, index) => {
      const line = original.replace(/[\r\n]+$/, ''), trimmed = line.trim(), marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!header || offset >= header.to) {
        if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''; }
        else if (html) { if (htmlComment && line.includes('-->') || !htmlComment && !trimmed) html = htmlComment = false; }
        else if (percentComment) { if ((line.match(/%%/g) || []).length % 2) percentComment = false; }
        else if (marker) fence = marker[1];
        else if (line.includes('%%')) percentComment = !!((line.match(/%%/g) || []).length % 2);
        else if (line.includes('<!--') || /^ {0,3}<[A-Za-z/!?]/.test(line)) {
          if (line.includes('<!--')) html = htmlComment = !line.slice(line.indexOf('<!--') + 4).includes('-->');
          else html = !!trimmed;
        } else if (/^ {0,3}!\[/.test(line)) {
          const parsed = parseImage(line);
          if (isCanvasImage(parsed)) refs.push({ from: offset, to: offset + line.length, parsed });
        }
      }
      offset += original.length;
    });
    return refs;
  }
  function rewriteCanvasReferences(source, note, renamed, newNote) {
    const changes = [];
    canvasReferences(source).forEach(ref => {
      const old = canvasTarget(note, ref.parsed.target); if (!old) return;
      const key = Object.keys(renamed || {}).find(key => key.toLowerCase() === old.toLowerCase());
      const target = key ? renamed[key] : old; if (!key && (!newNote || newNote === note)) return;
      const directories = (newNote || note).split('/').slice(0, -1), parts = target.split('/');
      while (directories.length && parts.length && directories[0].toLowerCase() === parts[0].toLowerCase()) { directories.shift(); parts.shift(); }
      const relative = '../'.repeat(directories.length) + parts.map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
      const parsed = Object.assign({}, ref.parsed);
      const oldName = old.split('/').pop(), newName = target.split('/').pop();
      let value = parsed.source;
      const labelEnd = closingBracket(value, parsed.leading.length + 1, '[', ']');
      const targetAt = value.indexOf(parsed.target, labelEnd + 2);
      value = value.slice(0, targetAt) + relative + value.slice(targetAt + parsed.target.length);
      let replacement = null;
      if (key && parsed.alt.toLowerCase() === oldName.toLowerCase()) replacement = newName;
      else if (key && parsed.alt.toLowerCase() === oldName.slice(0, -7).toLowerCase()) replacement = newName.slice(0, -7);
      if (replacement !== null) {
        const labelAt = parsed.leading.length + 2;
        const label = value.slice(labelAt, labelEnd), size = /\|[1-9]\d*(?:[xX][1-9]\d*)?$/.exec(label);
        value = value.slice(0, labelAt) + replacement.replace(/[\\\[\]]/g, '\\$&') + (size ? size[0] : '') + value.slice(labelEnd);
      }
      changes.push({ from: ref.from, to: ref.to, insert: value });
    });
    let value = source;
    changes.reverse().forEach(change => { value = value.slice(0, change.from) + change.insert + value.slice(change.to); });
    return value;
  }

  function serializeImage(parsed, dimensions) {
    if (!parsed || !parsed.target) return '';
    const width = Number(dimensions && dimensions.width);
    const height = dimensions && dimensions.height != null ? Number(dimensions.height) : null;
    if (!Number.isSafeInteger(width) || width < 1 || width > MAX_IMAGE_DIMENSION
        || (height != null && (!Number.isSafeInteger(height) || height < 1 || height > MAX_IMAGE_DIMENSION))) {
      return String(parsed.source || '');
    }
    const size = String(width) + (height == null ? '' : ('x' + height));
    const leading = String(parsed.leading || '');
    const trailing = String(parsed.trailing || '');
    const rawAlt = String(parsed.rawAlt || '');
    if (parsed.syntax === 'wiki' && !rawAlt) {
      return leading + '![[' + parsed.target + '|' + size + ']]' + trailing;
    }
    const destination = parsed.syntax === 'markdown' && parsed.rawDestination
      ? parsed.rawDestination : markdownImageDestination(parsed.target);
    const label = rawAlt ? (rawAlt + '|' + size) : size;
    return leading + '![' + label + '](' + destination + ')' + trailing;
  }

  function base64UrlEncodeUtf8(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlDecodeUtf8(value) {
    const source = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = source + '==='.slice((source.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function normalizeImageTextItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const keys = Object.keys(raw).sort().join(',');
    if (keys !== 'color,id,size,text,x,y') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n') : '';
    const x = raw.x;
    const y = raw.y;
    const size = raw.size;
    const color = raw.color;
    if (!id || id.length > 80 || !text.trim() || text.length > MAX_IMAGE_TEXT_LENGTH
        || !Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1
        || !IMAGE_TEXT_SIZES.has(size) || !IMAGE_TEXT_COLORS.has(color)) return null;
    return { id: id, text: text, x: x, y: y, size: size, color: color };
  }

  function decodeImageTextPayload(encoded) {
    try {
      const json = base64UrlDecodeUtf8(encoded);
      if (new TextEncoder().encode(json).length > MAX_IMAGE_TEXT_BYTES) return null;
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)
          || Object.keys(parsed).length !== 1 || parsed.items.length > MAX_IMAGE_TEXT_ITEMS) return null;
      const items = parsed.items.map(normalizeImageTextItem);
      if (items.some(function (item) { return !item; })) return null;
      if (new Set(items.map(function (item) { return item.id; })).size !== items.length) return null;
      return items;
    } catch (error) {
      return null;
    }
  }

  // A standalone note image may carry one versioned, same-line annotation comment.
  // The returned object stays flat for existing image consumers while exposing the
  // original image token and normalized text items to the note editor.
  function parseImageBlock(source) {
    const value = String(source || '');
    if (value.indexOf('\n') >= 0) return null;
    const metadata = IMAGE_TEXT_COMMENT_RE.exec(value);
    const imageSource = metadata ? value.slice(0, metadata.index) : value;
    const image = parseImage(imageSource);
    if (!image) return null;
    let metadataStatus = 'none';
    let items = [];
    if (metadata) {
      const version = Number(metadata[1]);
      if (isRemoteImageTarget(image.target)) metadataStatus = 'ineligible';
      else if (version !== IMAGE_TEXT_VERSION) metadataStatus = 'unsupported';
      else {
        const decoded = decodeImageTextPayload(metadata[2]);
        if (decoded) { metadataStatus = 'valid'; items = decoded; }
        else metadataStatus = 'invalid';
      }
    }
    return Object.assign({}, image, {
      source: value,
      imageSource: imageSource,
      image: image,
      imageTextItems: items,
      metadataStatus: metadataStatus,
      imageTextEditable: metadataStatus === 'none' || metadataStatus === 'valid',
      metadataSource: metadata ? metadata[0] : '',
    });
  }

  function serializeImageBlock(parsed, items, replacementImageSource) {
    if (!parsed || parsed.imageTextEditable === false) return String(parsed && parsed.source || '');
    const normalized = Array.isArray(items) ? items.map(normalizeImageTextItem) : [];
    if (normalized.some(function (item) { return !item; }) || normalized.length > MAX_IMAGE_TEXT_ITEMS) {
      return String(parsed.source || '');
    }
    const imageSource = String(replacementImageSource == null ? parsed.imageSource || parsed.source || '' : replacementImageSource);
    if (!normalized.length) return imageSource;
    const json = JSON.stringify({ items: normalized });
    if (new TextEncoder().encode(json).length > MAX_IMAGE_TEXT_BYTES) return String(parsed.source || '');
    const trailing = /[ \t]*$/.exec(imageSource)[0];
    const core = imageSource.slice(0, imageSource.length - trailing.length);
    return core + ' ' + IMAGE_TEXT_PREFIX + IMAGE_TEXT_VERSION + ':' + base64UrlEncodeUtf8(json)
      + IMAGE_TEXT_SUFFIX + trailing;
  }

  function imageTextVisibleSource(source) {
    return String(source || '').split('\n').map(function (line) {
      const block = parseImageBlock(line);
      if (block && block.metadataStatus !== 'none') {
        if (block.metadataStatus === 'ineligible') return line;
        const text = block.metadataStatus === 'valid'
          ? block.imageTextItems.map(function (item) { return item.text; }).join('\n') : '';
        return block.imageSource + (text ? ('\n' + text) : '');
      }
      return line;
    }).join('\n');
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

  function protectCode(src, noteBlocks) {
    const codes = [];
    const lines = normalizeSource(src).split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
      const quote = quoteLine(lines[i]);
      const fence = parseFenceLine(quote.text);
      if (!fence) {
        if (noteBlocks && /^(?: {4}|\t)/.test(quote.text)) {
          let close = i + 1;
          while (close < lines.length && quoteLine(lines[close]).depth >= quote.depth && /^(?: {4}|\t)/.test(stripQuote(lines[close], quote.depth))) close++;
          codes.push({ lang: '', code: lines.slice(i, close).map(line => stripQuote(line, quote.depth).replace(/^(?: {4}|\t)/, '')).join('\n') });
          output.push(quote.prefix + '\x00CODE' + (codes.length - 1) + '\x00');
          for (let pad = i + 1; pad < close; pad++) output.push(quote.prefix);
          i = close - 1; continue;
        }
        output.push(lines[i]);
        continue;
      }
      let close = i + 1;
      while (close < lines.length && quoteLine(lines[close]).depth >= quote.depth && !isFenceClose(stripQuote(lines[close], quote.depth), fence)) close++;
      // An unfinished fence is editable plain text, never a block that consumes
      // the rest of the document.
      if (close >= lines.length || !isFenceClose(stripQuote(lines[close], quote.depth), fence)) {
        if (noteBlocks) {
          codes.push({ lang: '', code: lines.slice(i + 1, close).map(line => stripQuote(line, quote.depth)).join('\n') });
          output.push(quote.prefix + '\x00CODE' + (codes.length - 1) + '\x00');
          for (let pad = i + 1; pad < close; pad++) output.push(quote.prefix);
          i = close - 1; continue;
        }
        output.push(lines[i]);
        continue;
      }
      codes.push({ lang: fence.language, code: lines.slice(i + 1, close).map((line) => stripQuote(line, quote.depth)).join('\n') });
      output.push(quote.prefix + '\x00CODE' + (codes.length - 1) + '\x00');
      for (let pad = i + 1; pad <= close; pad++) output.push(quote.prefix);
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

  function protectInlineCode(src) {
    const codes = [];
    const protectedSource = String(src || '').replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return '\x00ICODE' + (codes.length - 1) + '\x00';
    });
    return { protected: protectedSource, codes: codes };
  }

  function restoreInlineCode(html, codes) {
    if (!codes.length) return html;
    return html.replace(/\x00ICODE(\d+)\x00/g, function (_, idx) {
      return '<code>' + escapeHtml(codes[+idx] || '') + '</code>';
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
  function protectMath(src, preserveLines, noteBlocks) {
    const ranges = mathRanges(src);
    const maths = [];
    let s = '', cursor = 0;
    ranges.forEach((range) => {
      s += src.slice(cursor, range.from);
      const lineStart = src.lastIndexOf('\n', range.from - 1) + 1;
      const quote = quoteLine(src.slice(lineStart, range.from));
      const content = range.display && quote.depth ? range.body.split('\n').map((line, index) => index ? stripQuote(line, quote.depth) : line).join('\n') : range.body;
      maths.push({ content, raw: !!(noteBlocks && range.display && range.to - range.from > 32768), delimiter: range.open === '\\[' ? 'bracket-block' : range.open === '\\(' ? 'paren-inline' : range.display ? 'dollar-block' : 'dollar-inline' });
      const nl = preserveLines === false || !range.display ? 0 : (src.slice(range.from, range.to).match(/\n/g) || []).length;
      s += '\x00' + (range.display ? 'DMATH' : 'MATH') + (maths.length - 1) + '\x00' + ('\n' + quote.prefix).repeat(nl);
      cursor = range.to;
    });
    s += src.slice(cursor);
    return { protected: s, maths: maths };
  }
  function restoreMath(html, maths) {
    if (maths.length === 0) return html;
    html = html.replace(/\x00DMATH(\d+)\x00/g, function (_, idx) {
      const item = maths[+idx];
      if (!item) return '';
      const content = escapeHtml(item.content);
      if (item.raw) return '<pre class="md-math-source"><code>' + (item.delimiter === 'bracket-block' ? '\\[' + content + '\\]' : '$$' + content + '$$') + '</code></pre>';
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

  const COMMONMARK_ESCAPABLE = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(''));

  function protectEscapes(src) {
    const chars = [];
    const protectedSource = String(src || '').replace(/\\([^\r\n])/g, function (match, char) {
      if (!COMMONMARK_ESCAPABLE.has(char)) return match;
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
      const isUrl = /^(?:https?:\/\/|mailto:)/i.test(link.target);
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
    const source = String(src || '');
    let output = '';
    let cursor = 0;
    while (cursor < source.length) {
      if (source[cursor] !== '!' || source[cursor + 1] !== '[' || escapedAtSource(source, cursor)) {
        output += source[cursor++];
        continue;
      }
      let end = -1;
      if (source[cursor + 2] === '[') {
        const close = source.indexOf(']]', cursor + 3);
        const newline = source.indexOf('\n', cursor + 3);
        if (close >= 0 && (newline < 0 || close < newline)) end = close + 2;
      } else {
        const labelEnd = closingBracket(source, cursor + 1, '[', ']');
        if (labelEnd >= 0 && source[labelEnd + 1] === '(') {
          const targetEnd = closingBracket(source, labelEnd + 1, '(', ')');
          if (targetEnd >= 0 && source.slice(cursor, targetEnd + 1).indexOf('\n') < 0) end = targetEnd + 1;
        }
      }
      if (end < 0) {
        output += source[cursor++];
        continue;
      }
      let parsed = parseImage(source.slice(cursor, end));
      if (!parsed) {
        output += source[cursor++];
        continue;
      }
      const lineStart = source.lastIndexOf('\n', cursor - 1) + 1;
      const lineBreak = source.indexOf('\n', end);
      const lineEnd = lineBreak < 0 ? source.length : lineBreak;
      if (!source.slice(lineStart, cursor).trim()) {
        const block = parseImageBlock(source.slice(lineStart, lineEnd));
        if (block && block.metadataStatus !== 'none' && block.metadataStatus !== 'ineligible') {
          parsed = block;
          end = lineEnd;
        }
      }
      images.push(parsed);
      output += '\x00NIMAGE' + (images.length - 1) + '\x00';
      cursor = end;
    }
    return { protected: output, images: images };
  }

  function restoreLocalImages(html, images) {
    if (!images.length) return html;
    return html.replace(/\x00NIMAGE(\d+)\x00/g, function (_, idx) {
      const item = images[+idx];
      if (!item) return '';
      if (isCanvasImage(item)) return escapeHtml(item.source);
      const target = escapeHtml(item.target);
      const alt = escapeHtml(item.alt || item.target.split('/').pop() || '');
      const sized = item.width
        ? (' has-explicit-size' + (item.height ? ' has-explicit-box' : '')) : '';
      const sizeStyle = item.width
        ? (' style="width:min(100%,' + item.width + 'px)'
          + (item.height ? (';aspect-ratio:' + item.width + '/' + item.height) : '') + '"') : '';
      const overlays = Array.isArray(item.imageTextItems) ? item.imageTextItems.map(function (entry) {
        return '<span class="note-image-text-box" data-image-text-id="' + escapeHtml(entry.id)
          + '" data-image-text-size="' + entry.size + '" data-image-text-color="' + entry.color
          + '" style="left:clamp(var(--image-text-half-width,0px),' + (entry.x * 100)
          + '%,calc(100% - var(--image-text-half-width,0px)));top:clamp(var(--image-text-half-height,0px),'
          + (entry.y * 100) + '%,calc(100% - var(--image-text-half-height,0px)))">'
          + escapeHtml(entry.text) + '</span>';
      }).join('') : '';
      return '<span class="md-local-image' + sized + (overlays ? ' has-image-text' : '')
        + '" data-note-image-wrap="' + target + '"' + sizeStyle + '>'
        + '<img data-note-image="' + target + '" data-note-image-syntax="' + item.syntax + '" alt="' + alt + '" loading="lazy" decoding="async">'
        + (overlays ? ('<span class="note-image-text-layer">' + overlays + '</span>') : '')
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
    note: 'M10.5 2.5l3 3L6 13H3v-3z|M9 4l3 3',
    abstract: 'M5 3h6v11H3V3h2|M6 2h4v3H6z|M6 8h3M6 11h3',
    info: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M8 7v4|M8 5h0.01',
    todo: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M5 8l2 2 4-4',
    tip: 'M8 1.5a4.5 4.5 0 0 1 2.7 8.1V11a1 1 0 0 1-1 1H6.3a1 1 0 0 1-1-1V9.6A4.5 4.5 0 0 1 8 1.5z|M6.5 14h3',
    warning: 'M8 2 1.5 13.5h13L8 2z|M8 6.5v3.5|M8 12h0.01',
    failure: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M5.5 5.5l5 5M10.5 5.5l-5 5',
    danger: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
    success: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M5 8l2 2 4-4',
    question: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.5-.7 1.1|M8 11.5h0.01',
    quote: 'M5 5H3.5A1.5 1.5 0 0 0 2 6.5v3A1.5 1.5 0 0 0 3.5 11H5l-1.5 2.5|M12.5 5H11a1.5 1.5 0 0 0-1.5 1.5v3A1.5 1.5 0 0 0 11 11h1.5L11 13.5',
    example: 'M6.5 4h6M6.5 8h6M6.5 12h6|M3.5 4h0.01M3.5 8h0.01M3.5 12h0.01',
    bug: 'M5 6a3 3 0 0 1 6 0v3a3 3 0 0 1-6 0z|M8 3.5V2M2.5 7H5M11 7h2.5M2.5 11H5M11 11h2.5',
  };
  // Obsidian 别名 → 标准类型
  const CALLOUT_ALIAS = {
    summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', faq: 'question',
    help: 'question', check: 'success', done: 'success', caution: 'warning', attention: 'warning',
    fail: 'failure', missing: 'failure', error: 'danger', cite: 'quote', infobox: 'info',
  };
  const CALLOUT_LABEL = {
    note: '笔记', abstract: '摘要', info: '信息', todo: '待办', tip: '提示', success: '成功',
    question: '疑问', warning: '注意', failure: '失败', danger: '危险', bug: '缺陷',
    example: '示例', quote: '引用',
  };
  function calloutIcon(type) {
    const paths = (CALLOUT_ICONS[type] || CALLOUT_ICONS.note).split('|');
    const body = paths.map(function (d) { return '<path d="' + d + '"/>'; }).join('');
    return '<svg class="md-callout-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"'
      + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true">' + body + '</svg>';
  }

  function quoteLine(source) {
    const value = String(source || '');
    let offset = 0, depth = 0, match;
    while ((match = /^[ \t]{0,3}>[ \t]?/.exec(value.slice(offset)))) { offset += match[0].length; depth++; }
    return { prefix: value.slice(0, offset), depth, text: value.slice(offset) };
  }
  function stripQuote(source, depth) {
    let value = String(source || '');
    for (let index = 0; index < depth; index++) value = value.replace(/^\s*>[ \t]?/, '');
    return value;
  }

  // Local Lucide subset; license: assets/vendor/lucide/LICENSE.txt.
  const NOTE_ICONS = Object.freeze({
    note: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    abstract: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    todo: '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
    tip: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
    success: '<path d="M20 6 9 17l-5-5"/>',
    question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
    warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/>',
    failure: '<path d="m18 6-12 12M6 6l12 12"/>',
    danger: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
    bug: '<path d="M12 20v-9M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4M14.12 3.88 16 2M21 21a4 4 0 0 0-3.81-4M21 5a4 4 0 0 1-3.55 3.97M22 13h-4M3 21a4 4 0 0 1 3.81-4M3 5a4 4 0 0 0 3.55 3.97M6 13H2m6-11 1.88 1.88M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
    example: '<path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/>',
    quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2zM5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  });
  const NOTE_GROUPS = Object.freeze({
    blue: ['#086DDD', '#027AFF'], cyan: ['#00BFBC', '#53DFDD'], green: ['#08B94E', '#44CF6E'],
    orange: ['#EC7500', '#E9973F'], red: ['#E93147', '#FB464C'], purple: ['#7852EE', '#A882FF'], gray: ['#9E9E9E', '#9E9E9E'],
  });
  const NOTE_TYPE_GROUP = { note: 'blue', info: 'blue', todo: 'blue', abstract: 'cyan', tip: 'cyan', success: 'green', question: 'orange', warning: 'orange', failure: 'red', danger: 'red', bug: 'red', example: 'purple', quote: 'gray' };
  function mixedColor(base, surface, amount, round) {
    const rounding = round || Math.round;
    return '#' + [1, 3, 5].map((index) => rounding((parseInt(base.slice(index, index + 2), 16) * (amount * 100) + parseInt(surface.slice(index, index + 2), 16) * (100 - amount * 100)) / 100).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const NOTE_COLORS = Object.freeze([
    ['blue','668BB3','cool'],['sky','78ABC5','cool'],['steel','7C94A6','cool'],['denim','637D9D','cool'],['indigo','777AA6','cool'],['cyan','64A5B0','cool'],['aqua','7EB6B2','cool'],['turquoise','65AAA3','cool'],
    ['teal','5C938D','green'],['mint','96BEAB','green'],['forest','5E8775','green'],['sage','9CA88D','green'],['olive','9C9D70','green'],['green','789A75','green'],
    ['yellow','C3AF6F','warm'],['lemon','C7BF80','warm'],['amber','C5A16A','warm'],['orange','C29B79','warm'],['apricot','D2B393','warm'],['peach','D4B0A0','warm'],['coral','C68F83','warm'],['terracotta','B68B79','warm'],
    ['red','B98282','pink'],['rose','BD96A3','pink'],['pink','CEAAB9','pink'],['mauve','AB97AF','pink'],['lavender','ABA4CC','pink'],['purple','9584B0','pink'],
    ['gray','969B9F','neutral'],['silver','AFB7BA','neutral'],['stone','A6A095','neutral'],['sand','BFB299','neutral'],
  ].map(([name, hex, group]) => Object.freeze({ name, group, base: '#' + hex, light: mixedColor('#' + hex, '#FFFFFF', .16), dark: mixedColor('#' + hex, '#181A19', .22), example: '> [!' + name + ']\n> ' + name })));
  const NOTE_TYPES = Object.freeze(Object.keys(NOTE_ICONS).map((name) => Object.freeze({ name, aliases: Object.freeze(Object.keys(CALLOUT_ALIAS).filter((alias) => CALLOUT_ALIAS[alias] === name)), example: '> [!' + name + ']\n> ' + name.charAt(0).toUpperCase() + name.slice(1) })));
  function noteBlock(type, title, suffix) {
    const input = String(type || 'note').toLowerCase();
    const color = NOTE_COLORS.find((item) => item.name === input);
    const canonical = CALLOUT_ALIAS[input] || (NOTE_ICONS[input] ? input : 'note');
    const colors = NOTE_GROUPS[NOTE_TYPE_GROUP[canonical]];
    return { type: color ? input : canonical, input, color: !!color, title: String(title || '') || (color ? '' : input.charAt(0).toUpperCase() + input.slice(1)), foldable: !color && /^[+-]$/.test(suffix || ''), collapsed: !color && suffix === '-',
      style: color ? '--note-block-bg-light:' + color.light + ';--note-block-bg-dark:' + color.dark + ';'
        : '--note-block-accent-light:' + colors[0] + ';--note-block-accent-dark:' + colors[1] + ';--note-block-bg-light:' + mixedColor(colors[0], '#FFFFFF', .1, Math.floor) + ';--note-block-bg-dark:' + mixedColor(colors[1], '#181A19', .1, Math.floor) + ';',
      icon: color ? '' : '<svg class="md-callout-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + NOTE_ICONS[canonical] + '</svg>',
    };
  }
  function foldButton(collapsed) {
    return '<button type="button" class="note-callout-fold" aria-expanded="' + !collapsed + '" aria-label="' + (collapsed ? 'Expand callout' : 'Collapse callout') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>';
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
  function parseBlocks(text, topLevel, options, lineOffset) {
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

      // Note-only source headings are identified before placeholder transforms,
      // which otherwise shift line numbers (frontmatter, math and comments).
      const noteHeading = options && Array.isArray(options.noteHeadings)
        ? /^[ \t]{0,3}\x00NHEAD([1-6]):(\d+)\x00(.*)$/.exec(line) : null;
      if (noteHeading) {
        const tag = 'h' + noteHeading[1];
        out.push('<' + tag + ' data-note-heading-from="' + noteHeading[2] + '">' + renderInline(escapeHtml(noteHeading[3])) + '</' + tag + '>');
        i++; continue;
      }

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
          const descriptor = options && options.noteBlocks ? noteBlock(head[1], head[3].trim(), head[2]) : null;
          let type = head[1].toLowerCase();
          type = CALLOUT_ALIAS[type] || (CALLOUT_ICONS[type] ? type : 'note');
          const title = head[3].trim() || CALLOUT_LABEL[type] || head[1];
          const bodyHtml = parseBlocks(buf.slice(1).join('\n'), false, options, (lineOffset || 0) + startLn + 1);
          out.push('<div class="md-callout' + (descriptor ? ' note-block' + (descriptor.color ? ' note-color-block' : '') : '') + '" data-callout="' + (descriptor ? descriptor.type : type) + '"' + (descriptor ? ' data-ln="' + ((lineOffset || 0) + startLn) + '"' : ln(startLn))
            + (descriptor ? ' style="' + descriptor.style + '" data-fold="' + (descriptor.foldable ? head[2] : '') + '"' : '') + '>'
            + ((!descriptor || descriptor.title) ? '<div class="md-callout-title">' + (descriptor ? descriptor.icon : calloutIcon(type))
            + '<span class="note-callout-title-text">' + renderInline(escapeHtml(descriptor ? descriptor.title : title)) + '</span>' + (descriptor && descriptor.foldable ? foldButton(descriptor.collapsed) : '') + '</div>' : '')
            + (bodyHtml ? '<div class="md-callout-body"' + (descriptor && descriptor.collapsed ? ' hidden' : '') + '>' + bodyHtml + '</div>' : '')
            + '</div>');
        } else {
          out.push('<blockquote' + ln(startLn) + '>' + parseBlocks(buf.join('\n'), false, options, (lineOffset || 0) + startLn) + '</blockquote>');
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
    if (/^\x00NHEAD[1-6]:\d+\x00/.test(t)) return true;
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
    const options = arguments.length > 1 ? arguments[1] : null;
    const opts = options && typeof options === 'object' ? options : {};
    let headingSource = source;
    if (Array.isArray(opts.noteHeadings)) {
      const pieces = []; let position = 0;
      opts.noteHeadings.forEach(heading => {
        if (heading.from < position || heading.to > source.length || !/^[1-6]$/.test(String(heading.level))) return;
        pieces.push(source.slice(position, heading.from));
        const sourceFrom = Number.isInteger(heading.sourceFrom) ? heading.sourceFrom : heading.from;
        pieces.push('\x00NHEAD' + heading.level + ':' + sourceFrom + '\x00' + heading.text);
        // Retain every source newline for other note blocks and callout folds.
        pieces.push('\n'.repeat(source.slice(heading.from, heading.to).split('\n').length - 1));
        position = heading.to;
      });
      pieces.push(source.slice(position)); headingSource = pieces.join('');
    }
    const header = opts.noteTags ? frontmatter(headingSource) : null;
    const body = header ? headingSource.slice(header.to) : headingSource;
    const features = scanFeatures(body);
    try {
      const codeGuard = protectCode(body, opts.noteBlocks);
      const inlineCodeGuard = protectInlineCode(codeGuard.protected);
      const imageGuard = protectLocalImages(inlineCodeGuard.protected, opts.localImages === true);
      const wikiGuard = protectWikiLinks(imageGuard.protected);   // 先抠 [[双链]]（早于 [文字](url)）
      const linkGuard = protectLinks(wikiGuard.protected);
      const mathSource = opts.noteBlocks ? linkGuard.protected.replace(/<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?(?:%%|$)/g, (comment) => comment.split('\n').slice(1).map(line => '\n' + quoteLine(line).prefix).join('')) : linkGuard.protected;
      const mathGuard = protectMath(mathSource, undefined, opts.noteBlocks);
      if (opts.noteBlocks) features.math = mathGuard.maths.some(item => !item.raw) || /\\begin\{([^{}\s]+)\}[\s\S]+?\\end\{\1\}|\\(?:ref|eqref)\{[^{}\n]+\}/.test(mathGuard.protected);
      const escapeGuard = protectEscapes(mathGuard.protected);
      const tags = opts.noteTags ? tagRanges(escapeGuard.protected) : [];
      let tagged = escapeGuard.protected;
      tags.slice().reverse().forEach((tag, index) => {
        tagged = tagged.slice(0, tag.from) + '\x00NTAG' + (tags.length - index - 1) + '\x00' + tagged.slice(tag.to);
      });
      let html = parseBlocks(tagged, true, opts);
      html = html.replace(/\x00NTAG(\d+)\x00/g, (_, index) => '<a class="note-tag" data-note-tag="' + escapeHtml(tags[+index].tag) + '">' + escapeHtml('#' + tags[+index].tag) + '</a>');
      html = restoreMath(html, mathGuard.maths);
      html = restoreLinks(html, linkGuard.links);
      html = restoreWikiLinks(html, wikiGuard.wikis);
      html = restoreLocalImages(html, imageGuard.images);
      html = restoreEscapes(html, escapeGuard.chars);
      html = restoreInlineCode(html, inlineCodeGuard.codes);
      html = restoreCode(html, codeGuard.codes);
      if (header) html = '<pre class="note-frontmatter"><code>' + escapeHtml(source.slice(0, header.to)) + '</code></pre>' + html;
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

  // Short labels share the safe inline grammar, but never create links, images,
  // block structures or diagrams. Protect code and math before styling text.
  function renderLabelResult(src) {
    const source = normalizeSource(src);
    try {
      const code = protectInlineCode(source);
      const math = protectMath(code.protected, false);
      const escapes = protectEscapes(math.protected);
      let html = renderInlineSafe(escapes.protected).replace(/\n/g, '<br>');
      html = restoreMath(html, math.maths);
      // Display math already starts/ends a line; source-line padding belongs
      // to body click mapping, not the compact label's visual line breaks.
      html = html.replace(/<br>(?=<div class="md-math-block">)/g, '').replace(/(<\/div>)<br>/g, '$1');
      html = restoreEscapes(html, escapes.chars);
      html = restoreInlineCode(html, code.codes);
      return { html: html, features: { math: math.maths.length > 0, mermaid: false }, error: false };
    } catch (error) {
      return { html: escapeHtml(source).replace(/\n/g, '<br>'),
        features: { math: false, mermaid: false }, error: true };
    }
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
    renderLabelResult: renderLabelResult,
    renderInline: renderInlineSafe,
    escapeHtml: escapeHtml,
    highlightCode: highlightCode,
    markIntervals: markIntervals,
    parseImage: parseImage,
    isCanvasImage: isCanvasImage,
    canvasReferences: canvasReferences,
    canvasTarget: canvasTarget,
    rewriteCanvasReferences: rewriteCanvasReferences,
    serializeImage: serializeImage,
    parseImageBlock: parseImageBlock,
    serializeImageBlock: serializeImageBlock,
    imageTextVisibleSource: imageTextVisibleSource,
    structure: structure,
    frontmatter: frontmatter,
    tagRanges: tagRanges,
    mathRanges: mathRanges,
    quoteLine: quoteLine,
    stripQuote: stripQuote,
    noteBlock: noteBlock,
    foldButton: foldButton,
    noteBlockCatalog: Object.freeze({ types: NOTE_TYPES, colors: NOTE_COLORS }),
  };
})(window);
