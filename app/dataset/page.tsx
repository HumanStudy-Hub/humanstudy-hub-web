import { permanentRedirect } from "next/navigation";

// The old 15-study catalog moved into the full library at /studies.
export default function DatasetPage() {
  permanentRedirect("/studies");
}
