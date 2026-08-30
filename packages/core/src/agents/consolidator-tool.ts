import { Type } from "@sinclair/typebox";

export const VolumeSummariesToolSchema = Type.Object({
  volumeSummaries: Type.String({
    description: "Readable Markdown summaries organized by the volumes supported by the supplied outline and chapter summaries.",
  }),
});
