"""The XAC memory budgeter.

Given how much VRAM and RAM the machine has, decide:
  * which model size to run (parameters),
  * how long the context window can be (the conversation memory XAC holds in mind),
  * how many transformer layers live on the GPU vs. in system RAM (VRAM sharing).

Hard floors (configurable, defaults from the XAC spec):
  * at least 4 GB for model parameters (weights)  -> never picks a model smaller than that
  * at least 2 GB of conversation memory (KV cache) for the active chat
Only the active conversation occupies memory; parked chats live on disk (see engine.py).

Memory model (per loaded model):
    weights      = download size of the quantized model
    KV cache     = 2 (K and V) x layers x kv_heads x head_dim x context x bytes_per_element
    compute      = scratch buffers; grows with context, smaller with flash attention
Layers that don't fit in VRAM spill to system RAM ("hybrid" mode) - slower, but it
lets a bigger, smarter model run on a modest GPU.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict, dataclass, field

from .hardware import Hardware

GIB = 1024**3

KV_BYTES = {"f16": 2.0, "q8_0": 1.0625, "q4_0": 0.5625}

DEFAULT_MIN_WEIGHTS_GB = 4.0  # parameters floor
DEFAULT_MIN_CONTEXT_GB = 2.0  # per-conversation memory floor

# How each profile trades speed for depth.
PROFILES = {
    # Prefer everything on the GPU; only a tiny spill allowed. Snappy replies.
    "fast": {"ctx_cap": 40960, "hybrid_min_gpu_frac": 0.9, "cpu_max_params": 8.5, "max_params": 15.0},
    # Default. Fully on GPU when possible, small spill allowed, long context for coherent chats.
    "balanced": {"ctx_cap": 40960, "hybrid_min_gpu_frac": 0.8, "cpu_max_params": 8.5, "max_params": 99.0},
    # Biggest brain that fits VRAM + RAM. Slower, most thoughtful.
    # Per model (largest first) it tries full-GPU, then VRAM+RAM sharing, before stepping down a size.
    # Dense models need >=60% of layers on GPU; MoE models (few active params) may spill further.
    "deep": {"ctx_cap": 40960, "hybrid_min_gpu_frac": 0.6, "cpu_max_params": 15.0, "max_params": 99.0,
             "per_model": True},
}
CTX_STEP = 2048
MIN_CTX_TOKENS = 12288  # never fewer tokens than this, whatever the GB floor works out to


@dataclass
class Floors:
    weights_gb: float = DEFAULT_MIN_WEIGHTS_GB
    context_gb: float = DEFAULT_MIN_CONTEXT_GB


@dataclass
class ModelSpec:
    tag: str
    label: str
    params_b: float
    weights_gb: float
    layers: int
    kv_heads: int
    head_dim: int
    max_ctx: int = 32768
    thinking: bool = False
    moe: bool = False

    def kv_bytes_per_token(self, kv_type: str) -> float:
        return 2 * self.layers * self.kv_heads * self.head_dim * KV_BYTES[kv_type]

    def kv_gb(self, ctx: int, kv_type: str) -> float:
        return self.kv_bytes_per_token(kv_type) * ctx / GIB

    def min_ctx(self, floors: Floors, kv_type: str) -> int:
        """Smallest context (rounded up to a 2K step) whose KV cache meets the memory floor."""
        tokens = floors.context_gb * GIB / self.kv_bytes_per_token(kv_type)
        return min(self.max_ctx, max(MIN_CTX_TOKENS, math.ceil(tokens / CTX_STEP) * CTX_STEP))

    def meets_floors(self, floors: Floors, kv_type: str) -> bool:
        return self.weights_gb >= floors.weights_gb and self.kv_gb(self.max_ctx, kv_type) + 1e-3 >= floors.context_gb


@dataclass
class Plan:
    model: str
    label: str
    profile: str
    mode: str  # "gpu" | "hybrid" | "cpu"
    num_ctx: int
    num_gpu: int  # layers offloaded to GPU (Ollama option)
    total_layers: int
    kv_type: str
    flash_attention: bool
    num_predict: int  # max tokens per reply (incl. reasoning)
    thinking: bool
    gpu_budget_gb: float
    ram_budget_gb: float
    weights_gb: float = 0.0
    context_gb: float = 0.0  # this conversation's memory (KV cache)
    floors: dict = field(default_factory=dict)
    gpu_use: dict = field(default_factory=dict)  # weights / kv / compute in GB
    ram_use: dict = field(default_factory=dict)
    reason: str = ""
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def ollama_options(self) -> dict:
        return {"num_ctx": self.num_ctx, "num_gpu": self.num_gpu, "num_predict": self.num_predict}


def load_catalog(path: str | None = None) -> list[ModelSpec]:
    path = path or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models.json")
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    specs = [ModelSpec(**{k: v for k, v in m.items() if not k.startswith("_")}) for m in raw["models"]]
    return sorted(specs, key=lambda m: m.weights_gb)


def eligible(catalog: list[ModelSpec], floors: Floors, kv_type: str) -> list[ModelSpec]:
    """Models meeting both floors (parameters size, and able to hold the conversation-memory floor).
    If none do, fall back to the largest available."""
    ok = [m for m in catalog if m.meets_floors(floors, kv_type)]
    return ok or [max(catalog, key=lambda m: m.weights_gb)]


def compute_gb(ctx: int, flash_attention: bool) -> float:
    """Scratch/compute buffer estimate. Flash attention keeps it small at long context."""
    per_1k = 0.012 if flash_attention else 0.03
    return 0.5 + per_1k * ctx / 1024


def gpu_budget(hw: Hardware) -> float:
    """VRAM we let models use: what's free, minus a safety margin for the driver/desktop."""
    if hw.gpu_budget_gb <= 0:
        return 0.0
    margin = max(0.5, 0.05 * hw.vram_gb)
    return max(0.0, round(hw.gpu_budget_gb - margin, 2))


