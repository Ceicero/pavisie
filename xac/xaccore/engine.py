"""The XAC chat engine.

* Builds each prompt inside the memory budget (>= 4 GB parameters, >= 2 GB conversation memory).
* Auto-condense: when a chat's verbatim history reaches CONDENSE_AT of its budget, the oldest turns
  are condensed into a running summary so the conversation can keep going indefinitely.
* Parking: only one conversation is "active" (held in the model's memory). Switching chats, or
  leaving XAC idle, parks the chat - saved to disk, using no VRAM/RAM - and talking in it again
  resumes it from its summary + recent messages.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field

from . import budget
from .hardware import Hardware
from .memory import Store, condense_split, estimate_tokens, live_messages, pack_history, tokens_of
from .ollama import Ollama, OllamaError
from .persona import SUMMARY_PROMPT, SYSTEM_PROMPT, TITLE_PROMPT, build_system_prompt

ALIAS = "xac"
CONDENSE_AT = 0.70  # condense when verbatim history fills 70% of its budget...
CONDENSE_TO = 0.40  # ...down to 40%, keeping the latest turns word-for-word

DEFAULTS = {
    "profile": "balanced",  # fast | balanced | deep
    "model": None,  # force an Ollama tag instead of auto-picking
    "num_ctx": None,  # force a context length (never below the floors)
    "think": True,  # show XAC's reasoning before the answer
    "temperature": None,  # None = model-recommended
    "min_params_gb": budget.DEFAULT_MIN_WEIGHTS_GB,  # parameters floor
    "min_context_gb": budget.DEFAULT_MIN_CONTEXT_GB,  # per-conversation memory floor
    "auto_condense": True,
    "park_after_min": 15,  # idle minutes before the active chat is parked and memory freed
}


def data_dir() -> str:
    path = os.environ.get("XAC_HOME") or os.path.join(os.path.expanduser("~"), ".xac")
    os.makedirs(path, exist_ok=True)
    return path


@dataclass
class Settings:
    profile: str = "balanced"
    model: str | None = None
    num_ctx: int | None = None
    think: bool = True
    temperature: float | None = None
    min_params_gb: float = budget.DEFAULT_MIN_WEIGHTS_GB
    min_context_gb: float = budget.DEFAULT_MIN_CONTEXT_GB
    auto_condense: bool = True
    park_after_min: float = 15
    path: str = field(default="", repr=False)

    @classmethod
    def load(cls, path: str) -> Settings:
        values = dict(DEFAULTS)
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    values.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
            except (OSError, ValueError):
                pass
        return cls(**values, path=path)

    def save(self) -> None:
        if self.path:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(self.to_dict(), f, indent=2)

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in DEFAULTS}

    @property
    def floors(self) -> budget.Floors:
        return budget.Floors(float(self.min_params_gb), float(self.min_context_gb))


class ThinkSplitter:
    """Fallback for Ollama builds without native `think` support: peel <think>...</think> out of content."""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, text: str) -> list[tuple[str, str]]:
        self.buf += text
        out: list[tuple[str, str]] = []
        while self.buf:
            tag = "</think>" if self.inside else "<think>"
            idx = self.buf.find(tag)
            if idx >= 0:
                if idx:
                    out.append(("thinking" if self.inside else "content", self.buf[:idx]))
                self.buf = self.buf[idx + len(tag):]
                self.inside = not self.inside
                continue
            # Hold back a possible partial tag at the end of the buffer.
            keep = next((n for n in range(len(tag) - 1, 0, -1) if self.buf.endswith(tag[:n])), 0)
            emit = self.buf[: len(self.buf) - keep]
            if emit:
                out.append(("thinking" if self.inside else "content", emit))
            self.buf = self.buf[len(emit):]
            break
        return out


class Engine:
    def __init__(self, hw: Hardware, catalog: list[budget.ModelSpec], ollama: Ollama, store: Store,
                 settings: Settings, managed_server: bool):
        self.hw = hw
        self.catalog = catalog
        self.ollama = ollama
        self.store = store
        self.settings = settings
        # VRAM-saving KV quantization only applies when XAC launched `ollama serve` itself.
        self.managed_server = managed_server
        self.kv_type = "q8_0" if managed_server else "f16"
        self.flash_attention = managed_server
        self.gen_lock = threading.Lock()
        self.condensing: set[int] = set()
        self.active_cid: int | None = None
        self.last_activity = time.time()
        self.store.park_all()  # nothing is in memory at startup
        self.plan = self.replan()
        self._stop = threading.Event()
        threading.Thread(target=self._idle_watch, daemon=True).start()

    # ------------------------------------------------------------------ budget
    def replan(self) -> budget.Plan:
        s = self.settings
        floors = s.floors
        if s.model:
            spec = next((m for m in self.catalog if m.tag == s.model), None)
            if spec is None:  # an Ollama tag we have no specs for - assume an 8B-class layout
                spec = budget.ModelSpec(s.model, s.model, 8.0, 5.0, 36, 8, 128, 32768, True)
            plan = budget.plan_for_model(spec, self.hw, s.profile, self.kv_type, self.flash_attention,
                                         s.num_ctx, s.think, floors)
        else:
            plan = budget.choose(self.hw, self.catalog, s.profile, self.kv_type, self.flash_attention, s.think,
                                 floors)
            if s.num_ctx:
                spec = next(m for m in self.catalog if m.tag == plan.model)
                plan = budget.plan_for_model(spec, self.hw, s.profile, self.kv_type, self.flash_attention,
                                             s.num_ctx, s.think, floors)
        if not self.managed_server:
            plan.warnings.append("Ollama was already running, so XAC couldn't enable flash attention + q8_0 "
                                 "chat-memory compression. Quit Ollama and restart XAC to fit ~2x more context.")
        self.plan = plan
        return plan

    def sampling(self, think: bool) -> dict:
        # Qwen3's recommended sampling for reasoning vs. direct answers.
        opts = {"temperature": 0.6, "top_p": 0.95, "top_k": 20} if think else \
               {"temperature": 0.7, "top_p": 0.8, "top_k": 20}
        if self.settings.temperature is not None:
            opts["temperature"] = float(self.settings.temperature)
        return opts

    def options(self, think: bool) -> dict:
        return {**self.plan.ollama_options(), **self.sampling(think)}

    @property
    def keep_alive(self) -> str:
        return f"{max(1, int(self.settings.park_after_min))}m"

    # -------------------------------------------------------------- bootstrap
    def ensure_alias(self) -> None:
        """Best effort: make `ollama run xac` available with the same persona and budget."""
        try:
            self.ollama.create_alias(ALIAS, self.plan.model, SYSTEM_PROMPT,
                                     {"num_ctx": self.plan.num_ctx, "num_gpu": self.plan.num_gpu})
        except OllamaError:
            pass

    # ---------------------------------------------------------------- parking
    def activate(self, cid: int) -> dict | None:
        """Make `cid` the conversation held in memory; park whichever one was there."""
        resumed = None
        if self.active_cid != cid:
            if self.active_cid is not None:
                self.store.set_state(self.active_cid, "parked")
            conv = self.store.get_conversation(cid)
            if conv and conv["state"] == "parked" and self.store.messages(cid):
                resumed = {"type": "resumed", "conversation_id": cid, "summarized": bool(conv.get("summary"))}
            self.store.park_all(except_id=cid)
            self.store.set_state(cid, "active")
            self.active_cid = cid
        self.last_activity = time.time()
        return resumed

    def park(self, cid: int | None = None, unload: bool = True) -> None:
        """Put a chat away: it stays on disk, and the model's memory is released."""
        cid = self.active_cid if cid is None else cid
        if cid is None:
            return
        self.store.set_state(cid, "parked")
        if cid == self.active_cid:
            self.active_cid = None
            if unload:
                threading.Thread(target=self._unload_when_idle, daemon=True).start()

    def _unload_when_idle(self) -> None:
        # Wait for any in-flight reply / condense / title job, then free VRAM - unless a chat
        # became active again in the meantime.
        with self.gen_lock:
            if self.active_cid is None:
                self.ollama.unload(self.plan.model)

    def _idle_watch(self) -> None:
        while not self._stop.wait(30):
            idle = time.time() - self.last_activity
            if self.active_cid is not None and idle > float(self.settings.park_after_min) * 60:
                self.park()

    def shutdown(self) -> None:
        self._stop.set()
        self.store.close()

    # -------------------------------------------------------------- budgeting
    def _system_for(self, conv: dict) -> str:
        memories = [m["content"] for m in self.store.list_memories()]
        return build_system_prompt(memories, conv.get("summary"))

    def history_budget(self, system: str) -> int:
        # Context = system + history + reply room, with a 5% safety margin for tokenizer error.
        return max(512, int(self.plan.num_ctx * 0.95) - self.plan.num_predict - estimate_tokens(system))

    def context_stats(self, cid: int) -> dict:
        conv = self.store.get_conversation(cid)
        if not conv:
            return {}
        system = self._system_for(conv)
        hb = self.history_budget(system)
        live = live_messages(self.store.messages(cid), conv.get("summary_upto") or 0)
        used = tokens_of(live)
        return {"num_ctx": self.plan.num_ctx, "context_gb": self.plan.context_gb, "history_budget": hb,
                "history_tokens": used, "system_tokens": estimate_tokens(system),
                "fill": round(min(1.0, used / hb), 3) if hb else 0, "live_messages": len(live),
                "summarized": bool(conv.get("summary")), "condense_count": conv.get("condense_count", 0),
                "summary_upto": conv.get("summary_upto") or 0, "state": conv["state"],
                "condensing": cid in self.condensing}

    def needs_condense(self, cid: int, threshold: float = CONDENSE_AT) -> bool:
        stats = self.context_stats(cid)
        return bool(stats) and stats["history_tokens"] > stats["history_budget"] * threshold

    def build_messages(self, cid: int) -> tuple[list[dict], dict]:
        conv = self.store.get_conversation(cid)
        system = self._system_for(conv)
        live = live_messages(self.store.messages(cid), conv.get("summary_upto") or 0)
        packed, used = pack_history(live, self.history_budget(system))
        return [{"role": "system", "content": system}] + packed, self.context_stats(cid)

    # ------------------------------------------------------------------- chat
    def chat(self, cid: int, text: str, think: bool | None = None, regenerate: bool = False) -> Iterator[dict]:
        think = self.settings.think if think is None else think
        think = think and self.plan.thinking
        resumed = self.activate(cid)
        if resumed:
            yield resumed
        if regenerate:
            self.store.delete_last_assistant(cid)
        else:
            self.store.add_message(cid, "user", text)

        # Overflow guard: if the verbatim history no longer fits, condense *before* answering
        # so nothing silently falls out of XAC's memory.
        if self.settings.auto_condense and self.needs_condense(cid, threshold=1.0):
            yield {"type": "condensing"}
            self.condense(cid)
            yield {"type": "condensed", **self.context_stats(cid)}

        messages, stats = self.build_messages(cid)
        yield {"type": "context", **stats}

        content, thinking = [], []
        splitter = ThinkSplitter()
        final: dict = {}
        with self.gen_lock:
            try:
                for chunk in self._chat_with_fallback(messages, think):
                    msg = chunk.get("message") or {}
                    if msg.get("thinking"):
                        thinking.append(msg["thinking"])
                        yield {"type": "thinking", "delta": msg["thinking"]}
                    if msg.get("content"):
                        for kind, piece in splitter.feed(msg["content"]):
                            (thinking if kind == "thinking" else content).append(piece)
                            yield {"type": kind, "delta": piece}
                    if chunk.get("done"):
                        final = chunk
            except OllamaError as e:
                yield {"type": "error", "message": str(e)}
                return
        self.last_activity = time.time()

        answer = "".join(content).strip()
        reasoning = "".join(thinking).strip() or None
        if answer or reasoning:
            self.store.add_message(cid, "assistant", answer or "(no answer)", reasoning)
        speed = None
        if final.get("eval_count") and final.get("eval_duration"):
            speed = round(final["eval_count"] / (final["eval_duration"] / 1e9), 1)
        yield {"type": "done", "prompt_tokens": final.get("prompt_eval_count"),
               "reply_tokens": final.get("eval_count"), "tokens_per_sec": speed, **self.context_stats(cid)}

        # Housekeeping after the reply so the user never waits for it.
        conv = self.store.get_conversation(cid)
        jobs = []
        if self.settings.auto_condense and self.needs_condense(cid):
            jobs.append(lambda: self.condense(cid))
        if conv and conv["title"] == "New chat" and answer:
            jobs.append(lambda: self.make_title(cid, text, answer))
        if jobs:
            threading.Thread(target=self._run_jobs, args=(jobs,), daemon=True).start()

    def _run_jobs(self, jobs) -> None:
        for job in jobs:
            if self._stop.is_set():
                return
            try:
                job()
            except (OllamaError, sqlite3.Error):
                pass  # housekeeping is best-effort; the chat itself already succeeded

    def _chat_with_fallback(self, messages: list[dict], think: bool) -> Iterator[dict]:
        try:
            yield from self.ollama.chat(self.plan.model, messages, self.options(think), think=think,
                                        keep_alive=self.keep_alive)
        except OllamaError as e:
            if "think" not in str(e).lower():
                raise
            # Old Ollama or a model without native thinking: let ThinkSplitter handle <think> tags.
            yield from self.ollama.chat(self.plan.model, messages, self.options(think), think=None,
                                        keep_alive=self.keep_alive)

    # --------------------------------------------------------------- condense
    def _bg_options(self, num_predict: int) -> dict:
        return {"num_ctx": self.plan.num_ctx, "num_gpu": self.plan.num_gpu, "num_predict": num_predict,
                "temperature": 0.3, "top_p": 0.8, "top_k": 20}

    def condense(self, cid: int, force: bool = False) -> bool:
        """Fold the oldest verbatim turns into the conversation summary. Returns True if it condensed."""
        if cid in self.condensing:
            return False
        self.condensing.add(cid)
        try:
            conv = self.store.get_conversation(cid)
            if not conv:
                return False
            system = self._system_for(conv)
            live = live_messages(self.store.messages(cid), conv.get("summary_upto") or 0)
            target = 0.0 if force else CONDENSE_TO
            batch = condense_split(live, self.history_budget(system), target=target)
            if not batch:
                return False
            # Bound the summarizer's own prompt to what fits in the context window.
            room = int(self.plan.num_ctx * 3.5 * 0.6)
            lines, used = [], 0
            for m in batch:
                line = f"{m['role'].upper()}: {m['content'][:6000]}"
                if lines and used + len(line) > room:
                    break
                lines.append(line[:room])
                used += len(line)
            upto = batch[len(lines) - 1]["id"]
            prompt = f"EXISTING SUMMARY:\n{conv.get('summary') or '(none)'}\n\nNEW MESSAGES:\n" + "\n\n".join(lines)
            with self.gen_lock:
                summary = self.ollama.complete(
                    self.plan.model,
                    [{"role": "system", "content": SUMMARY_PROMPT}, {"role": "user", "content": prompt}],
                    self._bg_options(1200))
            if not summary:
                return False
            self.store.set_summary(cid, summary, upto)
            return True
        except OllamaError:
            return False
        finally:
            self.condensing.discard(cid)

    def make_title(self, cid: int, question: str, answer: str) -> None:
        try:
            with self.gen_lock:
                title = self.ollama.complete(
                    self.plan.model,
                    [{"role": "system", "content": TITLE_PROMPT},
                     {"role": "user", "content": f"User: {question[:800]}\nXAC: {answer[:800]}"}],
                    self._bg_options(24))
        except OllamaError:
            return
        title = title.strip().strip('"\'').splitlines()[0][:60] if title.strip() else ""
        if title:
            self.store.rename_conversation(cid, title)

    # ------------------------------------------------------------------ status
    def status(self) -> dict:
        loaded = self.ollama.running()
        return {"hardware": self.hw.to_dict(), "plan": self.plan.to_dict(), "settings": self.settings.to_dict(),
                "managed_server": self.managed_server, "ollama": self.ollama.host, "active_id": self.active_cid,
                "loaded": [{"name": m.get("name"), "size_vram": m.get("size_vram"), "size": m.get("size")}
                           for m in loaded],
                "profiles": list(budget.PROFILES),
                "catalog": [{"tag": m.tag, "label": m.label, "weights_gb": m.weights_gb} for m in self.catalog]}
