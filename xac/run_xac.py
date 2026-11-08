#!/usr/bin/env python3
"""XAC launcher.

    python run_xac.py                 # detect hardware, budget memory, start the red/black web UI
    python run_xac.py --plan          # just show the memory budget and exit
    python run_xac.py --cli           # chat in the terminal instead of the browser
    python run_xac.py --profile deep  # biggest model your VRAM + RAM can share
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
import webbrowser

if sys.version_info < (3, 9):
    sys.exit("XAC needs Python 3.9 or newer.")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from xaccore import __version__, budget, hardware  # noqa: E402
from xaccore.engine import Engine, Settings, data_dir  # noqa: E402
from xaccore.memory import Store  # noqa: E402
from xaccore.ollama import Ollama, OllamaError  # noqa: E402

RED = "\033[38;5;196m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"
if os.name == "nt":
    os.system("")  # enable ANSI colours on Windows 10+

BANNER = rf"""{RED}{BOLD}
   ██╗  ██╗  █████╗   ██████╗
   ╚██╗██╔╝ ██╔══██╗ ██╔════╝
    ╚███╔╝  ███████║ ██║
    ██╔██╗  ██╔══██║ ██║
   ██╔╝ ██╗ ██║  ██║ ╚██████╗
   ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═════╝{RESET}
   {DIM}local cybersecurity intelligence  ·  v{__version__}{RESET}
