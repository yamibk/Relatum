// A single quiz view; hosts own loading, visibility, Markdown and math lifecycles.
(function () {
  'use strict';
  const core = window.RelatumNoteQuizCore; let nextId = 0;
  function attach(root, options) {
    let source = '', range = options.range, model = null, disposed = false, paused = false, generation = 0, renderedLanguage = '';
    let radios = [], feedback, icon, reset, edit, mathNodes = [], mathCleanups = [], mathJobs = new WeakSet();
    const english = () => (options.language?.() || document.documentElement.lang).startsWith('en');
    const current = () => !disposed && !paused && root.isConnected && options.isCurrent();
    const text = (zh, en) => english() ? en : zh;
    function render(parent, value) {
      const result = options.renderText(value);
      const content = document.createElement('div'); content.className = 'note-quiz-text'; content.innerHTML = result.html;
      parent.append(content); if (result.features?.math) mathNodes.push(content); return content;
    }
    const currentRange = () => options.getRange?.() || range;
    function clearMath() { generation++; mathJobs = new WeakSet(); mathCleanups.splice(0).forEach(cleanup => cleanup()); }
    function typeset() {
      const ticket = generation;
      mathNodes.forEach(node => {
        if (node.closest('[hidden]') || mathJobs.has(node)) return;
        mathJobs.add(node);
        options.typesetMath?.(node, () => ticket === generation && current(), () => { if (current()) options.onLayout?.(); })
          ?.then(cleanup => { if (ticket === generation && !disposed) mathCleanups.push(cleanup); else cleanup?.(); });
      });
    }
    function refresh() {
      if (!model || disposed) return;
      const selected = options.session.get(options.notePath, currentRange(), model.fingerprint), result = core.evaluate(model, selected);
      radios.forEach((radio, index) => { radio.checked = selected === index; });
      const opening = feedback.hidden && result.answered;
      feedback.hidden = !result.answered; reset.hidden = !result.answered;
      root.dataset.quizState = result.answered ? result.correct ? 'correct' : 'incorrect' : 'unanswered';
      icon.textContent = result.correct ? '✓' : '!';
      icon.setAttribute('aria-label', result.correct ? text('回答正确', 'Correct') : text('回答错误', 'Incorrect'));
      if (opening) typeset(); options.onLayout?.();
    }
    function choose(index) {
      if (!current()) return;
      options.session.set(options.notePath, currentRange(), model.fingerprint, index); refresh();
    }
    function build(value, nextRange) {
      clearMath(); source = String(value || ''); range = nextRange; mathNodes = []; radios = [];
      renderedLanguage = english();
      root.replaceChildren(); root.classList.add('note-quiz'); root.contentEditable = 'false';
      root.classList.toggle('has-quiz-edit', !!options.onEdit);
      const parsed = core.parse(source); model = parsed.model;
      if (!parsed.valid) {
        root.dataset.quizState = 'invalid';
        const code = document.createElement('pre'); code.className = 'note-quiz-source'; code.textContent = '```quiz\n' + source + '\n```';
        const message = document.createElement('small'); message.className = 'note-quiz-error';
        const labels = { size: ['题块过大，请缩短内容。', 'This quiz is too large.'], question: ['请填写题干。', 'Add a question.'],
          options: ['请填写至少两个选项。', 'Add at least two options.'], answer: ['单选题需要恰好一个 [x] 正确答案。', 'Mark exactly one correct answer with [x].'],
          'empty-option': ['选项不能为空。', 'Options cannot be empty.'], 'option-line': ['每个选项占一行，解析写在 --- 后。', 'Use one line per option; put the explanation after ---.'] };
        message.textContent = (labels[parsed.error] || labels.options)[english() ? 1 : 0]; root.append(code, message);
      } else {
        const id = 'note-quiz-' + ++nextId;
        const question = document.createElement('div'); question.className = 'note-quiz-question'; question.id = id + '-question'; render(question, model.question);
        const group = document.createElement('div'); group.className = 'note-quiz-options'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', question.id);
        model.choices.forEach((choice, index) => {
          const row = document.createElement('div'); row.className = 'note-quiz-option';
          const radio = document.createElement('input'); radio.type = 'radio'; radio.name = id; radio.value = String(index); radio.dataset.quizOption = String(index);
          const label = render(row, choice); label.id = id + '-option-' + index; radio.setAttribute('aria-labelledby', label.id); row.prepend(radio); radios.push(radio);
          radio.addEventListener('change', () => choose(index));
          row.addEventListener('click', event => { if (!event.target.closest('a,input')) { radio.focus({ preventScroll: true }); choose(index); } }); group.append(row);
        });
        feedback = document.createElement('div'); feedback.className = 'note-quiz-feedback'; feedback.hidden = true; feedback.setAttribute('aria-live', 'polite');
        icon = document.createElement('span'); icon.className = 'note-quiz-result-icon'; icon.setAttribute('role', 'img');
        const body = document.createElement('div'); body.className = 'note-quiz-feedback-body';
        const answer = document.createElement('div'); answer.className = 'note-quiz-answer';
        const caption = document.createElement('span'); caption.textContent = text('正确答案：', 'Correct answer: '); answer.append(caption); render(answer, model.choices[model.answer]); body.append(answer);
        if (model.explanation) render(body, model.explanation); feedback.append(icon, body);
        reset = document.createElement('button'); reset.type = 'button'; reset.className = 'note-quiz-reset'; reset.hidden = true; reset.textContent = text('重做', 'Try again');
        reset.addEventListener('click', () => { if (!current()) return; options.session.set(options.notePath, currentRange(), model.fingerprint, null); radios[0].focus({ preventScroll: true }); refresh(); });
        root.append(question, group, feedback, reset); refresh();
      }
      if (options.onEdit) {
        edit = document.createElement('button'); edit.type = 'button'; edit.className = 'note-quiz-edit'; edit.textContent = text('编辑题目', 'Edit question');
        edit.addEventListener('click', () => { if (current()) options.onEdit(); }); root.append(edit);
      }
      typeset(); options.onLayout?.();
    }
    function onPointer(event) { if (!event.target.closest('a') && event.target.tagName !== 'INPUT') event.preventDefault(); event.stopPropagation(); }
    function onClick(event) {
      event.stopPropagation();
      if (!current()) { event.preventDefault(); return; }
      const link = event.target.closest('a'); if (link) { event.preventDefault(); if (current()) options.onLink?.(link.getAttribute('href')); }
    }
    function onKey(event) {
      if (event.target.matches('input,button,a')) event.stopPropagation();
      if (!current()) { event.preventDefault(); return; }
      if (event.target.type === 'radio' && /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) {
        event.preventDefault(); const at = radios.indexOf(event.target), direction = /Up|Left/.test(event.key) ? -1 : 1;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1 : (at + direction + radios.length) % radios.length;
        if (current()) { radios[index].focus({ preventScroll: true }); choose(index); }
      }
    }
    root.addEventListener('mousedown', onPointer); root.addEventListener('click', onClick); root.addEventListener('keydown', onKey);
    build(options.source, range);
    return {
      update(value, nextRange) { if (disposed) return; if (String(value) !== source || renderedLanguage !== english()) build(value, nextRange); else { range = nextRange; refresh(); } },
      suspend() { if (paused) return; paused = true; clearMath(); },
      resume() { if (!paused || disposed) return; paused = false; refresh(); typeset(); },
      destroy() { if (disposed) return; disposed = true; clearMath(); root.removeEventListener('mousedown', onPointer); root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); root.replaceChildren(); },
    };
  }
  window.RelatumNoteQuiz = Object.freeze({ attach });
})();
