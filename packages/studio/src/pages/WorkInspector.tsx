import { useMemo, useState } from "react";
import { ArrowLeft, Clock3, FileText, GitCommitHorizontal, Loader2 } from "lucide-react";
import { fetchJson, useApi } from "../hooks/use-api";
import { tr } from "../lib/app-language";

interface Revision {
  readonly id: string;
  readonly path: string;
  readonly contentType: string;
  readonly status: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

interface Artifact {
  readonly id: string;
  readonly kind: string;
  readonly currentRevisionId: string | null;
  readonly revisions: ReadonlyArray<Revision>;
}

interface WorkDetail {
  readonly work: {
    readonly id: string;
    readonly title: string;
    readonly profileId: string;
    readonly language: string;
    readonly status: string;
    readonly artifacts: ReadonlyArray<Artifact>;
  };
  readonly episodes: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly startedAt: string;
  }>;
}

interface RevisionPayload {
  readonly revision: Revision;
  readonly content?: string;
  readonly dataUrl?: string;
}

export function WorkInspector({ workId, onBack }: { readonly workId: string; readonly onBack: () => void }) {
  const { data, loading, error } = useApi<WorkDetail>(`/works/${encodeURIComponent(workId)}`);
  const [selected, setSelected] = useState<RevisionPayload | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const currentRevisions = useMemo(() => data?.work.artifacts.map((artifact) => ({
    artifact,
    revision: artifact.revisions.find((revision) => revision.id === artifact.currentRevisionId),
  })) ?? [], [data]);

  const openRevision = async (artifact: Artifact, revision: Revision) => {
    setPreviewLoading(true);
    try {
      setSelected(await fetchJson<RevisionPayload>(
        `/works/${encodeURIComponent(workId)}/artifacts/${encodeURIComponent(artifact.id)}/revisions/${encodeURIComponent(revision.id)}`,
      ));
    } finally {
      setPreviewLoading(false);
    }
  };

  if (loading) return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>;
  if (error || !data) return <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-destructive">{error ?? "Work not found"}</div>;

  return (
    <div className="space-y-8">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} /> {tr("返回创作库", "Back to library")}
      </button>
      <header className="rounded-2xl border border-border/55 bg-card/65 p-7 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{data.work.profileId}</div>
        <h1 className="mt-2 font-serif text-4xl">{data.work.title}</h1>
        <div className="mt-4 flex flex-wrap gap-3 text-sm text-muted-foreground">
          <span>{data.work.id}</span><span>·</span><span>{data.work.language}</span><span>·</span><span>{data.work.status}</span>
          <span>·</span><span>{data.work.artifacts.length} {tr("项生成物", "artifacts")}</span>
        </div>
      </header>

      <section>
        <div className="mb-4 flex items-center gap-2"><FileText size={18} className="text-primary" /><h2 className="text-xl font-semibold">{tr("生成物与版本", "Artifacts and revisions")}</h2></div>
        <div className="grid gap-3">
          {currentRevisions.map(({ artifact, revision }) => (
            <button
              key={artifact.id}
              type="button"
              disabled={!revision}
              onClick={() => revision && void openRevision(artifact, revision)}
              className="flex items-center justify-between gap-4 rounded-xl border border-border/55 bg-card px-5 py-4 text-left transition hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50"
            >
              <div className="min-w-0">
                <div className="font-medium">{revision?.path ?? artifact.id}</div>
                <div className="mt-1 text-xs text-muted-foreground">{artifact.kind} · {artifact.revisions.length} revision(s)</div>
              </div>
              <GitCommitHorizontal size={18} className="shrink-0 text-muted-foreground" />
            </button>
          ))}
          {currentRevisions.length === 0 && <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{tr("尚无生成物。", "No artifacts yet.")}</div>}
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-center gap-2"><Clock3 size={18} className="text-primary" /><h2 className="text-xl font-semibold">Episodes</h2></div>
        <div className="space-y-2">
          {data.episodes.map((episode) => (
            <div key={episode.id} className="flex items-center justify-between rounded-xl border border-border/45 bg-secondary/20 px-4 py-3 text-sm">
              <span className="truncate font-mono text-xs">{episode.id}</span>
              <span className="ml-4 shrink-0 font-medium">{episode.status}</span>
            </div>
          ))}
          {data.episodes.length === 0 && <div className="text-sm text-muted-foreground">{tr("尚无执行记录。", "No Episodes yet.")}</div>}
        </div>
      </section>

      {(selected || previewLoading) && (
        <div className="fixed inset-0 z-[90] flex justify-end bg-background/40 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <aside className="h-full w-[min(820px,94vw)] overflow-y-auto border-l border-border bg-background p-7 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            {previewLoading ? <Loader2 className="animate-spin text-primary" /> : selected?.dataUrl ? (
              <img src={selected.dataUrl} alt={selected.revision.path} className="h-auto w-full rounded-xl" />
            ) : (
              <>
                <div className="mb-5 break-all text-sm font-medium text-muted-foreground">{selected?.revision.path}</div>
                <pre className="whitespace-pre-wrap break-words font-sans text-base leading-8">{selected?.content}</pre>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
