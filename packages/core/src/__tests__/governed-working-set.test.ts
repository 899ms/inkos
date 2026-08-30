import { describe, expect, it } from "vitest";
import { buildGovernedHookWorkingSet } from "../utils/governed-working-set.js";

describe("governed-working-set", () => {
  it("projects only the hook ids selected by the semantic context package", () => {
    const hooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| opening-call | 1 | mystery | open | 0 | 8 | 匿名来电开篇出现 |",
      "| nearby-ledger | 4 | evidence | open | 0 | 12 | 近期开启的账本线 |",
      "| future-pr-machine | 22 | conspiracy | open | 0 | 60 | 远期舆情操盘线 |",
      "| future-template | 45 | system | open | 0 | 80 | 远期系统性话术线 |",
    ].join("\n");

    const filtered = buildGovernedHookWorkingSet({
      hooksMarkdown: hooks,
      contextPackage: {
        chapter: 1,
        selectedContext: [
          {
            source: "story/pending_hooks.md#opening-call",
            reason: "Current chapter opening hook.",
            excerpt: "mystery | open | 8 | 匿名来电开篇出现",
          },
        ],
      },
      language: "zh",
    });

    expect(filtered).toContain("opening-call");
    expect(filtered).not.toContain("nearby-ledger");
    expect(filtered).not.toContain("future-pr-machine");
    expect(filtered).not.toContain("future-template");
  });


  it("keeps the complete source when no semantic hook selection exists", () => {
    const hooks = [
      "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| river-oath | 8 | relationship | progressing | 16 | Reveal why the river oath was broken | Long debt should stay visible through the middle game |",
      "| future-pr-machine | 45 | system | open | 0 | Future hook should stay hidden | Future hook should stay hidden |",
    ].join("\n");

    const filtered = buildGovernedHookWorkingSet({
      hooksMarkdown: hooks,
      contextPackage: {
        chapter: 20,
        selectedContext: [],
      },
      language: "en",
    });

    expect(filtered).toContain("river-oath");
    expect(filtered).toContain("future-pr-machine");
  });

});
