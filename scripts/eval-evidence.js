import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { summarizeEvidenceCoverage } from "../src/domain/evidence/coverage.js";

const __filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(__filename));
const libraryPath = process.env.EVIDENCE_LIBRARY_PATH
  ? path.resolve(process.env.EVIDENCE_LIBRARY_PATH)
  : path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data"), "library.json");
const goldenPath = path.join(root, "evals", "golden.json");

if (!fs.existsSync(libraryPath)) {
  console.error(`Evidence corpus not found: ${libraryPath}. Use npm test for fixture-based regression, or set DATA_DIR/EVIDENCE_LIBRARY_PATH for corpus evaluation.`);
  process.exit(2);
}

const library = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const strictMode = process.argv.includes("--strict");
const docs = library.docs || [];
const fieldNames = ["research_question", "method", "data_or_materials", "contribution", "evidence", "limitations"];

const results = [];
for (const spec of golden.documents || []) {
  const doc = docs.find((item) => [
    item.title,
    item.filename,
    item.journal,
    item.sourceMeta?.journal,
    item.sourceMeta?.titleCandidate
  ].filter(Boolean).join(" ").includes(spec.title_contains));
  if (!doc) {
    results.push({ title_contains: spec.title_contains, status: "missing_doc" });
    continue;
  }
  const card = doc.evidenceCard || {};
  const fieldResults = {};
  for (const [field, rule] of Object.entries(spec.fields || {})) {
    const item = Array.isArray(card[field]) ? card[field][0] : card[field];
    const text = fieldText(item);
    const missing = !item || item.audit === "missing_quote" || item.dimension_audit === "missing_quote";
    const unusableFallback = Boolean(rule.allow_missing && item && !item.is_usable && /missing_quote|dimension_mismatch|low_quote_quality|weak_support|needs_review/.test(`${item.audit || ""} ${item.dimension_audit || ""}`));
    const expectedHit = (rule.expected_terms || []).some((term) => text.includes(term));
    const forbiddenHit = (rule.forbidden_terms || []).filter((term) => text.includes(term));
    const forbiddenPatternHit = (rule.forbidden_patterns || []).filter((pattern) => new RegExp(pattern, "i").test(text));
    const schemaOk = item ? [
      "field",
      "normalized_claim",
      "claim_atoms",
      "quote",
      "dimension_audit",
      "suggested_dimension",
      "support_level",
      "span_type",
      "evidence_type",
      "evidence_role",
      "direct_quote_eligible",
      "claim_type",
      "is_usable",
      "not_usable_reason",
      "missing_reason",
      "quote_quality_score",
      "quote_quality_issues",
      "source_quality",
      "source_span_id",
      "extraction_strategy",
      "cross_field_reuse",
      "reused_from_fields"
    ].every((key) => key in item) : false;
    const dimensionOk = !rule.expected_dimension || item?.dimension_audit === rule.expected_dimension;
    const usableOk = !rule.require_usable || item?.is_usable === true;
    const pass = Boolean(schemaOk) && !forbiddenHit.length && !forbiddenPatternHit.length && dimensionOk && usableOk && (expectedHit || (missing && rule.allow_missing) || unusableFallback);
    fieldResults[field] = {
      pass,
      schemaOk,
      missing,
      unusableFallback,
      expectedHit,
      forbiddenHit,
      forbiddenPatternHit,
      dimensionOk,
      usableOk,
      audit: item?.audit || "",
      dimensionAudit: item?.dimension_audit || "",
      claim: item?.normalized_claim || item?.claim || ""
    };
  }
  results.push({ title: doc.title, status: "checked", fields: fieldResults });
}

