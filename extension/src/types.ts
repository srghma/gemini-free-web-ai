export type CommandLanguage = "python" | "bash" | "bun";

export interface ParsedCommand {
  type: CommandLanguage;
  timeout: string;
  code: string;
  rawType: string;
}

export interface DaemonExecutionResponse {
  status: "completed" | "error" | "timeout" | "running";
  type: CommandLanguage;
  output?: string;
  timedOut?: boolean;
  exitCode?: number;
  timeout?: string;
}

export interface PromptBoxStatus {
  hasText: boolean;
  charCount: number;
  buttonLabel: string;
  isButtonDisabled: boolean;
  isAiPrinting: boolean;
}

export type BridgeConnectionStatus = "ready" | "running" | "error" | "offline";
