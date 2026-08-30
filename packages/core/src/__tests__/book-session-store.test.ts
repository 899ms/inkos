import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindBookSessionToBook,
  createAndPersistBookSession,
  deleteBookSession,
  extractFirstUserMessageTitle,
  listBookSessions,
  loadBookSession,
  renameBookSession,
  SessionAlreadyBoundError,
} from "../interaction/book-session-store.js";
import { appendManualSessionMessages, readTranscriptEvents } from "../interaction/session-transcript.js";

describe("book session transcript flow", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-session-flow-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates, appends, renames, lists, and deletes one append-only session", async () => {
    const created = await createAndPersistBookSession(root, null, "session-flow", "chat");
    await appendManualSessionMessages(root, created.sessionId, [{
      role: "user",
      content: "设计一部长篇",
      timestamp: Date.now(),
    } as never]);
    await renameBookSession(root, created.sessionId, "长篇讨论");

    const loaded = await loadBookSession(root, created.sessionId);
    const listed = await listBookSessions(root, null);
    expect({
      title: loaded?.title,
      messages: loaded?.messages.map((message) => message.content),
      listed: listed.map((session) => session.sessionId),
      eventTypes: (await readTranscriptEvents(root, created.sessionId)).map((event) => event.type),
    }).toEqual({
      title: "长篇讨论",
      messages: ["设计一部长篇"],
      listed: ["session-flow"],
      eventTypes: ["session_created", "request_started", "message", "request_committed", "session_metadata_updated"],
    });

    await deleteBookSession(root, created.sessionId);
    expect(await loadBookSession(root, created.sessionId)).toBeNull();
  });

  it("binds an unbound session to one Work exactly once", async () => {
    await createAndPersistBookSession(root, null, "bind-flow", "chat");
    const bound = await bindBookSessionToBook(root, "bind-flow", "book-a");
    expect(bound).toMatchObject({ bookId: "book-a", profileId: "longform-novel", workId: "book-a" });
    await expect(bindBookSessionToBook(root, "bind-flow", "book-b"))
      .rejects.toBeInstanceOf(SessionAlreadyBoundError);
  });

  it("keeps the complete first user message as title data", () => {
    const title = "这是一条超过二十个字符但不应由宿主截断的完整创作要求";
    expect(extractFirstUserMessageTitle([{ role: "user", content: title }])).toBe(title);
  });
});
