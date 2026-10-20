import tempfile
from pathlib import Path
from gemini_bridge.truncator import save_and_truncate_output, _prune_old_logs, MAX_PROMPT_OUTPUT_CHARS

def test_truncator_short_output_untouched():
    text = "Short output 123"
    res = save_and_truncate_output("bash", text, tab_id="tab_test")
    assert res == text

def test_truncator_long_output_sliced():
    long_text = "A" * 15000
    res = save_and_truncate_output("python", long_text, tab_id="tab_test")
    assert len(res) < len(long_text)
    assert "OUTPUT TRUNCATED: 15000 chars total" in res
    assert "/tmp/gemini_bridge_logs/cmd_" in res
    assert res.startswith("A" * 100)
    assert res.endswith("A" * 100)

def test_prune_old_logs():
    with tempfile.TemporaryDirectory() as tmpdir:
        p = Path(tmpdir)
        for i in range(25):
            f = p / f"cmd_{i:02d}.log"
            f.write_text(f"log {i}")
        _prune_old_logs(p, max_files=20)
        remaining = list(p.glob("cmd_*.log"))
        assert len(remaining) == 20
