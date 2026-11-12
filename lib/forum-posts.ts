const FORUM = "https://forum.humanstudy-hub.com";

export const forumPosts = [
  {
    id: "uFBWofLF9ptGWBnss",
    slug: "making-human-studies-as-reproducible-as-open-source-code",
    title: "Making Human Studies as Reproducible as Open-Source Code",
    author: "Xuan Liu",
    date: "2026-11-08",
    dateLabel: "November 8, 2026",
    description: "What it takes to make published experiments easier to reproduce, inspect, and adapt.",
  },
  {
    id: "6RCpqzAsG8bnsYNgC",
    slug: "beyond-human-likeness-preserving-the-human-trace",
    title: "Beyond Human Likeness: Preserving the Human Trace",
    author: "Y.F",
    date: "2026-11-09",
    dateLabel: "November 9, 2026",
    description: "A reflection on preserving human choices and contributions when AI can imitate human behavior.",
  },
] as const;

type ForumPost = (typeof forumPosts)[number];

export function forumPostUrl(post: ForumPost) {
  return `${FORUM}/posts/${post.id}/${post.slug}`;
}

export async function readForumPost(post: ForumPost, fetchImpl = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${FORUM}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: "query FeaturedPost($id: String!) { post(selector: { _id: $id }) { result { _id slug status draft deletedDraft contents { markdown } } } }",
        variables: { id: post.id },
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      next: { revalidate: 300 },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const result = payload?.data?.post?.result;
    const body = result?.contents?.markdown;
    return result?._id === post.id && result.slug === post.slug && result.status === 2
      && !result.draft && !result.deletedDraft && typeof body === "string" && body.trim()
      ? body : null;
  } catch {
    return null;
  }
}
