import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskQueue } from "../task-queue.js";

// Mock fs so TaskQueue doesn't touch the real filesystem
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
}));

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  it("starts empty", () => {
    expect(queue.getAll()).toEqual([]);
    expect(queue.length).toBe(0);
  });

  it("pushes and retrieves tasks", () => {
    const task = queue.push("Fix the build", "/project", 10);
    expect(task.id).toMatch(/^q\d+$/);
    expect(task.task).toBe("Fix the build");
    expect(task.project).toBe("/project");
    expect(task.priority).toBe(10);
    expect(queue.length).toBe(1);
    expect(queue.getAll()).toHaveLength(1);
  });

  it("sorts by priority then creation time", () => {
    queue.push("Low priority", undefined, 20);
    queue.push("High priority", undefined, 5);
    queue.push("Medium priority", undefined, 10);

    const tasks = queue.getAll();
    expect(tasks[0].task).toBe("High priority");
    expect(tasks[1].task).toBe("Medium priority");
    expect(tasks[2].task).toBe("Low priority");
  });

  it("removes tasks by ID", () => {
    const task = queue.push("To be removed");
    expect(queue.remove(task.id)).toBe(true);
    expect(queue.length).toBe(0);
  });

  it("returns false when removing nonexistent task", () => {
    expect(queue.remove("q999")).toBe(false);
  });

  it("tracks completed task IDs", () => {
    expect(queue.isCompleted("q1")).toBe(false);
    queue.markCompleted("q1");
    expect(queue.isCompleted("q1")).toBe(true);
  });

  it("supports blockedBy field", () => {
    const t1 = queue.push("Step 1");
    const t2 = queue.push("Step 2", undefined, 10, t1.id);
    expect(t2.blockedBy).toBe(t1.id);
  });
});
