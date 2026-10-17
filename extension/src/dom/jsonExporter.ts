import type { ExtractedTurn } from "../types";

export interface AIStudioExportJson {
  runSettings: {
    model: string;
    temperature: number;
    topP: number;
    topK: number;
    maxOutputTokens: number;
    safetySettings: { category: string; threshold: string }[];
  };
  systemInstruction: Record<string, unknown>;
  chunkedPrompt: {
    chunks: {
      text: string;
      role: "user" | "model";
      isThought?: boolean;
      finishReason?: string;
    }[];
  };
}

export const buildExportJson = (
  turns: ExtractedTurn[],
  model = "models/gemini-3.8-flash",
  rawRequestPayload?: unknown
): AIStudioExportJson => {
  let temperature = 1.0;
  let topP = 0.95;
  let topK = 64;
  let maxOutputTokens = 65536;

  if (Array.isArray(rawRequestPayload)) {
    const s = rawRequestPayload[3];
    if (Array.isArray(s)) {
      if (typeof s[3] === "number") maxOutputTokens = s[3];
      if (typeof s[4] === "number") temperature = s[4];
      if (typeof s[5] === "number") topP = s[5];
      if (typeof s[6] === "number") topK = s[6];
    }
  }

  const chunks: AIStudioExportJson["chunkedPrompt"]["chunks"] = [];

  for (const t of turns) {
    if (t.type === "user") {
      chunks.push({
        role: "user",
        text: t.userContent || "",
      });
    } else {
      if (t.thinkingContent) {
        chunks.push({
          role: "model",
          isThought: true,
          text: t.thinkingContent,
        });
      }
      let fullModelText = t.chatContent || "";
      if (t.codeBlocks && t.codeBlocks.length > 0) {
        const blocksText = t.codeBlocks
          .map((cb) => `\n\n\`\`\`${cb.language}\n${cb.code}\n\`\`\``)
          .join("");
        fullModelText = (fullModelText + blocksText).trim();
      }
      if (fullModelText) {
        chunks.push({
          role: "model",
          finishReason: "STOP",
          text: fullModelText,
        });
      }
    }
  }

  return {
    runSettings: {
      model,
      temperature,
      topP,
      topK,
      maxOutputTokens,
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      ],
    },
    systemInstruction: {},
    chunkedPrompt: { chunks },
  };
};
