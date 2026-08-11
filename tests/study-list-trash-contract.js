const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const study = fs.readFileSync(path.join(root, 'assets', 'study.js'), 'utf8');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');

assert(study.includes("actions.className = 'study-list-actions'")
  && study.includes("archiveBtn.className = 'study-list-archive'")
  && study.includes("trashBtn.className = 'study-list-trash'")
  && study.includes('actions.appendChild(archiveBtn);')
  && study.includes('actions.appendChild(trashBtn);')
  && study.includes('actions.appendChild(addBtn);'),
  'compact Study must place archive and trash icons before the add icon');
assert(study.includes("archiveBtn.addEventListener('click', function (event) { event.stopPropagation(); archiveDone(); });")
  && study.includes("archiveBtn.dataset.action = 'archive-done';")
  && study.includes('window.StudyView.archiveDone = archiveDone;')
  && start.includes('window.StudyView.archiveDone();'),
  'compact Study archive icon must reuse the existing completed-task archive action');
assert(study.includes("trashBtn.addEventListener('click', function (event) { event.stopPropagation(); openTrash(); });"),
  'compact Study trash icon must open the existing trash panel');
assert(study.includes("removeBtn.className = 'study-list-remove'")
  && study.includes('trashTaskById(task.id);'),
  'compact Study rows must reuse the direct move-to-trash path');
assert(!/study-list-remove[\s\S]{0,500}(confirm|openTrashConfirm)/.test(study),
  'compact Study row removal must not add a confirmation step');
assert(study.includes("const buttons = Array.from(document.querySelectorAll('[data-action=\"archive-done\"]'));")
  && study.includes('if (buttons.some((button) => button.disabled)) return;')
  && study.includes('buttons.forEach((button) => { button.disabled = true; });'),
  'all archive entry points must share the same in-flight lock');
assert(!index.includes('这里只处理任务。关联画布在删除任务时已进入 Relatum 回收站，可在那里恢复。')
  && !styles.includes('.study-trash-card > header p:not(.study-eyebrow)'),
  'the task trash panel must not retain the removed explanatory copy or its unused styling');
assert(index.includes('<h2 class="confirm-title" id="study-trash-confirm-title">永久清空任务回收站</h2>')
  && !index.includes('永久清空任务回收站？')
  && !index.includes('这里将只清除任务记录，且不可恢复。')
  && !styles.includes('.trash-empty-warning')
  && i18n.includes("'永久清空任务回收站': 'Permanently empty Task Trash'"),
  'empty-trash confirmation must keep only the concise bilingual title');
assert(study.includes("const archiveMessage = '已归档' + json.count + '项已完成任务';")
  && !study.includes("件任务，关联画布已移到回收站 · data/学习归档/")
  && i18n.includes("return `Archived ${match[1]} completed ${match[1] === '1' ? 'task' : 'tasks'}`;"),
  'archive success copy must stay concise in Chinese and support singular/plural English');

assert(styles.includes('.study-list-row:hover .study-list-remove,')
  && styles.includes('.study-list-remove:focus-visible')
  && styles.includes('pointer-events: none;')
  && styles.includes('pointer-events: auto;'),
  'compact Study remove controls must reveal on row hover or their own keyboard focus');

console.log('study list trash contract passed');