const allDocsStats = docs.map((doc) => {
  const card = doc.evidenceCard || {};
  const items = fieldNames.flatMap((field) => {
    const value = card[field];
    return Array.isArray(value) ? value : [value].filter(Boolean);
  });
  return {
    title: doc.title,
    version: card.version || 0,
    total: items.length,
    candidatePool: (card.evidence_candidates || []).length,
    selectedCandidates: (card.evidence_candidates || []).filter((item) => item.selected).length,
    missingQuote: items.filter((item) => item.audit === "missing_quote" || item.dimension_audit === "missing_quote").length,
    missingWithCandidates: items.filter((item) => (item.audit === "missing_quote" || item.dimension_audit === "missing_quote") && (card.evidence_candidates || []).length).length,
    mismatch: items.filter((item) => item.dimension_audit === "dimension_mismatch").length,
    lowQuality: items.filter((item) => item.audit === "low_quote_quality" || Number(item.quote_quality_score || 0) < 0.5).length,
    nonDirectUsable: items.filter((item) => /metric_evidence|figure_evidence|invalid_fragment|context_only/.test(item.evidence_type || "") && item.is_usable).length,
    weak: items.filter((item) => item.audit === "weak_support" || item.support_level === "weak").length,
    usable: items.filter((item) => item.is_usable).length
  };
});
const coverage = summarizeEvidenceCoverage(docs);
const qualityGates = {
  minimumEligibleUsableRate: Number(process.env.EVIDENCE_MIN_USABLE_RATE || 0.85),
  maximumCandidateEmpty: Number(process.env.EVIDENCE_MAX_CANDIDATE_EMPTY || 0),
  maximumDimensionMismatch: Number(process.env.EVIDENCE_MAX_DIMENSION_MISMATCH || 4)
};

const checkedFields = results.flatMap((doc) => Object.values(doc.fields || {}));
const missingDocs = results.filter((doc) => doc.status === "missing_doc").length;
const summary = {
  goldenDocs: results.length,
  missingDocs,
  checkedFields: checkedFields.length,
  passedFields: checkedFields.filter((item) => item.pass).length,
  schemaFailures: checkedFields.filter((item) => !item.schemaOk).length,
  forbiddenHits: checkedFields.reduce((sum, item) => sum + item.forbiddenHit.length + item.forbiddenPatternHit.length, 0),
  corpus: allDocsStats.reduce((acc, item) => {
    acc.total += item.total;
    acc.candidatePool += item.candidatePool;
    acc.selectedCandidates += item.selectedCandidates;
    acc.missingQuote += item.missingQuote;
    acc.missingWithCandidates += item.missingWithCandidates;
    acc.mismatch += item.mismatch;
    acc.lowQuality += item.lowQuality;
    acc.nonDirectUsable += item.nonDirectUsable;
    acc.weak += item.weak;
    acc.usable += item.usable;
    return acc;
  }, { total: 0, candidatePool: 0, selectedCandidates: 0, missingQuote: 0, missingWithCandidates: 0, mismatch: 0, lowQuality: 0, nonDirectUsable: 0, weak: 0, usable: 0 }),
  coverage: {
    eligibleTotal: coverage.eligible.total,
    eligibleUsable: coverage.eligible.usable,
    eligibleUsableRate: coverage.eligible.rate,
    unreadableDocuments: coverage.unreadableDocuments,
    failureStages: coverage.eligible.byStage
  },
  qualityGates
};

const gateFailures = [
  coverage.eligible.rate < qualityGates.minimumEligibleUsableRate
    ? `eligible_usable_rate:${coverage.eligible.rate}<${qualityGates.minimumEligibleUsableRate}`
    : "",
  Number(coverage.eligible.byStage.candidate_empty || 0) > qualityGates.maximumCandidateEmpty
    ? `candidate_empty:${coverage.eligible.byStage.candidate_empty}>${qualityGates.maximumCandidateEmpty}`
    : "",
  Number(coverage.eligible.byStage.dimension_mismatch || 0) > qualityGates.maximumDimensionMismatch
    ? `dimension_mismatch:${coverage.eligible.byStage.dimension_mismatch}>${qualityGates.maximumDimensionMismatch}`
    : ""
].filter(Boolean);

console.log(JSON.stringify({ summary, gateFailures, results, corpusByDoc: allDocsStats, coverageByDoc: coverage.documents }, null, 2));
if (strictMode && (
  summary.missingDocs ||
  summary.schemaFailures ||
  summary.forbiddenHits ||
  summary.passedFields < summary.checkedFields ||
  summary.corpus.nonDirectUsable ||
  gateFailures.length
)) process.exitCode = 1;

function fieldText(item) {
  if (!item) return "";
  return [item.normalized_claim, item.claim, item.quote, item.dimension_issue, item.not_usable_reason]
    .filter(Boolean)
    .join(" ");
}