"""

INSTALL_HELP = {
    "Windows": "Install Ollama:  winget install Ollama.Ollama   (or download from https://ollama.com/download)",
    "Darwin": "Install Ollama:  brew install ollama   (or download the app from https://ollama.com/download)",
    "Linux": "Install Ollama:  curl -fsSL https://ollama.com/install.sh | sh",
}


def say(msg: str) -> None:
    print(f"{RED}▸{RESET} {msg}", flush=True)


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def pull_with_progress(ollama: Ollama, tag: str) -> None:
    say(f"Downloading {tag} (one time only)...")
    last = ""
    for chunk in ollama.pull(tag):
        status = chunk.get("status", "")
        if chunk.get("total"):
            pct = 100 * (chunk.get("completed") or 0) / chunk["total"]
            line = f"  {status[:30]:30} {pct:5.1f}%  of {human(chunk['total'])}"
            print("\r" + line.ljust(70), end="", flush=True)
            last = "bar"
        elif status != last:
            if last == "bar":
                print()
            print(f"  {status}", flush=True)
            last = status
    print()


def terminal_chat(engine: Engine) -> None:
    store = engine.store
    conv = store.create_conversation()
    print(f"\n{DIM}Commands: /new  /remember <fact>  /condense  /think on|off  /quit{RESET}\n")
    think = engine.settings.think
    while True:
        try:
            text = input(f"{RED}{BOLD}you ›{RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not text:
            continue
        if text in ("/quit", "/exit"):
            return
        if text == "/new":
            engine.park(unload=False)
            conv = store.create_conversation()
            say("New conversation.")
            continue
        if text.startswith("/remember "):
            store.add_memory(text[10:])
            say("Saved to XAC's long-term notes.")
            continue
        if text == "/condense":
            say("Condensed." if engine.condense(conv["id"], force=True) else "Nothing to condense yet.")
            continue
        if text.startswith("/think"):
            think = text.endswith("on")
            say(f"Reasoning {'on' if think else 'off'}.")
            continue
        print(f"{RED}{BOLD}XAC ›{RESET} ", end="", flush=True)
        in_think = False
        for ev in engine.chat(conv["id"], text, think):
            t = ev["type"]
            if t == "condensing":
                print(f"{DIM}[condensing older context...]{RESET} ", end="", flush=True)
            elif t == "thinking":
                if not in_think:
                    print(f"{DIM}(thinking) ", end="")
                    in_think = True
                print(ev["delta"], end="", flush=True)
            elif t == "content":
                if in_think:
                    print(f"{RESET}\n\n", end="")
                    in_think = False
                print(ev["delta"], end="", flush=True)
            elif t == "error":
                print(f"\n{RED}error: {ev['message']}{RESET}")
            elif t == "done":
                fill = ev.get("fill")
                speed = ev.get("tokens_per_sec")
                meta = []
                if speed:
                    meta.append(f"{speed} tok/s")
                if fill is not None:
                    meta.append(f"memory {fill * 100:.0f}% full")
                print(f"{RESET}\n{DIM}{' · '.join(meta)}{RESET}\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="XAC - local cybersecurity AI")
    ap.add_argument("--profile", choices=list(budget.PROFILES), help="fast | balanced (default) | deep")
    ap.add_argument("--model", help="force a specific Ollama model tag, e.g. qwen3:14b")
    ap.add_argument("--ctx", type=int, help="force a context length in tokens")
    ap.add_argument("--min-params-gb", type=float, help="parameters floor in GB (default 4)")
    ap.add_argument("--min-context-gb", type=float, help="per-conversation memory floor in GB (default 2)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("XAC_PORT", 8787)))
    ap.add_argument("--plan", action="store_true", help="print the memory budget and exit")
    ap.add_argument("--cli", action="store_true", help="chat in the terminal")
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    ap.add_argument("--no-pull", action="store_true", help="don't download the model automatically")
    args = ap.parse_args()

    print(BANNER)
    home = data_dir()
    settings = Settings.load(os.path.join(home, "config.json"))
    for arg, key in (("profile", "profile"), ("model", "model"), ("ctx", "num_ctx"),
                     ("min_params_gb", "min_params_gb"), ("min_context_gb", "min_context_gb")):
        if getattr(args, arg) is not None:
            setattr(settings, key, getattr(args, arg))

    say("Scanning hardware...")
    hw = hardware.detect()
    catalog = budget.load_catalog()
    ollama = Ollama()

    managed = False
    if ollama.alive():
        say(f"Ollama {ollama.version()} is already running at {ollama.host}.")
    elif Ollama.installed() and not args.plan:
        say("Starting Ollama with flash attention + compressed chat memory (q8_0)...")
        managed = ollama.start_server(flash_attention=True, kv_type="q8_0")
        if not managed:
            sys.exit(f"{RED}Could not start Ollama.{RESET} Try running `ollama serve` in another terminal.")
    elif not args.plan:
        sys.exit(f"{RED}Ollama is not installed.{RESET}\n  {INSTALL_HELP.get(hw.os, INSTALL_HELP['Linux'])}\n"
                 "  Then run XAC again.")
    else:
        managed = True  # plan as if XAC will manage the server (it will on a normal start)

    store = Store(os.path.join(home, "xac.db"))
    engine = Engine(hw, catalog, ollama, store, settings, managed_server=managed)
    print()
    print(budget.describe(engine.plan, hw))
    print()
    if args.plan:
        return
    settings.save()

    try:
        if not ollama.has_model(engine.plan.model):
            if args.no_pull:
                say(f"Model {engine.plan.model} is not downloaded yet (pull it from the web UI).")
            else:
                pull_with_progress(ollama, engine.plan.model)
        engine.ensure_alias()
        say("Registered the `xac` model - you can also run `ollama run xac` from any terminal.")
    except OllamaError as e:
        say(f"Model setup problem: {e}")

    try:
        if args.cli:
            terminal_chat(engine)
            return
        from xaccore.server import serve

        httpd = serve(engine, args.port)
        url = f"http://127.0.0.1:{args.port}/"
        say(f"XAC is live at {BOLD}{url}{RESET}  (local only - press Ctrl+C to stop)")
        if not args.no_browser:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
    finally:
        say("Shutting down - your chats are saved in " + home)
        engine.shutdown()
        if managed:
            ollama.stop_server()
        time.sleep(0.2)


if __name__ == "__main__":
    main()
