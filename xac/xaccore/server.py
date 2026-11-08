"""XAC's local web server (stdlib only).

Security posture - this is a security tool, so it behaves like one:
  * binds to 127.0.0.1 only; nothing on your network can reach it
  * rejects requests whose Host header isn't localhost (blocks DNS-rebinding attacks)
  * state-changing requests must carry an `X-XAC: 1` header and a matching Origin, which a
    malicious web page in your browser cannot forge without a CORS preflight XAC never approves
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .engine import Engine
from .ollama import OllamaError

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
MAX_BODY = 2 * 1024 * 1024
ALLOWED_HOSTS = ("127.0.0.1", "localhost", "[::1]")
SETTABLE = {"profile", "model", "num_ctx", "think", "temperature", "min_params_gb", "min_context_gb",
            "auto_condense", "park_after_min"}


def make_handler(engine: Engine, port: int):
    origins = {f"http://{h}:{port}" for h in ALLOWED_HOSTS}
    pull_state: dict = {"active": False}

    class Handler(BaseHTTPRequestHandler):
        server_version = "XAC"
        sys_version = ""

        def log_message(self, fmt, *args):  # keep the console quiet
            pass

        # ------------------------------------------------------------ helpers
        def _host_ok(self) -> bool:
            host = re.sub(r":\d+$", "", (self.headers.get("Host") or "").strip().lower())
            return host in ALLOWED_HOSTS

        def _write_ok(self) -> bool:
            origin = self.headers.get("Origin")
            return self.headers.get("X-XAC") == "1" and (origin is None or origin in origins)

        def _headers(self, status: int, ctype: str, length: int | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
                             "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()

        def _json(self, obj, status: int = 200) -> None:
            body = json.dumps(obj).encode()
            self._headers(status, "application/json", len(body))
            self.wfile.write(body)

        def _err(self, status: int, msg: str) -> None:
            self._json({"error": msg}, status)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("request too large")
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw or b"{}")
            if not isinstance(data, dict):
                raise ValueError("expected a JSON object")
            return data

        def _stream_start(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()

        def _emit(self, obj: dict) -> None:
            self.wfile.write((json.dumps(obj) + "\n").encode())
            self.wfile.flush()

        def _conv(self, cid: int) -> dict | None:
            conv = engine.store.get_conversation(cid)
            if not conv:
                self._err(404, "conversation not found")
            return conv

        # ------------------------------------------------------------- routing
        def _dispatch(self, method: str) -> None:
            if not self._host_ok():
                return self._err(HTTPStatus.MISDIRECTED_REQUEST, "XAC only answers on localhost")
            path = urlparse(self.path).path
            if method != "GET" and not self._write_ok():
                return self._err(403, "missing XAC request header")
            try:
                if path.startswith("/api/"):
                    return self._api(method, path[4:])
                if method == "GET":
                    return self._static(path)
                self._err(405, "method not allowed")
            except (ValueError, json.JSONDecodeError) as e:
                self._err(400, str(e))
            except OllamaError as e:
                self._err(502, str(e))
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):  # noqa: N802
            self._dispatch("GET")

        def do_POST(self):  # noqa: N802
            self._dispatch("POST")

        def do_PATCH(self):  # noqa: N802
            self._dispatch("PATCH")

        def do_DELETE(self):  # noqa: N802
            self._dispatch("DELETE")

        def _static(self, path: str) -> None:
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            full = os.path.realpath(os.path.join(WEB_DIR, name))
            if not full.startswith(os.path.realpath(WEB_DIR) + os.sep) or not os.path.isfile(full):
                return self._err(404, "not found")
            with open(full, "rb") as f:
                body = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            self._headers(200, ctype, len(body))
            self.wfile.write(body)

        def _api(self, method: str, path: str) -> None:
            m = re.fullmatch(r"/conversations/(\d+)(/[a-z]+)?", path)
            cid = int(m.group(1)) if m else None
            sub = (m.group(2) or "") if m else ""

            if path == "/status" and method == "GET":
                return self._json(engine.status())

            if path == "/conversations":
                if method == "GET":
                    return self._json({"conversations": engine.store.list_conversations(),
                                       "active_id": engine.active_cid})
                if method == "POST":
                    return self._json(engine.store.create_conversation())

            if cid is not None:
                if not self._conv(cid):
                    return None
                if sub == "" and method == "GET":
                    conv = engine.store.get_conversation(cid)
                    return self._json({"conversation": conv, "messages": engine.store.messages(cid),
                                       "context": engine.context_stats(cid)})
                if sub == "" and method == "PATCH":
                    engine.store.rename_conversation(cid, str(self._body().get("title", "")))
                    return self._json({"ok": True})
                if sub == "" and method == "DELETE":
                    if engine.active_cid == cid:
                        engine.park(cid)
                    engine.store.delete_conversation(cid)
                    return self._json({"ok": True})
                if sub == "/chat" and method == "POST":
                    return self._chat(cid, self._body())
                if sub == "/condense" and method == "POST":
                    ok = engine.condense(cid, force=True)
                    return self._json({"condensed": ok, "context": engine.context_stats(cid)})
                if sub == "/park" and method == "POST":
                    engine.park(cid)
                    return self._json({"ok": True, "context": engine.context_stats(cid)})

            if path == "/memories":
                if method == "GET":
                    return self._json({"memories": engine.store.list_memories()})
                if method == "POST":
                    text = str(self._body().get("content", "")).strip()
                    if not text:
                        raise ValueError("memory is empty")
                    return self._json({"id": engine.store.add_memory(text)})
            mm = re.fullmatch(r"/memories/(\d+)", path)
            if mm and method == "DELETE":
                engine.store.delete_memory(int(mm.group(1)))
                return self._json({"ok": True})

            if path == "/settings" and method == "POST":
                return self._settings(self._body())
            if path == "/pull" and method == "POST":
                return self._pull()
            return self._err(404, "unknown endpoint")

        # ------------------------------------------------------------ actions
        def _chat(self, cid: int, body: dict) -> None:
            text = str(body.get("message", "")).strip()
            regenerate = bool(body.get("regenerate"))
            if not text and not regenerate:
                raise ValueError("message is empty")
            if text.startswith("/remember "):
                engine.store.add_memory(text[len("/remember "):])
                self._stream_start()
                self._emit({"type": "memory_saved", "content": text[len("/remember "):].strip()})
                return self._emit({"type": "done"})
            think = body.get("think")
            self._stream_start()
            for event in engine.chat(cid, text, think if isinstance(think, bool) else None, regenerate):
                self._emit(event)

        def _settings(self, body: dict) -> None:
            s = engine.settings
            for k, v in body.items():
                if k not in SETTABLE:
                    continue
                if k == "profile" and v not in ("fast", "balanced", "deep"):
                    raise ValueError("bad profile")
                if k in ("num_ctx",) and v is not None:
                    v = int(v)
                if k in ("temperature", "min_params_gb", "min_context_gb", "park_after_min") and v is not None:
                    v = float(v)
                    if v < 0:
                        raise ValueError(f"{k} must be positive")
                if k in ("model", "num_ctx") and not v:
                    v = None  # empty = automatic
                setattr(s, k, v)
            old = engine.plan.model
            plan = engine.replan()
            s.save()
            needs_pull = False
            try:
                needs_pull = not engine.ollama.has_model(plan.model)
            except OllamaError:
                pass
            if plan.model != old and not needs_pull:
                engine.ollama.unload(old)
                threading.Thread(target=engine.ensure_alias, daemon=True).start()
            return self._json({"plan": plan.to_dict(), "needs_pull": needs_pull, "settings": s.to_dict()})

        def _pull(self) -> None:
            if pull_state["active"]:
                return self._err(409, "a download is already running")
            pull_state["active"] = True
            try:
                self._stream_start()
                for chunk in engine.ollama.pull(engine.plan.model):
                    self._emit({"type": "progress", "status": chunk.get("status"),
                                "completed": chunk.get("completed"), "total": chunk.get("total")})
                engine.ensure_alias()
                self._emit({"type": "done"})
            except OllamaError as e:
                self._emit({"type": "error", "message": str(e)})
            finally:
                pull_state["active"] = False

    return Handler


def serve(engine: Engine, port: int = 8787) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(engine, port))
    httpd.daemon_threads = True
    return httpd
