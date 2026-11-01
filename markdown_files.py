"""Explicitly selected Markdown files and optional per-user Windows integration.

No directory is enrolled as a notebook. File bodies never enter preferences or
the recent-file list; writes retain the existing atomic-write convention.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import urllib.parse
import uuid

from notes_library import (MAX_NOTE_BYTES, MAX_NOTE_IMAGE_BYTES, NOTE_IMAGE_TYPES,
                           _is_reparse, _check_note_image_content)

SUFFIXES = ('.md', '.markdown')
PROGID = 'Relatum.Markdown'


class MarkdownFileError(ValueError):
    def __init__(self, message, code='invalid'):
        super().__init__(message)
        self.code = code


def safe_path(raw, *, existing=True):
    if not isinstance(raw, (str, Path)) or not str(raw).strip():
        raise MarkdownFileError('请选择 Markdown 文件。')
    path = Path(os.path.abspath(raw))
    for part in (path, *path.parents):
        if os.path.lexists(part) and _is_reparse(part):
            raise MarkdownFileError('暂不支持链接或重解析点，请选择实际文件。', 'unsafe_path')
    if path.suffix.lower() not in SUFFIXES:
        raise MarkdownFileError('请选择 .md 或 .markdown 文件。')
    if existing and not path.is_file():
        raise MarkdownFileError('文件已被移动或删除，请重新选择。', 'not_found')
    if not path.parent.is_dir():
        raise MarkdownFileError('目标文件夹不存在。', 'not_found')
    return path


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class MarkdownDocument:
    """One exact file grant, owned by one native window."""
    def __init__(self, path=None):
        self.path = safe_path(path) if path else None
        self.token = uuid.uuid4().hex
        self.lock = threading.RLock()
        self.newline = '\n'
        self.bom = False
        self.content = ''
        self.revision = None

    def _bytes(self):
        path = safe_path(self.path)
        with path.open('rb') as stream:
            raw = stream.read(MAX_NOTE_BYTES + 1)
        if len(raw) > MAX_NOTE_BYTES:
            raise MarkdownFileError('文件超过 4 MiB，暂时无法编辑。', 'too_large')
        return raw

    def read(self):
        with self.lock:
            if self.path:
                raw = self._bytes()
                try:
                    text = raw.decode('utf-8-sig')
                except UnicodeDecodeError as error:
                    raise MarkdownFileError('文件不是 UTF-8 编码，请先转换编码后再打开。', 'encoding') from error
                self.bom = raw.startswith(b'\xef\xbb\xbf')
                self.newline = '\r\n' if text.count('\r\n') > text.count('\n') / 2 else '\n'
                self.content = text.replace('\r\n', '\n').replace('\r', '\n')
                self.revision = digest(raw)
            return self.snapshot()

    def snapshot(self):
        return {'path': str(self.path or ''), 'name': self.path.name if self.path else 'Untitled.md',
                'content': self.content, 'revision': self.revision, 'token': self.token}

    def save(self, content, revision, *, destination=None):
        from app import _atomic_write_bytes, _cross_process_mutation_lock
        if not isinstance(content, str):
            raise MarkdownFileError('正文格式无效。')
        with self.lock, _cross_process_mutation_lock():
            target = safe_path(destination, existing=False) if destination else self.path
            if target is None:
                raise MarkdownFileError('请先选择保存位置。', 'untitled')
            # A native Save As picker authorizes replacement of its chosen file;
            # ordinary saves must never resurrect a deleted document or overwrite
            # a revision written by another editor.
            if destination is None:
                current = self._bytes()
                if revision != digest(current):
                    raise MarkdownFileError('磁盘文件已被其他程序修改。请重新载入，或另存为保留你的修改。', 'conflict')
            body = content.replace('\r\n', '\n').replace('\r', '\n')
            raw = (b'\xef\xbb\xbf' if self.bom else b'') + body.replace('\n', self.newline).encode('utf-8')
            if len(raw) > MAX_NOTE_BYTES:
                raise MarkdownFileError('文件超过 4 MiB，无法保存。', 'too_large')
            if destination is not None or raw != current:
                _atomic_write_bytes(target, raw)
            self.path, self.content, self.revision = target, body, digest(raw)
            return self.snapshot()

    def changed(self, revision):
        with self.lock:
            return bool(self.path and digest(self._bytes()) != revision)

    def image(self, source):
        with self.lock:
            if not self.path or not isinstance(source, str):
                raise MarkdownFileError('图片不可用。')
            value = urllib.parse.unquote(source).replace('\\', '/')
            if urllib.parse.urlsplit(value).scheme or value.startswith(('/', '//')):
                raise MarkdownFileError('仅支持文档文件夹内的相对图片。', 'unsafe_path')
            root = self.path.parent
            candidate = Path(os.path.abspath(root / value))
            if not candidate.is_relative_to(root):
                raise MarkdownFileError('图片超出文档文件夹。', 'unsafe_path')
            for part in (candidate, *candidate.parents):
                if os.path.lexists(part) and _is_reparse(part):
                    raise MarkdownFileError('图片路径包含链接。', 'unsafe_path')
            media = NOTE_IMAGE_TYPES.get(candidate.suffix.lower())
            if not media or not candidate.is_file():
                raise MarkdownFileError('图片不存在。', 'not_found')
            with candidate.open('rb') as stream:
                content = stream.read(MAX_NOTE_IMAGE_BYTES + 1)
            if len(content) > MAX_NOTE_IMAGE_BYTES:
                raise MarkdownFileError('图片过大。', 'too_large')
            _check_note_image_content(content, media)
            return content, media

    def upload_image(self, name, encoded):
        from app import _atomic_write_bytes
        with self.lock:
            if not self.path:
                raise MarkdownFileError('请先保存文档，再插入图片。', 'untitled')
            safe_path(self.path)
            suffix = Path(str(name)).suffix.lower()
            media = NOTE_IMAGE_TYPES.get(suffix)
            if not media or not isinstance(encoded, str) or len(encoded) > MAX_NOTE_IMAGE_BYTES * 4 // 3 + 8:
                raise MarkdownFileError('图片格式或大小不受支持。')
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > MAX_NOTE_IMAGE_BYTES:
                raise MarkdownFileError('图片过大。')
            _check_note_image_content(raw, media)
            folder = self.path.with_suffix('.assets')
            if os.path.lexists(folder) and (_is_reparse(folder) or not folder.is_dir()):
                raise MarkdownFileError('图片文件夹不可用。', 'unsafe_path')
            folder.mkdir(exist_ok=True)
            target = folder / (uuid.uuid4().hex[:16] + suffix)
            _atomic_write_bytes(target, raw)
            return folder.name + '/' + target.name


def launch_command():
    if getattr(sys, 'frozen', False):
        executable = Path(sys.executable)
        if executable.name.lower() == 'relatumlauncher.exe':
            executable = executable.with_name('Relatum.exe')
        return [str(executable)]
    executable = Path(sys.executable)
    windowless = executable.with_name('pythonw.exe')
    return [str(windowless if windowless.is_file() else executable), str(Path(__file__).with_name('desktop.py'))]


def spawn_editor(path=None):
    command = [*launch_command(), '--markdown-file']
    if path:
        command.append(str(safe_path(path)))
    subprocess.Popen(command, cwd=str(Path(__file__).parent), creationflags=0x08000000 if os.name == 'nt' else 0)


class MarkdownFiles:
    def __init__(self, root):
        self.root = Path(root)
        self.state_path = self.root / 'data' / 'markdown-files.json'

    def read(self):
        state = {'version': 1, 'autoSave': True, 'outline': False, 'recent': []}
        try:
            data = json.loads(self.state_path.read_text(encoding='utf-8'))
            if data.get('version') == 1:
                for key in ('autoSave', 'outline'):
                    if type(data.get(key)) is bool:
                        state[key] = data[key]
                state['recent'] = list(dict.fromkeys(path for path in data.get('recent', [])
                                                    if isinstance(path, str) and len(path) < 32768))[:20]
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        return state

    def update(self, action, value=None):
        from app import _cross_process_mutation_lock, _atomic_write_json
        with _cross_process_mutation_lock():
            state = self.read()
            if action in ('autoSave', 'outline') and type(value) is bool:
                state[action] = value
            elif action == 'remember':
                path = str(safe_path(value))
                state['recent'] = [path, *(item for item in state['recent'] if os.path.normcase(item) != os.path.normcase(path))][:20]
            elif action == 'remove':
                state['recent'] = [item for item in state['recent'] if item != value]
            elif action == 'clear':
                state['recent'] = []
            elif action == 'reset':
                state.update(autoSave=True, outline=False)
            else:
                raise MarkdownFileError('不支持的设置操作。')
            _atomic_write_json(self.state_path, state)
        return state

    def status(self):
        state = self.read()
        return {**state, 'association': association_status(),
                'recent': [{'path': path, 'name': Path(path).name, 'exists': Path(path).is_file()} for path in state['recent']]}


def association_command():
    return subprocess.list2cmdline([*launch_command(), '--markdown-file']) + ' "%1"'


def markdown_icon_path():
    from app import ASSETS
    return ASSETS / 'markdown-file.ico'


def association_icon():
    return subprocess.list2cmdline([str(markdown_icon_path())]) + ',0'


def default_markdown_progid():
    """Ask the Shell: recent Windows versions can use UserChoiceLatest."""
    if sys.platform != 'win32':
        return None
    try:
        import ctypes
        query = ctypes.windll.shlwapi.AssocQueryStringW
        query.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_wchar_p, ctypes.c_wchar_p,
                          ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint)]
        query.restype = ctypes.c_long
        output = ctypes.create_unicode_buffer(1024)
        size = ctypes.c_uint(len(output))
        return output.value if query(0, 20, '.md', None, output, ctypes.byref(size)) == 0 else None
    except (OSError, AttributeError, TypeError, ValueError):
        return None


def association_status():
    result = {'supported': sys.platform == 'win32', 'registered': False, 'otherLocation': False, 'default': False, 'iconCurrent': False}
    if not result['supported']:
        return result
    import winreg
    def read(key, name=''):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
                return winreg.QueryValueEx(handle, name)[0]
        except OSError:
            return ''
    command = read('Software\\Classes\\' + PROGID + r'\shell\open\command')
    effective = default_markdown_progid()
    result.update(registered=command == association_command(), otherLocation=bool(command and command != association_command()),
                  iconCurrent=read('Software\\Classes\\' + PROGID + r'\DefaultIcon') == association_icon(),
                  default=(effective if effective is not None else read(r'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice', 'ProgId')) == PROGID)
    return result


def register_association():
    if sys.platform != 'win32':
        raise MarkdownFileError('此操作仅适用于 Windows 桌面版。')
    if not markdown_icon_path().is_file():
        raise MarkdownFileError('Markdown 文档图标缺失，请使用完整的 Relatum 程序目录。')
    import winreg
    def put(key, name, value, kind=winreg.REG_SZ):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as handle:
            winreg.SetValueEx(handle, name, 0, kind, value)
    base = 'Software\\Classes\\' + PROGID
    put(base, '', 'Markdown document · Relatum')
    put(base + r'\shell\open\command', '', association_command())
    put(base + r'\DefaultIcon', '', association_icon())
    capabilities = r'Software\Relatum\MarkdownCapabilities'
    put(capabilities, 'ApplicationName', 'Relatum')
    put(capabilities, 'ApplicationDescription', 'Open and edit Markdown files with Relatum')
    for suffix in SUFFIXES:
        put('Software\\Classes\\' + suffix + r'\OpenWithProgids', PROGID, b'', winreg.REG_NONE)
        put(capabilities + r'\FileAssociations', suffix, PROGID)
    put(r'Software\RegisteredApplications', 'Relatum Markdown', capabilities)
    _notify_associations()


def unregister_association():
    if not association_status()['registered']:
        raise MarkdownFileError('当前注册不属于此位置的 Relatum，请先修复注册。')
    import winreg
    def delete_tree(key):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_READ | winreg.KEY_WRITE) as handle:
                while winreg.QueryInfoKey(handle)[0]:
                    delete_tree(key + '\\' + winreg.EnumKey(handle, 0))
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        except FileNotFoundError:
            pass
    for key, name in [('Software\\Classes\\' + suffix + r'\OpenWithProgids', PROGID) for suffix in SUFFIXES] + [(r'Software\RegisteredApplications', 'Relatum Markdown')]:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as handle:
                winreg.DeleteValue(handle, name)
        except FileNotFoundError:
            pass
    delete_tree('Software\\Classes\\' + PROGID)
    delete_tree(r'Software\Relatum\MarkdownCapabilities')
    _notify_associations()


def _notify_associations():
    import ctypes
    ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