def ram_budget(hw: Hardware) -> float:
    """System RAM available for spilled layers. Unified memory has no separate pool."""
    if hw.unified_memory:
        return 0.0
    reserve = max(4.0, 0.25 * hw.ram_gb)
    return max(0.0, round(hw.ram_gb - reserve, 2))


def reply_budget(ctx: int, thinking: bool) -> int:
    """Tokens reserved for each answer. Reasoning models need room to think first."""
    return min(8192, ctx // 3) if thinking else min(4096, ctx // 4)


def _full_gpu_ctx(m: ModelSpec, gpu: float, cap: int, kv_type: str, fa: bool) -> int:
    """Largest context that fits with the whole model on the GPU (0 if none)."""
    ctx = min(cap, m.max_ctx) // CTX_STEP * CTX_STEP
    while ctx >= MIN_CTX_TOKENS:
        if m.weights_gb + m.kv_gb(ctx, kv_type) + compute_gb(ctx, fa) <= gpu:
            return ctx
        ctx -= CTX_STEP
    return 0


def _hybrid_layers(m: ModelSpec, gpu: float, ctx: int, kv_type: str, fa: bool) -> int:
    """How many of the model's layers (+1 for the output head) fit on the GPU at this context."""
    slots = m.layers + 1
    per_layer = (m.weights_gb + m.kv_gb(ctx, kv_type)) / slots
    room = gpu - compute_gb(ctx, fa)
    return max(0, min(slots, int(room // per_layer))) if room > 0 else 0


def _build(m, profile, mode, ctx, n_gpu, kv_type, fa, gpu, ram, reason, think, floors) -> Plan:
    slots = m.layers + 1
    frac = n_gpu / slots
    w, kv, comp = m.weights_gb, m.kv_gb(ctx, kv_type), compute_gb(ctx, fa)
    gpu_use = {"weights": round(w * frac, 2), "kv_cache": round(kv * frac, 2),
               "compute": round(comp if n_gpu else 0, 2)}
    ram_use = {"weights": round(w * (1 - frac), 2), "kv_cache": round(kv * (1 - frac), 2),
               "compute": round(0 if n_gpu else comp, 2)}
    return Plan(
        model=m.tag, label=m.label, profile=profile, mode=mode, num_ctx=ctx, num_gpu=n_gpu, total_layers=slots,
        kv_type=kv_type, flash_attention=fa, num_predict=reply_budget(ctx, think and m.thinking),
        thinking=think and m.thinking, gpu_budget_gb=gpu, ram_budget_gb=ram, weights_gb=round(w, 2),
        context_gb=round(kv, 2), floors={"weights_gb": floors.weights_gb, "context_gb": floors.context_gb},
        gpu_use=gpu_use, ram_use=ram_use, reason=reason,
    )


def _check_floors(plan: Plan, m: ModelSpec, floors: Floors) -> None:
    if m.weights_gb < floors.weights_gb:
        plan.warnings.append(f"No model in the catalog meets the {floors.weights_gb:g} GB parameters floor; "
                             f"using {m.label} ({m.weights_gb:g} GB).")
    if plan.context_gb + 0.005 < floors.context_gb:
        plan.warnings.append(f"{m.label}'s maximum context only needs {plan.context_gb:.2f} GB, below the "
                             f"{floors.context_gb:g} GB conversation-memory floor.")


def plan_for_model(m: ModelSpec, hw: Hardware, profile: str = "balanced", kv_type: str = "f16",
                   flash_attention: bool = False, ctx: int | None = None, think: bool = True,
                   floors: Floors | None = None) -> Plan:
    """Fit one specific model as well as possible (used for manual overrides)."""
    floors = floors or Floors()
    p = PROFILES[profile]
    gpu, ram = gpu_budget(hw), ram_budget(hw)
    floor_ctx = m.min_ctx(floors, kv_type)
    if ctx:
        ctx = max(floor_ctx, min(ctx // CTX_STEP * CTX_STEP, m.max_ctx))
    full = _full_gpu_ctx(m, gpu, ctx or p["ctx_cap"], kv_type, flash_attention) if gpu else 0
    if full >= max(floor_ctx, ctx or 0):
        plan = _build(m, profile, "gpu", full, m.layers + 1, kv_type, flash_attention, gpu, ram,
                      f"{m.label} runs fully on the GPU with a {full:,}-token conversation memory.", think, floors)
    else:
        ctx = ctx or floor_ctx
        n = _hybrid_layers(m, gpu, ctx, kv_type, flash_attention) if gpu else 0
        mode = "hybrid" if n else "cpu"
        plan = _build(m, profile, mode, ctx, n, kv_type, flash_attention, gpu, ram,
                      f"{m.label}: {n}/{m.layers + 1} layers on GPU, the rest in system RAM." if n
                      else f"{m.label} on CPU + system RAM.", think, floors)
        spill = sum(plan.ram_use.values())
        if hw.unified_memory and n < m.layers + 1:
            plan.warnings.append("This model is larger than the GPU share of unified memory; expect swapping.")
        elif spill > ram + 1e-6:
            plan.warnings.append(f"Needs ~{spill:.1f} GB of RAM but only ~{ram:.1f} GB is budgeted - "
                                 "may swap or fail.")
    _check_floors(plan, m, floors)
    return plan


def choose(hw: Hardware, catalog: list[ModelSpec], profile: str = "balanced", kv_type: str = "f16",
           flash_attention: bool = False, think: bool = True, floors: Floors | None = None) -> Plan:
    """Pick the strongest model + context the machine can carry under this profile and the floors."""
    if profile not in PROFILES:
        raise ValueError(f"unknown profile {profile!r}; choose from {', '.join(PROFILES)}")
    floors = floors or Floors()
    p = PROFILES[profile]
    gpu, ram = gpu_budget(hw), ram_budget(hw)
    pool = eligible(catalog, floors, kv_type)
    big_first = sorted(pool, key=lambda m: m.weights_gb, reverse=True)

    def finish(plan: Plan, m: ModelSpec) -> Plan:
        _check_floors(plan, m, floors)
        return plan

    if gpu > 0:
        sized = [m for m in big_first if m.params_b <= p["max_params"]] or big_first[-1:]

        def full(m: ModelSpec) -> Plan | None:
            # Whole model in VRAM, with at least the conversation-memory floor.
            ctx = _full_gpu_ctx(m, gpu, p["ctx_cap"], kv_type, flash_attention)
            if ctx and ctx >= m.min_ctx(floors, kv_type):
                return _build(m, profile, "gpu", ctx, m.layers + 1, kv_type, flash_attention, gpu, ram,
                              f"Largest model that fits entirely in {gpu:.1f} GB of VRAM with a "
                              f"{ctx:,}-token conversation memory.", think, floors)
            return None

        def hybrid(m: ModelSpec) -> Plan | None:
            # Share VRAM with system RAM: offload as many layers as fit, spill the rest.
            ctx = m.min_ctx(floors, kv_type)
            n = _hybrid_layers(m, gpu, ctx, kv_type, flash_attention)
            slots = m.layers + 1
            frac = n / slots
            spill = (m.weights_gb + m.kv_gb(ctx, kv_type)) * (1 - frac)
            ok_frac = frac >= p["hybrid_min_gpu_frac"] or (profile == "deep" and m.moe and n > 0)
            if n and ok_frac and spill <= ram:
                return _build(m, profile, "hybrid", ctx, n, kv_type, flash_attention, gpu, ram,
                              f"Sharing memory: {n}/{slots} layers in VRAM, {spill:.1f} GB spilled to "
                              f"system RAM, {ctx:,}-token conversation memory.", think, floors)
            return None

        if p.get("per_model"):
            for m in sized:
                plan = full(m) or hybrid(m)
                if plan:
                    return finish(plan, m)
        else:
            for step in (full, hybrid):
                for m in sized:
                    plan = step(m)
                    if plan:
                        return finish(plan, m)

        # GPU too small for the floors under this profile: spill as much as RAM allows, smallest model.
        m = big_first[-1]
        ctx = m.min_ctx(floors, kv_type)
        n = _hybrid_layers(m, gpu, ctx, kv_type, flash_attention)
        spill = (m.weights_gb + m.kv_gb(ctx, kv_type)) * (1 - n / (m.layers + 1))
        if n and spill <= ram:
            return finish(_build(m, profile, "hybrid", ctx, n, kv_type, flash_attention, gpu, ram,
                                 f"GPU is below the {floors.weights_gb:g}+{floors.context_gb:g} GB floor, so "
                                 f"{n}/{m.layers + 1} layers run in VRAM and {spill:.1f} GB in system RAM.",
                                 think, floors), m)

    # CPU only (no GPU, or nothing acceptable fit). Keep it to models that stay responsive.
    for m in big_first:
        if m.params_b > p["cpu_max_params"] and m is not big_first[-1]:
            continue
        ctx = m.min_ctx(floors, kv_type)
        need = m.weights_gb + m.kv_gb(ctx, kv_type) + compute_gb(ctx, flash_attention)
        if need <= ram or (hw.unified_memory and need <= gpu):
            if hw.unified_memory:
                return finish(_build(m, profile, "gpu", ctx, m.layers + 1, kv_type, flash_attention, gpu, ram,
                                     f"{m.label} in unified memory with a {ctx:,}-token conversation memory.",
                                     think, floors), m)
            return finish(_build(m, profile, "cpu", ctx, 0, kv_type, flash_attention, gpu, ram,
                                 f"Running {m.label} on CPU + system RAM with a {ctx:,}-token conversation "
                                 "memory.", think, floors), m)

    # Below the floors: honour them anyway (the user asked for them) and warn.
    m = big_first[-1]
    ctx = m.min_ctx(floors, kv_type)
    n = _hybrid_layers(m, gpu, ctx, kv_type, flash_attention) if gpu else 0
    plan = _build(m, profile, "hybrid" if n else "cpu", ctx, n, kv_type, flash_attention, gpu, ram,
                  "This machine is below XAC's memory floors - it will run, but the OS may swap.", think, floors)
    need = m.weights_gb + m.kv_gb(ctx, kv_type) + compute_gb(ctx, flash_attention)
    plan.warnings.append(f"Floors need ~{need:.1f} GB but only ~{gpu + ram:.1f} GB is budgeted. Close other "
                         "apps, add RAM, or lower the floors with --min-params-gb / --min-context-gb.")
    return finish(plan, m)


def describe(plan: Plan, hw: Hardware) -> str:
    """Human-readable budget, printed at startup and by `--plan`."""
    gu, ru = plan.gpu_use, plan.ram_use
    gpu_total = sum(gu.values())
    ram_total = sum(ru.values())
    gpus = ", ".join(f"{g.name} ({g.vram_gb:.1f} GB)" for g in hw.gpus) or "none"
    bar = _bar(gpu_total, plan.gpu_budget_gb) if plan.gpu_budget_gb else ""
    f = plan.floors
    lines = [
        f"  Hardware   : {hw.os} {hw.arch}, {hw.cpu_threads} threads, {hw.ram_gb:.1f} GB RAM",
        f"  GPU(s)     : {gpus}",
        f"  Profile    : {plan.profile}",
        f"  Model      : {plan.label}  [{plan.model}]",
        f"  Parameters : {plan.weights_gb:.1f} GB   (floor {f.get('weights_gb', 0):g} GB)",
        f"  Chat memory: {plan.context_gb:.1f} GB = {plan.num_ctx:,} tokens   (floor {f.get('context_gb', 0):g} GB, "
        f"KV cache {plan.kv_type}{', flash attention' if plan.flash_attention else ''})",
        f"  Mode       : {plan.mode.upper()} - {plan.num_gpu}/{plan.total_layers} layers on GPU",
        f"  Reply room : {plan.num_predict:,} tokens{' (reasoning on)' if plan.thinking else ''}",
        f"  VRAM use   : {gpu_total:.1f} / {plan.gpu_budget_gb:.1f} GB  {bar}"
        f"  (weights {gu['weights']:.1f}, chat memory {gu['kv_cache']:.1f}, compute {gu['compute']:.1f})",
        f"  RAM spill  : {ram_total:.1f} / {plan.ram_budget_gb:.1f} GB",
        f"  Why        : {plan.reason}",
    ]
    lines += [f"  Note       : {n}" for n in hw.notes]
    lines += [f"  WARNING    : {w}" for w in plan.warnings]
    return "\n".join(lines)


def _bar(used: float, total: float, width: int = 20) -> str:
    filled = 0 if total <= 0 else min(width, math.ceil(width * used / total))
    return "[" + "#" * filled + "-" * (width - filled) + "]"
