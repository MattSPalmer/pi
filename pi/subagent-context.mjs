import { readFileSync } from "node:fs";

export function injectContext(task, contextFile, readFile = (path) => readFileSync(path, "utf8")) {
  if (!contextFile) return task;
  let context;
  try {
    context = readFile(contextFile);
  } catch (error) {
    throw new Error(`Could not read context file ${contextFile}: ${String(error)}`);
  }
  return `${task}\n\nInjected context from ${contextFile}:\n${context}`;
}
