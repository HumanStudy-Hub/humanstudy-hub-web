// Persona groups describe who the agents in a run are.
//
// A group is a population, not a fixed cast: each segment carries a share of the
// participants and the ranges its members are drawn from, so one saved group
// fits a 20-session run and a 600-session run alike. This mirrors
// playground/personas.py in HumanStudy-Bench, which does the actual sampling —
// the two validators must stay in step, so anything rejected here is also
// rejected there.

export const SCHEMA_VERSION = 1;
export const MAX_SEGMENTS = 12;
export const MAX_TEXT = 600;
export const MIN_AGE = 10;
export const MAX_AGE = 110;

export type AgeSpec = { min: number; max: number };
export type WeightSpec = Record<string, number>;

export type PersonaSegment = {
  id: string;
  label: string;
  share: number;
  age: AgeSpec | null;
  gender: WeightSpec | null;
  education: string | null;
  background: string | null;
  persona: string | null;
};

export type PersonaGroup = {
  schemaVersion: number;
  name: string;
  description: string | null;
  studyId: string | null;
  contributor: string | null;
  segments: PersonaSegment[];
};

export class PersonaError extends Error {}

function text(value: unknown, field: string, limit = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new PersonaError(`${field} must be text`);
  const cleaned = value.trim();
  if (cleaned.length > limit) throw new PersonaError(`${field} is longer than ${limit} characters`);
  return cleaned || null;
}

function age(value: unknown, field: string): AgeSpec | null {
  if (value === null || value === undefined) return null;
  let low: number;
  let high: number;
  if (typeof value === "number") {
    low = high = Math.round(value);
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.value !== undefined) {
      low = high = Math.round(Number(record.value));
    } else {
      low = Math.round(Number(record.min));
      high = Math.round(Number(record.max));
    }
  } else {
    throw new PersonaError(`${field} must be a number or a range`);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) throw new PersonaError(`${field} needs either a value or a min and max`);
  if (low > high) [low, high] = [high, low];
  if (low < MIN_AGE || high > MAX_AGE) throw new PersonaError(`${field} must fall between ${MIN_AGE} and ${MAX_AGE}`);
  return { min: low, max: high };
}

function weights(value: unknown, field: string): WeightSpec | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned ? { [cleaned]: 1 } : null;
  }
  if (typeof value !== "object") throw new PersonaError(`${field} must be a value or a set of weights`);
  const entries = Object.entries(value as Record<string, unknown>);
  const kept: WeightSpec = {};
  for (const [key, weight] of entries) {
    if (!key.trim()) throw new PersonaError(`${field} has an unnamed option`);
    const number = Number(weight);
    if (!Number.isFinite(number)) throw new PersonaError(`${field}.${key} must be a number`);
    if (number < 0) throw new PersonaError(`${field}.${key} cannot be negative`);
    if (number > 0) kept[key.trim()] = number;
  }
  const total = Object.values(kept).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) throw new PersonaError(`${field} has no option with a share above zero`);
  return Object.fromEntries(Object.entries(kept).map(([key, weight]) => [key, weight / total]));
}

export function normaliseGroup(raw: unknown): PersonaGroup {
  if (!raw || typeof raw !== "object") throw new PersonaError("A persona group must be an object");
  const record = raw as Record<string, unknown>;
  const rawSegments = record.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) throw new PersonaError("A persona group needs at least one segment");
  if (rawSegments.length > MAX_SEGMENTS) throw new PersonaError(`A persona group cannot have more than ${MAX_SEGMENTS} segments`);

  const used = new Set<string>();
  const segments: PersonaSegment[] = rawSegments.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new PersonaError(`Segment ${index + 1} must be an object`);
    const segment = entry as Record<string, unknown>;
    const where = `segments[${index}]`;
    const label = text(segment.label, `${where}.label`, 120) || `Group ${index + 1}`;
    const id = text(segment.id, `${where}.id`, 60) || label.toLowerCase().replace(/\s+/g, "_");
    if (used.has(id)) throw new PersonaError(`Two segments share the id ${id}`);
    used.add(id);
    const share = Number(segment.share ?? 1);
    if (!Number.isFinite(share) || share <= 0) throw new PersonaError(`${where}.share must be greater than zero`);
    return {
      id,
      label,
      share,
      age: age(segment.age, `${where}.age`),
      gender: weights(segment.gender, `${where}.gender`),
      education: text(segment.education, `${where}.education`, 160),
      background: text(segment.background, `${where}.background`),
      persona: text(segment.persona, `${where}.persona`),
    };
  });

  const total = segments.reduce((sum, segment) => sum + segment.share, 0);
  return {
    schemaVersion: SCHEMA_VERSION,
    name: text(record.name, "name", 120) || "Untitled persona group",
    description: text(record.description, "description"),
    studyId: text(record.studyId, "studyId", 60),
    contributor: text(record.contributor, "contributor", 80),
    segments: segments.map((segment) => ({ ...segment, share: segment.share / total })),
  };
}

// Largest remainder, matching personas.py: a 30/70 split of 10 participants is
// 3 and 7 rather than whatever repeated rounding happens to produce.
export function segmentCounts(segments: PersonaSegment[], total: number): number[] {
  if (total <= 0) return segments.map(() => 0);
  const exact = segments.map((segment) => segment.share * total);
  let counts = exact.map((value) => Math.floor(value));
  if (segments.length <= total) counts = counts.map((count) => Math.max(1, count));
  while (counts.reduce((sum, count) => sum + count, 0) > total) {
    counts[counts.indexOf(Math.max(...counts))] -= 1;
  }
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
    .map((entry) => entry.index);
  let position = 0;
  while (counts.reduce((sum, count) => sum + count, 0) < total) {
    counts[order[position % order.length]] += 1;
    position += 1;
  }
  return counts;
}

export function describeMix(group: PersonaGroup, total: number) {
  const counts = segmentCounts(group.segments, total);
  return group.segments.map((segment, index) => ({
    id: segment.id,
    label: segment.label,
    count: counts[index],
    share: total > 0 ? counts[index] / total : 0,
  }));
}

export function summariseSegment(segment: PersonaSegment): string {
  const parts: string[] = [];
  if (segment.age) parts.push(segment.age.min === segment.age.max ? `age ${segment.age.min}` : `ages ${segment.age.min}–${segment.age.max}`);
  if (segment.gender) {
    const entries = Object.entries(segment.gender);
    parts.push(entries.length === 1 ? entries[0][0] : entries.map(([name, weight]) => `${Math.round(weight * 100)}% ${name}`).join(", "));
  }
  if (segment.education) parts.push(segment.education);
  if (segment.background) parts.push(segment.background);
  return parts.join(" · ") || "no attributes set";
}

export function blankGroup(studyId: string | null = null): PersonaGroup {
  return normaliseGroup({
    name: "New persona group",
    studyId,
    segments: [{ id: "group_1", label: "Group 1", share: 1, age: { min: 18, max: 65 } }],
  });
}

// Contributed groups are stored as <study>-<contributor>-<n>.json, so both parts
// have to survive a file name without escaping anywhere.
export function slug(value: string, fallback: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return cleaned || fallback;
}
