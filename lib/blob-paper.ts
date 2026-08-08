import { head, issueSignedToken, presignUrl } from "@vercel/blob";

// Long enough that a job waiting on a busy Actions queue can still fetch its
// paper, short enough that a leaked link stops working the next day.
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

export function safePathname(value: unknown) {
  const pathname = String(value ?? "").trim();
  if (!pathname || pathname.length > 512) return "";
  if (pathname.startsWith("/") || pathname.includes("..")) return "";
  return pathname;
}

// Confirms the upload actually landed instead of trusting the client's word.
export async function blobUpload(pathname: string) {
  try {
    return await head(pathname);
  } catch {
    return null;
  }
}

// The store is private, so anything fetching the blob outside Vercel — the
// Actions runner in particular — needs a time-limited signed URL.
export async function signedBlobUrl(pathname: string) {
  const validUntil = Date.now() + LINK_TTL_MS;
  const signed = await issueSignedToken({ pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await presignUrl(signed, {
    operation: "get",
    pathname,
    access: "private",
    validUntil,
  });
  return presignedUrl;
}
