"""Native single-file Markdown windows, separate from workspace ownership."""
from __future__ import annotations

import http.server
import io
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import urllib.parse

from markdown_files import (MarkdownDocument, MarkdownFileError, MarkdownFiles,
                            register_association, unregister_association, safe_path, spawn_editor)


def result(operation):
    try:
        return {'ok': True, **(operation() or {})}
    except (OSError, ValueError) as error:
        return {'ok': False, 'error': str(error), 'code': getattr(error, 'code', 'io_error')}


def management(bridge, action, value=None):
    import app
    if not getattr(bridge, '_markdown_enabled', False):
        return {'ok': False, 'error': '当前会话未启用笔记。'}
    files = MarkdownFiles(app.ROOT)
    def operate():
        if action == 'status':
            return files.status()
        if action in ('autoSave', 'outline', 'clear', 'remove', 'reset'):
            files.update(action, value)
        elif action == 'register':
            register_association()
        elif action == 'unregister':
            unregister_association()
        elif action == 'defaults':
            os.startfile('ms-settings:defaultapps')
        elif action == 'new':
            spawn_editor()
        elif action == 'open':
            import webview
            selected = bridge._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True,
                file_types=('Markdown (*.md;*.markdown)',))
            for path in selected or ():
                spawn_editor(path)
        elif action in ('recent', 'reveal'):
            if value not in files.read()['recent']:
                raise MarkdownFileError('请从最近文件中选择。')
            path = safe_path(value)
            if action == 'recent':
                spawn_editor(path)
            else:
                import subprocess
                subprocess.Popen(['explorer.exe', '/select,', str(path)])
        else:
            raise MarkdownFileError('不支持的操作。')
        return files.status()
    return result(operate)


def run(shell, path=None):
    app, webview = shell.app, shell.webview
    if webview is None or not shell._webview2_runtime_available():
        shell._message_box('无法打开 Markdown 窗口，请检查 WebView2 Runtime 是否已安装。', 0x10)
        return 1
    try:
        document = MarkdownDocument(path)
        document.read()
    except (OSError, ValueError) as error:
        shell._message_box(str(error), 0x10)
        return 1
    app.DATA.mkdir(parents=True, exist_ok=True)
    files = MarkdownFiles(app.ROOT)
    preferences = shell.DesktopPreferences(app.ROOT, 'markdown-files')
    if not preferences.values:
        # Inherit the user's appearance once; separate windows never race with
        # the full workspace's preference snapshot.
        original = shell.DesktopPreferences(app.ROOT, 'full')
        preferences.values = {key: value for key, value in original.values.items()
                              if key.startswith(('canvas:note', 'canvas:toolbarLanguage', 'canvas:theme'))}

    class Handler(app.Handler):
        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == '/api/markdown-file-asset':
                query = urllib.parse.parse_qs(parsed.query)
                if not secrets.compare_digest(query.get('token', [''])[0].encode('utf-8'), document.token.encode('ascii')):
                    self.send_error(403)
                    return
                try:
                    raw, media = document.image(query.get('src', [''])[0])
                except (OSError, ValueError):
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', media)
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if parsed.path.startswith('/api/'):
                self.send_error(404)
                return
            # Static assets only. No user directories are served by this host.
            super().do_GET()

        def do_POST(self):
            self.send_error(405)

        def send_head(self):
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == '/markdown-file.html':
                source = (app.ASSETS / 'markdown-file.html').read_text(encoding='utf-8')
                source = source.replace('<head>', '<head>\n' + preferences.bootstrap(), 1)
                raw = source.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                return io.BytesIO(raw)
            return super().send_head()

    class Bridge(shell.DesktopBridge):
        def __init__(self):
            super().__init__(1040, 780)
            self._preferences = preferences
            self._markdown_enabled = True
            self._markdown_ready = False

        def markdown_document(self, action, content=None, revision=None):
            def operate():
                if action == 'read':
                    data = document.read()
                    self._markdown_ready = True
                elif action == 'save':
                    data = document.save(content, revision)
                elif action == 'save-as':
                    selected = self._window.create_file_dialog(webview.SAVE_DIALOG,
                        save_filename=document.path.name if document.path else 'Untitled.md', file_types=('Markdown (*.md)',))
                    if not selected:
                        return {'cancelled': True}
                    target = str(selected[0] if isinstance(selected, (list, tuple)) else selected)
                    if not Path(target).suffix:
                        target += '.md'
                    data = document.save(content, revision, destination=target)
                elif action == 'changed':
                    return {'changed': document.changed(revision), 'settings': files.read()}
                else:
                    raise MarkdownFileError('不支持的文档操作。')
                if document.path:
                    self._window.set_title(document.path.name + ' — Relatum')
                    try:
                        files.update('remember', str(document.path))
                    except OSError:
                        pass  # A successful document save must not become an error in the recent list.
                return {'document': data, 'settings': files.read()}
            return result(operate)

        def markdown_image(self, name, encoded):
            return result(lambda: {'source': document.upload_image(name, encoded)})

        def markdown_open_link(self, target):
            def operate():
                parsed = urllib.parse.urlsplit(str(target))
                if parsed.scheme.lower() in ('http', 'https', 'mailto'):
                    os.startfile(str(target))
                elif not parsed.scheme and document.path:
                    raw = urllib.parse.unquote(parsed.path)
                    if raw.startswith('#') or not raw:
                        return {}
                    candidate = safe_path(document.path.parent / raw)
                    spawn_editor(candidate)
                else:
                    raise MarkdownFileError('此链接无法从简洁窗口打开。')
            return result(operate)

    server = app.CanvasServer(('127.0.0.1', 0), Handler)
    server.desktop_preferences = preferences
    thread = threading.Thread(target=server.serve_forever, daemon=True, name='markdown-file-assets')
    thread.start()
    bridge = Bridge()
    window = webview.create_window((document.path.name if document.path else 'Untitled.md') + ' — Relatum',
        f'http://127.0.0.1:{server.server_address[1]}/markdown-file.html', js_api=bridge,
        width=1040, height=780, min_size=(520, 400), background_color='#fbfbfa', text_select=True)
    bridge._window = window

    def closing():
        if bridge._close_after_flush or not bridge._markdown_ready:
            return True
        def request():
            try:
                window.evaluate_js('window.RelatumMarkdownWindow && window.RelatumMarkdownWindow.close()')
            except Exception:
                pass
        threading.Thread(target=request, daemon=True).start()
        return False
    window.events.closing += closing
    window.events.minimized += lambda: shell._notify_usage_visibility(window, True)
    window.events.restored += lambda: shell._notify_usage_visibility(window, False)
    try:
        storage = app.DATA / 'desktop-sessions' / 'markdown-files' / 'WebView2'
        storage.mkdir(parents=True, exist_ok=True)
        shell._apply_webview_cache_limits()
        webview.start(gui='edgechromium', private_mode=False, storage_path=str(storage),
                      icon=str(app.ASSETS / 'app-icon.ico'))
    finally:
        try:
            preferences.flush()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
    return 0
