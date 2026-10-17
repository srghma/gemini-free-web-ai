import asyncio
import os
import re
import signal
import tempfile
from dataclasses import dataclass
from pathlib import Path

TIMEOUT_UNITS = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}

@dataclass(frozen=True)
class ExecutionResult:
    output: str
    timed_out: bool
    exit_code: int


def parse_timeout(val: str | None, default: float = 60.0) -> float:
    """Parse timeout strings like '2h', '30m', '45s', '1d'. Default: 60s."""
    if not val:
        return default
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([smhd])?", str(val).strip().lower())
    if not match:
        return default
    num, unit = match.groups()
    return float(num) * TIMEOUT_UNITS.get(unit or "s", 1.0)


def format_interleaved(segments: list[tuple[str, str]]) -> str:
    """Interleave stdout ('o') and stderr ('e')."""
    result: list[str] = []
    current_stream: str | None = None
    is_first = True

    for stream_type, text in segments:
        if not text:
            continue
        if current_stream != stream_type:
            if not (is_first and stream_type == "o"):
                result.append(f"[{stream_type}]")
            current_stream = stream_type
            is_first = False
        result.append(text)

    return "".join(result)


def get_execution_env() -> dict[str, str]:
    env = dict(os.environ)
    home = str(Path.home())
    extra_paths = [
        f"{home}/.cargo/bin",
        f"{home}/.local/bin",
        f"{home}/.nix-profile/bin",
        "/run/current-system/sw/bin",
    ]
    cur_path = env.get("PATH", "")
    env["PATH"] = ":".join([p for p in extra_paths if p not in cur_path] + [cur_path])
    return env


async def run_subprocess_interleaved(cmd: list[str], cwd: str, timeout: float) -> ExecutionResult:
    """Execute command in a new process group, read stdout/stderr concurrently, handle timeout."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=get_execution_env(),
        start_new_session=True,  # Creates a new process group so killpg kills all children
    )

    segments: list[tuple[str, str]] = []

    async def read_stream(stream: asyncio.StreamReader, stream_type: str):
        while True:
            chunk = await stream.read(1024)
            if not chunk:
                break
            segments.append((stream_type, chunk.decode("utf-8", errors="replace")))

    try:
        await asyncio.wait_for(
            asyncio.gather(
                read_stream(proc.stdout, "o"),
                read_stream(proc.stderr, "e"),
                proc.wait(),
            ),
            timeout=timeout,
        )
        return ExecutionResult(
            output=format_interleaved(segments),
            timed_out=False,
            exit_code=proc.returncode or 0,
        )
    except asyncio.TimeoutError:
        try:
            # Kill the entire process group
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            await proc.wait()
        except Exception:
            pass
        return ExecutionResult(
            output=format_interleaved(segments),
            timed_out=True,
            exit_code=124,
        )


async def execute_task(lang: str, code: str, timeout: float) -> ExecutionResult:
    ext_map = {"python": ".py", "bash": ".sh", "bun": ".ts"}
    suffix = ext_map.get(lang, ".sh")

    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        cmd = {
            "python": ["python3", tmp_path],
            "bun": ["bun", "run", tmp_path],
        }.get(lang, ["zsh", tmp_path])

        work_dir = Path.home() / "projects"
        cwd = str(work_dir) if work_dir.exists() else str(Path.home())

        return await run_subprocess_interleaved(cmd, cwd, timeout)
    except Exception as e:
        return ExecutionResult(output=f"[e]{e}", timed_out=False, exit_code=1)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
