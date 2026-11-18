"""Run the HTML frame boundary in the prepared Windows desktop environment."""
from __future__ import annotations

import json
from importlib.util import find_spec
import queue
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST_PAGE = b'''<!doctype html><meta charset="utf-8">
<style>body{margin:0}iframe{display:block;width:500px;height:260px;border:0}</style>
<input id="host" value="notebook">
<script>
  window.messages = [];
  window.project = (url, interactive) => {
    document.querySelector('iframe')?.remove();
    const frame = document.createElement('iframe');
    frame.sandbox = interactive ? 'allow-scripts' : '';
    frame.src = url;
    document.body.append(frame);
  };
  addEventListener('message', event => {
    if (event.origin === 'null' && event.source === document.querySelector('iframe')?.contentWindow) {
      messages.push(event.data);
    }
  });
</script>'''


class _HostBridge:
    def __init__(self):
        self.calls = 0

    def ping(self):
        self.calls += 1
        return 'host'


def _wait_until(check, seconds=6):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.025)
    raise TimeoutError('WebView2 HTML frame check timed out')


@unittest.skipUnless(sys.platform == 'win32' and find_spec('webview'),
                     'Requires the prepared Windows desktop environment')
class NoteHtmlRuntimeDesktopTest(unittest.TestCase):
    def test_webview2_boundary(self):
        import webview

        from note_html_runtime import NoteHtmlRuntime

        requests = []

        class Host(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/':
                    body = HOST_PAGE
                else:
                    if self.path.startswith('/blocked'):
                        requests.append(self.path)
                    body = b''
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory(prefix='relatum-html-webview-', ignore_cleanup_errors=True) as storage:
            disk = Path(storage) / 'private.txt'
            disk.write_text('The HTML frame must not read this local fixture.', encoding='utf-8')
            with ThreadingHTTPServer(('127.0.0.1', 0), Host) as server:
                threading.Thread(target=server.serve_forever, daemon=True).start()
                origin = f'http://127.0.0.1:{server.server_port}'
                bridge = _HostBridge()
                window = webview.create_window('Relatum HTML boundary test', origin, js_api=bridge,
                                               width=820, height=680)
                result = queue.Queue()

                def exercise():
                    try:
                        self.assertTrue(window.events.loaded.wait(12))
                        self._exercise(window, bridge, origin, disk.as_uri(), requests, NoteHtmlRuntime)
                    except BaseException as exc:
                        result.put(exc)
                    else:
                        result.put(None)
                    finally:
                        window.destroy()

                try:
                    webview.start(exercise, gui='edgechromium', private_mode=False, storage_path=storage)
                finally:
                    server.shutdown()
                if error := result.get_nowait():
                    raise error

    def _exercise(self, window, bridge, origin, disk_uri, requests, runtime_class):
        from System import Action

        native = window.native.webview

        def on_ui(action):
            result = queue.Queue()

            def run():
                try:
                    result.put((action(), None))
                except Exception as error:
                    result.put((None, error))

            native.BeginInvoke(Action(run))
            value, error = result.get(timeout=8)
            if error is not None:
                raise error
            return value

        core = on_ui(lambda: native.CoreWebView2)
        print('WebView2:', on_ui(lambda: core.Environment.BrowserVersionString), flush=True)
        runtime = on_ui(lambda: runtime_class(window.native.browser, origin))

        def cdp(method, params):
            task = on_ui(lambda: core.CallDevToolsProtocolMethodAsync(method, json.dumps(params)))
            self.assertTrue(task.Wait(6000), method)
            return json.loads(task.Result)

        def evaluate(expression):
            response = cdp('Runtime.evaluate', dict(expression=expression, returnByValue=True, awaitPromise=True))
            self.assertNotIn('exceptionDetails', response)
            return response['result'].get('value')

        def project(url, interactive):
            evaluate('messages.length = 0; project(' + json.dumps(url) + ', ' + json.dumps(interactive) + ')')

        def message(name):
            return _wait_until(lambda: evaluate(f'messages.find(item => Object.hasOwn(item, {json.dumps(name)}))'))[name]

        project(on_ui(lambda: runtime.start_probe(control=True)), True)
        self.assertFalse(message('noteHtmlProbe'), 'The control document must reach the synthetic endpoint')
        project(on_ui(runtime.start_probe), True)
        self.assertTrue(message('noteHtmlProbe'), 'Connection-Allowlist needs to block the synthetic fetch')
        self.assertTrue(on_ui(runtime.confirm_probe))
        self.assertEqual(evaluate('window.pywebview.api.ping()'), 'host')
        self.assertEqual(evaluate("fetch('/').then(response => response.status)"), 200)

        content = b'''<!doctype html><style>body{margin:0;height:850px}button,input{display:block}</style>
          <button id="button">Change week</button><input id="field" aria-label="Week name">
          <script>
            const button = document.querySelector('button');
            button.onclick = () => parent.postMessage({clicked: true}, '*');
            document.querySelector('input').oninput = event => parent.postMessage({typed: event.target.value}, '*');
            addEventListener('scroll', () => parent.postMessage({scrolled: scrollY}, '*'));
            addEventListener('load', () => parent.postMessage({ready: true}, '*'));
          </script>'''
        project(on_ui(lambda: runtime.open_document(content, False)), False)
        time.sleep(.35)
        self.assertFalse(evaluate('messages.some(item => item.ready)'))
        project(on_ui(lambda: runtime.open_document(content, True)), True)
        self.assertTrue(message('ready'))
        top = evaluate("document.querySelector('iframe').getBoundingClientRect().top")

        def click(x, y):
            for kind in ('mousePressed', 'mouseReleased'):
                cdp('Input.dispatchMouseEvent', dict(type=kind, x=x, y=y, button='left', clickCount=1))

        click(36, top + 9)
        self.assertTrue(message('clicked'))
        click(36, top + 30)
        cdp('Input.insertText', {'text': '4'})
        self.assertEqual(message('typed'), '4')
        cdp('Input.dispatchMouseEvent', dict(type='mouseWheel', x=100, y=125, deltaX=0, deltaY=150))
        self.assertGreater(message('scrolled'), 0)

        script = f'''<!doctype html><script>
          const target = {json.dumps(origin + '/blocked')};
          const readable = (fn) => {{ try {{ fn(); return true; }} catch {{ return false; }} }};
          const parentAccessible = readable(() => parent.document.body);
          const storageAccessible = readable(() => localStorage.length);
          const popup = window.open(target + '-window');
          window.chrome?.webview?.postMessage(['ping', '[]', 'html-test']);
          fetch(target + '-fetch').catch(() => {{}});
          const image = new Image(); image.src = target + '-image';
          const frame = document.createElement('iframe'); frame.src = target + '-nested';
          addEventListener('DOMContentLoaded', async () => {{
            document.body.append(frame);
            const disk = await fetch({json.dumps(disk_uri)}).then(() => true, () => false);
            parent.postMessage({{boundary:[parentAccessible, storageAccessible, popup !== null, disk]}}, '*');
            location.href = target + '-navigation';
          }});
        </script>'''
        project(on_ui(lambda: runtime.open_document(script.encode('utf-8'), True)), True)
        self.assertEqual(message('boundary'), [False, False, False, False])
        time.sleep(.25)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(requests, [])

        project(on_ui(lambda: runtime.open_document(
            b'<script>setInterval(() => parent.postMessage({tick: true}, "*"), 40)</script>', True)), True)
        self.assertTrue(message('tick'))
        evaluate("document.querySelector('iframe').remove(); messages.length = 0; document.querySelector('input').focus()")
        time.sleep(.25)
        self.assertEqual(evaluate('messages.length'), 0)
        self.assertEqual(evaluate('document.activeElement.id'), 'host')
