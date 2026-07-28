// 笔记坞的无 DOM 数据层：
// - 规范化随 .canvas 保存的多页 Markdown；
// - 把标题与缩进列表解析成一次性导图快照；
// - 把画布选区序列化为可追加的 Markdown 大纲。
(function (global) {
  'use strict';

  const VERSION = 1;
  const DEFAULT_MAX_NODES = 200;

  function markdownStructure() {
    return global.MarkdownMini && global.MarkdownMini.structure
      ? global.MarkdownMini.structure
      : null;
  }

  function text(value) {
    return String(value == null ? '' : value);
  }

  function iso(value, fallback) {
    const raw = text(value).trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw : fallback;
  }

  function makeId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return 'note-' + global.crypto.randomUUID();
    }
    return 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createNote(title, markdown, now) {
    const stamp = iso(now, new Date().toISOString());
    return {
      id: makeId(),
      title: text(title).trim().slice(0, 120) || '未命名笔记',
      markdown: text(markdown),
      createdAt: stamp,
      updatedAt: stamp,
    };
  }

  function normalizeNotebook(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const notes = [];
    const stamp = new Date().toISOString();
    (Array.isArray(source.notes) ? source.notes : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      let id = text(item.id).trim();
      if (!id || seen.has(id)) id = makeId();
      seen.add(id);
      const createdAt = iso(item.createdAt, stamp);
      notes.push({
        id: id,
        title: text(item.title).trim().slice(0, 120) || '未命名笔记',
        markdown: text(item.markdown),
        createdAt: createdAt,
        updatedAt: iso(item.updatedAt, createdAt),
      });
    });
    return { version: VERSION, notes: notes };
  }

  function cleanStructuralText(value) {
    let out = text(value).trim().replace(/\s+#+\s*$/, '');
    out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
    out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    out = out.replace(/\[\[([^\]]+)\]\]/g, '$1');
    for (let pass = 0; pass < 5; pass++) {
      const before = out;
      out = out.replace(/\{(?:hl|tc|fs):[^|{}]+\|([^{}]+)\}/g, '$1');
      if (out === before) break;
    }
    out = out
      .replace(/(\*\*|__|~~|==)/g, '')
      .replace(/(^|[\s(])([*_])([^*_\n]+)\2(?=$|[\s).,!?，。；：])/g, '$1$3')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return out;
  }

  function trimmedBody(lines) {
    const copy = lines.slice();
    while (copy.length && copy[0].trim() === '') copy.shift();
    while (copy.length && copy[copy.length - 1].trim() === '') copy.pop();
    return copy.join('\n');
  }

  function parseOutline(title, markdown, options) {
    options = options || {};
    const syntax = markdownStructure();
    if (!syntax) {
      return {
        ok: false,
        reason: 'parser-unavailable',
        nodes: [],
        edges: [],
        count: 0,
        maxDepth: 0,
      };
    }
    const maxNodes = Math.max(2, Number(options.maxNodes) || DEFAULT_MAX_NODES);
    const rootTitle = cleanStructuralText(title) || '未命名笔记';
    const nodes = [{ title: rootTitle, body: '', depth: 0, sourceLine: 0, type: 'root' }];
    const edges = [];
    const bodyLines = [[]];
    const headingStack = [];
    const listStack = [];
    let headingParent = 0;
    let current = 0;
    let structuralCount = 0;
    let tooManyLine = 0;
    let fence = null;
    let mathBlock = false;

    function addNode(nodeTitle, parent, type, sourceLine) {
      if (nodes.length >= maxNodes) {
        tooManyLine = sourceLine;
        return -1;
      }
      const safeParent = Number.isInteger(parent) && nodes[parent] ? parent : 0;
      const index = nodes.length;
      nodes.push({
        title: cleanStructuralText(nodeTitle) || '未命名',
        body: '',
        depth: (nodes[safeParent].depth || 0) + 1,
        sourceLine: sourceLine,
        type: type,
      });
      bodyLines.push([]);
      edges.push({ from: safeParent, to: index, text: '' });
      structuralCount += 1;
      return index;
    }

    const lines = text(markdown).replace(/\r\n?/g, '\n').split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const trimmed = line.trim();
      const fenceMatch = syntax.parseFence(line);
      if (fence) {
        bodyLines[current].push(line);
        if (syntax.isFenceClose(line, fence)) {
          fence = null;
        }
        continue;
      }
      if (fenceMatch) {
        fence = fenceMatch;
        bodyLines[current].push(line);
        continue;
      }
      if (mathBlock) {
        bodyLines[current].push(line);
        if (trimmed.endsWith('$$')) mathBlock = false;
        continue;
      }
      if (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$')) {
        mathBlock = true;
        bodyLines[current].push(line);
        continue;
      }

      const heading = syntax.parseHeading(line);
      if (heading) {
        const level = heading.level;
        const headingTitle = cleanStructuralText(heading.text);
        listStack.length = 0;
        if (structuralCount === 0 && level === 1
            && headingTitle.toLocaleLowerCase() === rootTitle.toLocaleLowerCase()) {
          headingStack.length = 0;
          headingStack[level] = 0;
          headingParent = 0;
          current = 0;
          continue;
        }
        let parent = 0;
        for (let candidate = level - 1; candidate >= 1; candidate--) {
          if (Number.isInteger(headingStack[candidate])) {
            parent = headingStack[candidate];
            break;
          }
        }
        const index = addNode(headingTitle, parent, 'heading', lineIndex + 1);
        if (index < 0) break;
        headingStack.length = level + 1;
        headingStack[level] = index;
        headingParent = index;
        current = index;
        continue;
      }

      const list = syntax.parseListMarker(line);
      if (list && !list.empty) {
        const indent = list.indent;
        let itemTitle = (list.task == null ? list.content : list.taskText).trim();
        if (list.task != null) itemTitle = (list.task ? '☑ ' : '☐ ') + itemTitle;
        while (listStack.length && listStack[listStack.length - 1].indent > indent) listStack.pop();
        let parent = headingParent;
        if (listStack.length) {
          const tail = listStack[listStack.length - 1];
          if (tail.indent < indent) {
            parent = tail.index;
          } else {
            parent = tail.parent;
            listStack.pop();
          }
        }
        const index = addNode(itemTitle, parent, list.task == null ? 'list' : 'task', lineIndex + 1);
        if (index < 0) break;
        listStack.push({ indent: indent, index: index, parent: parent });
        current = index;
        continue;
      }

      bodyLines[current].push(line);
    }

    nodes.forEach(function (node, index) {
      node.body = trimmedBody(bodyLines[index] || []);
    });
    const maxDepth = nodes.reduce(function (maximum, node) {
      return Math.max(maximum, Number(node.depth) || 0);
    }, 0);
    const reason = tooManyLine
      ? 'too-many'
      : (structuralCount === 0 ? 'no-structure' : '');
    return {
      ok: !reason,
      reason: reason,
      line: tooManyLine,
      nodes: nodes,
      edges: edges,
      count: nodes.length,
      structuralCount: structuralCount,
      maxDepth: maxDepth,
      maxNodes: maxNodes,
    };
  }

  function positionSort(a, b) {
    const ay = Number(a.y) || 0;
    const by = Number(b.y) || 0;
    const ax = Number(a.x) || 0;
    const bx = Number(b.x) || 0;
    return ay - by || ax - bx || text(a.title).localeCompare(text(b.title));
  }

  function indentBlock(value, spaces) {
    const prefix = ' '.repeat(Math.max(0, spaces));
    return text(value).split('\n').map(function (line) {
      return line ? prefix + line : prefix;
    }).join('\n');
  }

  function selectionToMarkdown(snapshot, options) {
    options = options || {};
    snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const relationLabel = text(options.relationLabel).trim() || '关系';
    const relationSeparator = options.relationSeparator == null
      ? '：' : text(options.relationSeparator);
    const nodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : [])
      .filter(function (node) { return node && node.id; })
      .map(function (node) { return Object.assign({}, node); });
    const byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
    const edges = (Array.isArray(snapshot.edges) ? snapshot.edges : []).filter(function (edge) {
      return edge && edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to);
    });
    if (!nodes.length) {
      return { markdown: '', count: 0, ignoredCount: Number(snapshot.ignoredCount) || 0, complex: false };
    }

    const incoming = new Map(nodes.map(function (node) { return [node.id, 0]; }));
    const children = new Map(nodes.map(function (node) { return [node.id, []]; }));
    const edgeByChild = new Map();
    const relationsByTarget = new Map(nodes.map(function (node) { return [node.id, []]; }));
    let complex = false;
    edges.forEach(function (edge) {
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
      children.get(edge.from).push(edge.to);
      if (!edgeByChild.has(edge.to)) edgeByChild.set(edge.to, edge);
      if (text(edge.text).trim()) relationsByTarget.get(edge.to).push(text(edge.text).trim());
      if ((incoming.get(edge.to) || 0) > 1) complex = true;
    });
    children.forEach(function (ids) {
      ids.sort(function (a, b) { return positionSort(byId.get(a), byId.get(b)); });
    });
    const roots = nodes.filter(function (node) { return (incoming.get(node.id) || 0) === 0; })
      .sort(positionSort);
    const visited = new Set();
    const visiting = new Set();
    function walkCycle(id) {
      if (visiting.has(id)) { complex = true; return; }
      if (visited.has(id)) return;
      visiting.add(id);
      (children.get(id) || []).forEach(walkCycle);
      visiting.delete(id);
      visited.add(id);
    }
    roots.forEach(function (root) { walkCycle(root.id); });
    if (visited.size !== nodes.length) complex = true;
    if (edges.length > nodes.length - Math.max(1, roots.length)) complex = true;

    function nodeTitle(node) {
      return cleanStructuralText(node.title) || options.untitled || '未命名';
    }
    function nodeBody(node) {
      return text(node.body).trim();
    }
    const chunks = [];
    if (complex) {
      chunks.push('## ' + (options.fallbackTitle || '画布选区'));
      nodes.slice().sort(positionSort).forEach(function (node) {
        chunks.push('- ' + nodeTitle(node));
        (relationsByTarget.get(node.id) || []).forEach(function (relation) {
          chunks.push('  _' + relationLabel + relationSeparator + relation + '_');
        });
        const body = nodeBody(node);
        if (body) chunks.push(indentBlock(body, 2));
      });
    } else {
      function appendChildren(parentId, depth) {
        (children.get(parentId) || []).forEach(function (childId) {
          const child = byId.get(childId);
          const prefix = '  '.repeat(Math.max(0, depth - 1));
          chunks.push(prefix + '- ' + nodeTitle(child));
          const relation = edgeByChild.get(childId);
          if (relation && text(relation.text).trim()) {
            chunks.push(indentBlock(
              '_' + relationLabel + relationSeparator + text(relation.text).trim() + '_',
              depth * 2,
            ));
          }
          const body = nodeBody(child);
          if (body) chunks.push(indentBlock(body, depth * 2));
          appendChildren(childId, depth + 1);
        });
      }
      roots.forEach(function (root, index) {
        if (index) chunks.push('');
        chunks.push('## ' + nodeTitle(root));
        const body = nodeBody(root);
        if (body) chunks.push(body);
        appendChildren(root.id, 1);
      });
    }
    return {
      markdown: trimmedBody(chunks) + '\n',
      count: nodes.length,
      ignoredCount: Number(snapshot.ignoredCount) || 0,
      complex: complex,
    };
  }

  function listContinuation(markdown, selectionStart, selectionEnd) {
    const syntax = markdownStructure();
    if (!syntax) return null;
    const value = text(markdown).replace(/\r\n?/g, '\n');
    const start = Math.max(0, Math.min(value.length, Number(selectionStart) || 0));
    const end = Math.max(0, Math.min(value.length, Number(selectionEnd) || 0));
    if (start !== end) return null;
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const nextBreak = value.indexOf('\n', start);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak;
    if (start !== lineEnd) return null;

    const precedingLines = value.slice(0, lineStart).split('\n');
    let fence = null;
    for (let i = 0; i < precedingLines.length; i++) {
      if (fence) {
        if (syntax.isFenceClose(precedingLines[i], fence)) fence = null;
      } else {
        fence = syntax.parseFence(precedingLines[i]);
      }
    }
    if (fence) return null;

    const marker = syntax.parseListMarker(value.slice(lineStart, lineEnd));
    if (!marker) return null;
    if (marker.empty) {
      return { start: lineStart, end: lineEnd, text: '', caret: lineStart };
    }
    let nextMarker = marker.marker;
    if (marker.ordered) nextMarker = String((marker.number || 0) + 1) + marker.delimiter;
    const task = marker.task == null ? '' : '[ ] ';
    const inserted = '\n' + marker.indentRaw + nextMarker + ' ' + task;
    return { start: start, end: end, text: inserted, caret: start + inserted.length };
  }

  global.RelatumMarkdownNotebook = {
    VERSION: VERSION,
    DEFAULT_MAX_NODES: DEFAULT_MAX_NODES,
    createNote: createNote,
    normalizeNotebook: normalizeNotebook,
    cleanStructuralText: cleanStructuralText,
    parseOutline: parseOutline,
    selectionToMarkdown: selectionToMarkdown,
    listContinuation: listContinuation,
  };
})(typeof window !== 'undefined' ? window : globalThis);
