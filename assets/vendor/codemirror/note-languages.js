// Relatum's small, offline textual engineering modes. These are lexers, not
// compilers or simulators; all source characters remain owned by CodeMirror.
const words = text => new Set(text.split(/\s+/));
const stKeywords = words('ACTION AND ARRAY AT BY CASE CONFIGURATION CONSTANT DO ELSE ELSIF END_ACTION END_CASE END_CONFIGURATION END_FOR END_FUNCTION END_FUNCTION_BLOCK END_IF END_PROGRAM END_REPEAT END_RESOURCE END_STEP END_STRUCT END_TRANSITION END_TYPE END_VAR END_WHILE EXIT FALSE FOR FROM FUNCTION FUNCTION_BLOCK IF IN INITIAL_STEP MOD NON_RETAIN NOT OF OR POINTER PROGRAM REF_TO REPEAT RESOURCE RETAIN RETURN STEP STRUCT TASK THEN TO TRANSITION TRUE TYPE UNTIL VAR VAR_ACCESS VAR_CONFIG VAR_EXTERNAL VAR_GLOBAL VAR_IN_OUT VAR_INPUT VAR_OUTPUT VAR_TEMP WHILE WITH XOR');
const stTypes = words('BOOL BYTE WORD DWORD LWORD SINT INT DINT LINT USINT UINT UDINT ULINT REAL LREAL TIME LTIME DATE LDATE TIME_OF_DAY TOD LTOD DATE_AND_TIME DT LDT STRING WSTRING CHAR WCHAR ANY ANY_BIT ANY_DATE ANY_INT ANY_NUM ANY_REAL');
const stBuiltins = words('ABS SQRT LN LOG EXP SIN COS TAN ASIN ACOS ATAN ATAN2 EXPT ADD MUL SUB DIV MOVE SEL MAX MIN LIMIT MUX SHL SHR ROL ROR LEN LEFT RIGHT MID CONCAT INSERT DELETE REPLACE FIND TON TOF TP CTU CTD CTUD R_TRIG F_TRIG RS SR');

function stComment(stream, state) {
  while (!stream.eol()) {
    if (stream.match('(*')) state.commentDepth++;
    else if (stream.match('*)')) { if (!--state.commentDepth) break; }
    else stream.next();
  }
  return 'comment';
}
function stString(stream, state) {
  while (!stream.eol()) {
    const char = stream.next();
    if (char === '$') stream.next();
    else if (char === state.quote && !stream.eat(state.quote)) { state.quote = ''; break; }
  }
  // An unfinished line is still editable text, rather than a diagnostic.
  if (stream.eol()) state.quote = '';
  return 'string';
}
export const structuredText = {
  name: 'structured-text',
  startState: () => ({ commentDepth: 0, quote: '' }),
  token(stream, state) {
    if (state.commentDepth) return stComment(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('(*')) { state.commentDepth = 1; return stComment(stream, state); }
    if (stream.match(/^(?:LTIME|TIME|LT|T|LDATE|DATE|LD|D|LTOD|TOD|TIME_OF_DAY|LDT|DT|DATE_AND_TIME)#[+\-]?[\d][\w.:+\-]*/i)) return 'number';
    if (stream.match(/^(?:(?:U?[SLD]?INT|L?WORD|BYTE|REAL|LREAL|BOOL)#)?(?:2#[01_]+|8#[0-7_]+|16#[\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+\-]?[\d_]+)?)/i)) return 'number';
    if (stream.match(/^%[IQM][XBWDL]?(?:\d+|\*)(?:\.\d+)*/i)) return 'variableName.special';
    if (stream.peek() === "'" || stream.peek() === '"') { state.quote = stream.next(); return stString(stream, state); }
    if (stream.match(/^#?[A-Za-z_][\w]*/)) {
      const name = stream.current().toUpperCase();
      if (stTypes.has(name)) return 'typeName';
      if (stKeywords.has(name)) return /^(?:TRUE|FALSE)$/.test(name) ? 'bool' : 'keyword';
      if (stBuiltins.has(name) || /^\s*\(/.test(stream.string.slice(stream.pos))) return 'variableName.function';
      return 'variableName';
    }
    if (stream.match(/^(?::=|=>|<>|<=|>=|\*\*|[+\-*/=<>])/)) return 'operator';
    stream.next(); return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '(*', close: '*)' } } },
};

const spiceFunctions = words('abs acos acosh asin asinh atan atan2 atanh ceil cos cosh db exp floor if int ln log log10 max min pow pwr pwrs round sgn sin sinh sqrt tan tanh ternary uramp u limit table v i');
export const spice = {
  name: 'spice',
  startState: () => ({ first: true }),
  token(stream, state) {
    if (stream.sol()) state.first = true;
    if (stream.eatSpace()) return null;
    if (state.first && stream.peek() === '*' || stream.match(/^(?:;|\$|\/\/)/)) { stream.skipToEnd(); return 'comment'; }
    const first = state.first; state.first = false;
    if (first && stream.match(/^\.[A-Za-z_][\w]*/)) return 'keyword';
    if (first && stream.match(/^\+/)) return 'operator';
    if (first && stream.match(/^[A-Za-z][\w.$:-]*/)) return 'definitionKeyword';
    if (stream.match(/^["'](?:[^"'\\]|\\.)*["']/)) return 'string';
    if (stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?(?:meg|mil|[tgkmunpf])?(?:[a-z]+)?/i)) return 'number';
    if (stream.match(/^[A-Za-z_][\w.$:]*/)) {
      const name = stream.current().toLowerCase();
      return spiceFunctions.has(name) && /^\s*\(/.test(stream.string.slice(stream.pos)) ? 'variableName.function' : 'variableName';
    }
    if (stream.match(/^[+\-*/^=<>!?:]+/)) return 'operator';
    stream.next(); return null;
  },
  languageData: { commentTokens: { line: '*' } },
};
