"""A tiny stand-in for the Ollama HTTP API, used by the tests (and handy for UI demos).

    python tests/fake_ollama.py 11434
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeOllama:
    def __init__(self, port: int = 0, models: list[str] | None = None, reply: str | None = None):
        self.requests: list[tuple[str, dict]] = []
        self.models = list(models or [])
        self.reply = reply or "Use **MFA** everywhere.\n\n```bash\nsudo ufw enable\n```"
        self.thinking = "The user wants hardening advice. Start with identity."
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, obj, status=200):
                body = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _stream(self, chunks):
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                for c in chunks:
                    self.wfile.write((json.dumps(c) + "\n").encode())
                    self.wfile.flush()

            def do_GET(self):  # noqa: N802
                fake.requests.append((self.path, {}))
                if self.path == "/api/version":
                    return self._send({"version": "0.12.0-fake"})
                if self.path == "/api/tags":
                    return self._send({"models": [{"name": m} for m in fake.models]})
                if self.path == "/api/ps":
                    return self._send({"models": []})
                self._send({"error": "not found"}, 404)

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                fake.requests.append((self.path, body))
                if self.path == "/api/pull":
                    fake.models.append(body["model"])
                    return self._stream([{"status": "pulling manifest"},
                                         {"status": "downloading", "completed": 50, "total": 100},
                                         {"status": "downloading", "completed": 100, "total": 100},
                                         {"status": "success"}])
                if self.path == "/api/create":
                    fake.models.append(body["model"] + ":latest")
                    return self._send({"status": "success"})
                if self.path == "/api/generate":
                    return self._send({"done": True})
                if self.path == "/api/chat":
                    system = body["messages"][0]["content"] if body["messages"] else ""
                    if not body.get("stream", True):
                        if "running memory" in system:
                            text = "- User is hardening servers.\n- Discussed MFA and firewalls."
                        else:
                            text = "Server Hardening Basics"
                        return self._send({"message": {"role": "assistant", "content": text}, "done": True})
                    chunks = []
                    if body.get("think"):
                        for w in fake.thinking.split(" "):
                            chunks.append({"message": {"role": "assistant", "content": "", "thinking": w + " "}})
                    for i in range(0, len(fake.reply), 7):
                        chunks.append({"message": {"role": "assistant", "content": fake.reply[i:i + 7]}})
                    chunks.append({"message": {"role": "assistant", "content": ""}, "done": True,
                                   "prompt_eval_count": 321, "eval_count": 42, "eval_duration": 1_000_000_000})
                    return self._stream(chunks)
                self._send({"error": "not found"}, 404)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"

    def start(self) -> FakeOllama:
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def chats(self, stream: bool | None = None) -> list[dict]:
        out = [b for p, b in self.requests if p == "/api/chat"]
        return out if stream is None else [b for b in out if b.get("stream", True) == stream]


if __name__ == "__main__":
    f = FakeOllama(int(sys.argv[1]) if len(sys.argv) > 1 else 11434, models=["qwen3:8b"]).start()
    print(f"fake ollama on {f.url}")
    while True:
        time.sleep(3600)
