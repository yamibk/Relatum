// Bounded equation editing helpers. No Obsidian API, executable snippets or renderer.
(function () {
  'use strict';
  const registry = window.RelatumNoteExtensions;
  const definition = registry.list().find(item => item.id === 'latex-input');
  const greek = new Set('alpha beta gamma Gamma delta Delta epsilon varepsilon zeta eta theta vartheta Theta iota kappa lambda Lambda mu nu xi Xi omicron pi Pi rho varrho sigma Sigma tau upsilon Upsilon phi varphi Phi chi psi Psi omega Omega'.split(' '));
  const matrices = new Set('matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix array cases align aligned gather'.split(' '));
  const variable = '(?:\\\\(?:' + Array.from(greek).join('|') + ')|[A-Za-z])';
  const accent = '\\\\(?:hat|bar|dot|ddot|tilde|vec|underline)\\{';
  const operand = '(?:' + accent + '(?:' + accent + variable + '\\}|' + variable + ')\\}|' + variable + ')';
  const numericSubscript = new RegExp('(' + operand + ')(?:_\\{(\\d+)\\})?(\\d)$');
  function parseTemplate(template, start) {
    const parsed = definition.parseTemplate(template, start);
    if (!parsed) return null;
    const groups = new Map();
    parsed.stops.forEach(stop => {
      if (groups.has(stop.number)) groups.get(stop.number).mirrors.push({ from: stop.from, to: stop.to, order: stop.order });
      else groups.set(stop.number, { ...stop, mirrors: [] });
    });
    return { ...parsed, stops: Array.from(groups.values()) };
  }
  // Scan only the prefix of a formula already identified by the host.
  function allowedPrefix(source) {
    const groups = [];
    let command = '', remaining = 0;
    for (let index = 0; index < source.length; index++) {
      if (index === 0 || source[index - 1] === '\n') {
        const quote = /^[ \t]*(?:>[ \t]*)+/.exec(source.slice(index));
        if (quote) { index += quote[0].length - 1; continue; }
      }
      const char = source[index];
      if (char === '%') {
        const newline = source.indexOf('\n', index);
        if (newline < 0) return false;
        index = newline; command = ''; remaining = 0; continue;
      }
      if (char === '\\') {
        const match = /^[A-Za-z]+\*?/.exec(source.slice(index + 1));
        if (match) {
          command = match[0].replace(/\*$/, ''); remaining = /^(?:textcolor|href)$/.test(command) ? 2 : 1;
          index += match[0].length;
        } else { index++; command = ''; remaining = 0; }
      } else if (char === '{') {
        groups.push({ blocked: /^(?:text\w*|mbox|operatorname|url|href|begin|end|array-format)$/.test(command) || groups.some(group => group.blocked),
          follow: command === 'begin' && source.slice(index, index + 7) === '{array}' ? { command: 'array-format', remaining: 1 } :
            remaining > 1 ? { command, remaining: remaining - 1 } : null });
        command = ''; remaining = 0;
      } else if (char === '}') {
        const follow = groups.pop()?.follow; command = follow?.command || ''; remaining = follow?.remaining || 0;
      } else if (!/\s/.test(char)) { command = ''; remaining = 0; }
    }
    return !groups.some(group => group.blocked);
  }
  // Lightweight delimiter/environment scan, bounded by the host's 4/32 KiB limits.
  // It keeps source offsets, including quote prefixes; it is not a TeX parser.
  function structure(source, offset) {
    const tokens = [], pairs = [], stack = [];
    const opening = { '(': ')', '[': ']', '{': '}', '\\{': '\\}', '\\langle': '\\rangle',
      '\\lvert': '\\rvert', '\\lVert': '\\rVert', '\\lfloor': '\\rfloor', '\\lceil': '\\rceil' };
    const closing = new Set(Object.values(opening));
    for (let at = 0; at < source.length;) {
      if (at === 0 || source[at - 1] === '\n') {
        const quote = /^[ \t]*(?:>[ \t]*)+/.exec(source.slice(at));
        if (quote) { at += quote[0].length; continue; }
      }
      if (source[at] === '%') { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end; continue; }
      if (/\s/.test(source[at])) { at++; continue; }
      const rest = source.slice(at);
      const environment = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(rest);
      const sized = /^\\(left|right)\s*(\\[A-Za-z]+|\\.|[()[\]{}|.])/.exec(rest);
      const raw = environment?.[0] || sized?.[0] || /^(?:\\[A-Za-z]+\*?|\\.|[A-Za-z0-9]+|.)/.exec(rest)[0];
      const token = { from: offset + at, to: offset + at + raw.length, text: raw, index: tokens.length };
      tokens.push(token); at += raw.length;
      let open = '', close = '';
      if (environment) { token.env = environment[2]; if (environment[1] === 'begin') open = 'env:' + token.env; else close = 'env:' + token.env; }
      else if (sized) { if (sized[1] === 'left') open = 'sized'; else close = 'sized'; }
      else if (opening[raw]) open = opening[raw];
      else if (closing.has(raw)) close = raw;
      if (open) { token.open = open; stack.push(token); }
      else if (close) {
        token.close = close;
        const first = stack[stack.length - 1];
        if (first?.open === close) { stack.pop(); const pair = { open: first, close: token }; pairs.push(pair); first.pair = token.pair = pair; }
        else token.unmatched = true;
      }
    }
    return { tokens, pairs, unmatched: stack };
  }
  registry.registerRuntime('latex-input', (context, options) => {
    const { CM, view } = context;
    const snippets = definition.effectiveSnippets(options).filter(item => item.enabled && !item.conflict).sort((a, b) => b.trigger.length - a.trigger.length);
    const maxTrigger = Math.max(1, ...snippets.map(item => item.trigger.length));
    const mapRange = (range, changes) => ({ ...range, from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) });
    const mapSession = (session, changes) => ({ ...mapRange(session, changes), exit: changes.mapPos(session.exit, 1),
      stops: session.stops.map(stop => ({ ...mapRange(stop, changes), mirrors: stop.mirrors.map(range => mapRange(range, changes)) })) });
    // Track ownership at shared boundaries. mapPos alone cannot distinguish two
    // adjacent empty tabstops (or an insertion at the boundary of two mirrors).
    function trackSession(session, changes, edits, selection, sessionIndex) {
      const active = session.stops[session.index], all = session.stops.flatMap(stop => [stop, ...stop.mirrors]);
      const preferred = active && [active, ...active.mirrors].find(range => contains(range, selection));
      const map = range => {
        let from = range.from, to = range.to, delta = 0;
        for (const edit of edits) {
          const owner = edit.owner?.sessionIndex === sessionIndex ? edit.owner.order :
            (preferred && edit.from >= preferred.from && edit.to <= preferred.to ? preferred.order :
              all.find(item => edit.from >= item.from && edit.to <= item.to)?.order);
          const a = edit.from + delta, b = edit.to + delta, length = edit.insert.length;
          const difference = length - (b - a), own = owner === range.order;
          if (a === b) {
            if (a < from || a === from && !own && (owner === undefined || owner < range.order)) { from += length; to += length; }
            else if (a > from && a < to || own && a >= from && a <= to) to += length;
          } else if (b <= from) { from += difference; to += difference; }
          else if (a < to) {
            from = from < a ? from : a;
            to = to <= b ? a + length : to + difference;
          }
          delta += difference;
        }
        return { ...range, from, to };
      };
      return { ...mapRange(session, changes), exit: changes.mapPos(session.exit, 1),
        stops: session.stops.map(stop => ({ ...map(stop), mirrors: stop.mirrors.map(map) })) };
    }
    const action = CM.StateEffect.define({ map: (value, changes) => value.type === 'push'
      ? { ...value, session: mapSession(value.session, changes) }
      : value.type === 'command' && value.command ? { ...value, command: mapRange(value.command, changes) } : value });
    let paused = false, disposed = false, pending = 0, cached = null, compositionCancelled = false;
    const ready = () => !paused && !disposed && context.isActive() && !context.inputPending()
      && context.acceptsInput() !== false && !view.composing && !view.compositionStarted
      && !view.state.readOnly && view.state.selection.ranges.length === 1;
    const contains = (session, selection) => selection.from >= session.from && selection.to <= session.to;
    const field = CM.StateField.define({
      create: () => ({ stack: [], command: null }),
      update(value, transaction) {
        if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.newSelection.ranges.length !== 1) return { stack: [], command: null };
        let { stack, command } = value;
        if (transaction.docChanged) {
          let edits = transaction.effects.find(effect => effect.is(action) && effect.value.type === 'mapping')?.value.edits;
          if (!edits) {
            edits = [];
            transaction.changes.iterChanges((from, to, _a, _b, insert) => edits.push({ from, to, insert }));
          }
          stack = stack.map((session, index) => trackSession(session, transaction.changes, edits, transaction.startState.selection.main, index));
          if (!['input', 'delete'].some(event => transaction.isUserEvent(event))) stack = [];
          if (command) command = { ...command, from: transaction.changes.mapPos(command.from, 1), to: transaction.changes.mapPos(command.to, -1) };
          if (!transaction.isUserEvent('input.type') && !transaction.isUserEvent('input.note-extension') && !transaction.isUserEvent('delete')) command = null;
        } else if (transaction.selection) command = null;
        for (const effect of transaction.effects) if (effect.is(action)) {
          if (effect.value.type === 'clear') { stack = []; command = null; }
          else if (effect.value.type === 'push') stack = stack.concat(effect.value.session);
          else if (effect.value.type === 'pop') stack = stack.slice(0, -1);
          else if (effect.value.type === 'move' && stack.length) stack = stack.slice(0, -1).concat({ ...stack[stack.length - 1], index: effect.value.index });
          else if (effect.value.type === 'command') command = effect.value.command;
        }
        while (stack.length && !contains(stack[stack.length - 1], transaction.newSelection.main)) stack = stack.slice(0, -1);
        const selection = transaction.newSelection.main;
        if (command && (!selection.empty || selection.head < command.to || selection.head > command.to + maxTrigger + 1
          || transaction.newDoc.sliceString(command.from, command.to) !== command.text)) command = null;
        return { stack, command };
      },
    });
    function mathAt(from = view.state.selection.main.head, to = from) {
      if (!ready()) return null;
      const math = context.mathAt(view.state, from, to);
      return math && allowedPrefix(view.state.doc.sliceString(math.from, from)) ? math : null;
    }
    function scan(math) {
      if (!cached || cached.state !== view.state || cached.from !== math.from || cached.to !== math.to)
        cached = { state: view.state, from: math.from, to: math.to, ...structure(view.state.doc.sliceString(math.from, math.to), math.from) };
      return cached;
    }
    // Extra changes use the original transaction coordinates, so mirror edits and
    // nested sessions remain one history event and preserve the real single cursor.
    function mirrorChanges(state, changes, force = false) {
      const extra = [], original = [];
      changes.iterChanges((from, to, _a, _b, inserted) => original.push({ from, to, insert: inserted }));
      const selection = state.selection.main;
      const stack = state.field(field, false)?.stack || [];
      for (let sessionIndex = stack.length - 1; sessionIndex >= 0; sessionIndex--) {
        const session = stack[sessionIndex];
        const stop = session.stops[session.index]; if (!stop?.mirrors.length) continue;
        const ranges = [stop, ...stop.mirrors], source = ranges.find(range => contains(range, selection));
        if (!source || !force && !original.some(edit => edit.from >= source.from && edit.to <= source.to)) continue;
        // Replacements crossing an occurrence invalidate its mirror session.
        if (original.some(edit => ranges.some(range => edit.from < range.to && edit.to > range.from
          && (edit.from < range.from || edit.to > range.to)))) continue;
        const combined = state.changes(original.concat(extra).sort((a, b) => a.from - b.from));
        const doc = combined.apply(state.doc), from = combined.mapPos(source.from, -1), to = combined.mapPos(source.to, 1);
        const text = doc.sliceString(from, to);
        for (const range of ranges) {
          if (range === source) continue;
          const a = combined.mapPos(range.from, -1), b = combined.mapPos(range.to, 1);
          if (doc.sliceString(a, b) !== text || range.from === source.from && range.to === source.to && source.from === source.to && text) {
            extra.push({ from: range.from, to: range.to, insert: text, owner: { sessionIndex, order: range.order } });
          }
        }
      }
      return extra;
    }
    const mirrorFilter = CM.EditorState.transactionFilter.of(transaction => {
      if (!transaction.docChanged || !ready() || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')
        || !['input', 'delete'].some(event => transaction.isUserEvent(event))) return transaction;
      const extra = mirrorChanges(transaction.startState, transaction.changes);
      const edits = [];
      transaction.changes.iterChanges((from, to, _a, _b, insert) => edits.push({ from, to, insert }));
      return extra.length ? [transaction, { changes: extra, effects: action.of({ type: 'mapping',
        edits: edits.concat(extra).sort((a, b) => a.from - b.from) }) }] : transaction;
    });
    function insert(from, to, template, literal = null) {
      const parsed = parseTemplate(template, from);
      if (!parsed) return false;
      // Selected source is literal text, never parsed as a snippet template.
      if (literal) {
        const index = parsed.text.indexOf('\u0000');
        parsed.text = parsed.text.replace('\u0000', () => literal);
        const delta = literal.length - 1, point = from + index;
        const shift = position => position > point ? position + delta : position;
        parsed.exit = shift(parsed.exit);
        parsed.stops = parsed.stops.map(stop => ({ ...stop, from: shift(stop.from), to: shift(stop.to),
          mirrors: stop.mirrors.map(range => ({ ...range, from: shift(range.from), to: shift(range.to) })) }));
      }
      const math = mathAt(from, to), changes = [];
      if (math && options.autoEnlargeBrackets && /\\(?:frac|sum|int|iint|iiint|oint|prod|bigcup|bigcap)(?![A-Za-z])/.test(parsed.text)) {
        const { pairs, tokens } = scan(math);
        const breaks = [0];
        tokens.forEach(token => breaks.push(breaks[breaks.length - 1] + Number(['&', '\\\\'].includes(token.text))));
        for (const pair of pairs) {
          const open = pair.open, close = pair.close;
          if (open.from >= from || open.to > from || close.from < to || open.env || open.open === 'sized' || open.text === '{') continue;
          const previous = tokens[open.index - 1];
          if (previous && /^\\(?:big|Big|bigg|Bigg)[lr]?$/.test(previous.text)) continue;
          if (open.text === '[' && previous && /^\\(?:sqrt|xrightarrow|xleftarrow)$/.test(previous.text)) continue;
          if (breaks[close.index] !== breaks[open.index + 1]) continue;
          changes.push({ from: open.from, insert: '\\left' }, { from: close.from, insert: '\\right' });
        }
      }
      const prefix = changes.filter(change => change.from <= from).reduce((n, change) => n + change.insert.length, 0);
      if (prefix) {
        parsed.exit += prefix;
        parsed.stops = parsed.stops.map(stop => ({ ...stop, from: stop.from + prefix, to: stop.to + prefix,
          mirrors: stop.mirrors.map(range => ({ ...range, from: range.from + prefix, to: range.to + prefix })) }));
      }
      const start = from + prefix, first = parsed.stops[0], effects = [];
      if (first) effects.push(action.of({ type: 'push', session: { from: start, to: start + parsed.text.length,
        exit: parsed.exit, stops: parsed.stops, index: 0 } }));
      effects.push(action.of({ type: 'command', command: /^\\[A-Za-z]+$/.test(parsed.text)
        ? { from: start, to: start + parsed.text.length, text: parsed.text } : null }));
      changes.push({ from, to, insert: parsed.text }); changes.sort((a, b) => a.from - b.from);
      view.dispatch({ changes,
        selection: CM.EditorSelection.range(first?.from ?? parsed.exit, first?.to ?? parsed.exit), effects,
        annotations: CM.isolateHistory.of('full'), userEvent: 'input.note-extension', scrollIntoView: true });
      return true;
    }
    function expand(automatic = false) {
      if (!ready() || !view.state.selection.main.empty) return false;
      const at = view.state.selection.main.head, tail = view.state.doc.sliceString(Math.max(0, at - maxTrigger), at);
      for (const snippet of snippets) {
        if (automatic && snippet.manual) continue;
        if (!tail.endsWith(snippet.trigger)) continue;
        let from = at - snippet.trigger.length, math = mathAt(from, at);
        if (!math) continue;
        let before = view.state.doc.sliceString(math.from, from), template = snippet.replacement;
        if (snippet.kind === 'environment') {
          const block = math.open === '$$' || math.open === '\\[';
          const prefix = /^[ \t]*(?:>[ \t]*)*/.exec(view.state.doc.lineAt(from).text)[0];
          template = template.replace(/\n/g, block ? '\n' + prefix : ' ');
        }
        const command = view.state.field(field).command;
        const adjacent = command && (command.to === from || command.to + 1 === from && view.state.doc.sliceString(command.to, from) === ' ');
        if (snippet.kind === 'accent') {
          const operand = adjacent ? command.text : /(\\[A-Za-z]+|[A-Za-z])$/.exec(before)?.[0];
          if (operand && (operand.length === 1 && !/[A-Za-z\\]$/.test(before.slice(0, -1)) || greek.has(operand.slice(1)))) {
            from = adjacent ? command.from : from - operand.length;
            before = view.state.doc.sliceString(math.from, from); template = template.replace('$1', () => operand);
          }
        }
        if (/\\[A-Za-z]*$/.test(before) && !adjacent) continue;
        let slashes = 0; for (let index = before.length - 1; index >= 0 && before[index] === '\\'; index--) slashes++;
        if (slashes % 2) continue;
        if (snippet.boundary === 'start' && /[A-Za-z0-9_\\]$/.test(before) && !adjacent) continue;
        if (snippet.boundary === 'suffix' && !/[A-Za-z0-9}\])|]$/.test(before) && !adjacent) continue;
        if (snippet.boundary === 'suffix' && adjacent && command.to + 1 === from) from--;
        return insert(from, at, template);
      }
      return false;
    }
    function subscript() {
      if (!options.subscripts || !ready() || !view.state.selection.main.empty) return false;
      const at = view.state.selection.main.head;
      if (!/[0-9]/.test(view.state.doc.sliceString(Math.max(0, at - 1), at))) return false;
      const math = mathAt(); if (!math) return false;
      const before = view.state.doc.sliceString(math.from, at);
      const match = numericSubscript.exec(before);
      if (!match || /[A-Za-z\\]$/.test(before.slice(0, -match[0].length))) return false;
      return insert(at - match[0].length, at, match[1] + '_{' + (match[2] || '') + match[3] + '}$0');
    }
    function fraction() {
      if (!options.autoFraction || !ready() || !view.state.selection.main.empty) return false;
      const at = view.state.selection.main.head;
      if (at < 1 || view.state.doc.sliceString(at - 1, at) !== '/') return false;
      const math = mathAt(); if (!math) return false;
      const { tokens } = scan(math), end = at - 1;
      const last = tokens.findIndex(token => token.to === end);
      if (last < 0) return false;
      function operand(index, depth = 0) {
        if (depth > 128) return null;
        const token = tokens[index]; if (!token || token.env || token.unmatched) return null;
        let first = index;
        if (token.close) {
          if (!token.pair) return null;
          first = token.pair.open.index;
          if (tokens[first - 1]?.to === tokens[first].from) {
            if (/^[A-Za-z0-9]+$|^\\[A-Za-z]+$/.test(tokens[first - 1].text)) first--;
            else if (tokens[first].text === '{' && tokens[first - 1].text === '}') {
              const previous = operand(first - 1, depth + 1); if (previous != null) first = previous;
            }
          }
        } else if (!/^[A-Za-z0-9]+$|^\\[A-Za-z]+$/.test(token.text)) return null;
        if (/^[\^_]$/.test(tokens[first - 1]?.text || '') && tokens[first - 1].to === tokens[first].from) {
          const base = operand(first - 2, depth + 1); if (base == null) return null; first = base;
        }
        return first;
      }
      const first = operand(last); if (first == null) return false;
      const from = tokens[first].from;
      if (!mathAt(from, at)) return false;
      let numerator = view.state.doc.sliceString(from, end);
      if (tokens[first].text === '(' && tokens[first].pair?.close === tokens[last]) numerator = numerator.slice(1, -1);
      if (numerator.includes('$')) return false;
      return insert(from, at, '\\frac{' + numerator + '}{$1}$0');
    }
    function separateCommand() {
      const command = view.state.field(field).command, at = view.state.selection.main.head;
      if (!command || at <= command.to || !mathAt()) return false;
      const tail = view.state.doc.sliceString(command.to, at);
      if (!/^[A-Za-z]/.test(tail)) return false;
      view.dispatch({ changes: { from: command.to, insert: ' ' }, selection: CM.EditorSelection.cursor(at + 1),
        userEvent: 'input.note-extension', annotations: CM.isolateHistory.of('full') });
      return true;
    }
    function matrixInfo() {
      if (!options.matrix || !ready() || !view.state.selection.main.empty) return null;
      const at = view.state.selection.main.head, math = mathAt(); if (!math) return null;
      const { pairs, unmatched } = scan(math);
      const inside = pairs.filter(pair => pair.open.to <= at && pair.close.from >= at).sort((a, b) => b.open.from - a.open.from);
      if (unmatched.some(token => token.from < at)) return null;
      const inner = inside[0];
      return inner?.open.env && matrices.has(inner.open.env) ? inner : null;
    }
    function matrixKey(exit) {
      const pair = matrixInfo(); if (!pair) return false;
      const at = view.state.selection.main.head;
      if (exit) view.dispatch({ selection: CM.EditorSelection.cursor(pair.close.to), scrollIntoView: true });
      else {
        const line = view.state.doc.lineAt(at), prefix = /^[ \t]*(?:>[ \t]*)*/.exec(line.text)[0];
        view.dispatch({ changes: { from: at, insert: '\\\\\n' + prefix }, selection: CM.EditorSelection.cursor(at + 3 + prefix.length),
          annotations: CM.isolateHistory.of('full'), userEvent: 'input.note-extension', scrollIntoView: true });
      }
      return true;
    }
    function tabout() {
      if (!options.tabout || !view.state.selection.main.empty) return false;
      const at = view.state.selection.main.head, math = mathAt(); if (!math) return false;
      const { pairs, unmatched, tokens } = scan(math);
      if (unmatched.some(token => token.from < at) || tokens.some(token => token.unmatched && token.from < at)) return false;
      const pair = pairs.filter(item => !item.open.env && item.open.to <= at && item.close.from >= at).sort((a, b) => b.open.from - a.open.from)[0];
      const target = pair?.close.to ?? (at === math.to ? math.outerTo : null);
      if (target == null || target === at) return false;
      view.dispatch({ selection: CM.EditorSelection.cursor(target), scrollIntoView: true }); return true;
    }
    function step(backward) {
      if (!ready()) return false;
      if (!backward && (expand() || fraction() || subscript())) return true;
      const stack = view.state.field(field).stack, current = stack[stack.length - 1];
      if (current) {
        const index = Math.max(0, current.index + (backward ? -1 : 1)), stop = current.stops[index];
        view.dispatch({ effects: action.of(stop ? { type: 'move', index } : { type: 'pop' }),
          selection: stop ? CM.EditorSelection.range(stop.from, stop.to) : CM.EditorSelection.cursor(current.exit), scrollIntoView: true });
        return true;
      }
      if (backward) return false;
      if (matrixInfo()) {
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: '&' }, selection: CM.EditorSelection.cursor(at + 1),
          annotations: CM.isolateHistory.of('full'), userEvent: 'input.note-extension', scrollIntoView: true }); return true;
      }
      return tabout();
    }
    function visual(key) {
      if (!options.visualSnippets || !ready()) return false;
      const range = view.state.selection.main;
      if (range.empty || !mathAt(range.from, range.to)) return false;
      const source = view.state.doc.sliceString(range.from, range.to);
      if (!allowedPrefix(view.state.doc.sliceString(mathAt(range.from, range.to).from, range.to))) return false;
      const templates = { U: '\\underbrace{\u0000}_{$1}$0', O: '\\overbrace{\u0000}^{$1}$0',
        B: '\\underset{$1}{\u0000}$0', C: '\\cancel{\u0000}$0', K: '\\cancelto{$1}{\u0000}$0', S: '\\sqrt{\u0000}$0' };
      return insert(range.from, range.to, templates[key], source);
    }
    const plugin = CM.ViewPlugin.fromClass(class {
      update(update) {
        if (update.docChanged && (view.composing || view.compositionStarted || context.inputPending())) {
          const token = ++pending;
          Promise.resolve(context.whenSettled()).then(() => {
            if (token !== pending || !ready() || compositionCancelled) return;
            const extra = mirrorChanges(view.state, view.state.changes([]), true);
            // CodeMirror deliberately joins this event to its preceding IME commit,
            // including when the mirror is far from the physical cursor.
            if (extra.length) view.dispatch({ changes: extra, userEvent: 'input.type.compose' });
          });
          return;
        }
        if (!update.docChanged || !ready()
          || !update.transactions.some(transaction => transaction.isUserEvent('input.type') && !transaction.isUserEvent('input.type.compose'))
          || update.transactions.some(transaction => transaction.isUserEvent('input.paste'))) return;
        const state = update.state, token = ++pending;
        queueMicrotask(() => {
          if (token !== pending || state !== view.state || !ready()) return;
          if (options.automatic && (expand(true) || fraction() || subscript())) return;
          separateCommand();
        });
      }
      destroy() { pending++; cached = null; }
    });
    return { extension: [field, mirrorFilter, plugin,
      CM.EditorView.domEventHandlers({
        compositionstart() { compositionCancelled = false; },
        compositionend(event) { compositionCancelled = event.data === ''; },
      }),
      CM.EditorView.inputHandler.of((_view, from, to, text) => from !== to && /^[UOBCKS]$/.test(text) && visual(text)),
      CM.Prec.highest(CM.keymap.of([
      { key: 'Tab', run: () => step(false), shift: () => step(true) },
      { key: 'Enter', run: () => matrixKey(false), shift: () => matrixKey(true) },
      { key: 'Escape', run: () => {
        if (!ready() || !view.state.field(field).stack.length) return false;
        view.dispatch({ effects: action.of({ type: 'clear' }) }); return true;
      } },
    ]))], suspend() { paused = true; pending++; cached = null; }, resume() { paused = false; },
      destroy() { disposed = true; paused = true; pending++; cached = null; } };
  });
})();
