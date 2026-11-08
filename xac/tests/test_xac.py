"""XAC test suite - stdlib unittest, no GPU or real Ollama needed.

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

from fake_ollama import FakeOllama  # noqa: E402
from xaccore import budget  # noqa: E402
from xaccore.engine import Engine, Settings, ThinkSplitter  # noqa: E402
from xaccore.hardware import GPU, Hardware  # noqa: E402
from xaccore.memory import Store, condense_split, estimate_tokens, pack_history  # noqa: E402
from xaccore.ollama import Ollama  # noqa: E402
from xaccore.server import serve  # noqa: E402

CATALOG = budget.load_catalog()


def hw(vram: list[float], ram: float, unified: bool = False) -> Hardware:
    return Hardware("Linux", "x86_64", 16, ram, ram, [GPU("gpu", "nvidia", v) for v in vram], unified, sum(vram))


class BudgetTests(unittest.TestCase):
    MACHINES = [([], 16), ([], 32), ([4], 8), ([6], 16), ([8], 16), ([8], 32), ([12], 32), ([16], 32),
                ([24], 64), ([12, 12], 64), ([48], 128)]

    def test_floors_hold_everywhere(self):
        """>= 4 GB parameters, >= 2 GB conversation memory, >= 12K tokens on every machine and profile."""
        for vram, ram in self.MACHINES:
            for profile in budget.PROFILES:
                for kv, fa in (("f16", False), ("q8_0", True)):
                    p = budget.choose(hw(vram, ram), CATALOG, profile, kv, fa)
                    label = f"{vram}/{ram} {profile} {kv} -> {p.model}"
                    self.assertGreaterEqual(p.weights_gb, 4.0, label)
                    self.assertGreaterEqual(p.context_gb + 1e-3, 2.0, label)
                    self.assertGreaterEqual(p.num_ctx, budget.MIN_CTX_TOKENS, label)
                    self.assertLessEqual(p.num_gpu, p.total_layers, label)

    def test_plans_fit_their_budgets(self):
        for vram, ram in self.MACHINES:
            for profile in budget.PROFILES:
                p = budget.choose(hw(vram, ram), CATALOG, profile, "q8_0", True)
                if p.warnings:
                    continue  # explicitly flagged as over budget
                self.assertLessEqual(sum(p.gpu_use.values()), p.gpu_budget_gb + 0.01, p.model)
                self.assertLessEqual(sum(p.ram_use.values()), p.ram_budget_gb + 0.01, p.model)

    def test_bigger_gpu_never_gets_a_smaller_model(self):
        for profile in budget.PROFILES:
            last = 0.0
            for v in (8, 12, 16, 24, 48):
                p = budget.choose(hw([v], 64), CATALOG, profile, "q8_0", True)
                self.assertGreaterEqual(p.weights_gb, last, f"{profile} {v}GB")
                last = p.weights_gb

    def test_vram_sharing_when_gpu_is_small(self):
        p = budget.choose(hw([6], 16), CATALOG, "balanced", "q8_0", True)
        self.assertEqual(p.mode, "hybrid")
        self.assertGreater(p.num_gpu, 0)
        self.assertGreater(p.ram_use["weights"], 0)

    def test_deep_profile_uses_more_parameters(self):
        balanced = budget.choose(hw([12], 32), CATALOG, "balanced", "q8_0", True)
        deep = budget.choose(hw([12], 32), CATALOG, "deep", "q8_0", True)
        self.assertGreater(deep.weights_gb, balanced.weights_gb)

    def test_custom_floors(self):
        floors = budget.Floors(weights_gb=9.0, context_gb=3.0)
        p = budget.choose(hw([24], 64), CATALOG, "balanced", "q8_0", True, floors=floors)
        self.assertGreaterEqual(p.weights_gb, 9.0)
        self.assertGreaterEqual(p.context_gb + 1e-3, 3.0)

    def test_min_ctx_math(self):
        m = next(x for x in CATALOG if x.tag == "qwen3:8b")
        # 8B, f16: 2*36*8*128*2 = 147,456 bytes/token -> 2 GiB ~= 14,564 tokens -> 16,384 rounded up.
        self.assertEqual(m.min_ctx(budget.Floors(), "f16"), 16384)
        self.assertGreaterEqual(m.kv_gb(m.min_ctx(budget.Floors(), "q8_0"), "q8_0"), 2.0)

    def test_bad_profile(self):
        with self.assertRaises(ValueError):
            budget.choose(hw([8], 16), CATALOG, "turbo")


class MemoryTests(unittest.TestCase):
    def msgs(self, n, size=400):
        return [{"id": i + 1, "role": "user" if i % 2 == 0 else "assistant", "content": "x" * size,
                 "tokens": estimate_tokens("x" * size)} for i in range(n)]

    def test_pack_keeps_newest(self):
        ms = self.msgs(20)
        packed, used = pack_history(ms, 500)
        self.assertLessEqual(used, 500)
        self.assertEqual(len(packed), used // ms[0]["tokens"])

    def test_pack_always_keeps_latest(self):
        packed, _ = pack_history(self.msgs(3, size=100000), 10)
        self.assertEqual(len(packed), 1)

    def test_condense_split_keeps_recent_turns(self):
        ms = self.msgs(30)
        batch = condense_split(ms, budget_tokens=2000, target=0.4)
        self.assertTrue(batch)
        self.assertEqual(batch[0]["id"], 1)
        self.assertLessEqual(len(batch), 26)  # last 4 stay verbatim
        self.assertEqual(batch[-1]["role"], "assistant")  # never splits a Q from its A

    def test_condense_split_small_chat(self):
        self.assertEqual(condense_split(self.msgs(4), 100), [])


class ThinkSplitterTests(unittest.TestCase):
    def test_split_across_chunks(self):
        s = ThinkSplitter()
        out = []
        for piece in ["<thi", "nk>plan ", "it</th", "ink>Answer", " here"]:
            out += s.feed(piece)
        thinking = "".join(t for k, t in out if k == "thinking")
        content = "".join(t for k, t in out if k == "content")
        self.assertEqual(thinking, "plan it")
        self.assertEqual(content, "Answer here")


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama(models=["qwen3:8b"]).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.tmp.name, "xac.db"))
        self.engine = Engine(hw([12], 32), CATALOG, Ollama(self.fake.url), self.store,
                             Settings(path=os.path.join(self.tmp.name, "config.json")), managed_server=True)

    def tearDown(self):
        self.engine.shutdown()
        self.fake.stop()
        self.tmp.cleanup()

    def run_chat(self, cid, text):
        return list(self.engine.chat(cid, text))

    def test_chat_streams_thinking_and_answer(self):
        c = self.store.create_conversation()
        events = self.run_chat(c["id"], "How do I harden a server?")
        kinds = [e["type"] for e in events]
        self.assertIn("thinking", kinds)
        self.assertIn("content", kinds)
        self.assertEqual(kinds[-1], "done")
        msgs = self.store.messages(c["id"])
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])
        self.assertIn("MFA", msgs[1]["content"])
        self.assertIn("identity", msgs[1]["thinking"])
        req = self.fake.chats(stream=True)[-1]
        self.assertEqual(req["options"]["num_ctx"], self.engine.plan.num_ctx)
        self.assertEqual(req["options"]["num_gpu"], self.engine.plan.num_gpu)
        self.assertIn("You are XAC", req["messages"][0]["content"])

    def test_saved_notes_reach_the_model(self):
        self.store.add_memory("I run a Splunk SIEM")
        c = self.store.create_conversation()
        self.run_chat(c["id"], "hi")
        self.assertIn("I run a Splunk SIEM", self.fake.chats(stream=True)[-1]["messages"][0]["content"])

    def test_title_generated(self):
        c = self.store.create_conversation()
        self.run_chat(c["id"], "How do I harden a server?")
        for _ in range(50):
            if self.store.get_conversation(c["id"])["title"] != "New chat":
                break
            time.sleep(0.05)
        self.assertEqual(self.store.get_conversation(c["id"])["title"], "Server Hardening Basics")

    def test_parking_and_resume(self):
        a = self.store.create_conversation()
        b = self.store.create_conversation()
        self.run_chat(a["id"], "first")
        self.assertEqual(self.store.get_conversation(a["id"])["state"], "active")
        self.run_chat(b["id"], "second")
        self.assertEqual(self.store.get_conversation(a["id"])["state"], "parked")
        self.assertEqual(self.store.get_conversation(b["id"])["state"], "active")
        events = self.run_chat(a["id"], "back again")
        self.assertEqual(events[0]["type"], "resumed")
        self.assertEqual(self.store.get_conversation(a["id"])["state"], "active")

    def test_idle_chat_is_put_away_and_memory_freed(self):
        c = self.store.create_conversation()
        self.run_chat(c["id"], "hello")
        self.engine.park()
        self.assertEqual(self.store.get_conversation(c["id"])["state"], "parked")
        self.assertIsNone(self.engine.active_cid)
        unloads = []
        for _ in range(100):  # unload waits for the background title job to finish
            unloads = [b for p, b in self.fake.requests if p == "/api/generate" and b.get("keep_alive") == 0]
            if unloads:
                break
            time.sleep(0.05)
        self.assertTrue(unloads, "model should be unloaded to free VRAM")

    def test_keep_alive_matches_park_timer(self):
        c = self.store.create_conversation()
        self.run_chat(c["id"], "hello")
        self.assertEqual(self.fake.chats(stream=True)[-1]["keep_alive"], "15m")

    def test_auto_condense_before_overflow(self):
        c = self.store.create_conversation()
        big = "log line " * 2000  # ~5k tokens each
        for i in range(12):
            self.store.add_message(c["id"], "user" if i % 2 == 0 else "assistant", f"{i} {big}")
        events = self.run_chat(c["id"], "summarize where we are")
        kinds = [e["type"] for e in events]
        self.assertIn("condensing", kinds)
        conv = self.store.get_conversation(c["id"])
        self.assertIn("hardening", conv["summary"])
        self.assertGreater(conv["summary_upto"], 0)
        # The summary is in the prompt and the request fits the context window.
        req = self.fake.chats(stream=True)[-1]
        self.assertIn("Earlier in this conversation", req["messages"][0]["content"])
        prompt_tokens = sum(estimate_tokens(m["content"]) for m in req["messages"])
        self.assertLess(prompt_tokens + self.engine.plan.num_predict, self.engine.plan.num_ctx)
        # Full transcript is still on disk.
        self.assertEqual(len(self.store.messages(c["id"])), 14)

    def test_manual_condense(self):
        c = self.store.create_conversation()
        for i in range(10):
            self.store.add_message(c["id"], "user" if i % 2 == 0 else "assistant", f"message {i}")
        self.assertTrue(self.engine.condense(c["id"], force=True))
        stats = self.engine.context_stats(c["id"])
        self.assertEqual(stats["live_messages"], 4)
        self.assertEqual(stats["condense_count"], 1)

    def test_settings_persist(self):
        self.engine.settings.profile = "deep"
        self.engine.settings.save()
        again = Settings.load(self.engine.settings.path)
        self.assertEqual(again.profile, "deep")
        self.assertEqual(again.min_params_gb, 4.0)
        self.assertEqual(again.min_context_gb, 2.0)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama(models=["qwen3:8b"]).start()
        self.tmp = tempfile.TemporaryDirectory()
        store = Store(os.path.join(self.tmp.name, "xac.db"))
        self.engine = Engine(hw([12], 32), CATALOG, Ollama(self.fake.url), store,
                             Settings(path=os.path.join(self.tmp.name, "config.json")), managed_server=True)
        self.httpd = serve(self.engine, 0)
        self.port = self.httpd.server_address[1]
        import threading
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.engine.shutdown()
        self.fake.stop()
        self.tmp.cleanup()

    def req(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"127.0.0.1:{self.port}", "X-XAC": "1", "Content-Type": "application/json"}
        h.update(headers or {})
        conn.request(method, path, json.dumps(body) if body is not None else None, h)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, data

    def test_ui_served(self):
        status, data = self.req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"XAC", data)
        for asset in ("/xac.css", "/xac.js", "/logo.svg"):
            self.assertEqual(self.req("GET", asset)[0], 200, asset)

    def test_path_traversal_blocked(self):
        self.assertEqual(self.req("GET", "/../run_xac.py")[0], 404)
        self.assertEqual(self.req("GET", "/%2e%2e/run_xac.py")[0], 404)

    def test_dns_rebinding_blocked(self):
        status, _ = self.req("GET", "/api/status", headers={"Host": "evil.example:8787"})
        self.assertEqual(status, 421)

    def test_cross_site_writes_blocked(self):
        self.assertEqual(self.req("POST", "/api/conversations", {}, {"X-XAC": ""})[0], 403)
        self.assertEqual(self.req("POST", "/api/conversations", {}, {"Origin": "https://evil.example"})[0], 403)

    def test_full_chat_flow(self):
        status, data = self.req("POST", "/api/conversations", {})
        self.assertEqual(status, 200)
        cid = json.loads(data)["id"]
        status, data = self.req("POST", f"/api/conversations/{cid}/chat", {"message": "harden ssh", "think": True})
        self.assertEqual(status, 200)
        events = [json.loads(line) for line in data.decode().splitlines() if line]
        self.assertEqual(events[-1]["type"], "done")
        answer = "".join(e["delta"] for e in events if e["type"] == "content")
        self.assertIn("MFA", answer)
        status, data = self.req("GET", f"/api/conversations/{cid}")
        convo = json.loads(data)
        self.assertEqual(len(convo["messages"]), 2)
        self.assertEqual(convo["context"]["state"], "active")
        self.assertEqual(self.req("POST", f"/api/conversations/{cid}/park", {})[0], 200)
        _, data = self.req("GET", "/api/conversations")
        self.assertEqual(json.loads(data)["conversations"][0]["state"], "parked")

    def test_remember_command(self):
        _, data = self.req("POST", "/api/conversations", {})
        cid = json.loads(data)["id"]
        self.req("POST", f"/api/conversations/{cid}/chat", {"message": "/remember I use Ubuntu 24.04"})
        _, data = self.req("GET", "/api/memories")
        self.assertEqual(json.loads(data)["memories"][0]["content"], "I use Ubuntu 24.04")

    def test_settings_rebudget(self):
        status, data = self.req("POST", "/api/settings", {"profile": "deep", "min_context_gb": 3})
        self.assertEqual(status, 200)
        r = json.loads(data)
        self.assertEqual(r["settings"]["profile"], "deep")
        self.assertGreaterEqual(r["plan"]["context_gb"] + 1e-3, 3.0)
        self.assertTrue(r["needs_pull"])  # the bigger model isn't downloaded in the fake
        self.assertEqual(self.req("POST", "/api/settings", {"profile": "turbo"})[0], 400)


if __name__ == "__main__":
    unittest.main()
