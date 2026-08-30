import { describe, expect, it } from "vitest";
import { buildGenreTemplate } from "../commands/genre.js";

describe("genre metadata scaffold", () => {
  it("creates language-specific metadata without embedding craft rules", () => {
    const input = { id: "scifi", name: "Sci-Fi", numerical: true, power: false, era: true } as const;
    const zh = buildGenreTemplate(input, "zh");
    const en = buildGenreTemplate(input, "en");
    expect({
      zhHeader: zh.split("---")[1]?.trim(),
      enHeader: en.split("---")[1]?.trim(),
      zhBody: zh.split("---").slice(2).join("---").trim(),
      enBody: en.split("---").slice(2).join("---").trim(),
    }).toEqual({
      zhHeader: "name: Sci-Fi\nid: scifi\nlanguage: zh",
      enHeader: "name: Sci-Fi\nid: scifi\nlanguage: en",
      zhBody: "",
      enBody: "",
    });
  });
});
