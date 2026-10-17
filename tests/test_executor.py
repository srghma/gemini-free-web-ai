import pytest
from gemini_bridge.executor import execute_task, parse_timeout

def test_parse_timeout():
    assert parse_timeout("30s") == 30.0
    assert parse_timeout("2m") == 120.0
    assert parse_timeout("1h") == 3600.0
    assert parse_timeout("0.5m") == 30.0
    assert parse_timeout(None, default=45.0) == 45.0

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
