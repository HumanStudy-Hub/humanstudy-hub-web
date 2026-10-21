// Compatibility URL: uploads remain bound to the signed-in contributor.
import { POST as prepare } from "../../community/upload-url/route";
export const runtime = "nodejs";
export const POST = prepare;
