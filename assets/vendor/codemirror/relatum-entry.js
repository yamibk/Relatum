// Reproducible entry for the checked-in offline asset. Versions and licenses
// live beside this source; scripts/build-note-codemirror.js needs no npm setup.
import { LanguageDescription, LanguageSupport, StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { cppLanguage } from '@codemirror/lang-cpp';
import { pythonLanguage } from '@codemirror/lang-python';
import { javascriptLanguage, jsxLanguage, typescriptLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { htmlLanguage } from '@codemirror/lang-html';
import { cssLanguage } from '@codemirror/lang-css';
import { javaLanguage } from '@codemirror/lang-java';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl';
import { structuredText, spice } from './note-languages.js';

export { Compartment, EditorSelection, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, Transaction } from '@codemirror/state';
export { BlockType, Decoration, Direction, EditorView, MatchDecorator, ViewPlugin, WidgetType, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars, keymap, placeholder, rectangularSelection, showTooltip, tooltips } from '@codemirror/view';
export { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, bracketMatching, defaultHighlightStyle, forceParsing, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
export { commonmarkLanguage, markdown, markdownLanguage, markdownKeymap, deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
export { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, selectAll, undo } from '@codemirror/commands';
export { closeSearchPanel, highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search';
export { closeBrackets, closeBracketsKeymap, autocompletion, startCompletion, closeCompletion, completionStatus, selectedCompletion, moveCompletionSelection, acceptCompletion } from '@codemirror/autocomplete';
export { highlightTree } from '@lezer/highlight';

const support = language => new LanguageSupport(language);
const stream = mode => support(StreamLanguage.define(mode));
const language = (name, alias, parser) => LanguageDescription.of({ name, alias, support: parser });
// Preserve the pinned modes, with small lexical adapters for engineering syntax
// that the legacy modes predate. None of these adapters rewrites source text.
const matlab = {
  ...octave,
  startState: () => ({ ...octave.startState(), transpose: false, tokenEnd: -1 }),
  token(input, state) {
    if (input.sol()) { state.transpose = false; state.tokenEnd = -1; }
    if (state.transpose && input.pos === state.tokenEnd && input.match(/^\.?'/)) {
      state.tokenEnd = input.pos; return 'operator';
    }
    const style = octave.token(input, state), text = input.current();
    if (text.trim()) {
      state.transpose = /^(?:variable|number|string|builtin)$/.test(style || '') || /^[)\]}]$/.test(text);
      state.tokenEnd = input.pos;
    }
    return style;
  },
};
const lowerCurrent = function () { return this.string.slice(this.start, this.pos).toLowerCase(); };
const vhdlMode = {
  ...vhdl,
  token(input, state) {
    if (!state.tokenize && input.match(/^'[A-Za-z_]\w*\b(?!')/)) return 'attributeName';
    const current = input.current; input.current = lowerCurrent;
    try { return vhdl.token(input, state); } finally { input.current = current; }
  },
};
export const relatumCodeLanguages = [
  language('C', ['c', 'h'], support(cppLanguage)),
  language('C++', ['cpp', 'c++', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'arduino', 'ino'], support(cppLanguage)),
  language('Python', ['python', 'py', 'python3', 'py3'], support(pythonLanguage)),
  language('JavaScript', ['javascript', 'js', 'mjs'], support(javascriptLanguage)),
  language('JSX', ['jsx'], support(jsxLanguage)),
  language('TypeScript', ['typescript', 'ts'], support(typescriptLanguage)),
  language('TSX', ['tsx'], support(tsxLanguage)),
  language('JSON', ['json'], support(jsonLanguage)),
  language('HTML', ['html', 'htm'], support(htmlLanguage)),
  language('CSS', ['css'], support(cssLanguage)),
  language('Java', ['java'], support(javaLanguage)),
  language('Shell', ['shell', 'sh', 'bash', 'zsh'], stream(shell)),
  language('PowerShell', ['powershell', 'ps1'], stream(powerShell)),
  language('SQL', ['sql'], stream(standardSQL)),
  language('LaTeX', ['latex', 'tex'], stream(stex)),
  language('MATLAB', ['matlab', 'octave'], stream(matlab)),
  language('Verilog', ['verilog', 'v', 'systemverilog', 'sv'], stream(verilog)),
  language('VHDL', ['vhdl', 'vhd'], stream(vhdlMode)),
  language('Structured Text', ['iecst', 'iec-st', 'structured-text', 'st', 'scl'], stream(structuredText)),
  language('SPICE', ['spice', 'spice-netlist', 'pspice', 'ltspice', 'ngspice', 'cir'], stream(spice)),
  language('Markdown', ['markdown', 'md'], support(markdownLanguage)),
];

export const relatumCodeStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'note-live-code-comment' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.operatorKeyword], class: 'note-live-code-keyword' },
  { tag: [tags.typeName, tags.className, tags.bool, tags.null], class: 'note-live-code-type' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], class: 'note-live-code-string' },
  { tag: tags.escape, class: 'note-live-code-escape' },
  { tag: [tags.number, tags.integer, tags.float], class: 'note-live-code-number' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.standard(tags.variableName)], class: 'note-live-code-function' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], class: 'note-live-code-definition' },
  { tag: [tags.meta, tags.macroName, tags.processingInstruction, tags.annotation, tags.attributeName], class: 'note-live-code-meta' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], class: 'note-live-code-operator' },
  { tag: tags.invalid, class: 'note-live-code-invalid' },
]);
export const relatumCodeHighlighting = syntaxHighlighting(relatumCodeStyle);

// Exact fence names only. Unknown/plain fences never borrow a fuzzy match.
export function relatumCodeLanguage(name) {
  const label = String(name || '').trim().toLowerCase().split(/\s+/, 1)[0];
  if (!label || /^(?:text|plain|plaintext|txt|output|none)$/.test(label)) return null;
  return LanguageDescription.matchLanguageName(relatumCodeLanguages, label, false)?.support?.language || null;
}
export function relatumCodeParser(name) {
  return relatumCodeLanguage(name)?.parser || null;
}
