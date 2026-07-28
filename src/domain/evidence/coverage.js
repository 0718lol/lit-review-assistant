export const EVIDENCE_FIELDS = Object.freeze([
  "research_question",
  "method",
  "data_or_materials",
  "contribution",
  "evidence",
  "limitations"
]);

export function evidenceItemsForCard(card = {}) {
  return EVIDENCE_FIELDS.flatMap((field) => {
    const value = card[field];
    const item = Array.isArray(value) ? value[0] : value;
    return item ? [{ field, item }] : [];
  });
}

export function sourceParseStatus(doc = {}) {
  const chunks = (doc.chunks || []).filter((chunk) => String(chunk?.text || "").trim());
  const wordCount = Number(doc.wordCount || 0);
  if (chunks.length || wordCount > 0) return "readable";
  if (doc.sourceType === "pdf" && Number(doc.pages || 0) > 0) return "source_unreadable";
  return "source_empty";
}

export function evidenceFailureStage(item = {}, { candidateCount = 0, parseStatus = "readable" } = {}) {
  if (parseStatus !== "readable") return "parse_empty";
  if (!item?.quote) return candidateCount ? "selection_rejected" : "candidate_empty";
  if (item.dimension_audit === "dimension_mismatch") return "dimension_mismatch";
  if (Number(item.quote_quality_score || 0) < 0.5 || item.audit === "low_quote_quality") return "quality_rejected";
  if (/weak|missing/.test(String(item.support_level || ""))) return "support_rejected";
  if (item.direct_quote_eligible === false) return "direct_quote_rejected";
  return item.is_usable ? "usable" : "selection_rejected";
}

export function evidenceCoverageForDoc(doc = {}) {
  const card = doc.evidenceCard || {};
  const parseStatus = sourceParseStatus(doc);
  const candidateCount = (card.evidence_candidates || []).length;
  const applicableFields = Array.isArray(card.applicable_fields)
    ? new Set(card.applicable_fields)
    : new Set(EVIDENCE_FIELDS);
  const entries = evidenceItemsForCard(card)
    .filter(({ field }) => applicableFields.has(field))
    .map(({ field, item }) => ({
    field,
    usable: item.is_usable === true,
    stage: evidenceFailureStage(item, { candidateCount, parseStatus })
    }));
  const byStage = entries.reduce((counts, entry) => {
    counts[entry.stage] = (counts[entry.stage] || 0) + 1;
    return counts;
  }, {});
  return {
    id: doc.id || "",
    title: doc.title || doc.filename || "",
    sourceType: doc.sourceType || "pdf",
    documentKind: card.document_kind || "research_document",
    applicabilityReason: card.applicability_reason || "legacy_default",
    applicableFields: [...applicableFields],
    parseStatus,
    candidateCount,
    total: entries.length,
    usable: entries.filter((entry) => entry.usable).length,
    byStage,
    entries
  };
}

export function summarizeEvidenceCoverage(docs = []) {
  const documents = docs.map(evidenceCoverageForDoc);
  const readable = documents.filter((doc) => doc.parseStatus === "readable");
  const aggregate = (items) => items.reduce((summary, doc) => {
    summary.total += doc.total;
    summary.usable += doc.usable;
    for (const [stage, count] of Object.entries(doc.byStage)) {
      summary.byStage[stage] = (summary.byStage[stage] || 0) + count;
    }
    return summary;
  }, { total: 0, usable: 0, byStage: {} });
  const all = aggregate(documents);
  const eligible = aggregate(readable);
  return {
    documents,
    all,
    eligible: {
      ...eligible,
      rate: eligible.total ? Number((eligible.usable / eligible.total).toFixed(4)) : 0
    },
    unreadableDocuments: documents.filter((doc) => doc.parseStatus !== "readable").length
  };
}
