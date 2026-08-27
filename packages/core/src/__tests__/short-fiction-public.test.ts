import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMClient } from "../llm/provider.js";
import {
  ShortFictionOutlineAgent,
  ShortFictionOutlineReviserAgent,
  ShortFictionDraftReviserAgent,
  buildShortFictionChapterBatches,
  minimumShortFictionChapterLength,
  parseShortFictionBatchDraft,
  validateShortFictionDraftForFinal,
} from "../agents/short-fiction.js";
import { saveSecrets } from "../llm/secrets.js";
import { loadWorkManifest } from "../harness/work-store.js";
import {
  extractGeminiImageBase64,
  extractImagesGenerationImage,
  generateShortFictionCover,
  resolveCoverGenerationRequest,
} from "../pipeline/short-fiction-runner.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function fakeClient(): LLMClient {
  return {
    provider: "openai",
    apiFormat: "chat",
    stream: false,
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
      thinkingBudget: 0,
      extra: {},
    },
  };
}

describe("public short-fiction chain", () => {
  it("gives outline generation enough output budget for models with a separate reasoning channel", async () => {
    const validOutline = `=== SHORT_FICTION_PLAN_TITLE ===\n电梯多一层\n=== SHORT_FICTION_PLAN ===\n## 12章完整方案`;
    const createChat = vi
      .spyOn(ShortFictionOutlineAgent.prototype as never, "chat" as never)
      .mockResolvedValue({ content: validOutline, usage: ZERO_USAGE });
    const reviseChat = vi
      .spyOn(ShortFictionOutlineReviserAgent.prototype as never, "chat" as never)
      .mockResolvedValue({ content: validOutline, usage: ZERO_USAGE });
    const context = { client: fakeClient(), model: "fake", projectRoot: "/tmp" };

    const first = await new ShortFictionOutlineAgent(context).createOutline({
      direction: "现实悬疑", chapterCount: 12, charsPerChapter: 1000,
    });
    await new ShortFictionOutlineReviserAgent(context).reviseOutline({
      direction: "现实悬疑", outline: first, review: "加强反扑", chapterCount: 12, charsPerChapter: 1000,
    });

    expect(createChat.mock.calls[0]?.[1]).toMatchObject({ maxTokens: 16_384 });
    expect(reviseChat.mock.calls[0]?.[1]).toMatchObject({ maxTokens: 16_384 });
  });

  it("parses a complete tagged short-fiction draft", () => {
    const draft = parseShortFictionBatchDraft(`
=== SHORT_FICTION_TITLE ===
我离婚后，全家悔疯了
=== SHORT_FICTION_OPENING_HOOK ===
离婚协议递到我面前时，婆婆正在直播间教人做贤妻。
=== CHAPTER 1 TITLE ===
她把离婚协议递到直播镜头前
=== CHAPTER 1 CONTENT ===
我看着镜头里的红灯亮起，先把桌上的房本推了过去。婆婆脸上的笑僵住，丈夫伸手来抢，我按住合同，问他还记不记得这套房是谁付的首付。
=== CHAPTER 2 TITLE ===
三年前那张转账单
=== CHAPTER 2 CONTENT ===
第二天早上，家庭群里全是骂我的语音。我没有回，只把三年前的转账单发给律师。十分钟后，丈夫第一次打电话求我回家谈谈。
`, { expectedChapters: 2 });

    expect(draft.storyTitle).toBe("我离婚后，全家悔疯了");
    expect(draft.openingHook).toContain("离婚协议");
    expect(draft.chapters).toHaveLength(2);
    expect(draft.chapters[0]?.title).toContain("离婚协议");
    expect(draft.chapters[1]?.charCount).toBeGreaterThan(20);
    expect(() => validateShortFictionDraftForFinal(draft, { expectedChapters: 2 })).not.toThrow();
  });

  it("splits a large short into bounded batches using the active model output limit", () => {
    expect(buildShortFictionChapterBatches(
      Array.from({ length: 18 }, (_, index) => index + 1),
      1200,
      8192,
    )).toEqual([
      [1], [2], [3], [4], [5], [6], [7], [8], [9], [10], [11], [12], [13], [14], [15], [16], [17], [18],
    ]);
  });

  it("caps each writer call even when the model advertises a very large output window", () => {
    expect(buildShortFictionChapterBatches(
      Array.from({ length: 12 }, (_, index) => index + 1),
      1000,
      65_536,
    )).toEqual([
      [1], [2], [3], [4], [5], [6], [7], [8], [9], [10], [11], [12],
    ]);
  });

  it("rejects non-empty but near-empty chapters before final promotion", () => {
    const draft = parseShortFictionBatchDraft(`
=== SHORT_FICTION_TITLE ===
近空稿
=== CHAPTER 1 TITLE ===
只有标题
=== CHAPTER 1 CONTENT ===
只有两句话。仍然不够。
`, { expectedChapters: 1 });

    expect(minimumShortFictionChapterLength(1200)).toBe(240);
    expect(() => validateShortFictionDraftForFinal(draft, {
      expectedChapters: 1,
      minimumChapterLength: minimumShortFictionChapterLength(1200),
    })).toThrow(/chapters below the minimum usable length: 1/);
  });

  it("recovers chapter content when a model repeats the title tag instead of the content tag", () => {
    const draft = parseShortFictionBatchDraft(`
=== SHORT_FICTION_TITLE ===
离婚协议签好那天，我甩出十三页证据清单
=== CHAPTER 1 TITLE ===
藏在婚纱照后面的摄像头
=== CHAPTER 1 CONTENT ===
我摘下婚纱照，看到墙后那个针孔摄像头还亮着红点。
=== CHAPTER 2 TITLE ===
她逼小三亲自递上了最后的刀
=== CHAPTER 2 TITLE ===
陈磊的慌张，是一个信号。
林晚等了三天，没有去找陈磊，也没有再发短信。
第三天傍晚，贺言打来电话：“上钩了，苏念又给陈磊妻子转了五十万。”
=== CHAPTER 3 TITLE ===
他砸了家，但没算到我在直播
=== CHAPTER 3 TITLE ===
凌晨三点，陆景琛踹开老宅院门，举着铁棍砸碎电视。
林晚坐在闺蜜家，把早就准备好的直播链接发给了董事会。
`, { expectedChapters: 3 });

    expect(draft.chapters[1]?.title).toBe("她逼小三亲自递上了最后的刀");
    expect(draft.chapters[1]?.content).toContain("陈磊的慌张");
    expect(draft.chapters[1]?.content).not.toContain("陆景琛踹开老宅院门");
    expect(draft.chapters[2]?.content).toContain("直播链接");
    expect(() => validateShortFictionDraftForFinal(draft, { expectedChapters: 3 })).not.toThrow();
  });

  it("uses the previous draft as assistant context for the second writer pass", async () => {
    const firstDraft = parseShortFictionBatchDraft(`
=== SHORT_FICTION_TITLE ===
初稿标题
=== CHAPTER 1 TITLE ===
旧章
=== CHAPTER 1 CONTENT ===
旧正文有一处时间线问题。
`, { expectedChapters: 1 });

    const chatSpy = vi
      .spyOn(ShortFictionDraftReviserAgent.prototype as never, "chat" as never)
      .mockResolvedValue({
        content: `
=== SHORT_FICTION_TITLE ===
新稿标题
=== CHAPTER 1 TITLE ===
新章
=== CHAPTER 1 CONTENT ===
${"新正文修正时间线，并保留人物行动、证据和现场反应。".repeat(45)}
`,
        usage: ZERO_USAGE,
      });

    const agent = new ShortFictionDraftReviserAgent({
      client: fakeClient(),
      model: "fake",
      projectRoot: "/tmp",
    });

    const revised = await agent.reviseDraft({
      direction: "女频短篇 婚姻反杀",
      outlineMarkdown: "12章完整故事方案",
      draft: firstDraft,
      review: "时间线不成立，第二天不能先收到律师函再补证据。",
      chapterCount: 1,
      charsPerChapter: 1000,
    });

    const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[2]?.content).toContain("旧正文有一处时间线问题");
    expect(messages[3]?.content).toContain("时间线不成立");
    expect(revised.storyTitle).toBe("新稿标题");

    chatSpy.mockRestore();
  });

  it("adopts valid chapter revisions without letting one bad chapter revert the whole draft", async () => {
    const originalOne = "第一章原稿保留完整场面和证据。".repeat(70);
    const originalTwo = "第二章原稿保留人物行动和因果。".repeat(70);
    const acceptedOne = "第一章新版修正时间线并压缩重复反应。".repeat(55);
    const firstDraft = parseShortFictionBatchDraft(`
=== SHORT_FICTION_TITLE ===
初稿标题
=== CHAPTER 1 TITLE ===
旧一章
=== CHAPTER 1 CONTENT ===
${originalOne}
=== CHAPTER 2 TITLE ===
旧二章
=== CHAPTER 2 CONTENT ===
${originalTwo}
`, { expectedChapters: 2 });
    const chatSpy = vi.spyOn(ShortFictionDraftReviserAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: `=== SHORT_FICTION_TITLE ===\n新稿标题\n=== CHAPTER 1 TITLE ===\n新一章\n=== CHAPTER 1 CONTENT ===\n${acceptedOne}`,
        usage: ZERO_USAGE,
      })
      .mockResolvedValue({
        content: "=== CHAPTER 2 TITLE ===\n过短二章\n=== CHAPTER 2 CONTENT ===\n仍然太短。",
        usage: ZERO_USAGE,
      });
    const agent = new ShortFictionDraftReviserAgent({ client: fakeClient(), model: "fake", projectRoot: "/tmp" });

    const revised = await agent.reviseDraft({
      direction: "现实悬疑",
      outlineMarkdown: "两章完整方案",
      draft: firstDraft,
      review: "修正时间线并压缩重复反应。",
      chapterCount: 2,
      charsPerChapter: 1000,
    });

    expect(revised.chapters[0]?.content).toBe(acceptedOne);
    expect(revised.chapters[1]?.content).toBe(originalTwo);
    expect(revised.storyTitle).toBe("新稿标题");
    expect(chatSpy).toHaveBeenCalledTimes(3);
  });

  it("resolves cover generation from project cover config and stored cover secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-short-cover-"));
    try {
      await writeFile(join(root, "inkos.json"), JSON.stringify({
        name: "cover-test",
        version: "0.1.0",
        language: "zh",
        llm: {
          provider: "openai",
          service: "kkaiapi",
          configSource: "studio",
          baseUrl: "https://api.kkaiapi.com/v1",
          apiKey: "",
          model: "deepseek-v4-flash",
          cover: {
            service: "kkaiapi",
            model: "gpt-image-2",
          },
        },
        notify: [],
      }, null, 2), "utf-8");
      await saveSecrets(root, {
        services: {
          "cover:kkaiapi": { apiKey: "sk-cover" },
        },
      });

      await expect(resolveCoverGenerationRequest({ root })).resolves.toMatchObject({
        api: "images",
        baseUrl: "https://api.kkaiapi.com/v1",
        model: "gpt-image-2",
        apiKey: "sk-cover",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a custom cover base URL stored in the project cover config", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-short-cover-custom-"));
    try {
      await writeFile(join(root, "inkos.json"), JSON.stringify({
        name: "cover-test",
        version: "0.1.0",
        language: "zh",
        llm: {
          provider: "openai",
          service: "kkaiapi",
          configSource: "studio",
          baseUrl: "https://api.kkaiapi.com/v1",
          apiKey: "",
          model: "deepseek-v4-flash",
          cover: {
            service: "kkaiapi",
            model: "gpt-image-2",
            baseUrl: "https://images.example.com/v1",
          },
        },
        notify: [],
      }, null, 2), "utf-8");
      await saveSecrets(root, {
        services: {
          "cover:kkaiapi": { apiKey: "sk-cover" },
        },
      });

      await expect(resolveCoverGenerationRequest({ root })).resolves.toMatchObject({
        api: "images",
        baseUrl: "https://images.example.com/v1",
        model: "gpt-image-2",
        apiKey: "sk-cover",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts OpenAI-compatible image generation URLs and base64 payloads", () => {
    expect(extractImagesGenerationImage({
      data: [{ url: "https://api.kkaiapi.com/files/img_abc123.png" }],
    })).toEqual({ url: "https://api.kkaiapi.com/files/img_abc123.png" });

    expect(extractImagesGenerationImage({
      data: [{ b64_json: "ZmFrZQ==" }],
    })).toEqual({ base64: "ZmFrZQ==", extension: "png" });
  });

  it("extracts Gemini inline image data from generateContent responses", () => {
    const image = extractGeminiImageBase64({
      candidates: [
        {
          content: {
            parts: [
              { text: "ok" },
              { inlineData: { mimeType: "image/jpeg", data: "ZmFrZQ==" } },
            ],
          },
        },
      ],
    });

    expect(image).toEqual({ base64: "ZmFrZQ==", extension: "jpg" });
  });

  it("generates a standalone cover artifact without running the short fiction pipeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-cover-tool-"));
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    process.env.INKOS_TEST_COVER_KEY = "sk-cover";
    try {
      const fetchMock = vi.fn(async (_url: unknown, _init?: { readonly body?: unknown }) => new Response(JSON.stringify({
        data: [{ b64_json: "ZmFrZQ==" }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = fetchMock as never;

      const result = await generateShortFictionCover({
        projectRoot: root,
        title: "离婚协议他递了三年",
        intro: "她签字当天多了十八份附件。",
        sellingPoints: ["婚姻背叛", "证据反杀"],
        coverPrompt: "女主冷笑，手里举着离婚协议。",
        outputDir: "covers/demo",
        coverEndpoint: "https://images.example.test/v1/images/generations",
        coverModel: "gpt-image-2",
        coverApiKeyEnv: "INKOS_TEST_COVER_KEY",
        signal: controller.signal,
      });

      expect(result.workId).toBe("demo");
      expect(result.coverPromptPath).toBe("works/demo/source/cover-prompt.md");
      expect(result.coverImagePath).toBe("works/demo/source/cover.png");
      await expect(readFile(join(root, "works", "demo", "source", "cover-prompt.md"), "utf-8"))
        .resolves.toContain("离婚协议他递了三年");
      await expect(readFile(join(root, "works", "demo", "source", "cover.png")))
        .resolves.toEqual(Buffer.from("fake"));
      await expect(loadWorkManifest(root, "demo")).resolves.toMatchObject({
        profileId: "visual-asset",
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: "image" }),
        ]),
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://images.example.test/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("离婚协议他递了三年"),
          signal: controller.signal,
        }),
      );
      const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
      expect(body).toContain("按用户给出的标题、简介、卖点和视觉要求生成封面图。");
      expect(body).not.toContain("不添加文字");
      expect(body).not.toContain("水印");
      expect(body).not.toContain("固定模板");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.INKOS_TEST_COVER_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});
