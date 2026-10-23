// Community publishing, pure parts: paper keys and folder names (must match
// HumanStudy-Bench scripts/community.py), Hub signatures, encrypted token storage and
// the check a contribution zip has to pass before anything is sent to GitHub.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import AdmZip from "adm-zip";
import { ACCESS_SECRET } from "./access";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ZIP_BYTES = 40 * 1024 * 1024;
export const MAX_PUBLISHES_PER_HOUR = 5;
export const BOT_LOGIN = process.env.COMMUNITY_BOT_LOGIN || "humanstudy-bot";

// ---- paper keys (port of scripts/community.py) -------------------------------------------

const DOI_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i;

export function normaliseDoi(doi: string): string {
  return doi.trim().replace(DOI_PREFIX, "").trim().toLowerCase();
}

function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "");
}

export function normaliseTitle(title: string, maxLength = 60): string {
  const words = fold(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= maxLength) return words;
  let cut = words.slice(0, maxLength);
  if (words[maxLength] !== "-" && cut.includes("-")) cut = cut.slice(0, cut.lastIndexOf("-"));
  return cut.replace(/^-+|-+$/g, "");
}

export function surname(author: string): string {
  const a = author.trim();
  const part = a.includes(",") ? a.split(",")[0] : (a.split(/\s+/).filter(Boolean).pop() ?? "");
  return normaliseTitle(part, 30);
}

export type PaperMeta = { doi?: string | null; title: string; year?: number | null; firstAuthor: string };

export function makePaperKey(meta: PaperMeta): string {
  // Same DOI shape HumanStudy-Bench accepts (scripts/research/catalog.py normalise_doi); anything else keys by title.
  if (meta.doi && /^10\.\d{4,9}\/\S+$/.test(normaliseDoi(meta.doi))) return `doi:${normaliseDoi(meta.doi)}`;
  const parts = [normaliseTitle(meta.title), meta.year ? String(meta.year) : "nd", surname(meta.firstAuthor) || "anon"];
  return `title:${parts.filter(Boolean).join("-")}`;
}

export function paperKeyToDir(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---- contributor ids and folders ---------------------------------------------------------

export function hubContributorId(userId: string): string {
  const hex = userId.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 8);
  return `hub-${hex}`;
}

export function githubContributorId(login: string): string {
  return `gh-${login.toLowerCase()}`;
}

export function contributionFolder(slug: string, contributorId: string, version = 1): string {
  return `${slug}--${contributorId}${version > 1 ? `-v${version}` : ""}`;
}

/** Highest version among existing folder names for `<slug>--<id>`; 0 when none exists. */
export function latestVersion(existing: string[], slug: string, contributorId: string): number {
  const base = `${slug}--${contributorId}`;
  let latest = 0;
  for (const name of existing) {
    if (name === base) latest = Math.max(latest, 1);
    else if (name.startsWith(`${base}-v`)) {
      const n = Number(name.slice(base.length + 2));
      if (Number.isInteger(n) && n >= 2) latest = Math.max(latest, n);
    }
  }
  return latest;
}

// ---- Hub signature -----------------------------------------------------------------------

export function signHub(userId: string): string {
  return createHmac("sha256", ACCESS_SECRET).update(`hub:${userId}`).digest("base64url");
}

