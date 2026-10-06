"use client";
/* eslint-disable @next/next/no-img-element -- private blob URLs are local previews with no image loader */

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import type { StudioSource } from "@/lib/studio/types";
import { isPaper, MAX_RESOURCE_BYTES, sourceSpec } from "@/lib/studio/resources";
import { MAX_PAPER_BYTES } from "@/lib/studio/resources";
import { useT } from "@/app/build-preview/ui";
import { studioApi } from "./client";
import s from "./resources.module.css";

const resourceAccept = ".txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.zip,.docx,.xlsx,.py,.r";

async function sourceUrl(workspaceId: string, sourceId: string, signal?: AbortSignal): Promise<string> {
  const result = await studioApi<{ url: string }>(`/api/studio/workspaces/${workspaceId}/sources/${sourceId}`, { signal });
  return result.url;
}

async function previewBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error("This resource could not be downloaded.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("This resource is too large to preview.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function downloadStudioResource(workspaceId: string, source: StudioSource): Promise<void> {
  const url = await sourceUrl(workspaceId, source.id);
  const bytes = await previewBytes(await fetch(url), isPaper(source) ? MAX_PAPER_BYTES : MAX_RESOURCE_BYTES);
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: source.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = source.name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

export function ResourceControls({ sources, selectedId, disabled, uploading, onSelect, onUpload, onDownload, onToggleBuild }: {
  sources: StudioSource[];
  selectedId: string;
  disabled: boolean;
  uploading: boolean;
  onSelect: (id: string) => void;
  onUpload: (file: File) => Promise<void>;
  onDownload: (source: StudioSource) => void;
  onToggleBuild: (source: StudioSource) => void;
}) {
  const t = useT();
  const selected = sources.find((source) => source.id === selectedId);
  return <div className={s.controls}>
    <select aria-label={t("Study source")} value={selectedId} onChange={(event) => onSelect(event.target.value)}>
      {!sources.length && <option value="">{t("No source yet")}</option>}
      {sources.map((source) => <option key={source.id} value={source.id}>{t(isPaper(source) ? "Paper" : "Resource")} · {source.name}{source.includeInBuild===false?` (${t("excluded from build")})`:''}</option>)}
    </select>
    <label className={s.upload}>{uploading ? t("Uploading…") : t("+ Paper")}<input disabled={disabled} type="file" accept=".pdf,application/pdf" onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void onUpload(file);
    }}/></label>
    <label className={s.upload}>{uploading ? t("Uploading…") : t("+ Resource")}<input disabled={disabled} type="file" multiple accept={resourceAccept} onChange={(event) => {
      const files = [...(event.target.files || [])]; event.target.value = "";
      void (async () => { for (const file of files) await onUpload(file); })();
    }}/></label>
    {selected && <button type="button" disabled={disabled} onClick={() => onDownload(selected)}>{t("Download original")}</button>}
    {selected && <button type="button" disabled={disabled} onClick={() => onToggleBuild(selected)}>{t(selected.includeInBuild===false ? "Include in build" : "Exclude from build")}</button>}
  </div>;
}

export function PrimaryPaperHint({ name }: { name: string }) {
  const t = useT();
  return <small title={t("Build resources are limited to 20 MB combined.")}>{name} · {t("Selected PDF is the primary paper for the next build.")}</small>;
}

export function ResourceViewer({ workspaceId, source, onDownload }: { workspaceId: string; source: StudioSource; onDownload: () => void }) {
  const t = useT();
  const spec = useMemo(() => sourceSpec(source.name), [source.name]);
  const [state, setState] = useState<{ status: string; text?: string; entries?: string[]; image?: string; truncated?: boolean }>({ status: "Loading resource…" });

  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | undefined;
    if (!spec || spec.view === "download") return;
    void (async () => {
      try {
        const url = await sourceUrl(workspaceId, source.id, controller.signal);
        const response = await fetch(url, { signal: controller.signal });
        const previewLimit = spec.view === "text" ? 2 * 1024 * 1024 : MAX_RESOURCE_BYTES;
        const bytes = await previewBytes(response, previewLimit);
        if (controller.signal.aborted) return;
        if (spec.view === "text") {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          setState({ status: "Raw file preview. Content is not interpreted or executed.", text, truncated: bytes.byteLength < source.size });
        } else if (spec.view === "image") {
          imageUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: source.mimeType }));
          setState({ status: "Original image preview.", image: imageUrl });
        } else if (spec.view === "archive") {
          const archive = await JSZip.loadAsync(bytes);
          const names = Object.keys(archive.files).filter((name) => !archive.files[name].dir);
          setState({ status: "ZIP directory only. File contents are supplied to the build worker; no analysis is shown here.", entries: names.slice(0, 200), truncated: names.length > 200 });
        }
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: error instanceof Error ? error.message : "Resource preview unavailable." });
      }
    })();
    return () => { controller.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [source.id, source.mimeType, source.size, workspaceId, spec]);

  return <section className={s.viewer} aria-label={t("Research resource")}>
    <div className={s.header}><div><strong>{source.name}</strong><small>{Math.ceil(source.size / 1024).toLocaleString()} KB · {source.mimeType}</small></div><button type="button" onClick={onDownload}>{t("Download original")}</button></div>
    {spec?.view === "download" ? <p>{t("Inline preview is unavailable for this file type. The original file is retained for download and passed to the study-building worker as a research resource. It is not executed.")}</p> : <p>{t(state.status)}</p>}
    {state.text !== undefined && <pre className={s.text}>{state.text}</pre>}
    {state.image && <img className={s.image} src={state.image} alt={`Uploaded resource ${source.name}`}/>}
    {state.entries && <ul className={s.entries}>{state.entries.map((entry) => <li key={entry}>{entry}</li>)}</ul>}
    {state.truncated && <p>{t("The preview is truncated. Download the original to inspect all content.")}</p>}
  </section>;
}
