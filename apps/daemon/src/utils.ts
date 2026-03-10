import { basename } from "path";
import { readFileSync } from "fs";

/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
export function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Read the last N bytes of a file. Returns the full file if smaller than N.
 */
export function readTail(path: string, bytes: number): string {
  const buf = readFileSync(path);
  if (buf.length <= bytes) return buf.toString("utf-8");
  return buf.subarray(buf.length - bytes).toString("utf-8");
}

/**
 * Recognize common Bash commands and return a human-readable description.
 * Falls back to the raw command if no pattern matches.
 */
export function describeBashCommand(cmd: string): string {
  if (!cmd) return "Running command";
  const c = cmd.toLowerCase();
  if (c.includes("npm run build") || c.includes("next build") || c.includes("tsc") && !c.includes("--noEmit")) return "Building project";
  if (c.includes("tsc") && c.includes("--noEmit")) return "Type-checking";
  if (c.includes("npm run test") || c.includes("jest") || c.includes("vitest") || c.includes("npm test")) return "Running tests";
  if (c.includes("git push")) return "Pushing to remote";
  if (c.includes("git commit")) return "Committing changes";
  if (c.includes("git diff")) return "Reviewing changes";
  if (c.includes("git status")) return "Checking git status";
  if (c.includes("git log")) return "Reading git history";
  if (c.includes("git add")) return "Staging changes";
  if (c.includes("npm install") || c.includes("pnpm install") || c.includes("yarn install")) return "Installing dependencies";
  if (c.includes("curl") && c.includes("/api/")) return "Calling API";
  if (c.includes("npx next build")) return "Building Next.js";
  return cmd; // Raw command as fallback
}

/**
 * Convert a tool name + input into a human-readable action description.
 * Used by telemetry, session streaming, and discovery for dashboard display.
 */
export function describeAction(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): string {
  if (!toolName) return "Working";
  if (!toolInput) return `Using ${toolName}`;

  const filePath = toolInput.file_path as string | undefined;
  const fileName = filePath ? basename(filePath) : undefined;

  switch (toolName) {
    case "Bash":
      if (toolInput.description) return toolInput.description as string;
      if (toolInput.command) return describeBashCommand(truncate(toolInput.command as string, 60));
      return "Running command";
    case "Edit":
      return fileName ? `Editing ${fileName}` : "Editing file";
    case "Write":
      return fileName ? `Writing ${fileName}` : "Writing file";
    case "Read":
      return fileName ? `Reading ${fileName}` : "Reading file";
    case "Grep":
      return toolInput.pattern
        ? `Searching "${truncate(toolInput.pattern as string, 30)}"`
        : "Searching code";
    case "Glob":
      return toolInput.pattern
        ? `Finding ${truncate(toolInput.pattern as string, 30)}`
        : "Finding files";
    case "WebFetch":
      return "Fetching web page";
    case "WebSearch":
      return `Searching web: ${truncate(toolInput.query as string, 50)}`;
    case "Task":
      return `Running subagent: ${truncate(toolInput.description as string, 50)}`;
    case "AskUserQuestion": {
      const questions = toolInput.questions as Array<{
        question?: string;
        options?: Array<{ label?: string }>;
      }> | undefined;
      if (questions && questions.length > 0) {
        const q = questions[0];
        let text = q.question || "Question";
        if (q.options && q.options.length > 0) {
          text += "\n" + q.options.map((o, i) => `${i + 1}. ${o.label || "Option"}`).join("\n");
        }
        return text;
      }
      return "Asking you a question";
    }
    default:
      return toolName.replace(/^mcp__\w+__/, "");
  }
}
