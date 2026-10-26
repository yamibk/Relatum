// Relatum's small snippet engine, inspired by LaTeX Suite's documented workflow.
// No Obsidian code, executable snippet files, parser, renderer or dependencies.
(function () {
  'use strict';
  const registry = window.RelatumNoteExtensions;
  const snippets = registry.list().find(item => item.id === 'latex-input').snippets.slice().sort((a, b) => b.trigger.length - a.trigger.length);
  function parseTemplate(template, start) {
    let text = '', cursor = 0, exit = null;
    const stops = [];
    for (const match of template.matchAll(/\$(\d+)/g)) {
      text += template.slice(cursor, match.index);
      const position = start + text.length, number = Number(match[1]);
      if (number === 0) exit = position; else stops.push({ number, from: position, to: position });
      cursor = match.index + match[0].length;
    }
    text += template.slice(cursor); stops.sort((a, b) => a.number - b.number);
    return { text, stops, exit: exit ?? start + text.length };
  }
  // Inspect only the prefix of the already identified, bounded formula.
  function allowedPrefix(source) {
    const groups = [];
    let command = '', remaining = 0;
    for (let index = 0; index < source.length; index++) {
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
        groups.push({ blocked: /^(?:text\w*|mbox|operatorname|url|href)$/.test(command) || groups.some(group => group.blocked),
          follow: remaining > 1 ? { command, remaining: remaining - 1 } : null });
        command = ''; remaining = 0;
      } else if (char === '}') {
        const follow = groups.pop()?.follow; command = follow?.command || ''; remaining = follow?.remaining || 0;
      } else if (!/\s/.test(char)) { command = ''; remaining = 0; }
    }
    return !groups.some(group => group.blocked);
  }
  registry.registerRuntime('latex-input', (context, options) => {
    const { CM, view } = context;
    const action = CM.StateEffect.define();
    let paused = false, disposed = false, pending = 0;
    const ready = () => !paused && !disposed && context.isActive() && !context.inputPending()
      && context.acceptsInput() !== false
      && !view.composing && !view.compositionStarted && !view.state.readOnly && view.state.selection.ranges.length === 1;
    const contains = (session, selection) => selection.from >= session.from && selection.to <= session.to;
    const field = CM.StateField.define({
      create: () => [],
      update(stack, transaction) {
        if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.newSelection.ranges.length !== 1) return [];
        if (transaction.docChanged) stack = stack.map(session => ({ ...session,
          from: transaction.changes.mapPos(session.from, -1), to: transaction.changes.mapPos(session.to, 1),
          exit: transaction.changes.mapPos(session.exit, 1),
          stops: session.stops.map(stop => ({ ...stop, from: transaction.changes.mapPos(stop.from, -1), to: transaction.changes.mapPos(stop.to, 1) })),
        }));
        for (const effect of transaction.effects) if (effect.is(action)) {
          if (effect.value.type === 'clear') stack = [];
          else if (effect.value.type === 'push') stack = stack.concat(effect.value.session);
          else if (effect.value.type === 'pop') stack = stack.slice(0, -1);
          else if (effect.value.type === 'move' && stack.length) stack = stack.slice(0, -1).concat({ ...stack[stack.length - 1], index: effect.value.index });
        }
        while (stack.length && !contains(stack[stack.length - 1], transaction.newSelection.main)) stack = stack.slice(0, -1);
        return stack;
      },
    });
    function findSnippet() {
      if (!ready() || !view.state.selection.main.empty) return null;
      const at = view.state.selection.main.head, tail = view.state.doc.sliceString(Math.max(0, at - 8), at);
      const snippet = snippets.find(item => tail.endsWith(item.trigger));
      if (!snippet) return null;
      const from = at - snippet.trigger.length, math = context.mathAt(view.state, from, at);
      if (!math) return null;
      const before = view.state.doc.sliceString(math.from, from);
      if (!allowedPrefix(before) || /\\[A-Za-z]*$/.test(before)) return null;
      let slashes = 0;
      for (let index = before.length - 1; index >= 0 && before[index] === '\\'; index--) slashes++;
      if (slashes % 2) return null;
      if (snippet.boundary === 'start' && /[A-Za-z0-9_\\]$/.test(before)) return null;
      if (snippet.boundary === 'suffix' && !/[A-Za-z0-9}\])|]$/.test(before)) return null;
      return { snippet, from, to: at };
    }
    function expand() {
      const found = findSnippet(); if (!found) return false;
      const { snippet, from, to } = found, parsed = parseTemplate(snippet.replacement, from);
      const first = parsed.stops[0], effects = [];
      if (first) effects.push(action.of({ type: 'push', session: { from, to: from + parsed.text.length,
        exit: parsed.exit, stops: parsed.stops, index: 0 } }));
      view.dispatch({ changes: { from, to, insert: parsed.text },
        selection: CM.EditorSelection.range(first?.from ?? parsed.exit, first?.to ?? parsed.exit), effects,
        annotations: CM.isolateHistory.of('full'), userEvent: 'input.note-extension', scrollIntoView: true });
      return true;
    }
    function step(backward) {
      if (!ready()) return false;
      const stack = view.state.field(field), current = stack[stack.length - 1];
      if (!current) return !backward && expand();
      const index = Math.max(0, current.index + (backward ? -1 : 1));
      const stop = current.stops[index];
      view.dispatch({ effects: action.of(stop ? { type: 'move', index } : { type: 'pop' }),
        selection: stop ? CM.EditorSelection.range(stop.from, stop.to) : CM.EditorSelection.cursor(current.exit), scrollIntoView: true });
      return true;
    }
    const plugin = CM.ViewPlugin.fromClass(class {
      update(update) {
        if (!options.automatic || !update.docChanged || !ready()
          || !update.transactions.some(transaction => transaction.isUserEvent('input.type') && !transaction.isUserEvent('input.type.compose'))
          || update.transactions.some(transaction => transaction.isUserEvent('input.paste'))) return;
        const state = update.state, token = ++pending;
        // A separate history boundary restores the literal trigger on Undo.
        queueMicrotask(() => { if (token === pending && state === view.state && ready()) expand(); });
      }
      destroy() { pending++; }
    });
    return { extension: [field, plugin, CM.Prec.highest(CM.keymap.of([
      { key: 'Tab', run: () => step(false), shift: () => step(true) },
      { key: 'Escape', run: () => {
        if (!ready() || !view.state.field(field).length) return false;
        view.dispatch({ effects: action.of({ type: 'clear' }) }); return true;
      } },
    ]))],
      suspend() { paused = true; pending++; }, resume() { paused = false; },
      destroy() { disposed = true; paused = true; pending++; },
    };
  });
})();
