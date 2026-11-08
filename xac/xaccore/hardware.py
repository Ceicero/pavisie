"""Best-effort hardware detection: GPU VRAM, system RAM, CPU threads.

Nothing here needs third-party packages. Every probe is wrapped so a missing
tool (no nvidia-smi, no rocm, etc.) just means "not detected" instead of a crash.
You can always override with the XAC_VRAM_GB / XAC_RAM_GB environment variables.
"""

from __future__ import annotations

import ctypes
import glob
import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass, field

GIB = 1024**3


@dataclass
class GPU:
    name: str
    vendor: str
    vram_gb: float
    used_gb: float = 0.0


@dataclass
class Hardware:
    os: str
    arch: str
    cpu_threads: int
    ram_gb: float
    ram_available_gb: float
    gpus: list[GPU] = field(default_factory=list)
    unified_memory: bool = False  # Apple Silicon: GPU and CPU share one pool
    gpu_budget_gb: float = 0.0  # VRAM the GPU(s) can actually use for models
    notes: list[str] = field(default_factory=list)

    @property
    def vram_gb(self) -> float:
        return round(sum(g.vram_gb for g in self.gpus), 2)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["vram_gb"] = self.vram_gb
        return d


def _run(cmd: list[str], timeout: float = 5.0) -> str:
    if not shutil.which(cmd[0]):
        return ""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


# --------------------------------------------------------------------------- RAM


def _ram_linux() -> tuple[float, float]:
    total = avail = 0.0
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                key, _, rest = line.partition(":")
                kb = float(rest.strip().split()[0])
                if key == "MemTotal":
                    total = kb * 1024 / GIB
                elif key == "MemAvailable":
                    avail = kb * 1024 / GIB
    except (OSError, ValueError, IndexError):
        pass
    return total, avail or total


def _ram_macos() -> tuple[float, float]:
    total = float(_run(["sysctl", "-n", "hw.memsize"]).strip() or 0) / GIB
    # vm_stat reports pages; free + inactive + speculative is a fair "available".
    avail = 0.0
    out = _run(["vm_stat"])
    if out:
        page = 16384 if platform.machine() == "arm64" else 4096
        first = out.splitlines()[0]
        if "page size of" in first:
            try:
                page = int(first.split("page size of")[1].split()[0])
            except (ValueError, IndexError):
                pass
        pages = 0
        for line in out.splitlines():
            if any(k in line for k in ("Pages free", "Pages inactive", "Pages speculative")):
                try:
                    pages += int(line.split(":")[1].strip().rstrip("."))
                except (ValueError, IndexError):
                    pass
        avail = pages * page / GIB
    return total, avail or total * 0.5


def _ram_windows() -> tuple[float, float]:
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    try:
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))  # type: ignore[attr-defined]
        return stat.ullTotalPhys / GIB, stat.ullAvailPhys / GIB
    except (AttributeError, OSError):
        return 0.0, 0.0


# --------------------------------------------------------------------------- GPUs


def _nvidia() -> list[GPU]:
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"])
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3:
            try:
                gpus.append(GPU(parts[0], "nvidia", float(parts[1]) / 1024, float(parts[2]) / 1024))
            except ValueError:
                continue
    return gpus


def _amd_linux() -> list[GPU]:
    gpus = []
    for path in sorted(glob.glob("/sys/class/drm/card[0-9]*/device/mem_info_vram_total")):
        try:
            with open(path, encoding="utf-8") as f:
                total = int(f.read().strip()) / GIB
            used = 0.0
            used_path = path.replace("vram_total", "vram_used")
            if os.path.exists(used_path):
                with open(used_path, encoding="utf-8") as f:
                    used = int(f.read().strip()) / GIB
            # Integrated APUs report a tiny carve-out; ignore anything under 1 GB.
            if total >= 1.0:
                gpus.append(GPU("AMD GPU", "amd", total, used))
        except (OSError, ValueError):
            continue
    return gpus


def _windows_other() -> list[GPU]:
    """Non-NVIDIA GPUs on Windows. WMI's AdapterRAM caps at 4 GB, so read the registry value."""
    ps = (
        "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\"
        "{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | "
        "ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }"
    )
    out = _run(["powershell", "-NoProfile", "-Command", ps], timeout=10)
    gpus = []
    for line in out.strip().splitlines():
        name, _, size = line.partition("|")
        try:
            vram = int(size) / GIB
        except ValueError:
            continue
        low = name.lower()
        vendor = "amd" if ("amd" in low or "radeon" in low) else "intel" if "intel" in low else "other"
        if vram >= 1.0 and "nvidia" not in low:
            gpus.append(GPU(name.strip(), vendor, vram))
    return gpus


def _apple_gpu_budget(ram_gb: float) -> float:
    """macOS lets Metal wire roughly 2/3 of RAM on small machines, ~3/4 on 36 GB+."""
    return ram_gb * (0.75 if ram_gb >= 36 else 0.66)


# --------------------------------------------------------------------------- main


def detect() -> Hardware:
    system = platform.system()
    arch = platform.machine().lower()
    threads = os.cpu_count() or 4

    if system == "Linux":
        ram, avail = _ram_linux()
    elif system == "Darwin":
        ram, avail = _ram_macos()
    elif system == "Windows":
        ram, avail = _ram_windows()
    else:
        ram, avail = 8.0, 4.0

    hw = Hardware(system, arch, threads, round(ram, 2), round(avail, 2))

    if system == "Darwin" and arch in ("arm64", "aarch64"):
        hw.unified_memory = True
        budget = _apple_gpu_budget(ram)
        hw.gpus = [GPU("Apple Silicon (unified memory)", "apple", round(budget, 2))]
        hw.notes.append("Apple Silicon shares RAM with the GPU; XAC budgets both from one pool.")
    else:
        gpus = _nvidia()
        if not gpus and system == "Linux":
            gpus = _amd_linux()
        if not gpus and system == "Windows":
            gpus = _windows_other()
        hw.gpus = [GPU(g.name, g.vendor, round(g.vram_gb, 2), round(g.used_gb, 2)) for g in gpus]
        if any(g.vendor == "intel" for g in hw.gpus):
            hw.notes.append("Intel GPUs are not accelerated by Ollama yet; XAC will plan for CPU.")
            hw.gpus = [g for g in hw.gpus if g.vendor != "intel"]
        if not hw.gpus:
            hw.notes.append("No supported GPU found - XAC will run on CPU + system RAM (slower, still works).")

    # Manual overrides win over everything.
    if os.environ.get("XAC_VRAM_GB"):
        v = float(os.environ["XAC_VRAM_GB"])
        hw.gpus = [GPU("Manual override", "manual", v)] if v > 0 else []
        hw.notes = [n for n in hw.notes if not n.startswith(("No supported GPU", "Intel GPUs"))]
        hw.notes.append(f"VRAM overridden to {v} GB via XAC_VRAM_GB.")
    if os.environ.get("XAC_RAM_GB"):
        hw.ram_gb = hw.ram_available_gb = float(os.environ["XAC_RAM_GB"])
        hw.notes.append(f"RAM overridden to {hw.ram_gb} GB via XAC_RAM_GB.")

    # Usable GPU memory: total minus what other apps (desktop, browser) already hold.
    hw.gpu_budget_gb = round(sum(max(g.vram_gb - g.used_gb, 0.0) for g in hw.gpus), 2)
    return hw
