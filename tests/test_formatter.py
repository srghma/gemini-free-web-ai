from gemini_bridge.executor import ExecutionResult
from gemini_bridge.formatter import format_execution_reply, group_replies

def test_format_success():
    res = ExecutionResult(output="Hello world", timed_out=False, exit_code=0)
    msg = format_execution_reply("python", res)
    assert msg == "PREVIOUS_PYTHON_OUTPUT\nHello world"

def test_format_error():
    res = ExecutionResult(output="command not found", timed_out=False, exit_code=127)
    msg = format_execution_reply("bash", res)
    assert msg == "PREVIOUS_BASH_ERROR (status=127)\ncommand not found"

def test_format_timeout():
    res = ExecutionResult(output="partial log", timed_out=True, exit_code=124)
    msg = format_execution_reply("bun", res)
    assert msg == "PREVIOUS_BUN_TIMEOUT\npartial log"

def test_format_cd_write_success_is_empty():
    res = ExecutionResult(output="", timed_out=False, exit_code=0)
    assert format_execution_reply("cd", res) == ""
    assert format_execution_reply("write_next", res) == ""

def test_format_cd_write_error():
    res = ExecutionResult(output="Directory does not exist", timed_out=False, exit_code=1)
    msg = format_execution_reply("cd", res)
    assert msg == "PREVIOUS_CD_ERROR (status=1)\nDirectory does not exist"

    res_w = ExecutionResult(output="File not empty", timed_out=False, exit_code=1)
    msg_w = format_execution_reply("write_next", res_w)
    assert msg_w == "PREVIOUS_WRITE_NEXT_ERROR (status=1)\nFile not empty"

def test_group_replies():
    r1 = "PREVIOUS_BASH_OUTPUT\nok1"
    r2 = "PREVIOUS_PYTHON_OUTPUT\nok2"
    grouped = group_replies([r1, "", r2, ""])
    assert grouped == f"{r1}\n\n{r2}"
