import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkManifest, saveWorkManifest } from "@actalk/inkos-core";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(testDir, "..", "..", "dist", "index.js");

describe("CLI mini-flows", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "inkos-cli-flow-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("initializes a project and round-trips structured configuration", async () => {
    run(["init"]);
    run(["config", "set", "llm.provider", "anthropic"]);
    run(["config", "set", "foundation.reviewRetries", "3"]);
    const shown = JSON.parse(run(["config", "show"]));

    expect({
      provider: shown.llm.provider,
      foundationReviewRetries: shown.foundation.reviewRetries,
      worksDirectory: (await stat(join(projectDir, "works"))).isDirectory(),
      nodeVersion: (await readFile(join(projectDir, ".node-version"), "utf-8")).trim(),
    }).toEqual({
      provider: "anthropic",
      foundationReviewRetries: 3,
      worksDirectory: true,
      nodeVersion: "22",
    });
  });

  it("lists and inspects canonical Works through one surface", async () => {
    run(["init"]);
    await saveWorkManifest(projectDir, createWorkManifest({
      id: "cli-script",
      title: "CLI Script",
      profileId: "script",
      language: "en",
    }));

    const listed = JSON.parse(run(["work", "list", "--json"])) as {
      works: Array<{ id: string; profileId: string }>;
    };
    const shown = JSON.parse(run(["work", "show", "cli-script", "--json"])) as {
      work: { id: string; profileId: string };
      episodes: unknown[];
    };

    expect({
      listed: listed.works.map((work) => [work.id, work.profileId]),
      shown: [shown.work.id, shown.work.profileId],
      episodeCount: shown.episodes.length,
    }).toEqual({
      listed: [["cli-script", "script"]],
      shown: ["cli-script", "script"],
      episodeCount: 0,
    });
  });

  it("routes natural language through Pi and preserves an explicit Work binding", async () => {
    run(["init"]);
    await saveWorkManifest(projectDir, createWorkManifest({
      id: "harbor",
      title: "Harbor",
      profileId: "longform-novel",
      language: "en",
    }));
    const unbound = JSON.parse(run(["interact", "--json", "--message", "Discuss the premise first"]));
    const bound = JSON.parse(run([
      "interact",
      "--json",
      "--book",
      "harbor",
      "--message",
      "Review the current direction",
    ]));

    expect({
      unboundKind: unbound.session.sessionKind,
      unboundRequest: unbound.request,
      boundBook: bound.session.bookId ?? bound.session.activeBookId,
      boundKind: bound.session.sessionKind,
    }).toEqual({
      unboundKind: "chat",
      unboundRequest: undefined,
      boundBook: "harbor",
      boundKind: "book",
    });
  });

  function run(args: string[]): string {
    return execFileSync("node", [cliEntry, ...args], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("INKOS_"))),
        HOME: projectDir,
        INKOS_AGENT_LLM_STUB: "1",
      },
    });
  }
});