export function verifyHub(userId: string, signature: string | null | undefined): boolean {
  if (!signature || !ACCESS_SECRET) return false;
  const expected = Buffer.from(signHub(userId)), given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---- token encryption (AES-256-GCM, key derived from ACCESS_SECRET) ----------------------

function tokenKey(): Buffer {
  if (!ACCESS_SECRET) throw new Error("ACCESS_COOKIE_SECRET (or PROMO_CODE) is not configured.");
  return createHmac("sha256", ACCESS_SECRET).update("community:github-token:v1").digest();
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptToken(sealed: string): string | null {
  try {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !body) return null;
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---- zip validation ----------------------------------------------------------------------

export type ZipEntryInfo = { name: string; size: number; isDirectory?: boolean };

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function ignorable(name: string): boolean {
  return name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store";
}

/** Plain-language problems with a contribution zip; an empty list means it can be published. */
export function validateContributionZip(
  entries: ZipEntryInfo[],
  opts: { includesPdf?: boolean; zipBytes?: number } = {},
): string[] {
  const errors: string[] = [];
  if (opts.zipBytes !== undefined && opts.zipBytes > MAX_ZIP_BYTES) {
    errors.push(`The contribution is ${mb(opts.zipBytes)}, over the ${mb(MAX_ZIP_BYTES)} limit. Leave out large simulation outputs and try again.`);
  }
  const files = entries.filter((e) => !e.isDirectory && !ignorable(e.name));
  const names = new Set<string>();
  let unsafe = false;
  let totalBytes = 0;
  const extra = new Set<string>();
  for (const f of files) {
    const name = f.name;
    const parts = name.split("/");
    if (name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || name.includes("\0") || parts.some((p) => p === ".." || p === "." || p === "")) {
      if (!unsafe) errors.push(`The zip contains a file path that is not allowed (${JSON.stringify(name)}). Paths must stay inside the contribution folder.`);
      unsafe = true;
      continue;
    }
    if (parts.some(p => [".env", ".git", ".opencode", ".humanstudy", "node_modules", "threads", "conversations", "chat", "chats", "credentials", "account.json", "settings.json"].includes(p.toLowerCase()) || p.toLowerCase().startsWith(".env."))) {
      errors.push(`${name} is a private project file and is not published.`);
      continue;
    }
    if (names.has(name)) errors.push(`The zip contains the same file more than once: ${name}.`);
    names.add(name);
    totalBytes += f.size;
    const top = parts[0];
    const allowed =
      name === "program.json" || name === "CONTRIBUTION.json" ||
      (top === "package" && parts.length > 1) ||
      (top === "artifacts" && parts.length > 1) ||
      (top === "sources" && parts.length > 1);
    if (!allowed) extra.add(parts.length > 1 ? `${top}/` : top);
    if (f.size > MAX_FILE_BYTES) errors.push(`${name} is ${mb(f.size)}, over the ${mb(MAX_FILE_BYTES)} per-file limit.`);
    if (/\.pdf$/i.test(name) && !opts.includesPdf) {
      errors.push(`${name} is a PDF. Papers are usually under copyright, so PDFs are only published when you tick "Include the paper PDF".`);
    }
  }
  if (files.length > 2000 || totalBytes > 128 * 1024 * 1024) errors.push("The expanded contribution is too large. Store large research data as referenced resources; no files have been published.");
  if (!names.has("CONTRIBUTION.json")) errors.push("The zip has no CONTRIBUTION.json. It should be created by the HumanStudy app when you press Publish.");
  if (!names.has("program.json")) errors.push("The zip has no program.json, so there is no study to publish.");
  if (extra.size) {
    errors.push(`The zip contains files that are not part of a contribution: ${[...extra].sort().join(", ")}. Only program.json, package/, sources/, research artifacts and CONTRIBUTION.json are published.`);
  }
  return errors;
}

export type ZipFile = { name: string; data: Buffer };

/** Reads a zip into memory. Declared sizes are checked before inflating and real sizes after. */
export function readContributionZip(buf: Buffer, opts: { includesPdf?: boolean } = {}): { files: ZipFile[]; errors: string[] } {
  let zip: AdmZip;
  let list;
  try {
    zip = new AdmZip(buf);
    list = zip.getEntries();
  } catch {
    return { files: [], errors: ["That file is not a valid zip archive."] };
  }
  const info: ZipEntryInfo[] = list.map((e) => ({ name: e.entryName, size: e.header.size, isDirectory: e.isDirectory }));
  const errors = validateContributionZip(info, { includesPdf: opts.includesPdf, zipBytes: buf.length });
  if (errors.length) return { files: [], errors };
  const files: ZipFile[] = [];
  for (const e of list) {
    if (e.isDirectory || ignorable(e.entryName)) continue;
    let data: Buffer;
    try {
      data = e.getData();
    } catch {
      return { files: [], errors: [`${e.entryName} could not be read from the zip; it may be damaged.`] };
    }
    if (data.length > MAX_FILE_BYTES) return { files: [], errors: [`${e.entryName} is larger than its zip entry claims and over the ${mb(MAX_FILE_BYTES)} limit.`] };
    files.push({ name: e.entryName, data });
  }
  return { files, errors: [] };
}
