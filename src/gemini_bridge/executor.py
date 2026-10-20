import asyncio
from collections.abc import Callable
import os
import re
import shutil
import signal
import tempfile
from dataclasses import dataclass
from pathlib import Path
from .models import TabSession, get_default_work_dir

TIMEOUT_UNITS = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}

@dataclass(frozen=True)
class ExecutionResult:
    output: str
    timed_out: bool
    exit_code: int

def parse_timeout(val: str | None, default: float = 60.0) -> float:
    if not val:
        return default
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([smhd])?", str(val).strip().lower())
    if not match:
        return default
    num, unit = match.groups()
    return float(num) * TIMEOUT_UNITS.get(unit or "s", 1.0)

def format_interleaved(segments: list[tuple[str, str]]) -> str:
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

async def run_subprocess_interleaved(
    cmd: list[str],
    cwd: str,
    timeout: float,
    on_chunk: Callable[[str, str], None] | None = None,
) -> ExecutionResult:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=get_execution_env(),
        start_new_session=True,
    )

    segments: list[tuple[str, str]] = []

    async def read_stream(stream: asyncio.StreamReader, stream_type: str):
        while True:
            chunk = await stream.read(1024)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            segments.append((stream_type, text))
            if on_chunk:
                on_chunk(stream_type, text)

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
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            await proc.wait()
        except Exception:
            pass
        return ExecutionResult(
            output=format_interleaved(segments),
            timed_out=True,
            exit_code=124,
        )

def resolve_session_path(session: TabSession, path_str: str) -> Path:
    raw = path_str.strip().strip("'").strip('"')
    target = Path(os.path.expanduser(raw))
    if target.is_absolute():
        return target.resolve()
    base = Path(session.cwd) if session.cwd else Path(get_default_work_dir())
    return (base / target).resolve()

def execute_cd(session: TabSession, target_dir: str) -> ExecutionResult:
    try:
        resolved = resolve_session_path(session, target_dir)
        if not resolved.exists():
            return ExecutionResult(output=f"[e]Directory does not exist: {target_dir}", timed_out=False, exit_code=1)
        if not resolved.is_dir():
            return ExecutionResult(output=f"[e]Target is not a directory: {target_dir}", timed_out=False, exit_code=1)
        session.cwd = str(resolved)
        return ExecutionResult(output="", timed_out=False, exit_code=0)
    except Exception as e:
        return ExecutionResult(output=f"[e]{e}", timed_out=False, exit_code=1)

def execute_write(session: TabSession, path_str: str, content: str, overwrite: bool) -> ExecutionResult:
    try:
        resolved = resolve_session_path(session, path_str)
        parent = resolved.parent
        if not parent.exists():
            return ExecutionResult(output=f"[e]Parent directory does not exist: {parent}", timed_out=False, exit_code=1)
        if not parent.is_dir():
            return ExecutionResult(output=f"[e]Parent path is not a directory: {parent}", timed_out=False, exit_code=1)
        if resolved.exists() and resolved.is_file() and resolved.stat().st_size > 0 and not overwrite:
            return ExecutionResult(
                output=f"[e]File already exists and is not empty: {resolved}. Use WRITE_NEXT({path_str},overwrite=true) to overwrite.",
                timed_out=False,
                exit_code=1,
            )
        resolved.write_text(content, encoding="utf-8")
        return ExecutionResult(output="", timed_out=False, exit_code=0)
    except Exception as e:
        return ExecutionResult(output=f"[e]{e}", timed_out=False, exit_code=1)

async def execute_task(
    lang: str,
    code: str,
    timeout: float,
    cwd: str | None = None,
    on_chunk: Callable[[str, str], None] | None = None,
) -> ExecutionResult:
    ext_map = {"python": ".py", "bash": ".sh", "bun": ".ts"}
    suffix = ext_map.get(lang, ".sh")

    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        shell = "zsh" if shutil.which("zsh") else "bash"
        cmd = {
            "python": ["python3", tmp_path],
            "bun": ["bun", "run", tmp_path],
            "bash": ["bash", tmp_path] if shutil.which("bash") else [shell, tmp_path],
        }.get(lang, [shell, tmp_path])

        effective_cwd = cwd or get_default_work_dir()
        return await run_subprocess_interleaved(cmd, effective_cwd, timeout, on_chunk=on_chunk)
    except Exception as e:
        return ExecutionResult(output=f"[e]{e}", timed_out=False, exit_code=1)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
