'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/vendor/codemirror/relatum-codemirror.min.js'), 'utf8'), context);
const CM = context.RelatumCodeMirror;
function spans(language, source) {
  const parser = CM.relatumCodeParser(language); assert(parser, language + ' must have a parser');
  const result = [];
  CM.highlightTree(parser.parse(source), CM.relatumCodeStyle, (from, to, className) => result.push({ from, to, className, text: source.slice(from, to) }));
  return result;
}
function styleAt(tokens, source, text) {
  const from = source.indexOf(text); assert(from >= 0);
  return tokens.find(token => token.from <= from && token.to >= from + text.length)?.className || '';
}
const cases = [
  { aliases: ['c', 'h', 'cpp', 'c++', 'arduino', 'ino'], source: '#include <stdio.h>\nint main(void) { /* 中文 */ printf("hello\\n"); return 0xFF; }', checks: [['#include', 'meta'], ['中文', 'comment'], ['hello', 'string'], ['\\n', 'escape'], ['printf', 'function'], ['0xFF', 'number']] },
  { aliases: ['py', 'python', 'PYTHON', 'python3', 'py3'], source: 'def sample(x):\n    value = 7 // 2 # 中文注释\n    return "text\\n"', checks: [['def', 'keyword'], ['//', 'operator'], ['中文注释', 'comment'], ['text', 'string'], ['\\n', 'escape']] },
  { aliases: ['js', 'javascript'], source: 'const message = "ready\\n"; console.log(message);', checks: [['const', 'keyword'], ['ready', 'string'], ['\\n', 'escape'], ['log', 'function']] },
  { aliases: ['matlab', 'octave'], source: "a = A.'; b = A'; c = (A+B)';\ns = 'hello'; t = \"world\"; % 中文\nx = fft(a);", checks: [[".'", 'operator'], ["'hello'", 'string'], ['"world"', 'string'], ['中文', 'comment'], ['fft', 'function']] },
  { aliases: ['verilog', 'v', 'sv', 'systemverilog'], source: 'module blink;\nlogic [7:0] count = 8\'hFF;\n// 中文\ninitial $display("hello");\nendmodule', checks: [['module', 'keyword'], ["8'hFF", 'number'], ['中文', 'comment'], ['"hello"', 'string']] },
  { aliases: ['vhdl', 'vhd'], source: "eNtItY demo Is\nend demo;\nif clk'event and clk = '1' then -- 中文\nend if;", checks: [['eNtItY', 'keyword'], ["'event", 'meta'], ["'1'", 'string'], ['中文', 'comment']] },
  { aliases: ['iecst', 'iec-st', 'structured-text', 'st', 'scl'], source: "vAr enabled : BOOL; END_VAR\nIF %IX0.0 THEN delay := T#100ms; mask := WORD#16#FF; END_IF;\n(* 外层 (* 内层 *) 注释 *)\ntext := 'a$'b';", checks: [['vAr', 'keyword'], ['BOOL', 'type'], ['T#100ms', 'number'], ['WORD#16#FF', 'number'], ['内层', 'comment'], ["'a$'b'", 'string']] },
  { aliases: ['spice', 'spice-netlist', 'pspice', 'ltspice', 'ngspice', 'cir'], source: '* RC circuit 中文\nR1 in out 10k\nC1 out 0 100n\n.tran 1u 10m\n.param gain=1.2e-3\nB1 out 0 V=sin(time) ; comment', checks: [['中文', 'comment'], ['.tran', 'keyword'], ['10k', 'number'], ['100n', 'number'], ['1.2e-3', 'number'], ['sin', 'function']] },
];
for (const fixture of cases) for (const alias of fixture.aliases) {
  const tokens = spans(alias, fixture.source);
  assert(tokens.length, alias + ' has highlighted tokens');
  for (const [text, kind] of fixture.checks) assert(styleAt(tokens, fixture.source, text).includes('note-live-code-' + kind), alias + ' / ' + text + ': ' + JSON.stringify(tokens));
  const fence = '```' + alias + '\n' + fixture.source + '\n```';
  const state = CM.EditorState.create({ doc: fence, extensions: [CM.markdown({base:CM.markdownLanguage,codeLanguages:CM.relatumCodeLanguage}),CM.relatumCodeHighlighting] });
  assert.notEqual(CM.syntaxTree(state).resolveInner(fence.indexOf('\n') + 2, 1).name, 'CodeText', alias + ' mounts in Markdown');
}
for (const name of ['', 'text', 'plain', 'plaintext', 'output', 'txt', 'none', 'unknown-language', 'pyth', 'unknown-python-language', 'not-cpp']) {
  assert.equal(CM.relatumCodeParser(name), null, name + ' stays plain');
  const doc='```'+name+'\nreturn 42;\n```', state=CM.EditorState.create({doc,extensions:[CM.markdown({base:CM.markdownLanguage,codeLanguages:CM.relatumCodeLanguage})]});
  assert.equal(CM.syntaxTree(state).resolveInner(doc.indexOf('return')+2,1).name,'CodeText',name+' must not use fuzzy language matching');
}
for (const name of ['javascript','typescript','json','html','css','java','shell','powershell','sql','latex','markdown']) assert(CM.relatumCodeParser(name), 'preserve existing ' + name);
console.log('note engineering code regression: ok (' + cases.reduce((count, fixture) => count + fixture.aliases.length, 0) + ' aliases)');
