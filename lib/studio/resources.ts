import type { StudioSource } from "./types";

export type ResourceView = "pdf" | "text" | "image" | "archive" | "download";
export type ResourceSpec = { extension: string; mimeType: string; kind: "paper" | "resource"; view: ResourceView };

const formats: Record<string, Omit<ResourceSpec, "extension">> = {
  pdf: { mimeType: "application/pdf", kind: "paper", view: "pdf" },
  txt: { mimeType: "text/plain", kind: "resource", view: "text" },
  md: { mimeType: "text/markdown", kind: "resource", view: "text" },
  csv: { mimeType: "text/csv", kind: "resource", view: "text" },
  json: { mimeType: "application/json", kind: "resource", view: "text" },
  py: { mimeType: "text/x-python", kind: "resource", view: "text" },
  r: { mimeType: "text/x-r", kind: "resource", view: "text" },
  docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "resource", view: "download" },
  xlsx: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "resource", view: "download" },
  png: { mimeType: "image/png", kind: "resource", view: "image" },
  jpg: { mimeType: "image/jpeg", kind: "resource", view: "image" },
  jpeg: { mimeType: "image/jpeg", kind: "resource", view: "image" },
  webp: { mimeType: "image/webp", kind: "resource", view: "image" },
  zip: { mimeType: "application/zip", kind: "resource", view: "archive" },
};

export const MAX_PAPER_BYTES = 25 * 1024 * 1024;
export const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_PIPELINE_RESOURCE_BYTES = 20 * 1024 * 1024;

export function sourceSpec(name: string): ResourceSpec | null {
  if (name.length < 1 || name.length > 200 || name.trim() !== name || /[\\/\x00-\x1f\x7f]/.test(name)) return null;
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const format = extension && formats[extension];
  return format && extension ? { extension, ...format } : null;
}

export function sourceStoragePath(ownerId: string, workspaceId: string, sourceId: string, extension: string): string {
  return `${ownerId}/${workspaceId}/${sourceId}.${extension}`;
}

export function validStoredSource(source: StudioSource, ownerId: string, workspaceId: string): boolean {
  const spec = sourceSpec(source.name);
  if (!spec || source.mimeType !== spec.mimeType || source.kind && source.kind !== spec.kind) return false;
  const maximum = spec.kind === "paper" ? MAX_PAPER_BYTES : MAX_RESOURCE_BYTES;
  return source.path === sourceStoragePath(ownerId, workspaceId, source.id, spec.extension) &&
    Number.isInteger(source.size) && source.size >= 1 && source.size <= maximum;
}

export function isPaper(source: StudioSource): boolean {
  return source.mimeType === "application/pdf" && sourceSpec(source.name)?.kind === "paper" && source.kind !== "resource";
}
