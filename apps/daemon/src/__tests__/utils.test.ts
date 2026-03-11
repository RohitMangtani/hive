import { describe, it, expect } from "vitest";
import { describeAction, truncate } from "../utils.js";

describe("describeAction", () => {
  it("describes Bash with command", () => {
    const result = describeAction("Bash", { command: "npm test" });
    expect(result).toBe("Running tests");
  });

  it("prefers Bash description over command", () => {
    const result = describeAction("Bash", { description: "Run tests", command: "npm test" });
    expect(result).toBe("Run tests");
  });

  it("truncates long Bash commands", () => {
    const longCmd = "x".repeat(100);
    const result = describeAction("Bash", { command: longCmd });
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(70);
  });

  it("describes Edit tool with file path", () => {
    const result = describeAction("Edit", { file_path: "/src/app/page.tsx" });
    expect(result).toBe("Editing page.tsx");
  });

  it("describes Write tool", () => {
    const result = describeAction("Write", { file_path: "/src/new-file.ts" });
    expect(result).toBe("Writing new-file.ts");
  });

  it("describes Read tool", () => {
    const result = describeAction("Read", { file_path: "/src/config.ts" });
    expect(result).toBe("Reading config.ts");
  });

  it("describes Grep tool with pattern", () => {
    const result = describeAction("Grep", { pattern: "TODO" });
    expect(result).toBe('Searching "TODO"');
  });

  it("describes Glob tool", () => {
    const result = describeAction("Glob", { pattern: "**/*.ts" });
    expect(result).toBe("Finding **/*.ts");
  });

  it("describes WebFetch", () => {
    const result = describeAction("WebFetch", { url: "https://example.com/api" });
    expect(result).toBe("Fetching web page");
  });

  it("describes WebSearch", () => {
    const result = describeAction("WebSearch", { query: "how to fix build" });
    expect(result).toBe("Searching web: how to fix build");
  });

  it("describes Task/subagent", () => {
    const result = describeAction("Task", { description: "Review code" });
    expect(result).toBe("Running subagent: Review code");
  });

  it("describes AskUserQuestion", () => {
    const result = describeAction("AskUserQuestion", {
      questions: [{ question: "Which database?" }],
    });
    expect(result).toBe("Which database?");
  });

  it("strips MCP prefix for unknown tools", () => {
    const result = describeAction("mcp__slack__send_message", {});
    expect(result).toBe("send_message");
  });

  it("returns tool name for unknown tools", () => {
    const result = describeAction("SomeNewTool", {});
    expect(result).toBe("SomeNewTool");
  });

  it("returns 'Using {tool}' when input is undefined", () => {
    const result = describeAction("Bash", undefined);
    expect(result).toBe("Using Bash");
  });

  it("returns 'Working' when tool name is undefined", () => {
    const result = describeAction(undefined, undefined);
    expect(result).toBe("Working");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello wo...");
  });

  it("returns empty string for undefined input", () => {
    expect(truncate(undefined, 10)).toBe("");
  });
});
