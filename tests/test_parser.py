from gemini_bridge.parser import extract_commands_from_text, extract_commands_from_turn
from gemini_bridge.models import ChatTurn, CodeBlock

def test_extract_single_python_command():
    text = """
Some intro text.
EXECUTE_NEXT_PYTHON
```py
import sys
print(sys.version)
```
"""
    cmds = extract_commands_from_text(text)
    assert len(cmds) == 1
    assert cmds[0].lang == "python"
    assert cmds[0].timeout == "60s"
    assert "import sys" in cmds[0].code

def test_extract_custom_timeout():
    text = """
EXECUTE_NEXT_BASH(timeout=2m)
```bash
git status
```
"""
    cmds = extract_commands_from_text(text)
    assert len(cmds) == 1
    assert cmds[0].lang == "bash"
    assert cmds[0].timeout == "2m"
    assert cmds[0].code == "git status"

def test_extract_cd_command():
    text = "CD(~/projects/gemini-free-web-ai)"
    cmds = extract_commands_from_text(text)
    assert len(cmds) == 1
    assert cmds[0].lang == "cd"
    assert cmds[0].code == "~/projects/gemini-free-web-ai"
    assert cmds[0].raw_trigger == "CD"

def test_extract_write_next_command():
    text = """
WRITE_NEXT(./src/hello.txt, overwrite=true)
```txt
Hello world!
```
"""
    cmds = extract_commands_from_text(text)
    assert len(cmds) == 1
    assert cmds[0].lang == "write_next"
    assert cmds[0].path == "./src/hello.txt"
    assert cmds[0].overwrite is True
    assert cmds[0].code == "Hello world!"

def test_extract_mixed_sequence_preserves_order():
    text = """
CD(~/projects)

WRITE_NEXT(test.py)
```python
print(123)
```

EXECUTE_NEXT_BASH
```bash
python3 test.py
```
"""
    cmds = extract_commands_from_text(text)
    assert len(cmds) == 3
    assert cmds[0].lang == "cd"
    assert cmds[0].code == "~/projects"
    assert cmds[1].lang == "write_next"
    assert cmds[1].path == "test.py"
    assert cmds[2].lang == "bash"
    assert cmds[2].code == "python3 test.py"

def test_extract_from_turn_with_code_blocks():
    turn = ChatTurn(
        id="turn-123",
        type="ai_chat",
        status="completed",
        chat_content="I will run these:\nEXECUTE_NEXT_BASH\nEXECUTE_NEXT_PYTHON",
        code_blocks=[
            CodeBlock(language="bash", code="echo 'hello'"),
            CodeBlock(language="py", code="print('world')"),
        ],
    )
    cmds = extract_commands_from_turn(turn)
    assert len(cmds) == 2
    assert cmds[0].lang == "bash"
    assert cmds[0].code == "echo 'hello'"
    assert cmds[1].lang == "python"
    assert cmds[1].code == "print('world')"
