import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.PERSONA_DESIGNER_MODEL || "anthropic/claude-sonnet-5";
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const DESIGN_CONTRACT = `You are a senior human-subjects study design collaborator. Turn the researcher's early idea into a concrete, testable protocol. Be constructive but rigorous. Distinguish design quality from ethics review and never claim that synthetic participants validate human behavior.

Return JSON with exactly these string fields: summary, researchQuestion, design, measures, analysisPlan, risks, nextStep. The design must specify participants, conditions, procedure, stimuli, and response format. risks should cover confounds, ambiguity, feasibility, and ethics considerations.`;

const PREVIEW_CONTRACT = `You are previewing a proposed study protocol with synthetic participants only. Generate varied plausible responses to expose confusing instructions, ceiling effects, missing response options, and implementation problems. Do not imitate real human evidence and do not estimate population effects.

Return JSON with exactly these fields: overview (string), issues (array of strings), responses (array of objects with participant, interpretation, response, friction). Generate 6 responses.`;

function filePart(file: File) {
  return file.arrayBuffer().then((buffer) => ({
    type: "file",
    file: { filename: file.name, file_data: `data:application/pdf;base64,${Buffer.from(buffer).toString("base64")}` },
  }));
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "The study design agent is not configured." }, { status: 503 });
  try {
    const form = await request.formData();
    const action = String(form.get("action") || "design");
    const name = String(form.get("name") || "").trim().slice(0, 120);
    const idea = String(form.get("idea") || "").trim().slice(0, 12000);
    const design = String(form.get("design") || "").trim().slice(0, 20000);
    const pdf = form.get("pdf");
    if (!name) return NextResponse.json({ error: "Name the study so the prototype can be saved." }, { status: 400 });
    if (!idea && !design && !(pdf instanceof File && pdf.size)) return NextResponse.json({ error: "Describe the study idea or attach a PDF." }, { status: 400 });
    if (pdf instanceof File && pdf.size > MAX_PDF_BYTES) return NextResponse.json({ error: "Keep the prototype PDF under 8 MB." }, { status: 400 });

    const prompt = action === "preview"
      ? `Study name: ${name}\nResearcher's idea: ${idea}\nCurrent protocol:\n${design}\nPreview this protocol and identify implementation friction.`
      : `Study name: ${name}\nResearcher's idea: ${idea}\n${design ? `Current draft to improve:\n${design}` : "Create the first protocol draft."}`;
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (pdf instanceof File && pdf.size) content.push(await filePart(pdf));
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://humanstudy-hub.org", "X-Title": "HumanStudy-Hub study prototype" },
      body: JSON.stringify({ model: MODEL, temperature: action === "preview" ? 0.8 : 0.3, max_tokens: 3500, response_format: { type: "json_object" }, messages: [{ role: "system", content: action === "preview" ? PREVIEW_CONTRACT : DESIGN_CONTRACT }, { role: "user", content }] }),
    });
    if (!response.ok) {
      console.error("prototype agent upstream error", response.status, (await response.text()).slice(0, 500));
      return NextResponse.json({ error: "The study design agent is unavailable right now." }, { status: 502 });
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") throw new Error("The design agent returned no usable response.");
    return NextResponse.json({ result: JSON.parse(raw) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The prototype could not be generated." }, { status: 400 });
  }
}
