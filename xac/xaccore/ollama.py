"""Minimal Ollama HTTP client (stdlib only)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Iterator

DEFAULT_HOST = "http://127.0.0.1:11434"


class OllamaError(RuntimeError):
    pass


class Ollama:
    def __init__(self, host: str | None = None):
        self.host = (host or os.environ.get("OLLAMA_HOST") or DEFAULT_HOST).rstrip("/")
        if not self.host.startswith("http"):
            self.host = "http://" + self.host
        self.managed_process: subprocess.Popen | None = None

    # ------------------------------------------------------------------ basics
    def _req(self, path: str, payload: dict | None = None, method: str | None = None, timeout: float = 30):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.host + path, data=data, method=method or ("POST" if data else "GET"),
                                     headers={"Content-Type": "application/json"})
        try:
            return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 - local URL
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            try:
                body = json.loads(body).get("error", body)
            except ValueError:
                pass
            raise OllamaError(f"Ollama {e.code}: {body}") from None
        except (urllib.error.URLError, OSError) as e:
            raise OllamaError(f"Cannot reach Ollama at {self.host}: {e}") from None

    def _json(self, path: str, payload: dict | None = None, method: str | None = None, timeout: float = 30):
        with self._req(path, payload, method, timeout) as r:
            return json.loads(r.read() or b"{}")

    def _stream(self, path: str, payload: dict, timeout: float = 600) -> Iterator[dict]:
        with self._req(path, payload, timeout=timeout) as r:
            for line in r:
                line = line.strip()
                if not line:
                    continue
                chunk = json.loads(line)
                if chunk.get("error"):
                    raise OllamaError(chunk["error"])
                yield chunk

    def alive(self) -> bool:
        try:
            self._json("/api/version", timeout=2)
            return True
        except OllamaError:
            return False

    def version(self) -> str:
        return self._json("/api/version", timeout=3).get("version", "?")

    # --------------------------------------------------------------- lifecycle
    @staticmethod
    def installed() -> bool:
        return shutil.which("ollama") is not None

    def start_server(self, flash_attention: bool, kv_type: str, wait: float = 30) -> bool:
        """Start `ollama serve` ourselves so we control VRAM-saving settings. Returns True if started."""
        if not self.installed():
            return False
        env = dict(os.environ)
        env["OLLAMA_FLASH_ATTENTION"] = "1" if flash_attention else "0"
        env["OLLAMA_KV_CACHE_TYPE"] = kv_type  # q8_0 halves context memory; needs flash attention
        env.setdefault("OLLAMA_MAX_LOADED_MODELS", "1")  # never let a 2nd model steal the VRAM budget
        env.setdefault("OLLAMA_NUM_PARALLEL", "1")  # parallel slots multiply the KV cache
        flags = {}
        if os.name == "nt":
            flags["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        self.managed_process = subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL,
                                                stderr=subprocess.DEVNULL, **flags)
        deadline = time.time() + wait
        while time.time() < deadline:
            if self.alive():
                return True
            if self.managed_process.poll() is not None:
                return False
            time.sleep(0.5)
        return False

    def stop_server(self) -> None:
        if self.managed_process and self.managed_process.poll() is None:
            self.managed_process.terminate()

    # ------------------------------------------------------------------ models
    def local_models(self) -> list[str]:
        return [m["name"] for m in self._json("/api/tags").get("models", [])]

    def has_model(self, tag: str) -> bool:
        names = self.local_models()
        want = tag if ":" in tag else tag + ":latest"
        return want in names or tag in names

    def pull(self, tag: str) -> Iterator[dict]:
        yield from self._stream("/api/pull", {"model": tag, "stream": True}, timeout=3600)

    def create_alias(self, name: str, base: str, system: str, parameters: dict) -> None:
        """Register `xac` as an Ollama model so `ollama run xac` works from any terminal too."""
        payload = {"model": name, "from": base, "system": system, "parameters": parameters, "stream": False}
        self._json("/api/create", payload, timeout=120)

    def unload(self, tag: str) -> None:
        try:
            self._json("/api/generate", {"model": tag, "keep_alive": 0}, timeout=30)
        except OllamaError:
            pass

    def running(self) -> list[dict]:
        try:
            return self._json("/api/ps", timeout=3).get("models", [])
        except OllamaError:
            return []

    # -------------------------------------------------------------------- chat
    def chat(self, model: str, messages: list[dict], options: dict, think: bool | None = None,
             keep_alive: str = "30m") -> Iterator[dict]:
        payload = {"model": model, "messages": messages, "options": options, "stream": True,
                   "keep_alive": keep_alive}
        if think is not None:
            payload["think"] = think
        yield from self._stream("/api/chat", payload)

    def complete(self, model: str, messages: list[dict], options: dict, think: bool = False) -> str:
        """Non-streaming helper for background jobs (summaries, titles)."""
        payload = {"model": model, "messages": messages, "options": options, "stream": False, "think": think}
        try:
            out = self._json("/api/chat", payload, timeout=600)
        except OllamaError as e:
            # Older Ollama builds reject the `think` field - retry without it.
            if "think" not in str(e):
                raise
            payload.pop("think")
            out = self._json("/api/chat", payload, timeout=600)
        return (out.get("message") or {}).get("content", "").strip()
