import { createHash } from "node:crypto";
import { normaliseDoi, type ZipFile } from "./community";
import {
  CONTRIBUTION_PROGRAM, CONTRIBUTION_PROTOCOL, CONTRIBUTION_SOURCES, CONTRIBUTION_STUDY,
} from "./community-archive";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const revision = /^[a-f0-9]{64}$/;
type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;

function hostedLicense(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "").trim().toLowerCase()
    .replace(/[\s_\u2010-\u2015-]+/g, "-").replace(/-(?:international|universal|generic|unported)$/, "")
    .replace(/^ccby/, "cc-by");
  return /^(?:cc-by(?:-(?:1\.0|2\.0|2\.5|3\.0|4\.0|[1-4]))?|cc0(?:-1\.0)?|public-domain|pdm(?:-1\.0)?)$/.test(normalized)
    ? normalized : null;
}

function parse(bytes?: Buffer) {
  if (!bytes) return null;
  try { return record(JSON.parse(bytes.toString("utf8"))); }
  catch { return null; }
}

const text = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() : "";
const doi = (value: unknown) => typeof value === "string" ? normaliseDoi(value) : "";
const authors = (value: unknown) => Array.isArray(value) ? value.map(text) : [];
const authorText = (value: unknown) => text(value).replace(/\s+(?:and|&)\s+|[;,·]\s*/g, ", ");

function matchesPaper(value: unknown, study: RecordValue): boolean {
  const input = record(value);
  const expected = authors(study.authors);
  return Boolean(input && text(study.title) && text(input.title) === text(study.title) &&
    Number.isInteger(study.year) && Number(input.year) === study.year &&
    expected.length && expected.every(Boolean) && text(input.firstAuthor) === expected[0] &&
    JSON.stringify(authors(input.authors)) === JSON.stringify(expected) && doi(input.doi) === doi(study.doi));
}

/** Checks the exact paired archive before public submission. Bench retains scientific and release review. */
export function checkPairedContribution(files: ZipFile[], exportedPaper: unknown, requestedPaper: unknown): { version: string; title: string; authors: string[]; year: number } | { error: string } {
  const payload = new Map(files.map(file => [file.name, file.data]));
  const protocolBytes = payload.get(CONTRIBUTION_PROTOCOL);
  const protocol = parse(protocolBytes);
  const program = parse(payload.get(CONTRIBUTION_PROGRAM));
  const study = parse(payload.get(CONTRIBUTION_STUDY));
  const sourceManifest = parse(payload.get(CONTRIBUTION_SOURCES));
  if (!protocolBytes || !protocol || !program || !study || sourceManifest?.schemaVersion !== 1 || !Array.isArray(sourceManifest.files)) {
    return { error: "The paired ZIP needs valid program.json, protocol.json, study.json and sources/SOURCE.json." };
  }
  const projection = record(protocol.distribution);
  const held = record(projection?.held);
  if (protocol.schema_version !== "1" || projection?.format !== "hsenv-projection/1" || projection.strict !== true ||
      projection.placeholder !== "░" || !held || Object.keys(held).length > 0 ||
      Object.keys(projection).some(key => !["format", "hsenv", "placeholder", "held", "strict", "attribution"].includes(key)) ||
      Object.entries(protocol).some(([key, value]) => key !== "distribution" && JSON.stringify(value).includes("░")) || protocol.release_hold ||
      !Array.isArray(protocol.arms) || protocol.arms.some(arm => !record(arm) || arm.release_hold)) {
    return { error: "Export a strict public protocol projection with open sources and no held or restored participant text." };
  }
  const protocolId = protocol.id;
  const binding = record(study.protocol);
  const scholarly = record(record(program.extensions)?.scholarly);
  const programBinding = record(scholarly?.protocol);
  if (typeof protocolId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(protocolId) ||
      study.id !== protocolId || study.schema_version !== "1" || (study.slug !== undefined && study.slug !== protocolId) ||
      study.quality !== "draft" || "fidelity" in study || "visibility" in study || study.release_hold ||
      (study.quality_evidence !== undefined && (!Array.isArray(study.quality_evidence) || study.quality_evidence.length > 0)) ||
      typeof study.version !== "string" || !study.version.trim() || study.version.length > 100 ||
      binding?.path !== CONTRIBUTION_PROTOCOL || binding.schema_version !== "1" ||
      typeof binding.sha256 !== "string" || !revision.test(binding.sha256) ||
      program.schemaVersion !== 2 || scholarly?.profile !== "scholarly-v1" ||
      programBinding?.id !== protocolId || programBinding.path !== CONTRIBUTION_PROTOCOL ||
      programBinding.sha256 !== sha256(protocolBytes)) {
    return { error: "The program and draft study must identify the same exported protocol. Remove contributor-supplied review claims and export again." };
  }

  const source = record(program.source);
  if (!matchesPaper(exportedPaper, study) || !matchesPaper(requestedPaper, study) ||
      text(source?.title) !== text(study.title) || authorText(source?.authors) !== authorText(authors(study.authors).join(", ")) ||
      (source?.doi != null && doi(source.doi) !== doi(study.doi))) {
    return { error: "The paper title, authors, year or DOI differs between the ZIP and the submission. Export the paired draft again." };
  }

  const openSources = new Map<string, { license: string; digest: string }>();
  for (const item of sourceManifest.files) {
    const source = record(item);
    const path = source?.path;
    const license = hostedLicense(source?.license);
    const bytes = typeof path === "string" ? payload.get(path) : undefined;
    if (typeof path !== "string" || !path.startsWith("sources/open/") || !bytes || !license ||
        openSources.has(path) || source?.bytes !== bytes.length || source.sha256 !== sha256(bytes)) {
      return { error: "Each included source needs an open redistribution license and the exact bytes and hash in sources/SOURCE.json." };
    }
    openSources.set(path, { license, digest: source.sha256 as string });
  }
  if ([...payload.keys()].some(path => path.startsWith("sources/open/") && !openSources.has(path))) {
    return { error: "An included source is missing from sources/SOURCE.json." };
  }
  const sources = record(record(protocol.meta)?.sources);
  if (!sources || Object.keys(sources).length === 0) return { error: "The protocol needs a declared source list." };
  for (const source of Object.values(sources)) {
    const entry = record(source);
    const declaration = record(entry?.distribution);
    const hosted = typeof entry?.file === "string" ? openSources.get(entry.file) : undefined;
    if (declaration?.tier !== "hosted" || !hosted || declaration.sha256 !== hosted.digest ||
        hostedLicense(declaration.licence) !== hosted.license ||
        typeof declaration.attribution !== "string" || !declaration.attribution.trim()) {
      return { error: "Every declared protocol source must match an included, licensed source and its attribution." };
    }
  }
  const safeEvidenceUrl = (value: unknown) => {
    try { const url = new URL(String(value ?? "")); return url.protocol === "https:" && !url.username && !url.password; }
    catch { return false; }
  };
  if ((source?.filename && (typeof source.filename !== "string" || !openSources.has(source.filename))) ||
      !Array.isArray(program.evidence) || program.evidence.some(item => {
        const evidence = record(item);
        if (!evidence) return true;
        if (evidence.path !== undefined) return typeof evidence.path !== "string" || !openSources.has(evidence.path);
        if (evidence.url !== undefined) return !safeEvidenceUrl(evidence.url);
        return typeof evidence.sourceId !== "string" || !Object.hasOwn(sources, evidence.sourceId);
      })) {
    return { error: "Program evidence must point to an included licensed source or a public HTTPS reference." };
  }
  return { version: study.version.trim(), title: study.title as string, authors: study.authors as string[], year: study.year as number };
}
