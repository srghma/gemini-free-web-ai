import { describe, expect, it } from "bun:test";
import {
  extractCandidatesFromClosureResponse,
  extractTextFromClosureResponse,
} from "../src/dom/networkParser";

describe("Closure RPC Response Decoder", () => {
  it("extracts text fragments from streaming closure response", () => {
    const sample = `[[[[[[[[null,"1 + 1 = 2"]],"model"]]],null,[4,7,11,null,[[1,4]]],null,null,null,null,"v1_hash"]`;
    const text = extractTextFromClosureResponse(sample);
    expect(text).toBe("1 + 1 = 2");
  });

  it("concatenates multi-chunk stream correctly", () => {
    const sample = `[[[[[[[[null,"Hello! "]],"model"]]],null],[[[[[[null,"How can I help?"]],"model"]]],null]`;
    const text = extractTextFromClosureResponse(sample);
    expect(text).toBe("Hello! How can I help?");
  });

  it("extracts multiple candidates when A/B variants are provided", () => {
    const sampleAB = `[[[[[[[[null,"Option 1 text"]],"model",null,null,0]],null],[[[[[[null,"Option 2 text"]],"model",null,null,1]],null]`;
    const candidates = extractCandidatesFromClosureResponse(sampleAB);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe("Option 1 text");
    expect(candidates[1]).toBe("Option 2 text");
  });
});
