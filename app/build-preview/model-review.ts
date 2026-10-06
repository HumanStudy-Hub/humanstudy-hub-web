import type { StudyReviewIssue } from "./study-schema";
import { study } from "./study-schema";

export type Point = { x: number; y: number };
export type ModelAnchor = {
  kind: "objects" | "lasso" | "issue";
  entityIds: string[];
  points?: Point[]; // Percent coordinates in the overview, independent of display size.
  issueId?: string;
};
export type ReviewResponse = { text: string; savedAt: string };
export type ReviewIssue = StudyReviewIssue & { type?: "Interpretation" | "Missing information"; question?: string; suggestion?: string };
const evidence = (id: string) => study.entities.find(e => e.id === id)!.evidence;

// Curated review examples for this prototype, not the result of a live audit.
const exampleIssues = [
  { id: "anchor-unit", entity: "manipulation", type: "Interpretation",
    title: "Check the unit of manipulation",
    question: "The earlier extraction treated high / low anchor as a participant group. The revised model attaches it to each item in a questionnaire version. Is this correction right?",
    impact: "Changes the assignment model, response keys and high / low comparison.",
    suggestion: "Confirm the item-level interpretation; keep participant identity across both anchor levels.", evidence: evidence("manipulation") },
  { id: "version-allocation", entity: "inputs", type: "Missing information",
    title: "How are versions allocated?",
    question: "The linked passage describes two questionnaire versions, but does not specify how participants receive a version. What should the implementation do?",
    impact: "Blocks a complete assignment procedure. Random allocation must not be silently assumed.",
    suggestion: "Check additional materials, or specify a researcher decision and label it separately from the paper.", evidence: evidence("inputs") },
  { id: "analysis-contract", entity: "analysis", type: "Missing information",
    title: "Define the analysis contract",
    question: "The paper reports a contrast of individual average percentile scores. Confirm the exact pooling, pairing and missing-response policy before producing analysis code.",
    impact: "Determines the rows and values entering the test, and whether incomplete observations are included.",
    suggestion: "Review the source and specify these choices explicitly. A reported t statistic alone is not an executable analysis plan.", evidence: evidence("analysis") },
] as const;
export const reviewIssues: ReviewIssue[] = exampleIssues.map(issue => ({ ...issue,
  severity: issue.id === "version-allocation" ? "blocking" : "decision",
  reason: issue.question, suggestedAction: issue.suggestion }));

export const overview = {
  question: "How much do numerical anchors shift estimates?",
  summary: "Compare estimates made after low and high anchors, using a separate calibration sample as the reference.",
  stages: [
    { id: "prepare", title: "Prepare the study", subtitle: "People + materials", nodes: ["people", "inputs", "manipulation"] },
    { id: "run", title: "Run a participant session", subtitle: "Input → person → output", nodes: ["procedure"] },
    { id: "record", title: "Keep the observations", subtitle: "One record per participant × item", nodes: ["responses"] },
    { id: "analyze", title: "Turn observations into evidence", subtitle: "Derive → compare", nodes: ["outcome", "analysis"] },
  ],
  cards: {
    people: { title: "Participants", text: "53 calibration · 103 experimental", foot: "Separate samples · Berkeley students" },
    inputs: { title: "Questionnaires", text: "15 quantities · 2 versions", foot: "Same item order across versions" },
    manipulation: { title: "Low / high anchor", text: "Varies by item within a version", foot: "Manipulation · participant × item" },
    procedure: { title: "Compare → estimate → confidence", text: "One participant repeats this sequence for 15 quantities.", foot: "Input: item + anchor → Output: 3 responses" },
    responses: { title: "Response record", text: "Comparison · estimate · confidence", foot: "Linked to participant, item and version" },
    outcome: { title: "Calibrate the estimate", text: "Raw estimate → percentile", foot: "Reference: same item's calibration sample" },
    analysis: { title: "Compare low / high", text: "Average percentiles + anchoring index", foot: "Analysis choices need review" },
  } as Record<string, { title: string; text: string; foot: string }>,
};

/** Include an object when a freehand selection encloses or crosses its bounds. */
export function intersectsPolygon(points: Point[], box: { x: number; y: number; w: number; h: number }) {
  if (points.length < 3) return false;
  const inside = (p: Point) => {
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
  if (corners.some(inside) || points.some(p => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h)) return true;
  const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = 0; j < 4; j++) {
      const c = corners[j], d = corners[(j + 1) % 4];
      if (cross(a,b,c) * cross(a,b,d) < 0 && cross(c,d,a) * cross(c,d,b) < 0) return true;
    }
  }
  return false;
}

export function modelOverview(model: typeof study) {
  if(model.id===study.id)return overview;
  const stageKinds=[['participants','material'],['procedure'],['record'],['variable','analysis']];
  return {
    question:model.title, summary:'',
    stages:overview.stages.map((stage,i)=>({...stage,subtitle:["People + materials","Input → person → output","Recorded observations","Derive → compare"][i],nodes:model.entities.filter(e=>stageKinds[i].includes(e.kind)).map(e=>e.id)})).filter(stage=>stage.nodes.length),
    cards:Object.fromEntries(model.entities.map(e=>[e.id,{title:e.title,text:e.subtitle,foot:e.description}])) as typeof overview.cards,
  };
}
export function modelIssues(model: typeof study): ReviewIssue[] {
  if(model.id===study.id)return reviewIssues;
  const explicit=model.reviewIssues??[];
  const generic=model.entities.flatMap(entity=>entity.fields.flatMap((field,i)=>{
    if(field.status!=='unresolved')return [];
    const covered=explicit.some(issue=>issue.field===field.name&&(issue.entity===undefined||issue.entity===entity.id)
      ||issue.entity===entity.id&&issue.title===field.name);
    if(covered)return [];
    const id=`${entity.id}:field:${i}`;
    return explicit.some(issue=>issue.id===id)?[]:[{id,entity:entity.id,severity:'check' as const,title:field.name,reason:field.value,question:field.value,impact:'',suggestedAction:'',evidence:entity.evidence}];
  }));
  return [...explicit,...generic];
}
export function prioritizeReviewIssues(issues: ReviewIssue[], responses: Record<string, ReviewResponse>): ReviewIssue[] {
  const rank = { blocking: 0, decision: 1, check: 2 };
  return [...issues].sort((a, b) => Number(!!responses[a.id]) - Number(!!responses[b.id]) || rank[a.severity] - rank[b.severity]);
}
