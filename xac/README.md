<p align="center">
  <img src="web/logo.svg" width="140" alt="XAC raccoon logo">
</p>

<h1 align="center">XAC</h1>
<p align="center"><b>A private cybersecurity expert that runs entirely on your own computer.</b><br>
Red-and-black chat app · hardware-aware memory budgeting · chats that never forget</p>

---

XAC is a local AI you can talk to about any security topic: incident response, detection engineering,
pentesting methodology, AD attack paths, cloud and Kubernetes security, secure code review, forensics,
cryptography, compliance (NIST CSF, ISO 27001, SOC 2, PCI), and certification study plans. Nothing
leaves your machine. XAC has no account, no cloud API, and no telemetry.

It's built on [Ollama](https://ollama.com) (the local model runtime) and the open-weight **Qwen3**
model family, which can reason step by step before answering. XAC itself is a small Python program
with **no third-party dependencies**.

## Quick start

| OS | Do this |
|---|---|
| **Windows** | Install [Python 3.9+](https://www.python.org/downloads/), then double-click **`start-xac.bat`**. It offers to install Ollama with `winget` if needed. |
| **macOS** | `./start-xac.sh` (offers `brew install ollama` if needed) |
| **Linux** | `./start-xac.sh` (offers Ollama's official installer if needed) |

The first launch scans your hardware, picks the right model, downloads it once (5–20 GB depending on
your machine), and opens **http://127.0.0.1:8787** in your browser. Later launches take seconds.

Prefer the terminal? Run `python run_xac.py --cli`. XAC also registers itself with Ollama, so
`ollama run xac` works from any terminal with the same persona and memory settings.

## How XAC budgets your memory

When XAC starts, it measures your GPU VRAM (NVIDIA, AMD, Apple Silicon unified memory) and system RAM.
Then it decides three things:

1. **Parameters**: which model size to run. Bigger means smarter.
2. **Memory per conversation**: how many tokens of the chat the model holds in mind at once (its
   KV cache).
3. **VRAM sharing**: how many of the model's layers go on the GPU. Any that don't fit **spill into
   system RAM**, which is slower but lets a bigger model run on a modest card.

### Hard floors

| Floor | Default | What it guarantees |
|---|---|---|
| Parameters | **≥ 4 GB** | XAC never runs a model smaller than 4 GB of weights. On the default catalog that means Qwen3 8B or larger. |
| Memory per conversation | **≥ 2 GB** | The active chat always gets at least 2 GB of context memory (and never fewer than 12K tokens). |

You can change both in **Memory & model** in the app, or with `--min-params-gb` / `--min-context-gb`.
If a machine is too small to meet the floors fully on the GPU, XAC still meets them by sharing VRAM
with system RAM, and tells you that it's doing so.

### Profiles

| Profile | Strategy |
|---|---|
| `fast` | Keep everything on the GPU (≥ 90%) for snappy replies; models up to 14B |
| `balanced` *(default)* | Largest model that fits fully in VRAM with long memory; small spill allowed (≥ 80% on GPU) |
| `deep` | Largest model your **VRAM + RAM can share**. Prefers the 30B mixture-of-experts model, which stays usable even when mostly in RAM. |

### What you'll typically get (balanced profile)

| Machine | Model | Memory per chat | Where it runs |
|---|---|---|---|
| No GPU, 16 GB RAM | Qwen3 8B | 2.1 GB · 28K tokens | CPU |
| 6 GB GPU, 16 GB RAM | Qwen3 8B | 2.1 GB · 28K tokens | GPU + RAM shared |
| 8 GB GPU | Qwen3 8B | 2.1 GB · 28K tokens | ~90% GPU |
| 12 GB GPU | Qwen3 8B | 3.0 GB · 40K tokens | GPU |
| 16 GB GPU | Qwen3 14B | 3.3 GB · 40K tokens | GPU |
| 24 GB GPU | Qwen3 14B (or 32B with `deep`) | 3.3 GB · 40K tokens | GPU |
| Mac, 16 GB unified | Qwen3 8B | 3.0 GB · 40K tokens | GPU (unified) |
| Mac, 36 GB unified | Qwen3 32B | 4.5 GB · 34K tokens | GPU (unified) |

These figures assume XAC starts Ollama itself, as described below. Run `python run_xac.py --plan` to see the exact budget for your machine without starting anything.

**Tip:** let XAC start Ollama itself. If Ollama is already running, for example the tray app on
Windows or macOS, quit it first. When XAC launches Ollama, it turns on flash attention and **q8_0
chat-memory compression**, which roughly halves context memory. That fits about twice the
conversation into the same VRAM. XAC also limits Ollama to one loaded model and one conversation
slot, so nothing else can take your budget.

## Chats that keep going

- **Auto-condense.** When a chat's verbatim history reaches 70% of its memory, XAC condenses the
  oldest turns into a running summary. That summary keeps your goals, your environment, decisions,
  findings, and the commands that mattered. The latest turns always stay word-for-word. If a long
  paste would overflow the window, XAC condenses *before* answering, so nothing silently drops out.
  The full transcript stays on disk; only the model's view is condensed. You can also press
  **Condense** at any time.
- **Inactive chats are put away.** Only the chat you're talking in is held in memory (marked
  **active** in the sidebar). Switching chats, pressing **Put away**, or staying idle for 15 minutes
  (configurable) parks the chat: it's saved to disk and the model's memory is released. Send a
  message to a stored chat and it **resumes automatically** from its summary and recent messages.
- **Saved notes.** These are facts XAC remembers in every conversation, such as your role, your
  stack, or your lab. Add them in **Saved notes**, or type `/remember I run a Splunk + Sysmon lab`
  in any chat.

## Command-line options

```
python run_xac.py [--profile fast|balanced|deep] [--model qwen3:14b] [--ctx 32768]
                  [--min-params-gb 4] [--min-context-gb 2]
                  [--port 8787] [--cli] [--plan] [--no-browser] [--no-pull]
```

Environment variables: `XAC_HOME` sets the data folder (default `~/.xac`). `XAC_VRAM_GB` and
`XAC_RAM_GB` override hardware detection. `OLLAMA_HOST` points XAC at a non-default Ollama.

## Privacy & security

- Chats, notes, and settings live in `~/.xac/` (a SQLite database plus `config.json`). Delete the
  folder to wipe everything.
- The web UI listens on **127.0.0.1 only**, so other devices on your network can't reach it.
- It rejects requests whose `Host` isn't localhost, which blocks DNS-rebinding attacks.
- Every state-changing request must carry a custom header and a matching `Origin`, so a malicious
  website open in your browser can't drive XAC (CSRF).
- The UI is served with a strict Content-Security-Policy (no inline scripts, no third-party content).
  Model output is HTML-escaped before it's rendered.
- XAC's persona supports authorized security work: defense, research, CTFs, and testing systems you
  own or have permission to test.

## Customizing models

Edit `models.json` to add any Ollama model: give its tag, download size, and layer, KV-head, and
head-dim counts, and the budgeter does the rest. You can also pick any catalog model under
**Memory & model**, or pass `--model <tag>`.

## Project layout

```
run_xac.py           launcher: hardware scan → budget → Ollama → web UI / terminal chat
xaccore/hardware.py  VRAM / RAM / GPU detection (NVIDIA, AMD, Apple Silicon, Windows)
xaccore/budget.py    the memory budgeter: model size, context, GPU layers, floors
xaccore/memory.py    SQLite chat store, context packing, condense selection
xaccore/engine.py    chat engine: streaming, auto-condense, parking/resume, titles
xaccore/persona.py   XAC's cybersecurity-expert system prompt
xaccore/server.py    hardened localhost web server
web/                 red/black UI (HTML/CSS/JS, no frameworks) + raccoon logo
tests/               test suite with a fake Ollama server: python -m unittest discover -s tests
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Ollama was already running" warning | Quit the Ollama tray app, then restart XAC so it can enable memory compression. |
| Replies are slow | Use `--profile fast`, or close GPU-heavy apps (games, browsers with many tabs) before starting. |
| Out-of-memory / model fails to load | Run `--plan` to check the budget; override with `XAC_VRAM_GB=<smaller>` to leave more headroom. |
| GPU not detected | Update your GPU driver. NVIDIA needs `nvidia-smi` on the PATH. Intel GPUs aren't accelerated by Ollama yet. |
| Port 8787 in use | `--port 8790` |
