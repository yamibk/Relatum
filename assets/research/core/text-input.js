/** Local text history belongs to one field/object, separate from document commands. */
export function bindTextInput(field, { signal, commit, canEdit }) {
  let owner = null, history = [], index = 0, bytes = 0;
  const snapshot = () => ({ value: field.value, start: field.selectionStart, end: field.selectionEnd });
  function reset(id) { owner = id; history = [snapshot()]; index = 0; bytes = field.value.length * 2; }
  function record() {
    if (!canEdit() || history[index]?.value === field.value) return;
    history.splice(index + 1); history.push(snapshot()); index++;
    bytes = history.reduce((sum, item) => sum + item.value.length * 2, 0);
    while ((bytes > 4 * 1024 * 1024 || history.length > 200) && history.length > 2) { bytes -= history.shift().value.length * 2; index--; }
    commit(field);
  }
  function travel(redo) {
    if (!canEdit()) return;
    const next = index + (redo ? 1 : -1);
    if (next < 0 || next >= history.length) return;
    index = next; const item = history[index]; field.value = item.value;
    if (item.start != null) field.setSelectionRange(item.start, item.end);
    commit(field);
  }
  field.addEventListener('beforeinput', event => {
    if (event.isComposing || !canEdit()) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); travel(event.inputType === 'historyRedo');
    } else if (history[index]?.value === field.value) history[index] = snapshot();
  }, { signal });
  field.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || !canEdit()) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
      event.preventDefault(); event.stopPropagation(); travel(key === 'y' || event.shiftKey);
    }
  }, { signal });
  return { record, sync(id, value, force = false) {
    if (force || owner !== id || (document.activeElement !== field && field.value !== value)) {
      field.value = value; reset(id);
    }
  } };
}
