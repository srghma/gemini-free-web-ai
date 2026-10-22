export type AutomationMode = "auto" | "manual";

export interface ExtractedCodeBlock {
  language: string;
  code: string;
}

export interface ExtractedTurn {
  id: string;
  type: "user" | "ai_thinking" | "ai_chat" | "ai_both";
  status: "streaming" | "completed";
  userContent?: string;
  thinkingContent?: string;
  chatContent?: string;
  codeBlocks: ExtractedCodeBlock[];
}

export interface PreferenceOption {
  index: number;
  side: "left" | "right";
  text: string;
}

export interface PreferenceVoteData {
  question: string;
  options: PreferenceOption[];
  hasSubmitButton: boolean;
  isSubmitDisabled: boolean;
}

export interface PromptBoxStatus {
  hasText: boolean;
  charCount: number;
  promptText: string;
  buttonLabel: string;
  isButtonDisabled: boolean;
  isAiPrinting: boolean;
}

export interface ActiveFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  rawCode: string;
}

export type BridgeConnectionStatus =
  | "ready"
  | "running"
  | "waiting"
  | "review"
  | "error"
  | "offline";
