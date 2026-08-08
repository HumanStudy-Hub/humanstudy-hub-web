import { NextResponse } from "next/server";
import { CONTRACT, parseReply } from "@/lib/persona-chat";
import { normaliseGroup, PersonaError, type PersonaGroup } from "@/lib/persona-groups";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.PERSONA_DESIGNER_MODEL || "anthropic/claude-sonnet-5";
const MAX_TURNS = 24;
const MAX_MESSAGE = 4000;

type ChatTurn = { role: "user" | "assistant"; content: string };

function turns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is ChatTurn =>
      Boolean(entry) && typeof entry === "object"
      && (entry as ChatTurn).role !== undefined
      && ["user", "assistant"].includes((entry as ChatTurn).role)
      && typeof (entry as ChatTurn).content === "string")
    .slice(-MAX_TURNS)
    .map((entry) => ({ role: entry.role, content: entry.content.slice(0, MAX_MESSAGE) }));
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "The persona designer is not configured. Set OPENROUTER_API_KEY, or build the group by hand." },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
    const history = turns(body.messages);
    if (history.length === 0) {
      return NextResponse.json({ error: "Describe the people you want first." }, { status: 400 });
    }

    const context = [
      `Study: ${String(body.studyTitle || body.studyId || "unknown")}.`,
      `The run has ${Number(body.participants) || 0} participant sessions.`,
      body.group ? `Current group:\n${JSON.stringify(body.group)}` : "There is no group yet; create one.",
    ].join("\n");

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://humanstudy-hub.org",
        "X-Title": "HumanStudy-Hub persona designer",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CONTRACT },
          { role: "system", content: context },
          ...history,
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("persona designer upstream error", response.status, detail.slice(0, 500));
      return NextResponse.json({ error: "The persona designer is unavailable right now." }, { status: 502 });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return NextResponse.json({ error: "The persona designer returned nothing usable." }, { status: 502 });
    }

    const { reply, group } = parseReply(content);
    // Validated here so an unusable group never reaches the editor, and never
    // reaches a run.
    const normalised: PersonaGroup = normaliseGroup({
      ...(typeof group === "object" && group ? group : {}),
      studyId: body.studyId || null,
    });
    return NextResponse.json({ reply, group: normalised });
  } catch (error) {
    if (error instanceof PersonaError) {
      return NextResponse.json({ error: `The designer returned a group that cannot be used: ${error.message}` }, { status: 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The persona designer failed." },
      { status: 400 },
    );
  }
}
