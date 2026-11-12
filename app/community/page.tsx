import { permanentRedirect } from "next/navigation";

export default function CommunityRedirect() {
  permanentRedirect("/studies");
}
