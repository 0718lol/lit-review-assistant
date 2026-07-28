export function createEvidenceSelectionState({ crossFieldPenalty = 14 } = {}) {
  const fieldsBySpan = new Map();

  function fields(spanId) {
    return [...(fieldsBySpan.get(String(spanId || "")) || [])];
  }

  function has(spanId, field) {
    const selected = fieldsBySpan.get(String(spanId || ""));
    return field ? Boolean(selected?.has(field)) : Boolean(selected?.size);
  }

  function select(spanId, field) {
    const key = String(spanId || "");
    if (!key || !field) return;
    const selected = fieldsBySpan.get(key) || new Set();
    selected.add(field);
    fieldsBySpan.set(key, selected);
  }

  function penalty(spanId, field) {
    const selected = fields(spanId).filter((item) => item !== field);
    return selected.length * crossFieldPenalty;
  }

  return Object.freeze({ fields, has, penalty, select });
}
