import { redirect } from "next/navigation";

export default async function BlogPostRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(slug === "reproducible-human-studies" ? "/forum/making-human-studies-as-reproducible-as-open-source-code" : "/forum");
}
