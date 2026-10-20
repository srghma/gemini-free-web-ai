export const hasExecutableCommands = (text: string): boolean => {
  if (!text) return false;
  return /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN|CD\(|WRITE_NEXT\()/i.test(text);
};
