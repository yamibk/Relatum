"""Local note chat storage and a cancellable, stdlib-only Chat Completions client.

This store owns durable conversations; it is deliberately separate from the
rebuildable note index and from the canvas AI's configuration/action protocol.
"""
from __future__ import annotations

import codecs
import http.client
import io
import json
import math
import re
import select
import socket
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path


DEFAULTS = {"baseUrl": "https://api.deepseek.com", "model": "", "apiKey": "",
            "stream": True, "thinking": "auto", "effort": "high", "temperature": 1,
            "topP": 1, "maxTokens": None, "timeout": 600}
DICTIONARY_PROMPT = """你是一个英语查词助手。用户会输入一个英文单词或短语，你用简体中文讲解。请严格按下面的纯文本格式输出，不要使用 # 或 ** 等 markdown 符号，不要有任何开场白或结尾寒暄：

【词频】
用一行说明该词的常用程度（高频/中频/低频），并标注适用级别（如 CEFR 等级、四六级/考研/雅思托福），可加简短说明。

【释义】
按词性和义项分条，编号 1、2、3…… 每条以 [词性] 开头（如 [动词]、[名词]、[形容词]），后接中文释义。

【例句】
为每个义项配 1-2 个例句，例句编号与释义对应：义项 1 的例句编号为 1.1、1.2，义项 2 的例句编号为 2.1、2.2，依此类推。每句格式为：英文例句 (中文翻译)

【搭配与辨析】
- 常用搭配：列出常见搭配或词组，附简短中文说明。
- 词根记忆：拆解词根词缀帮助记忆（若适用）。
- 易混词：列出形近或义近、容易混淆的词，并简要说明区别。

注意：解释一律用简体中文（例句正文用英文）；若用户输入的不是英文单词或短语，请先用一句话说明，再尽量给出最有用的信息。"""
BUILTINS = [
    {"id": "none", "name": "无预设", "prompt": "", "builtin": True},
    {"id": "dictionary", "name": "查词", "prompt": DICTIONARY_PROMPT, "builtin": True},
    {"id": "deepseek", "name": "Deepseek", "prompt": "你是一名通用 AI 助手。默认使用简体中文，清晰、准确地回答用户的问题；根据需要使用 Markdown；信息不足时说明不确定之处。", "builtin": True},
]
MAX_TEXT = 262144
MAX_RESPONSE = 8 * 1024 * 1024
IDENTITY = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")


class NoteAIError(Exception):
    def __init__(self, message, code="invalid", status=400):
        super().__init__(message)
        self.code, self.status = code, status


def identity(value):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise NoteAIError("操作身份无效")
    return value


def validate_field(key, value):
    if key in ("baseUrl", "model", "apiKey"):
        if not isinstance(value, str) or len(value) > 8192:
            raise NoteAIError("连接参数无效")
        value = value.strip()
        if key == "baseUrl":
            url = urllib.parse.urlsplit(value)
            if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise NoteAIError("接口地址应为 HTTP 或 HTTPS 基础地址", "base-url")
            value = value.rstrip("/")
        return value
    if key == "stream" and type(value) is bool:
        return value
    if key == "thinking" and value in ("auto", "enabled", "disabled"):
        return value
    if key == "effort" and value in ("low", "high", "max"):
        return value
    if key in ("temperature", "topP") and type(value) in (int, float) and math.isfinite(value):
        if (key == "temperature" and 0 <= value <= 2) or (key == "topP" and 0 < value <= 1):
            return value
    if key == "maxTokens" and (value is None or type(value) is int and 1 <= value <= 393216):
        return value
    if key == "timeout" and type(value) is int and 1 <= value <= 3600:
        return value
    raise NoteAIError("生成参数无效：" + key)


def chat_body(config, messages):
    body = {"model": config["model"], "messages": messages, "stream": config["stream"],
            "temperature": config["temperature"], "top_p": config["topP"]}
    if config["stream"]:
        body["stream_options"] = {"include_usage": True}
    if config["thinking"] != "auto":
        body["thinking"] = {"type": config["thinking"]}
    if config["thinking"] == "enabled":
        body["reasoning_effort"] = config["effort"]
        body.pop("temperature")
    if config["maxTokens"] is not None:
        body["max_tokens"] = config["maxTokens"]
    return body


