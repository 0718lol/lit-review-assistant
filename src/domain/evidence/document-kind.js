export const RESEARCH_EVIDENCE_FIELDS = Object.freeze([
  "research_question",
  "method",
  "data_or_materials",
  "contribution",
  "evidence",
  "limitations"
]);

export function classifyEvidenceDocument(doc = {}) {
  const sourceType = String(doc.sourceType || "pdf").toLowerCase();
  if (sourceType !== "pptx") {
    return {
      kind: "research_document",
      applicableFields: [...RESEARCH_EVIDENCE_FIELDS],
      reason: "document_source"
    };
  }

  const text = [
    doc.title || "",
    doc.abstract || "",
    ...(doc.chunks || []).map((chunk) => chunk?.text || "")
  ].join("\n");
  const title = String(doc.title || "").trim();
  const pedagogicalTitle = /(?:入门|基础|从示例中学习|教程|课程|讲义|introduction to|foundations|tutorial|lecture|course)/i.test(title) ||
    /^人工智能\s*[:：]/.test(title);
  if (pedagogicalTitle) {
    return {
      kind: "teaching_or_reference_material",
      applicableFields: [],
      reason: "pedagogical_title"
    };
  }
  const structuralSignals = [
    /(?:研究问题|研究目的|research question|research objective|problem statement)\s*[:：]?/i,
    /(?:研究方法|方法路径|methodology|research method|methods?)\s*[:：]?/i,
    /(?:数据(?:与材料)?|样本|data(?: and materials)?|dataset|participants)\s*[:：]/i,
    /(?:研究结果|实验结果|results?|findings?)\s*[:：]?/i,
    /(?:主要贡献|研究贡献|contributions?)\s*[:：]?/i,
    /(?:研究局限|局限性|limitations?|future work)\s*[:：]?/i
  ].filter((pattern) => pattern.test(text)).length;
  const authorialResearchSignal = /(?:本文|本研究|this (?:study|paper|work)|we)\s*.{0,36}(?:提出|研究|考察|检验|分析|propose|investigate|examine|evaluate|show)/i.test(text);

  if (structuralSignals >= 2 || (structuralSignals >= 1 && authorialResearchSignal)) {
    return {
      kind: "research_presentation",
      applicableFields: [...RESEARCH_EVIDENCE_FIELDS],
      reason: authorialResearchSignal ? "research_structure_and_authorship" : "research_structure"
    };
  }

  return {
    kind: "teaching_or_reference_material",
    applicableFields: [],
    reason: "no_research_structure"
  };
}
