import type { DaemonExecutionResponse } from "../types";

export const formatExecutionReply = ({
  type,
  output,
  timedOut,
  exitCode,
}: DaemonExecutionResponse): string => {
  const lang = (type || "PYTHON").toUpperCase();
  const content = output || "";

  if (timedOut) {
    return `PREVIOUS_${lang}_TIMEOUT\n${content}`;
  }
  if (exitCode !== 0) {
    return `PREVIOUS_${lang}_ERROR (status=${exitCode})\n${content}`;
  }
  return `PREVIOUS_${lang}_OUTPUT\n${content}`;
};
