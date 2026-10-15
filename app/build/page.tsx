import { redirect } from "next/navigation";

// /build used to open the web study builder. The desktop app replaced it as the way to
// build a study, so the old address now lands on its download page. The web workspace
// (and the sign-in and sign-up it carries) lives on at /build/projects for existing projects.
export default function BuildPage() {
  redirect("/download");
}
