export type CommandLanguage = "python" | "bash" | "bun";

export interface ParsedCommand {
  type: CommandLanguage;
  timeout: string;
  code: string;
  rawType: string;
}

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

export interface DaemonExecutionResponse {
  status: "completed" | "error" | "timeout" | "running";
  type: CommandLanguage;
  output?: string;
  timedOut?: boolean;
  exitCode?: number;
  timeout?: string;
  command?: string;
  variantIndex?: number;
}

export interface PromptBoxStatus {
  hasText: boolean;
  charCount: number;
  promptText: string;
  buttonLabel: string;
  isButtonDisabled: boolean;
  isAiPrinting: boolean;
}

export interface ProposedVariant {
  index: number;
  label: string;
  textSnippet: string;
}

export type BridgeConnectionStatus = "ready" | "running" | "error" | "offline";
