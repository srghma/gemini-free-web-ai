import { describe, expect, it } from "bun:test";

describe("Preference Vote Extraction Data Structure", () => {
  it("formats preference options as expected", () => {
    const rawOptions = [
      { index: 0, side: "left" as const, text: "EXECUTE_NEXT_PYTHON\nprint(1)" },
      { index: 1, side: "right" as const, text: "EXECUTE_NEXT_BASH\necho 1" },
    ];
    expect(rawOptions).toHaveLength(2);
    expect(rawOptions[0]?.side).toBe("left");
    expect(rawOptions[1]?.side).toBe("right");
  });
});