class ActiveRequest:
    def __init__(self, session):
        self.session = session
        self.cancelled = threading.Event()
        self.reason = "interrupted"
        self.response = None
        self.connection = None
        self.lock = threading.Lock()

    def attach(self, response):
        with self.lock:
            self.response = response
            cancelled = self.cancelled.is_set()
        if cancelled:
            self.cancel(self.reason)

    def attach_connection(self, connection):
        with self.lock:
            self.connection = connection
            cancelled = self.cancelled.is_set()
        if cancelled:
            self.cancel(self.reason)

    def cancel(self, reason="interrupted"):
        with self.lock:
            self.reason = reason
            self.cancelled.set()
            response = self.response
            connection = self.connection
        if connection:
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except (AttributeError, OSError):
                pass
            connection.close()
        if response:
            # Interrupt a blocking read before close(), including Windows sockets.
            try:
                response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
            except (AttributeError, OSError):
                pass
            try:
                response.close()
            except (OSError, ValueError):
                pass


def sse_payloads(response):
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buffer, data, data_size = "", [], 0
    while True:
        chunk = response.read1(4096) if hasattr(response, "read1") else response.read(4096)
        buffer += decoder.decode(chunk, final=not chunk)
        if len(buffer) > MAX_RESPONSE:
            raise NoteAIError("接口返回过长的数据行", "response-limit", 502)
        # CRLF may itself straddle transport chunks; split only on LF.
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line:
                if data:
                    yield "\n".join(data)
                    data = []
                    data_size = 0
            elif line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
                data_size += len(line)
                if data_size > MAX_RESPONSE:
                    raise NoteAIError("接口返回过长的事件", "response-limit", 502)
        if not chunk:
            if buffer.startswith("data:"):
                data.append(buffer[5:].lstrip(" ").rstrip("\r"))
            if data:
                yield "\n".join(data)
            return


