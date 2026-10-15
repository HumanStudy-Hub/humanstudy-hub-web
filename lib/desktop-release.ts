// Download links for the HumanStudy Hub desktop app, resolved from the public GitHub
// Releases of HumanStudy-Hub/humanstudy-desktop. The page renders whatever the newest
// non-draft release (prereleases included) carries; when nothing is published yet, or
// GitHub is unreachable, every button falls back to the releases page instead of a
// broken asset link.

export const DESKTOP_REPO = "HumanStudy-Hub/humanstudy-desktop";
export const DESKTOP_RELEASES_URL = `https://github.com/${DESKTOP_REPO}/releases`;
const API_URL = `https://api.github.com/repos/${DESKTOP_REPO}/releases?per_page=20`;

export const MAC_ARM64_ASSET = /mac-arm64\.dmg$/;
export const MAC_X64_ASSET = /mac-x64\.dmg$/;
export const WINDOWS_ASSET = /Setup-[\w.-]+\.exe$/;

export type DesktopAsset = { name: string; url: string; size: number };

export type DesktopRelease = {
  /** Tag of the release the links come from, or null when none is published. */
  version: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  /** Release notes page for this release, or the releases index as a fallback. */
  pageUrl: string;
  macArm64: DesktopAsset | null;
  macX64: DesktopAsset | null;
  /** Windows installer (preview: unsigned, not yet tested on real machines). */
  windows: DesktopAsset | null;
};

type GitHubAsset = { name?: unknown; browser_download_url?: unknown; size?: unknown };
type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
};

export const NO_RELEASE: DesktopRelease = {
  version: null,
  publishedAt: null,
  prerelease: false,
  pageUrl: DESKTOP_RELEASES_URL,
  macArm64: null,
  macX64: null,
  windows: null,
};

const str = (value: unknown) => (typeof value === "string" && value ? value : null);

function findAsset(assets: unknown, pattern: RegExp): DesktopAsset | null {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets as GitHubAsset[]) {
    const name = str(asset?.name), url = str(asset?.browser_download_url);
    if (name && url && pattern.test(name) && url.startsWith("https://")) {
      return { name, url, size: typeof asset.size === "number" ? asset.size : 0 };
    }
  }
  return null;
}

/** Picks the newest non-draft release from a GitHub Releases API response. */
export function pickDesktopRelease(payload: unknown): DesktopRelease {
  if (!Array.isArray(payload)) return NO_RELEASE;
  const published = (payload as GitHubRelease[])
    .filter((r) => r && typeof r === "object" && r.draft !== true)
    .map((r) => ({ r, at: Date.parse(str(r.published_at) ?? str(r.created_at) ?? "") || 0 }))
    .sort((a, b) => b.at - a.at);
  const newest = published[0]?.r;
  if (!newest) return NO_RELEASE;
  const pageUrl = str(newest.html_url);
  return {
    version: str(newest.tag_name) ?? str(newest.name),
    publishedAt: str(newest.published_at) ?? str(newest.created_at),
    prerelease: newest.prerelease === true,
    pageUrl: pageUrl?.startsWith("https://github.com/") ? pageUrl : DESKTOP_RELEASES_URL,
    macArm64: findAsset(newest.assets, MAC_ARM64_ASSET),
    macX64: findAsset(newest.assets, MAC_X64_ASSET),
    windows: findAsset(newest.assets, WINDOWS_ASSET),
  };
}

type FetchLike = (url: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>;

/** Fetches the current release. Never throws; returns NO_RELEASE on any failure. */
export async function getDesktopRelease(
  fetchImpl: FetchLike = fetch,
  token: string | undefined = process.env.GITHUB_TOKEN,
): Promise<DesktopRelease> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "humanstudy-hub-web",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    let response = await fetchImpl(API_URL, { headers, next: { revalidate: 300 } });
    // A stale or under-scoped token must not hide a public release.
    if ((response.status === 401 || response.status === 403) && token) {
      delete headers.Authorization;
      response = await fetchImpl(API_URL, { headers, next: { revalidate: 300 } });
    }
    if (!response.ok) return NO_RELEASE;
    return pickDesktopRelease(await response.json());
  } catch {
    return NO_RELEASE;
  }
}

/** "48 MB" style label for an asset size; empty when the size is unknown. */
export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  return `${Math.round(bytes / 1_000_000)} MB`;
}
