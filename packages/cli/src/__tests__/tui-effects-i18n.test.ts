import { describe, expect, it } from "vitest";
import { stripAnsi } from "../tui/ansi.js";
import { buildStyledHelpSections, intentToBadge } from "../tui/effects.js";

describe("tui effects i18n", () => {
  it("builds localized help sections", () => {
    const zhSections = buildStyledHelpSections("zh-CN");
    const enSections = buildStyledHelpSections("en");

    expect(zhSections[0]?.title).toBe("写作");
    expect(zhSections[1]?.commands[0]?.[1]).toContain("列出");
    expect(enSections[0]?.title).toBe("Writing");
  });

  it("localizes intent badges", () => {
    expect(stripAnsi(intentToBadge("write_next", "zh-CN"))).toContain("写作");
  });
});
