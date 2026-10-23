// Compatibility URL: all contributions follow the authenticated proposal pipeline.
import { POST as publish } from "../../community/publish/route";
export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = publish;
