import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCharacterContext } from "../utils/outline-paths.js";
import { readBookRules as readStructuredBookRules } from "./rules-reader.js";

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Phase 5: prefer roles/ directory; fall back to legacy character_matrix.md.
 * storyDir is <bookDir>/story, so the caller indirectly points us at bookDir
 * via dirname().
 */
export async function readCharacterMatrix(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  return readCharacterContext(bookDir, "");
}

export async function readSubplotBoard(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "subplot_board.md"));
}

export async function readEmotionalArcs(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "emotional_arcs.md"));
}

export async function readBrief(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "brief.md"));
}

/**
 * Render the structured book rules (protagonist / prohibitions / genreLock /
 * behavioral constraints) as a compact markdown block for the planner prompt.
 *
 * Phase 5 cleanup #3: reads the YAML frontmatter via readStructuredBookRules
 * (which prefers story_frame.md and falls back to legacy book_rules.md).
 * Returns "" when no structured rules are defined — the planner template
 * provides its own placeholder for that case.
 */
export async function readBookRules(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  const parsed = await readStructuredBookRules(bookDir);
  return parsed?.body.trim() ?? "";
}
