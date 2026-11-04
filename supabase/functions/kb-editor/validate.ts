// Server-side validation of every write. Pure functions (no I/O) so they can be unit-tested.
//
// Goals
//   * a bad or malicious payload can never break the public site (render-breaking shapes are rejected)
//   * existing content can never shrink or disappear through the editor (no row / topic / section deletion)
//   * no javascript:/data: links can be stored

export const KNOWN_GROUPS = [
  "topics", "kb_faqs_full", "kb_faqs", "fees_5m", "fees_10m", "companies", "sla", "banks", "channels",
  "validation_policy", "scripts", "revisit_plan", "actions", "actions_all", "actions_increase_max_balance",
  "actions_block", "actions_deposit", "actions_update_data",
  "kb_meta", // extra group: custom categories ("branches") created from the editor
];

const SECTION_TYPES = ["overview", "list", "steps", "notes", "validation", "faq", "statuses", "videos", "link_cards", "related", "table_ref"];
const LIST_TYPES = ["list", "steps", "notes", "validation", "videos", "related"];
const MAX_STRING = 20_000;
export const MAX_BYTES = 1_500_000;

type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => !!x && typeof x === "object" && !Array.isArray(x);
const isStr = (x: Json): x is string => typeof x === "string";
const strOrNull = (x: Json) => x === null || x === undefined || typeof x === "string";

/** Returns an error message, or null when the write is acceptable. */
export function validateWrite(group: string, next: Json, prev: Json | null | undefined): string | null {
  if (!KNOWN_GROUPS.includes(group)) return "unknown_group";
  if (!Array.isArray(next) && !isObj(next)) return "content_must_be_array_or_object";

  let size = 0;
  try { size = JSON.stringify(next).length; } catch { return "content_not_serializable"; }
  if (size > MAX_BYTES) return "content_too_large";

  const hasPrev = prev !== null && prev !== undefined;
  if (hasPrev && Array.isArray(prev) !== Array.isArray(next)) return "content_type_changed";

  const strErr = scan(next, 0);
  if (strErr) return strErr;

  if (group === "kb_meta") return validateMeta(next, hasPrev ? prev : null);

  if (Array.isArray(next)) {
    if (!next.every(isObj)) return "rows_must_be_objects";
    if (hasPrev && Array.isArray(prev) && next.length < prev.length) return "rows_cannot_be_removed";
    if (group === "topics") return validateTopics(next as Record<string, Json>[], hasPrev && Array.isArray(prev) ? (prev as Record<string, Json>[]) : null);
  }
  return null;
}

/** Walks the whole value: string length limit + only http(s) links in `url` / `video` fields. */
function scan(v: Json, depth: number, key = ""): string | null {
  if (depth > 12) return "content_too_deep";
  if (isStr(v)) {
    if (v.length > MAX_STRING) return "string_too_long";
    if ((key === "url" || key === "video") && v.trim() !== "" && !/^https?:\/\/\S+$/i.test(v.trim())) return "invalid_link";
    return null;
  }
  if (Array.isArray(v)) {
    for (const x of v) { const e = scan(x, depth + 1, key); if (e) return e; }
    return null;
  }
  if (isObj(v)) {
    // `videos` sections keep bare URLs in `items`
    if (v.type === "videos" && Array.isArray(v.items)) {
      for (const u of v.items) if (!isStr(u) || !/^https?:\/\/\S+$/i.test(u.trim())) return "invalid_link";
    }
    for (const k of Object.keys(v)) { const e = scan(v[k], depth + 1, k); if (e) return e; }
  }
  return null;
}

function validateMeta(next: Json, prev: Json | null): string | null {
  if (!isObj(next) || !Array.isArray(next.categories)) return "meta_shape";
  const names = new Set<string>();
  for (const c of next.categories) {
    if (!isObj(c) || !isStr(c.name) || !c.name.trim() || c.name.length > 60) return "meta_category_name";
    if (c.icon !== undefined && (!isStr(c.icon) || c.icon.length > 16)) return "meta_category_icon";
    if (names.has(c.name)) return "meta_category_duplicate";
    names.add(c.name);
  }
  if (isObj(prev) && Array.isArray(prev.categories)) {
    for (const c of prev.categories) if (isObj(c) && isStr(c.name) && !names.has(c.name)) return "categories_cannot_be_removed";
  }
  return null;
}

function validateTopics(next: Record<string, Json>[], prev: Record<string, Json>[] | null): string | null {
  if (!next.length) return "topics_empty";
  const ids = new Set<string>();
  for (const t of next) {
    if (!isStr(t.id) || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(t.id)) return "topic_id";
    if (ids.has(t.id)) return "topic_id_duplicate";
    ids.add(t.id);
    if (!isStr(t.title) || !t.title.trim() || t.title.length > 200) return "topic_title";
    if (!isStr(t.cat) || !t.cat.trim() || t.cat.length > 80) return "topic_cat";
    if (!strOrNull(t.icon) || (isStr(t.icon) && t.icon.length > 16)) return "topic_icon";
    if (!strOrNull(t.keywords)) return "topic_keywords";
    if (!Array.isArray(t.sections)) return "topic_sections";
    for (const s of t.sections) { const e = validateSection(s); if (e) return e + ":" + t.id; }
  }
  if (prev) {
    const byId = new Map(next.map((t) => [t.id as string, t]));
    for (const p of prev) {
      const n = byId.get(p.id as string);
      if (!n) return "topics_cannot_be_removed";
      if (Array.isArray(p.sections) && (n.sections as Json[]).length < p.sections.length) return "sections_cannot_be_removed";
    }
  }
  return null;
}

function validateSection(s: Json): string | null {
  if (!isObj(s) || !isStr(s.type) || !SECTION_TYPES.includes(s.type)) return "section_type";
  if (s.cat !== undefined && !isStr(s.cat)) return "section_cat";
  if (s.title !== undefined && !strOrNull(s.title)) return "section_title";
  if (s.type === "overview") return isStr(s.text) ? null : "section_text";
  if (s.type === "table_ref") return isStr(s.ref) && KNOWN_GROUPS.includes(s.ref) ? null : "section_ref";
  if (!Array.isArray(s.items)) return "section_items";
  if (LIST_TYPES.includes(s.type)) return s.items.every(isStr) ? null : "section_items_strings";
  if (s.type === "faq") return s.items.every((i) => isObj(i) && isStr(i.q) && isStr(i.a) && strOrNull(i.video)) ? null : "faq_items";
  if (s.type === "statuses") return s.items.every((i) => isObj(i) && isStr(i.name) && strOrNull(i.desc)) ? null : "status_items";
  if (s.type === "link_cards") {
    return s.items.every((i) => isObj(i) && isStr(i.name) && isStr(i.url) && strOrNull(i.purpose) &&
      (i.uses === undefined || i.uses === null || (Array.isArray(i.uses) && i.uses.every(isStr)))) ? null : "link_items";
  }
  return null;
}
