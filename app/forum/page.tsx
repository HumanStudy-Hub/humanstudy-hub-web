import { permanentRedirect } from "next/navigation";

export default function ForumRedirect() {
  permanentRedirect("/blog");
}
