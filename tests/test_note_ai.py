import io
import http.server
import json
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from note_ai import BUILTINS, DEFAULTS, NoteAIError, NoteAIStore, chat_body, sse_payloads


class Chunked(io.BytesIO):
    def read1(self, size):
        return self.read(min(size, 3))


def completion(text="回答", reason="思考", finish="stop"):
    chunks = [
        {"choices": [{"delta": {"reasoning_content": reason}}]},
        {"choices": [{"delta": {"content": text}}]},
        {"choices": [{"delta": {}, "finish_reason": finish}], "usage": {"prompt_tokens": 12, "completion_tokens": 5}},
    ]
    return Chunked((": heartbeat\r\n\r\n" + "".join("data: " + json.dumps(item, ensure_ascii=False) + "\r\n\r\n" for item in chunks) + "data: [DONE]\r\n\r\n").encode())


class NoteAIStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        def atomic(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix('.tmp')
            temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            temp.replace(path)
        self.atomic = atomic
        self.store = NoteAIStore(self.root, atomic)

    def tearDown(self):
        self.temp.cleanup()

    def configured(self, **kwargs):
        return self.store.save_config({"apiKey": "secret-test-key", "model": "test-model", **kwargs})

    def run_chat(self, text="hello", session="session", request="request", **kwargs):
        body = {"sessionId": session, "requestId": request, "text": text, "newSession": True, **kwargs}
        with mock.patch.object(self.store, '_upstream', return_value=completion()):
            return list(self.store.events(body))

    def test_defaults_empty_key_model_and_prompt_without_io(self):
        self.assertEqual(self.store.config(), {**DEFAULTS, "presets": []})
        public = self.store.public_config()
        self.assertFalse(public['hasKey'])
        self.assertNotIn('apiKey', public)
        self.assertEqual(public['model'], '')
        self.assertEqual(public['presets'][0]['prompt'], '')
        self.assertFalse(list(self.root.iterdir()))

    def test_dictionary_prompt_matches_user_reference_structure(self):
        prompt = BUILTINS[1]['prompt']
        for title in ('【词频】', '【释义】', '【例句】', '【搭配与辨析】', '不要使用 # 或 **'):
            self.assertIn(title, prompt)

    def test_config_reset_keeps_identity_presets_and_history(self):
        self.configured(temperature=.3, baseUrl='https://example.test/v1/', presets=[{'id': 'custom', 'name': '自定义', 'prompt': 'My prompt'}])
        self.run_chat()
        result = self.store.save_config({'reset': True})
        self.assertEqual(result['baseUrl'], DEFAULTS['baseUrl'])
        self.assertEqual(result['temperature'], 1)
        self.assertEqual(result['model'], 'test-model')
        self.assertEqual(self.store.config()['apiKey'], 'secret-test-key')
        self.assertEqual(result['presets'][-1]['prompt'], 'My prompt')
        self.assertEqual(len(self.store.sessions()['items']), 1)
        self.assertNotIn('secret-test-key', json.dumps(result))
        self.assertNotIn('secret-test-key', self.store.db_path.read_bytes().decode('utf-8', 'ignore'))

    def test_invalid_patch_does_not_overwrite_good_config(self):
        self.configured()
        before = self.store.config_path.read_bytes()
        for patch in ({'temperature': float('nan')}, {'topP': 0}, {'timeout': True}, {'maxTokens': 1.5}, {'baseUrl': 'javascript:x'}, {'baseUrl': 'https://user:pass@host'}, {'presets': [{'id': 'none', 'name': 'override', 'prompt': ''}]}):
            with self.subTest(patch=patch), self.assertRaises(NoteAIError):
                self.store.save_config(patch)
            self.assertEqual(before, self.store.config_path.read_bytes())
        self.store.save_config({'model': ''})
        self.assertEqual(self.store.config()['model'], '')

    def test_corrupt_config_recovers_without_rewriting(self):
        self.store.config_path.write_text('{bad', encoding='utf-8')
        self.assertEqual(self.store.config()['model'], '')
        self.assertEqual(self.store.config_path.read_text(), '{bad')
        self.store.config_path.write_text(json.dumps({'version': 1, 'apiKey': 'preserve', 'temperature': 900}), encoding='utf-8')
        self.assertEqual(self.store.config()['apiKey'], 'preserve')
        self.assertEqual(self.store.config()['temperature'], 1)

    def test_request_parameter_modes(self):
        config = dict(DEFAULTS, model='user-model')
        request = chat_body(config, [{'role': 'user', 'content': 'hello'}])
        self.assertNotIn('thinking', request)
        self.assertNotIn('reasoning_effort', request)
        self.assertNotIn('max_tokens', request)
        self.assertEqual(request['stream_options'], {'include_usage': True})
        request = chat_body(dict(config, stream=False, thinking='enabled', effort='max', maxTokens=123), [])
        self.assertEqual(request['thinking'], {'type': 'enabled'})
        self.assertEqual(request['reasoning_effort'], 'max')
        self.assertNotIn('temperature', request)
        self.assertNotIn('stream_options', request)
        self.assertEqual(request['max_tokens'], 123)

    def test_stream_split_utf8_usage_and_reload(self):
        self.configured()
        events = self.run_chat()
        self.assertEqual([item['text'] for item in events if item['type'] == 'delta'], ['回答'])
        self.assertEqual(events[-1]['status'], 'complete')
        reopened = NoteAIStore(self.root, self.atomic)
        history = reopened.messages('session')
        self.assertEqual(history['messages'][1]['reasoning'], '思考')
        self.assertEqual(history['messages'][1]['usage']['prompt_tokens'], 12)
        self.assertEqual(reopened.sessions()['active'], 'session')

    def test_no_system_and_bounded_complete_context(self):
        self.configured()
        captured = []
        def upstream(config, messages, active):
            captured.append(messages)
            return completion()
        with mock.patch.object(self.store, '_upstream', side_effect=upstream):
            for index in range(23):
                list(self.store.events({'sessionId': 's', 'requestId': 'r' + str(index), 'text': str(index), 'newSession': True}))
        self.assertEqual(captured[0], [{'role': 'user', 'content': '0'}])
        self.assertEqual(len(captured[-1]), 39)
        self.assertEqual(captured[-1][0], {'role': 'user', 'content': '3'})
        self.assertTrue(all('reasoning_content' not in item and item['role'] != 'system' for item in captured[-1]))
        recent = self.store.messages('s')
        self.assertTrue(recent['more'])
        self.assertEqual(len(recent['messages']), 40)
        self.assertEqual(len(self.store.messages('s', recent['messages'][0]['id'])['messages']), 6)

    def test_preset_snapshot_survives_edit_and_delete(self):
        self.configured(presets=[{'id': 'custom', 'name': 'Name', 'prompt': 'Original system'}])
        self.run_chat(presetId='custom')
        self.store.save_config({'presets': []})
        with mock.patch.object(self.store, '_upstream', return_value=completion()) as upstream:
            list(self.store.events({'sessionId': 'session', 'requestId': 'second', 'text': 'again'}))
        self.assertEqual(upstream.call_args.args[1][0], {'role': 'system', 'content': 'Original system'})

    def test_duplicate_cancel_and_deletion_cannot_resurrect(self):
        self.configured()
        events = self.store.events({'sessionId': 's', 'requestId': 'r', 'text': 'hello', 'newSession': True})
        self.assertEqual(next(events)['type'], 'meta')
        with self.assertRaises(NoteAIError):
            next(self.store.events({'sessionId': 's', 'requestId': 'r2', 'text': 'overlap'}))
        self.store.session_action({'id': 's', 'action': 'delete'})
        self.assertEqual(list(events)[-1]['status'], 'interrupted')
        self.assertEqual(self.store.sessions()['items'], [])
        with self.assertRaises(NoteAIError):
            next(self.store.events({'sessionId': 's', 'requestId': 'r', 'text': 'hello', 'newSession': True}))
        self.store.cancel('early')
        with self.assertRaises(NoteAIError):
            next(self.store.events({'sessionId': 'new', 'requestId': 'early', 'text': 'hello', 'newSession': True}))
        self.assertEqual(self.store.sessions()['items'], [])

    def test_http_errors_are_redacted_and_retry_replaces_failed_turn(self):
        self.configured()
        for index, code in enumerate((401, 402, 429, 503)):
            error = urllib.error.HTTPError('https://private', code, 'secret-test-key', {}, io.BytesIO(b'secret-test-key'))
            with mock.patch.object(self.store, '_upstream', side_effect=error):
                result = list(self.store.events({'sessionId': 'err' + str(index), 'requestId': 'err' + str(index), 'text': 'hello', 'newSession': True}))
            self.assertIn({'type': 'error', 'code': 'http-' + str(code)}, result)
            self.assertNotIn('secret-test-key', str(result))
        self.run_chat(session='err0', request='retry', retryOf='err0')
        self.assertEqual(len(self.store.messages('err0')['messages']), 2)

    def test_incomplete_and_truncated_and_nonstream(self):
        self.configured()
        with mock.patch.object(self.store, '_upstream', return_value=Chunked(b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')):
            result = list(self.store.events({'sessionId': 'partial', 'requestId': 'partial', 'text': 'hello', 'newSession': True}))
        self.assertEqual(result[-1]['status'], 'failed')
        with mock.patch.object(self.store, '_upstream', return_value=completion(finish='length')):
            result = list(self.store.events({'sessionId': 'length', 'requestId': 'length', 'text': 'hello', 'newSession': True}))
        self.assertEqual(self.store.messages('length')['messages'][-1]['finish_reason'], 'length')
        self.store.save_config({'stream': False})
        payload = io.BytesIO(json.dumps({'choices': [{'message': {'content': 'Full answer'}, 'finish_reason': 'stop'}]}).encode())
        with mock.patch.object(self.store, '_upstream', return_value=payload):
            result = list(self.store.events({'sessionId': 'full', 'requestId': 'full', 'text': 'hello', 'newSession': True}))
        self.assertEqual(result[-1]['status'], 'complete')

    def test_total_timeout_interrupts_without_holding_db_lock(self):
        self.configured(timeout=1)
        entered = threading.Event()
        class Waiting:
            def __init__(self):
                self.closed = threading.Event()
            def read1(self, size):
                entered.set()
                self.closed.wait(3)
                return b''
            def close(self):
                self.closed.set()
        def upstream(config, messages, active):
            response = Waiting(); active.attach(response); return response
        results = []
        with mock.patch.object(self.store, '_upstream', side_effect=upstream):
            worker = threading.Thread(target=lambda: results.extend(self.store.events({'sessionId': 's', 'requestId': 'r', 'text': 'hello', 'newSession': True})))
            worker.start(); self.assertTrue(entered.wait(2))
            self.assertEqual(len(self.store.sessions()['items']), 1)
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertIn({'type': 'error', 'code': 'timeout'}, results)
        self.assertEqual(self.store.messages('s')['messages'][-1]['status'], 'failed')

    def test_sse_final_frame_without_newline(self):
        self.assertEqual(list(sse_payloads(Chunked('data: {"text":"中文"}'.encode()))), ['{"text":"中文"}'])

    def test_short_key_never_returns_the_complete_secret(self):
        public = self.store.save_config({'apiKey': 'abc'})
        self.assertNotIn('abc', json.dumps(public))

    def test_stop_before_provider_sends_headers(self):
        entered, release = threading.Event(), threading.Event()
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                entered.set()
                release.wait(3)
                try:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'data: [DONE]\n\n')
                except OSError:
                    pass
            def log_message(self, *_):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        serve = threading.Thread(target=server.serve_forever, daemon=True)
        serve.start()
        self.configured(baseUrl='http://127.0.0.1:' + str(server.server_address[1]))
        events = []
        worker = threading.Thread(target=lambda: events.extend(self.store.events({'sessionId': 's', 'requestId': 'r', 'text': 'hello', 'newSession': True})))
        try:
            worker.start()
            self.assertTrue(entered.wait(2))
            self.assertIsNotNone(self.store.active['r'].connection)
            self.assertIsNotNone(self.store.active['r'].connection.sock)
            self.store.cancel('r')
            worker.join(1)
            self.assertFalse(worker.is_alive(), 'stop must interrupt header reads')
            self.assertEqual(events[-1]['status'], 'interrupted')
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            worker.join(3)


if __name__ == '__main__':
    unittest.main()