class NoteAIStore:
    def __init__(self, directory: Path, atomic_json):
        self.directory = Path(directory)
        self.config_path = self.directory / "note-ai.json"
        self.db_path = self.directory / "note-ai.sqlite3"
        self.atomic_json = atomic_json
        self.config_lock = threading.RLock()
        self.db_lock = threading.RLock()
        self.ready = False
        self.active_lock = threading.RLock()
        self.active = {}
        self.early_cancel = {}

    def config(self):
        with self.config_lock:
            value = {**DEFAULTS, "presets": []}
            try:
                raw = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
                if not isinstance(raw, dict) or raw.get("version") != 1:
                    return value
                for key in DEFAULTS:
                    if key in raw:
                        try:
                            value[key] = validate_field(key, raw[key])
                        except (NoteAIError, TypeError, ValueError):
                            pass
                value["presets"] = self._presets(raw.get("presets", []))
            except (OSError, ValueError, TypeError, NoteAIError):
                pass
            return value

    @staticmethod
    def _presets(items):
        if not isinstance(items, list) or len(items) > 100:
            raise NoteAIError("预设列表无效")
        result, seen = [], {item["id"] for item in BUILTINS}
        for item in items:
            if not isinstance(item, dict):
                raise NoteAIError("预设无效")
            key = identity(item.get("id"))
            name, prompt = item.get("name"), item.get("prompt")
            if key in seen or not isinstance(name, str) or not name.strip() or len(name) > 80 or not isinstance(prompt, str) or len(prompt) > 65536:
                raise NoteAIError("预设名称或提示词无效")
            seen.add(key)
            result.append({"id": key, "name": name.strip(), "prompt": prompt, "builtin": False})
        return result

    def public_config(self, value=None):
        value = dict(value or self.config())
        key = value.pop("apiKey")
        return {**value, "hasKey": bool(key), "keyHint": ("••••" + key[-4:] if len(key) > 4 else "••••") if key else "",
                "presets": [*BUILTINS, *value["presets"]]}

    def save_config(self, patch):
        if not isinstance(patch, dict):
            raise NoteAIError("设置格式无效")
        with self.config_lock:
            value = self.config()
            if patch.get("reset") is True:
                value.update({key: default for key, default in DEFAULTS.items() if key not in ("model", "apiKey")})
            else:
                for key, raw in patch.items():
                    if key in DEFAULTS:
                        value[key] = validate_field(key, raw)
                    elif key == "presets":
                        value[key] = self._presets(raw)
                    else:
                        raise NoteAIError("未知设置字段")
            self.atomic_json(self.config_path, {"version": 1, **value})
            return self.public_config(value)

    @contextmanager
    def db(self):
        with self.db_lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.db_path, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                if not self.ready:
                    conn.executescript("""
                        PRAGMA journal_mode=WAL;
                        CREATE TABLE IF NOT EXISTS sessions(
                            id TEXT PRIMARY KEY, title TEXT NOT NULL, preset_id TEXT NOT NULL,
                            preset_name TEXT NOT NULL, prompt TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
                        CREATE TABLE IF NOT EXISTS messages(
                            id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                            request_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
                            reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
                            usage TEXT, model TEXT NOT NULL DEFAULT '', elapsed REAL NOT NULL DEFAULT 0,
                            context_count INTEGER NOT NULL DEFAULT 0, finish_reason TEXT NOT NULL DEFAULT '', UNIQUE(request_id,role));
                        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,id);
                        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);
                        UPDATE messages SET status='interrupted' WHERE status='pending';
                    """)
                    conn.commit()
                    self.ready = True
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.close()

    def sessions(self, offset=0):
        with self.db() as conn:
            rows = conn.execute("SELECT id,title,preset_id,preset_name,created,updated FROM sessions ORDER BY updated DESC,id LIMIT 41 OFFSET ?", (max(0, offset),)).fetchall()
            active = conn.execute("SELECT value FROM state WHERE key='active'").fetchone()
            return {"items": [dict(row) for row in rows[:40]], "more": len(rows) > 40, "active": active[0] if active else None}

    def messages(self, session, before=0):
        identity(session)
        with self.db() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
            if not row:
                raise NoteAIError("会话不存在", "not-found", 404)
            rows = conn.execute("SELECT * FROM messages WHERE session_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT 41", (session, before, before)).fetchall()
            messages = [dict(item) for item in reversed(rows[:40])]
            for item in messages:
                item["usage"] = json.loads(item["usage"]) if item["usage"] else None
            return {"session": dict(row), "messages": messages, "more": len(rows) > 40}

    def session_action(self, body):
        key, action = body.get("id"), body.get("action")
        if action == "select" and key is None:
            with self.db() as conn:
                conn.execute("DELETE FROM state WHERE key='active'")
            return {"ok": True}
        identity(key)
        if action == "delete":
            with self.active_lock:
                running = [item for item in self.active.values() if item.session == key]
            for item in running:
                item.cancel()
        with self.db() as conn:
            if not conn.execute("SELECT 1 FROM sessions WHERE id=?", (key,)).fetchone():
                raise NoteAIError("会话不存在", "not-found", 404)
            if action == "delete":
                conn.execute("DELETE FROM sessions WHERE id=?", (key,))
                conn.execute("DELETE FROM state WHERE key='active' AND value=?", (key,))
            elif action == "rename":
                title = body.get("title")
                if not isinstance(title, str) or not title.strip() or len(title) > 120:
                    raise NoteAIError("会话名称无效")
                conn.execute("UPDATE sessions SET title=? WHERE id=?", (title.strip(), key))
            elif action == "select":
                conn.execute("INSERT OR REPLACE INTO state VALUES('active',?)", (key,))
            else:
                raise NoteAIError("未知会话操作")
        return {"ok": True}

    def cancel(self, request_id):
        identity(request_id)
        with self.active_lock:
            active = self.active.get(request_id)
            if not active:
                now = time.monotonic()
                self.early_cancel = {key: stamp for key, stamp in self.early_cancel.items() if now - stamp < 60}
                if len(self.early_cancel) >= 128:
                    self.early_cancel.pop(next(iter(self.early_cancel)))
                self.early_cancel[request_id] = now
        if active:
            active.cancel()
        return {"ok": True}

    def _prepare(self, body, config):
        session, request_id = identity(body.get("sessionId")), identity(body.get("requestId"))
        text = body.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise NoteAIError("消息不能为空或超过 262144 字符", "message-limit")
        if not config["apiKey"] or not config["model"]:
            raise NoteAIError("请先填写模型名称和 API Key", "config-required")
        with self.active_lock:
            if request_id in self.active or any(item.session == session for item in self.active.values()):
                raise NoteAIError("此会话已有进行中的请求", "busy", 409)
            if request_id in self.early_cancel:
                self.early_cancel.pop(request_id)
                raise NoteAIError("请求已停止", "interrupted", 409)
            active = ActiveRequest(session)
            self.active[request_id] = active
        try:
            with self.db() as conn:
                if conn.execute("SELECT 1 FROM requests WHERE id=?", (request_id,)).fetchone():
                    raise NoteAIError("请求已处理，请勿重复发送", "duplicate", 409)
                row = conn.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
                if not row:
                    if body.get("newSession") is not True:
                        raise NoteAIError("会话不存在", "not-found", 404)
                    preset = next((item for item in [*BUILTINS, *config["presets"]] if item["id"] == body.get("presetId", "none")), None)
                    if not preset:
                        raise NoteAIError("预设不存在", "preset-missing")
                    now = time.time()
                    conn.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)", (session, text.strip().splitlines()[0][:60], preset["id"], preset["name"], preset["prompt"], now, now))
                    row = conn.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
                retry = body.get("retryOf")
                if retry:
                    last = conn.execute("SELECT request_id,status FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1", (session,)).fetchone()
                    original = conn.execute("SELECT content FROM messages WHERE session_id=? AND request_id=? AND role='user'", (session, retry)).fetchone()
                    if not last or last[0] != retry or last[1] not in ("failed", "interrupted") or not original or original[0] != text:
                        raise NoteAIError("只能重试最后一个未完成请求", "retry-invalid", 409)
                    conn.execute("DELETE FROM messages WHERE session_id=? AND request_id=?", (session, retry))
                # Only complete historical turns enter the new context. Keep pairs
                # intact and reserve one user message within the existing 40 limit.
                prior = conn.execute("SELECT u.content user,a.content assistant FROM messages u JOIN messages a ON u.request_id=a.request_id AND a.role='assistant' WHERE u.session_id=? AND u.role='user' AND a.status='complete' ORDER BY u.id DESC LIMIT 19", (session,)).fetchall()
                messages = [{"role": "system", "content": row["prompt"]}] if row["prompt"] else []
                for turn in reversed(prior):
                    messages.extend([{"role": "user", "content": turn["user"]}, {"role": "assistant", "content": turn["assistant"]}])
                messages.append({"role": "user", "content": text})
                if len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) > MAX_RESPONSE:
                    raise NoteAIError("本轮上下文超过 8 MiB，请新建对话", "context-limit")
                conn.execute("INSERT INTO requests VALUES(?,?)", (request_id, session))
                conn.execute("INSERT INTO messages(session_id,request_id,role,content,status) VALUES(?,?,'user',?,'complete')", (session, request_id, text))
                conn.execute("INSERT INTO messages(session_id,request_id,role,status,model,context_count) VALUES(?,?,'assistant','pending',?,?)", (session, request_id, config["model"], len(prior)))
                conn.execute("UPDATE sessions SET updated=? WHERE id=?", (time.time(), session))
                conn.execute("INSERT OR REPLACE INTO state VALUES('active',?)", (session,))
            return active, dict(row), messages, len(prior)
        except BaseException:
            with self.active_lock:
                self.active.pop(request_id, None)
            raise

    @staticmethod
    def _upstream(config, messages, active):
        base = config["baseUrl"].rstrip("/")
        url = base if base.endswith("/chat/completions") else base + "/chat/completions"
        request = urllib.request.Request(url, data=json.dumps(chat_body(config, messages)).encode("utf-8"), headers={"Authorization": "Bearer " + config["apiKey"], "Content-Type": "application/json", "Accept": "text/event-stream" if config["stream"] else "application/json"}, method="POST")

        class CancellableReader(io.RawIOBase):
            def __init__(self, raw, sock):
                self.raw, self._sock = raw, sock

            def readable(self):
                return True

            def readinto(self, buffer):
                # Windows header reads are not reliably woken by closing another
                # thread's buffered socket. Nonblocking reads + bounded select
                # make both headers and body cooperative, without a poll thread.
                while True:
                    if active.cancelled.is_set():
                        raise NoteAIError("请求已停止", active.reason)
                    writing = False
                    try:
                        size = self.raw.readinto(buffer)
                        if size is not None:
                            return size
                    except (BlockingIOError, ssl.SSLWantReadError):
                        pass
                    except ssl.SSLWantWriteError:
                        writing = True
                    select.select([] if writing else [self._sock], [self._sock] if writing else [], [], .1)

            def close(self):
                try:
                    self.raw.close()
                finally:
                    super().close()

        class ResponseSocket:
            def __init__(self, sock):
                self.sock = sock

            def makefile(self, mode):
                raw = self.sock.makefile(mode, buffering=0)
                self.sock.setblocking(False)
                return io.BufferedReader(CancellableReader(raw, self.sock))

        class HTTPResponse(http.client.HTTPResponse):
            def __init__(self, sock, *args, **kwargs):
                super().__init__(ResponseSocket(sock), *args, **kwargs)

        class CancellableConnection:
            response_class = HTTPResponse

            def _tunnel(self):
                # CONNECT also uses response_class. Its cancellable reader makes
                # the socket nonblocking; TLS must start with the connect timeout
                # restored after the proxy's headers have been consumed.
                try:
                    return super()._tunnel()
                finally:
                    if self.sock is not None:
                        self.sock.settimeout(self.timeout)

            def connect(self):
                if active.cancelled.is_set():
                    raise NoteAIError("请求已停止", active.reason)
                timeout = self.timeout
                self.timeout = min(timeout, 30)
                try:
                    super().connect()
                finally:
                    self.timeout = timeout
                self.sock.settimeout(timeout)
                active.attach_connection(self)
                if active.cancelled.is_set():
                    raise NoteAIError("请求已停止", active.reason)

        class HTTPConnection(CancellableConnection, http.client.HTTPConnection):
            pass

        class HTTPSConnection(CancellableConnection, http.client.HTTPSConnection):
            pass

        class HTTPHandler(urllib.request.HTTPHandler):
            def http_open(self, req):
                return self.do_open(HTTPConnection, req)

        class HTTPSHandler(urllib.request.HTTPSHandler):
            def https_open(self, req):
                return self.do_open(HTTPSConnection, req, context=self._context)

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        opener = urllib.request.build_opener(HTTPHandler(), HTTPSHandler(), NoRedirect())
        response = opener.open(request, timeout=config["timeout"])
        active.attach(response)
        return response

    def events(self, body):
        config = self.config()
        active, session, messages, count = self._prepare(body, config)
        request_id = body["requestId"]
        started, saved = time.monotonic(), 0
        content, reasoning, usage, finish, error = "", "", None, "", ""
        status, response = "pending", None
        timer = threading.Timer(config["timeout"], lambda: active.cancel("timeout"))
        timer.daemon = True
        timer.start()

        def persist():
            with self.db() as conn:
                conn.execute("UPDATE messages SET content=?,reasoning=?,status=?,error=?,usage=?,elapsed=?,finish_reason=? WHERE session_id=? AND request_id=? AND role='assistant'", (content, reasoning, status, error, json.dumps(usage) if usage else None, time.monotonic() - started, finish, session["id"], request_id))

        try:
            yield {"type": "meta", "session": session, "requestId": request_id, "contextCount": count, "model": config["model"]}
            if active.cancelled.is_set():
                raise NoteAIError("请求已停止", active.reason)
            response = self._upstream(config, messages, active)
            if config["stream"]:
                payloads = sse_payloads(response)
            else:
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise NoteAIError("回复超过 8 MiB", "response-limit", 502)
                payloads = [raw.decode("utf-8")]
            ended = False
            for raw in payloads:
                if active.cancelled.is_set():
                    raise NoteAIError("请求已停止", active.reason)
                if raw.strip() == "[DONE]":
                    ended = True
                    break
                try:
                    payload = json.loads(raw)
                except (ValueError, TypeError):
                    raise NoteAIError("接口返回了无效的 JSON", "protocol", 502) from None
                if not isinstance(payload, dict) or "error" in payload:
                    raise NoteAIError("AI 服务返回错误", "upstream", 502)
                if isinstance(payload.get("usage"), dict):
                    usage = {key: value for key, value in payload["usage"].items() if key in ("prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "completion_tokens_details") and isinstance(value, (int, dict))}
                    yield {"type": "usage", "usage": usage}
                choices = payload.get("choices") or []
                if choices:
                    choice = choices[0]
                    delta = choice.get("delta" if config["stream"] else "message") or {}
                    for field, event in (("reasoning_content", "reasoning"), ("content", "delta")):
                        part = delta.get(field)
                        if isinstance(part, str) and part:
                            if field == "content":
                                content += part
                            else:
                                reasoning += part
                            if len(content) + len(reasoning) > MAX_RESPONSE // 4:
                                raise NoteAIError("回复过长，已停止接收", "response-limit", 502)
                            yield {"type": event, "text": part}
                    if choice.get("finish_reason"):
                        finish = str(choice["finish_reason"])
                        ended = True
                if time.monotonic() - saved >= .4:
                    persist()
                    saved = time.monotonic()
            if active.cancelled.is_set():
                raise NoteAIError("请求已停止", active.reason)
            if not ended or not content.strip():
                raise NoteAIError("接口未返回完整回答", "incomplete", 502)
            status = "complete"
        except GeneratorExit:
            active.cancel()
            status = "interrupted"
            raise
        except Exception as exc:
            if active.cancelled.is_set():
                code = active.reason
            elif isinstance(exc, urllib.error.HTTPError):
                code = "http-" + str(exc.code)
                exc.close()
            elif isinstance(exc, (TimeoutError, socket.timeout)):
                code = "timeout"
            elif isinstance(exc, NoteAIError):
                code = exc.code
            else:
                code = "network"
            status = "interrupted" if code == "interrupted" else "failed"
            # Error bodies/URLs can echo credentials; expose only our stable codes.
            error = code
            yield {"type": "error", "code": code}
        finally:
            timer.cancel()
            if response:
                try:
                    response.close()
                except (OSError, ValueError):
                    pass
            if status == "pending":
                status = "interrupted"
            try:
                persist()
            finally:
                with self.active_lock:
                    self.active.pop(request_id, None)
        yield {"type": "done", "status": status, "finishReason": finish, "elapsed": time.monotonic() - started, "usage": usage}

    def test_connection(self, body=None):
        config = self.config()
        if not config["model"] or not config["apiKey"]:
            raise NoteAIError("请先填写模型名称和 API Key", "config-required")
        config.update({"stream": False, "thinking": "disabled", "timeout": 20, "maxTokens": 16})
        active = ActiveRequest("")
        request_id = identity((body or {}).get("requestId") or uuid.uuid4().hex)
        with self.active_lock:
            if request_id in self.active:
                raise NoteAIError("请求正在进行", "busy", 409)
            if request_id in self.early_cancel:
                self.early_cancel.pop(request_id)
                raise NoteAIError("请求已停止", "interrupted", 409)
            self.active[request_id] = active
        response = None
        timer = threading.Timer(20, lambda: active.cancel("timeout"))
        timer.daemon = True
        timer.start()
        try:
            response = self._upstream(config, [{"role": "user", "content": "Reply OK."}], active)
            if active.cancelled.is_set():
                raise NoteAIError("请求已停止", active.reason)
            payload = json.loads(response.read(65536))
            if not payload.get("choices"):
                raise NoteAIError("接口返回内容异常", "protocol", 502)
            return {"ok": True}
        except urllib.error.HTTPError as exc:
            exc.close()
            raise NoteAIError("连接测试失败", "http-" + str(exc.code), 502) from None
        except (OSError, ValueError, urllib.error.URLError):
            raise NoteAIError("连接测试失败", "network", 502) from None
        finally:
            timer.cancel()
            if response:
                response.close()
            with self.active_lock:
                self.active.pop(request_id, None)
