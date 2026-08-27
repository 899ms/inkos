import { describe, expect, it } from "vitest";
import type { Message, ToolExecution } from "../../types";
import { createSessionRuntime, deriveResolvedProposals, deserializeMessages, extractErrorMessage, extractToolError, hasInFlightExecution, markRunningToolsFailed, mergeTaskExecution, updateToolPartById, withToolExecutions } from "./runtime";

function exec(overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution {
  const { id, tool, ...rest } = overrides;
  return {
    id,
    tool,
    label: tool,
    status: "completed",
    startedAt: 1,
    ...rest,
  };
}

describe("chat runtime error copy", () => {
  it("localizes known assistant errors", () => {
    expect(extractErrorMessage({
      message: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    })).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes known tool errors", () => {
    expect(extractToolError({
      content: [
        {
          type: "text",
          text: "Latest chapter 2 is state-degraded. Repair state or rewrite that chapter before continuing.",
        },
      ],
    })).toBe("最新第 2 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });
});

describe("createSessionRuntime", () => {
  it("carries playMode on the session runtime", () => {
    const rt = createSessionRuntime({ sessionId: "s1", bookId: null, sessionKind: "play", playMode: "guided", title: null });
    expect(rt.playMode).toBe("guided");
  });

  it("carries the creation-entry proposal action", () => {
    const rt = createSessionRuntime({
      sessionId: "s2",
      bookId: null,
      sessionKind: "chat",
      proposalAction: "style_imitation",
      title: null,
    });
    expect(rt.proposalAction).toBe("style_imitation");
  });
});

describe("deriveResolvedProposals", () => {
  it("marks a proposed play start as confirmed when play_start completed later", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动旧影院",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "play-1",
            tool: "play_start",
            details: { kind: "play_world_started" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed interactive-film creation as confirmed when the tool completed later", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "interactive_film_create",
              targetSessionKind: "interactive-film",
              instruction: "制作鸦冠之宴",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "interactive-1",
            tool: "interactive_film_create",
            details: { kind: "interactive_film_created" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed book creation as confirmed only by an architect sub-agent", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本债务悬疑",
            },
          }),
          exec({ id: "writer-1", tool: "sub_agent", agent: "writer" }),
          exec({ id: "architect-1", tool: "sub_agent", agent: "architect" }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("confirms only one matching proposal per completed production action", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "old-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动旧广播站",
            },
          }),
          exec({
            id: "new-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动水文站",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "play-1",
            tool: "play_start",
            details: { kind: "play_world_started" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "new-proposal": "confirmed" });
  });
});

describe("deserializeMessages", () => {
  it("restores capability tool names as their user-facing action ids", () => {
    const messages = deserializeMessages([{
      role: "assistant",
      content: "",
      timestamp: 1,
      toolExecutions: [exec({
        id: "architect-1",
        tool: "longform__sub_agent",
        agent: "architect",
      })],
    } as any]);

    expect(messages[0]?.toolExecutions?.[0]).toMatchObject({
      tool: "sub_agent",
      label: "建书",
    });
  });

  it("restores tool executions from legacyDisplay for tool-only assistant messages", () => {
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        legacyDisplay: {
          toolExecutions: [
            exec({
              id: "interactive-1",
              tool: "interactive_film_create",
              details: { kind: "interactive_film_created", baseDir: "interactive-films/crow-crown-banquet" },
            }),
          ],
        },
      } as any,
    ]);

    expect(messages[0]?.toolExecutions?.[0]?.tool).toBe("interactive_film_create");
    expect(messages[0]?.parts?.[0]?.type).toBe("tool");
  });
});

