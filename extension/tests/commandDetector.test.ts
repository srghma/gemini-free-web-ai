import { describe, expect, it } from "bun:test";
import { hasExecutableCommands } from "../src/dom/commandDetector";

describe("Command Detection Helper", () => {
  it("detects EXECUTE_NEXT_PYTHON triggers", () => {
    expect(hasExecutableCommands("Let me test:\nEXECUTE_NEXT_PYTHON\n```py\nprint(1)\n```")).toBe(
      true
    );
    expect(hasExecutableCommands("EXECUTE_NEXT_PYTHON(timeout=30s)")).toBe(true);
  });

  it("detects EXECUTE_NEXT_BASH and EXECUTE_NEXT_BUN triggers", () => {
    expect(hasExecutableCommands("EXECUTE_NEXT_BASH\n```bash\nls\n```")).toBe(true);
    expect(hasExecutableCommands("EXECUTE_NEXT_BUN(timeout=1m)")).toBe(true);
  });

  it("detects CD and WRITE_NEXT triggers", () => {
    expect(hasExecutableCommands("CD(~/projects)")).toBe(true);
    expect(hasExecutableCommands("WRITE_NEXT(./file.txt)")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasExecutableCommands("execute_next_python\n```py\nprint(1)\n```")).toBe(true);
    expect(hasExecutableCommands("cd(~/projects)")).toBe(true);
    expect(hasExecutableCommands("write_next(foo.txt)")).toBe(true);
  });

  it("returns false for regular chat messages without triggers", () => {
    expect(hasExecutableCommands("Hello! How can I help you today?")).toBe(false);
    expect(hasExecutableCommands("Here is some code:\n```py\nprint('just example')\n```")).toBe(
      false
    );
    expect(hasExecutableCommands("")).toBe(false);
  });
});
