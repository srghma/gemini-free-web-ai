import os
import tempfile
import pytest
from pathlib import Path
from gemini_bridge.executor import execute_cd, execute_task, execute_write, parse_timeout
from gemini_bridge.models import TabSession

def test_parse_timeout():
    assert parse_timeout("30s") == 30.0
    assert parse_timeout("2m") == 120.0
    assert parse_timeout("1h") == 3600.0
    assert parse_timeout("0.5m") == 30.0
    assert parse_timeout(None, default=45.0) == 45.0

def test_execute_cd_success():
    with tempfile.TemporaryDirectory() as tmpdir:
        session = TabSession(tab_id="tab_1")
        res = execute_cd(session, tmpdir)
        assert res.exit_code == 0
        assert res.output == ""
        assert Path(session.cwd).resolve() == Path(tmpdir).resolve()

def test_execute_cd_not_found():
    session = TabSession(tab_id="tab_1")
    res = execute_cd(session, "/nonexistent/random/dir/xyz_123")
    assert res.exit_code == 1
    assert "Directory does not exist" in res.output

def test_execute_write_success_and_overwrite():
    with tempfile.TemporaryDirectory() as tmpdir:
        session = TabSession(tab_id="tab_1", cwd=tmpdir)
        # 1. Create new file
        res = execute_write(session, "test.txt", "content_1", overwrite=False)
        assert res.exit_code == 0
        assert res.output == ""
        assert (Path(tmpdir) / "test.txt").read_text() == "content_1"

        # 2. Overwrite fails without overwrite=True
        res_fail = execute_write(session, "test.txt", "content_2", overwrite=False)
        assert res_fail.exit_code == 1
        assert "File already exists and is not empty" in res_fail.output

        # 3. Overwrite succeeds with overwrite=True
        res_ow = execute_write(session, "test.txt", "content_2", overwrite=True)
        assert res_ow.exit_code == 0
        assert (Path(tmpdir) / "test.txt").read_text() == "content_2"

def test_execute_write_missing_parent():
    session = TabSession(tab_id="tab_1")
    res = execute_write(session, "/nonexistent_parent/file.txt", "content", overwrite=False)
    assert res.exit_code == 1
    assert "Parent directory does not exist" in res.output

@pytest.mark.asyncio
async def test_execute_bash():
    res = await execute_task("bash", "echo 'bridge_test_ok'", timeout=5.0)
    assert not res.timed_out
    assert res.exit_code == 0
    assert "bridge_test_ok" in res.output

@pytest.mark.asyncio
async def test_execute_python():
    res = await execute_task("python", "import sys; print('python_val', 2 + 2)", timeout=5.0)
    assert not res.timed_out
    assert res.exit_code == 0
    assert "python_val 4" in res.output

@pytest.mark.asyncio
async def test_execute_timeout():
    res = await execute_task("bash", "sleep 3; echo 'done'", timeout=0.3)
    assert res.timed_out
    assert res.exit_code == 124
