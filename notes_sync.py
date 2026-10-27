"""Bounded note indexing and filesystem notifications, using the standard library."""
from __future__ import annotations

import ctypes
import os
import stat
import struct
import threading
import time
from collections import OrderedDict
from pathlib import Path

from notes_index import book_root, normalize


class NoteSync:
    def __init__(self, store, *, background=False):
        self.store, self.background = store, background
        self._condition = threading.Condition(threading.RLock())
        self._scan_lock = threading.Lock()
        self._pending = OrderedDict()
        self._color_renames = []
        self._saved = OrderedDict()
        self._saved_bytes = 0
        self._stop = threading.Event()
        self._worker = self._watcher = None
        self._scan_requested = True
        self._verify_scan = False
        self._scanned = False
        self._scanning = False
        self._active_until = 0
        self._foreground_until = 0
        self._visibility_epoch = 0
        self._epoch = 0
        self._serial = 0
        self._retired = {}
        self._processing = False
        self._processing_path = None
        self._incomplete = set()
        self._directory_failed = set()
        self._graph_books = set()
        self._last_scan = 0
        self._watch_supported = False
        self._maintenance_requested = False

    def start(self):
        with self._condition:
            if self._worker or self._stop.is_set():
                return
            self.store.ensure_root()
            self._worker = threading.Thread(target=self._run, name='note-index', daemon=True)
            self._worker.start()
            if os.name == 'nt':
                self._watcher = threading.Thread(target=self._watch_windows, name='note-files', daemon=True)
                self._watcher.start()

    def activity(self, visible):
        with self._condition:
            returning = not self.active
            if not visible:
                self._visibility_epoch += 1
            self._active_until = time.monotonic() + 45 if visible else 0
            if visible and returning:
                self._scan_requested = True
            self._condition.notify_all()
        if visible and self.background:
            self.start()

    @property
    def active(self):
        return not self.background or time.monotonic() < self._active_until

    def foreground(self):
        # Atomic Markdown saves take precedence; continue indexing after a
        # short quiet period. An already started file finishes its next stage.
        if self.background:
            # Publishing the deadline must itself never wait behind a metadata
            # registration transaction holding the scheduler condition.
            self._foreground_until = time.monotonic() + .25

    def cooperate(self):
        if self.background and threading.current_thread() is self._worker:
            if not self.active or self._stop.is_set():
                raise InterruptedError('笔记索引已暂停')
            with self._condition:
                while not self._stop.is_set() and time.monotonic() < self._foreground_until:
                    self._condition.wait(min(.05, self._foreground_until - time.monotonic()))
            if not self.active or self._stop.is_set():
                raise InterruptedError('笔记索引已暂停')

    def request_scan(self):
        with self._condition:
            self._scan_requested = True; self._condition.notify_all()

    def enqueue(self, path, *, book=None, priority=False, content=None, signature=None, notification=False):
        with self._condition:
            previous = self._saved.pop(path, None) if content is not None or notification else None
            if previous:
                self._saved_bytes -= len(previous[0])
            if content is not None:
                self._saved[path] = (content, signature)
                self._saved_bytes += len(content)
                while self._saved_bytes > 8 * 1024 * 1024:
                    _, removed = self._saved.popitem(last=False)
                    self._saved_bytes -= len(removed[0])
            self._serial += 1
            self._pending[path] = (book, self._serial, self._epoch)
            if priority or path in self._saved:
                self._pending.move_to_end(path, last=False)
            # A mass filesystem operation gets reconciled instead of retaining
            # an unbounded notification queue or any note bodies.
            if len(self._pending) > 8192:
                self._pending.clear(); self._scan_requested = True
                self._verify_scan = True
                self._saved.clear(); self._saved_bytes = 0
            self._condition.notify_all()

    def retire(self, path, *, notebook=False):
        with self._condition:
            self._apply_color_renames()
            prefix = normalize(path)
            self._epoch += 1
            self._serial += 1
            self._retired[normalize(path)] = self._serial
            for item in list(self._pending):
                if not prefix or normalize(item) == prefix or normalize(item).startswith(prefix + '/'):
                    self._pending.pop(item, None)
                    saved = self._saved.pop(item, None)
                    if saved:
                        self._saved_bytes -= len(saved[0])
            self._incomplete = {item for item in self._incomplete if prefix and normalize(item) != prefix and not normalize(item).startswith(prefix + '/')}
            self._directory_failed = {item for item in self._directory_failed if prefix and normalize(item) != prefix and not normalize(item).startswith(prefix + '/')}
            self.store.index.remove(path, notebook=notebook)
            self.store.sync_file_colors('remove', path)
            self._maintenance_requested = True
            self._condition.notify_all()
        self.store._drop_graph_cache(book_root(path))

    def _apply_color_renames(self):
        # Called under the existing scheduler lock, before any old-path cleanup.
        pending, self._color_renames = self._color_renames, []
        for source, destination in pending:
            self.store.sync_file_colors('remap', source, destination)

    def notifications(self, events):
        """Decode one complete kernel batch; never guess across missing pairs."""
        with self._condition:
            previous = None
            for action, raw in events:
                try:
                    name = self.store.normalize_path(raw)
                except ValueError:
                    previous = None
                    continue
                if action == 4:
                    previous = name
                    self._scan_requested = True
                else:
                    if action == 5 and previous:
                        if len(self._color_renames) < 8192:
                            self._color_renames.append((previous, name))
                        self._epoch += 1  # Invalidate a walk begun before this rename.
                    previous = None
                    self.enqueue(name, priority=True, notification=True)
            self._condition.notify_all()

    def graph(self, root):
        self._graph_books.add(normalize(root))

    def prioritize(self, scope):
        with self._condition:
            for path, book in reversed(self.store.index.pending(128, scope)):
                if path in self._pending:
                    self._pending.move_to_end(path, last=False)
                elif path != self._processing_path:
                    self.enqueue(path, book=book, priority=True)

    def _walk(self, scope=None):
        from notes_library import _is_reparse
        records, failed, directories_failed, identities = [], set(), set(), {}
        def visit(folder, prefix):
            if self._stop.is_set() or self.background and not self.active:
                raise InterruptedError('笔记索引已暂停')
            if _is_reparse(folder):
                failed.add(prefix.rstrip('/')); return
            try:
                relative = prefix.rstrip('/')
                if relative == '' or book_root(relative) == relative:
                    data = Path(folder).stat(follow_symlinks=False)
                    identities[relative] = str((data.st_dev, data.st_ino, getattr(data, 'st_birthtime_ns', 0)))
                with os.scandir(folder) as scan:
                    for number, entry in enumerate(scan):
                        if number % 64 == 0:
                            self.cooperate()
                        low = entry.name.casefold()
                        if low.endswith('.assets') or low.startswith('.relatum-') or low == '.trash' \
                                or not prefix and low == 'canvases' \
                                or scope == '' and not prefix and low == 'customnotebook':
                            continue
                        path = prefix + entry.name
                        try:
                            data = entry.stat(follow_symlinks=False)
                            if stat.S_ISLNK(data.st_mode) or getattr(data, 'st_file_attributes', 0) & 1024:
                                continue
                            if stat.S_ISDIR(data.st_mode):
                                if _is_reparse(Path(folder) / entry.name):
                                    continue
                                records.append((path, 'folder', data.st_mtime_ns,
                                    getattr(data, 'st_birthtime_ns', data.st_ctime_ns), 0))
                                visit(Path(folder) / entry.name, path + '/')
                            elif stat.S_ISREG(data.st_mode) and low.endswith('.md'):
                                records.append((path, 'note', data.st_mtime_ns,
                                    getattr(data, 'st_birthtime_ns', data.st_ctime_ns), data.st_size))
                        except InterruptedError:
                            raise
                        except OSError:
                            failed.add(path)
            except InterruptedError:
                raise
            except (OSError, RuntimeError):
                failed.add(prefix.rstrip('/'))
                directories_failed.add(prefix.rstrip('/'))
        self.store.ensure_root()
        target = self.store._absolute(scope, allow_root=True) if scope is not None else self.store.root
        visit(target, (scope + '/') if scope else '')
        self._directory_failed = directories_failed
        self._observed_identities = identities
        return records, failed

    def scan(self, scope=None, *, strict=False, drain=False):
        from notes_library import NotesError
        with self._scan_lock:
            with self._condition:
                self._apply_color_renames()
            epoch = self._epoch
            verify = self._verify_scan
            previous_failures, previous_directory_failures = set(self._incomplete), set(self._directory_failed)
            self._scanning = True
            try:
                records, failed = self._walk(scope)
                if epoch != self._epoch or self._stop.is_set() or self.background and not self.active:
                    self.request_scan(); return
                for root, identity in self._observed_identities.items():
                    if any(not root or path == root or path.startswith(root + '/') or root.startswith(path + '/') for path in failed):
                        continue
                    with self._condition:
                        if epoch != self._epoch:
                            self.request_scan(); return
                        previous = self.store.index.source_identity(root)
                        if previous and previous != identity:
                            self.retire(root, notebook=True)
                            epoch = self._epoch
                        self.store.index.identify(root, identity)
                live = {normalize(row[0]): row[1] for row in records}
                changed_keys = set()
                for begin in range(0, len(records), 64):
                    self.cooperate()
                    if self._stop.is_set() or epoch != self._epoch or self.background and not self.active:
                        self.request_scan(); return
                    with self._condition:
                        if epoch != self._epoch:
                            self.request_scan(); return
                        pending = self.store.index.register(records[begin:begin + 64], verify=verify)
                    for path, book in pending:
                        self.enqueue(path, book=book)
                        changed_keys.update((normalize(Path(path).stem), normalize(path[:-3])))
                    if self.background:
                        time.sleep(0)
                removed_roots = []
                for row in self.store.index.rows(scope, folders=True, directory=True):
                    if epoch != self._epoch or self._stop.is_set() or self.background and not self.active:
                        self.request_scan(); return
                    key = row['key']
                    if any(key.startswith(prefix + '/') for prefix in removed_roots):
                        continue
                    if scope == '' and key == 'customnotebook':
                        continue
                    if key in live or scope and key == normalize(scope):
                        continue
                    if any(key == normalize(p) or key.startswith(normalize(p) + '/') or normalize(p).startswith(key + '/') for p in failed):
                        continue
                    root = book_root(row['path'])
                    with self._condition:
                        if epoch != self._epoch:
                            self.request_scan(); return
                        self.retire(row['path'], notebook=bool(root and normalize(root) == key))
                        if row['kind'] == 'folder':
                            removed_roots.append(key)
                        epoch = self._epoch
                with self._condition:
                    if epoch != self._epoch or self._stop.is_set() or self.background and not self.active:
                        self.request_scan(); return
                    self.store.sync_file_colors('reconcile', live, failed, scope)
                if changed_keys:
                    keys = list(changed_keys)
                    for begin in range(0, len(keys), 128):
                        self.store.index.resolve(keys[begin:begin + 128])
                with self._condition:
                    if epoch != self._epoch:
                        self.request_scan(); return
                    if scope is None:
                        self._incomplete = failed
                        self._scanned = True; self._scan_requested = False; self._last_scan = time.monotonic()
                        self._verify_scan = False
                    else:
                        contains = lambda path: normalize(book_root(path)) == normalize(scope) if not scope else normalize(path) == normalize(scope) or normalize(path).startswith(normalize(scope) + '/')
                        self._incomplete = {path for path in previous_failures if not contains(path)} | failed
                        self._directory_failed |= {path for path in previous_directory_failures if not contains(path)}
                self._maintenance_requested = True
            finally:
                self._scanning = False
            if strict and self._incomplete:
                raise NotesError('统计未完成：有笔记目录或文件无法读取，请重试', status=409, code='statistics_incomplete')
        if drain:
            self.drain(strict=strict)

    def _process(self, path, job):
        from notes_library import NotesError, _is_reparse
        book, serial, epoch = job
        parts = normalize(path).split('/')
        prefixes = [''] + ['/'.join(parts[:end]) for end in range(1, len(parts) + 1)]
        valid = lambda: not self._stop.is_set() \
            and not any(serial <= self._retired.get(prefix, 0) for prefix in prefixes) \
            and self._pending.get(path, (None, serial, epoch))[1] <= serial
        with self._condition:
            if not valid():
                return
            if book:
                with self.store.index.read() as conn:
                    if not conn.execute('SELECT 1 FROM books WHERE id=? AND deleted=0', (book,)).fetchone():
                        return
        try:
            target = self.store._absolute(path)
            try:
                data = target.stat(follow_symlinks=False)
            except (FileNotFoundError, NotADirectoryError):
                with self.store.index.read() as conn:
                    known = conn.execute('SELECT 1 FROM entries e JOIN books b ON b.id=e.book WHERE e.key=? AND b.deleted=0 LIMIT 1', (normalize(path),)).fetchone()
                if not known:
                    # The index may just have been rebuilt; colors are durable
                    # and still need this confirmed missing-path notification.
                    with self._condition:
                        self._apply_color_renames()
                        if valid():
                            self.store.sync_file_colors('remove', path)
                    self._incomplete.discard(path)
                    return
                self.retire(path, notebook=bool(book_root(path) and normalize(book_root(path)) == normalize(path)))
                return
            if _is_reparse(target):
                raise NotesError('不能索引链接或重解析点', status=403, code='unsafe_path')
            if stat.S_ISDIR(data.st_mode):
                self.store._publish_path(path)
                self.scan(path); return
            if target.suffix.casefold() != '.md':
                return
            original_path = path
            path = target.resolve(strict=True).relative_to(self.store.root.resolve()).as_posix()
            prefixes = [''] + ['/'.join(normalize(path).split('/')[:end]) for end in range(1, len(path.split('/')) + 1)]
            with self._condition:
                if not valid():
                    return
                self.store.index.register([(path, 'note', data.st_mtime_ns,
                    getattr(data, 'st_birthtime_ns', data.st_ctime_ns), data.st_size)], verify=True)
            with self._condition:
                saved = self._saved.pop(original_path, None) if valid() else None
                if saved:
                    self._saved_bytes -= len(saved[0])
            raw = saved[0] if saved and saved[1] == (data.st_mtime_ns, data.st_size) else self.store._read_note_bytes(target)
            after = target.stat(follow_symlinks=False)
            if (data.st_mtime_ns, data.st_size) != (after.st_mtime_ns, after.st_size):
                self.enqueue(path, priority=True); return
            self.store._index_document(path, raw, (after.st_mtime_ns, after.st_size),
                metadata=True, graph=self.background and self.store.graph_index_enabled or normalize(book_root(path)) in self._graph_books,
                expected_book=book, valid=valid)
            self._incomplete.discard(path)
        except InterruptedError:
            raise
        except (OSError, NotesError, UnicodeError) as error:
            self._incomplete.add(path)
            self.store.index.error(path, str(error))

    def drain(self, *, strict=False):
        from notes_library import NotesError
        while True:
            with self._condition:
                self._apply_color_renames()
                if not self._pending:
                    for path, book in self.store.index.pending():
                        self.enqueue(path, book=book)
                    if not self._pending:
                        break
                path, job = self._pending.popitem(last=False)
            self._process(path, job)
        if strict and self._incomplete:
            raise NotesError('统计未完成：有笔记无法读取，请重试', status=409, code='statistics_incomplete')

    def complete(self, scope=None, *, graph=False, timeout=30):
        if graph:
            self.graph(scope or '')
        if not self.background:
            self.scan(scope, strict=True, drain=True)
        else:
            self.activity(True)
            visibility = self._visibility_epoch
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if visibility != self._visibility_epoch and not self.active:
                    from notes_library import NotesError
                    raise NotesError('笔记索引已暂停', status=409, code='indexing')
                if time.monotonic() + 10 > self._active_until:
                    self.activity(True)
                ready = not self._pending and not self._processing and not self.store.index.pending(1)
                if scope is not None and self._scanned:
                    with self.store.index.read() as conn:
                        book = conn.execute('SELECT total,indexed,errors FROM books WHERE key=? AND deleted=0', (normalize(scope),)).fetchone()
                    if book and book['errors']:
                        from notes_library import NotesError
                        raise NotesError('统计未完成：有笔记无法读取，请重试', status=409, code='statistics_incomplete')
                    ready = bool(book and book['total'] == book['indexed'] and not book['errors'] and not self.store.index.pending(1, scope))
                    with self._condition:
                        relevant = [path for path in self._pending if normalize(book_root(path)) == normalize(scope)]
                        for path in reversed(relevant):
                            self._pending.move_to_end(path, last=False)
                if self._scanned and not self._scanning and not self._scan_requested and ready:
                    break
                time.sleep(.01)
            else:
                from notes_library import NotesError
                raise NotesError('正在整理笔记，请稍后重试', status=409, code='indexing')
        failures = [path for path in self._incomplete if not path or scope is None or normalize(book_root(path)) == normalize(scope)]
        if failures:
            from notes_library import NotesError
            raise NotesError('统计未完成：有笔记无法读取，请重试', status=409, code='statistics_incomplete')
        if graph:
            for path, book in self.store.index.graph_pending(scope):
                if self.background and not self.active:
                    from notes_library import NotesError
                    raise NotesError('笔记索引已暂停', status=409, code='indexing')
                self._process(path, (book, self._serial, self._epoch))

    def status(self):
        result = self.store.index.status()
        result.update(phase='scanning' if self._scanning or not self._scanned else
            'indexing' if self._pending or self._processing or result['pendingDocuments'] else 'partial' if self._incomplete or result['errors'] else 'ready',
            pending=len(self._pending), incomplete=bool(self._incomplete), visible=self.active,
            catalogComplete=self._scanned)
        return result

    def _run(self):
        while not self._stop.is_set():
            try:
                with self._condition:
                    if not self.active:
                        self._condition.wait(.5); continue
                    needs_scan = self._scan_requested or time.monotonic() - self._last_scan > (120 if self._watch_supported else 30)
                    if not needs_scan and not self._pending:
                        for path, book in self.store.index.pending():
                            self.enqueue(path, book=book)
                    job = self._pending.popitem(last=False) if self._pending and not needs_scan else None
                    self._processing = bool(job)
                    self._processing_path = job[0] if job else None
                if needs_scan:
                    self.scan()
                elif job:
                    self.cooperate()
                    self._process(*job)
                    self._maintenance_requested = True
                else:
                    if self._maintenance_requested:
                        self.cooperate()
                        self._maintenance_requested = self.store.index.maintenance(lambda: self._stop.is_set() or not self.active
                            or time.monotonic() < self._foreground_until)
                    with self._condition:
                        self._condition.wait(.5)
            except InterruptedError:
                self.request_scan()
            except Exception as error:
                self._last_error = str(error)
                self._incomplete.add(''); self._last_scan = time.monotonic()
                with self._condition:
                    self._condition.wait(1)
            finally:
                self._processing = False
                self._processing_path = None

    def _watch_windows(self):
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        class Overlapped(ctypes.Structure):
            _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                        ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD), ('hEvent', wintypes.HANDLE)]
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateEventW.restype = wintypes.HANDLE
        kernel.ReadDirectoryChangesW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
            wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(Overlapped), ctypes.c_void_p]
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.GetOverlappedResult.argtypes = [wintypes.HANDLE, ctypes.POINTER(Overlapped), ctypes.POINTER(wintypes.DWORD), wintypes.BOOL]
        kernel.CancelIoEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.ResetEvent.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateFileW(str(self.store.root), 1, 7, None, 3, 0x02000000 | 0x40000000, None)
        if handle == ctypes.c_void_p(-1).value:
            return
        event = kernel.CreateEventW(None, True, False, None)
        if not event:
            kernel.CloseHandle(handle); return
        buffer = ctypes.create_string_buffer(65536)
        overlap = Overlapped(); overlap.hEvent = event
        try:
            self._watch_supported = True
            while not self._stop.is_set():
                kernel.ResetEvent(event)
                if not kernel.ReadDirectoryChangesW(handle, buffer, len(buffer), True, 0x1 | 0x2 | 0x8 | 0x10, None, ctypes.byref(overlap), None):
                    if ctypes.get_last_error() != 997:
                        self._verify_scan = True; self.request_scan(); break
                while not self._stop.is_set() and kernel.WaitForSingleObject(event, 200) == 258:
                    pass
                if self._stop.is_set():
                    kernel.CancelIoEx(handle, ctypes.byref(overlap))
                    kernel.WaitForSingleObject(event, 1000); break
                # Let a burst of our atomic saves finish before decoding the
                # notification batch. Kernel overflow still forces verification.
                with self._condition:
                    while not self._stop.is_set() and time.monotonic() < self._foreground_until:
                        self._condition.wait(.05)
                returned = wintypes.DWORD()
                if not kernel.GetOverlappedResult(handle, ctypes.byref(overlap), ctypes.byref(returned), False) or not returned.value:
                    self._verify_scan = True
                    self.request_scan(); continue
                offset = 0
                events = []
                while offset + 12 <= returned.value:
                    following, action, length = struct.unpack_from('<III', buffer.raw, offset)
                    name = buffer.raw[offset + 12:offset + 12 + length].decode('utf-16-le').replace('\\', '/')
                    events.append((action, name))
                    if not following:
                        break
                    offset += following
                self.notifications(events)
        finally:
            self._watch_supported = False
            kernel.CancelIoEx(handle, None); kernel.CloseHandle(event); kernel.CloseHandle(handle)

    def close(self):
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        for thread in (self._worker, self._watcher):
            if thread and thread is not threading.current_thread():
                thread.join(5)
        if not self.store.index._closed:
            self.store.index.mark_pending(list(self._pending))
        self.store.index.close()
