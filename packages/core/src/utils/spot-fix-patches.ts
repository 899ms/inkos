export interface SpotFixPatch {
  readonly targetText: string;
  readonly replacementText: string;
}

export function applySpotFixPatches(
  original: string,
  patches: ReadonlyArray<SpotFixPatch>,
): string {
  if (patches.length === 0) throw new Error("Spot-fix returned no patches.");

  let current = original;
  for (const [index, patch] of patches.entries()) {
    if (!patch.targetText) throw new Error(`Spot-fix patch ${index + 1} has an empty target.`);
    const start = current.indexOf(patch.targetText);
    if (start < 0) throw new Error(`Spot-fix patch ${index + 1} target was not found.`);
    if (current.indexOf(patch.targetText, start + patch.targetText.length) >= 0) {
      throw new Error(`Spot-fix patch ${index + 1} target is not unique.`);
    }
    current = `${current.slice(0, start)}${patch.replacementText}${current.slice(start + patch.targetText.length)}`;
  }
  return current;
}