describe("withToolExecutions", () => {
  it("adds returned tool executions before final text content", () => {
    const message = withToolExecutions({
      role: "assistant",
      content: "完成。",
      timestamp: 1,
    }, [
      exec({
        id: "script-1",
        tool: "script_create",
        details: { kind: "script_created" },
      }),
    ]);

    expect(message.toolExecutions?.map((execution) => execution.tool)).toEqual(["script_create"]);
    expect(message.parts?.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(message.content).toBe("完成。");
  });
});

describe("mergeTaskExecution", () => {
  it("adds a persisted running task as a background-tagged restorable tool card", () => {
    const execution = exec({
      id: "short-task-1",
      tool: "short_fiction_run",
      status: "running",
      logs: ["正在生成大纲"],
      startedAt: 10,
    });

    const messages = mergeTaskExecution([], execution);

    // 任务快照必然来自后台生产任务：恢复出的卡带 background 标记，
    // 供无 id 事件的回退路由跳过它。
    const tagged = { ...execution, background: true };
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        timestamp: 10,
        toolExecutions: [tagged],
        parts: [{ type: "tool", execution: tagged }],
      }),
    ]);
  });

  it("updates the existing task card instead of duplicating it", () => {
    const running = exec({ id: "task-1", tool: "script_create", status: "running", startedAt: 10 });
    const completed = exec({
      id: "task-1",
      tool: "script_create",
      status: "completed",
      result: "完成",
      startedAt: 10,
      completedAt: 20,
    });

    const messages = mergeTaskExecution(mergeTaskExecution([], running), completed);

    // 终态快照替换整个 execution 时不能丢 background 标记
    const tagged = { ...completed, background: true };
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolExecutions).toEqual([tagged]);
    expect(messages[0]?.parts).toEqual([{ type: "tool", execution: tagged }]);
  });
});

describe("mergeToolExecution identity", () => {
  it("keeps one visible card when the same execution id raced into two messages", () => {
    const duplicate = exec({ id: "task-1", tool: "longform__sub_agent", agent: "architect" });
    const messages: Message[] = [
      { role: "assistant", content: "", timestamp: 1, toolExecutions: [duplicate], parts: [{ type: "tool", execution: duplicate }] },
      { role: "assistant", content: "done", timestamp: 2, toolExecutions: [duplicate], parts: [{ type: "tool", execution: duplicate }, { type: "text", content: "done" }] },
    ];

    const merged = mergeTaskExecution(messages, { ...duplicate, status: "completed" });
    const visible = merged.flatMap((message) => message.toolExecutions ?? [])
      .filter((execution) => execution.id === "task-1");

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ tool: "sub_agent", label: "建书" });
  });

  it("deduplicates an execution while applying its terminal SSE update", () => {
    const duplicate = exec({ id: "task-2", tool: "sub_agent", agent: "writer", status: "running" });
    const messages: Message[] = [
      { role: "assistant", content: "", timestamp: 1, parts: [{ type: "tool", execution: duplicate }] },
      { role: "assistant", content: "done", timestamp: 2, parts: [{ type: "tool", execution: duplicate }, { type: "text", content: "done" }] },
    ];

    const updated = updateToolPartById(messages, "task-2", (execution) => ({
      ...execution,
      status: "completed",
    }));
    const visible = (updated ?? []).flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "tool" && part.execution.id === "task-2");

    expect(visible).toHaveLength(1);
  });
});

describe("hasInFlightExecution", () => {
  it("finds an execution that is still running in the session messages", () => {
    const running = exec({ id: "task-1", tool: "short_fiction_run", status: "running", startedAt: 10 });
    const messages = mergeTaskExecution([], running);

    expect(hasInFlightExecution(messages, "task-1")).toBe(true);
  });

  it("does not treat a completed execution or an unknown id as in flight", () => {
    const completed = exec({
      id: "task-1",
      tool: "short_fiction_run",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
    });
    const messages = mergeTaskExecution([], completed);

    expect(hasInFlightExecution(messages, "task-1")).toBe(false);
    expect(hasInFlightExecution(messages, "task-2")).toBe(false);
  });
});

describe("markRunningToolsFailed", () => {
  it("ends active tool cards immediately when the user stops a task", () => {
    const running = exec({ id: "task-1", tool: "short_fiction_run", status: "running", startedAt: 10 });
    const message: Message = {
      role: "assistant",
      content: "",
      timestamp: 10,
      toolExecutions: [running],
      parts: [{ type: "tool", execution: running }],
    };

    const messages = markRunningToolsFailed([message], "已由用户停止", 20);

    expect(messages[0]?.toolExecutions?.[0]).toMatchObject({
      status: "error",
      error: "已由用户停止",
      completedAt: 20,
    });
    expect(messages[0]?.parts?.[0]).toMatchObject({
      type: "tool",
      execution: {
        status: "error",
        error: "已由用户停止",
        completedAt: 20,
      },
    });
  });
});
