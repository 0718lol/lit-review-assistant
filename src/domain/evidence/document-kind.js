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
  const text = [
    doc.title || "",
    doc.filename || "",
    doc.abstract || "",
    ...(doc.chunks || []).slice(0, 40).map((chunk) => chunk?.text || "")
  ].join("\n");
  const title = String(doc.title || doc.filename || "").trim();
  const strongPedagogicalTitle = /(?:入门|基础|从示例中学习|教程|课程|讲义|指南|手册|规范|规则|写作中心|writing center|handout|how to write|introduction to|foundations|tutorial|lecture|course|guidelines?|rules?|user manual|style manual|writing manual)/i.test(title) ||
    /^人工智能\s*[:：]/.test(title);
  const literatureReviewGuideTitle = /why do we write literature reviews?|how to write literature reviews?|literature review guide/i.test(title);
  const pedagogicalBodySignals = [
    /(?:you should|you can|you need to|your paper|your review|ask your professor|find models|narrow your topic|be selective|begin composing|works consulted)/i,
    /(?:literature reviews? (?:are|also|tend to|should)|organizing the body|thematic reviews?|methodological approach|chronological review)/i,
    /(?:学位论文|编写规则|格式规范|插图和附表清单|缩写、符号清单|论文撰写|写作要求|参考格式)/,
    /(?:课程目标|教学目标|课堂练习|学习目标|作业要求|讲义|教程)/
  ].filter((pattern) => pattern.test(text)).length;
  const structuralSignals = [
    /(?:研究问题|研究目的|research question|research objective|problem statement)\s*[:：]?/i,
    /(?:研究方法|方法路径|methodology|research method|methods?)\s*[:：]?/i,
    /(?:数据(?:与材料)?|样本|data(?: and materials)?|dataset|participants)\s*[:：]/i,
    /(?:研究结果|实验结果|results?|findings?)\s*[:：]?/i,
    /(?:主要贡献|研究贡献|contributions?)\s*[:：]?/i,
    /(?:研究局限|局限性|limitations?|future work)\s*[:：]?/i
  ].filter((pattern) => pattern.test(text)).length;
  const authorialResearchSignal = /(?:本文|本研究|this (?:study|paper|work)|we)\s*.{0,36}(?:提出|研究|考察|检验|分析|propose|investigate|examine|evaluate|show)/i.test(text);
  const explicitGuide = strongPedagogicalTitle || literatureReviewGuideTitle || (pedagogicalBodySignals >= 2 && structuralSignals < 2);
  if (explicitGuide) {
    return {
      kind: "teaching_or_reference_material",
      applicableFields: [],
      reason: (strongPedagogicalTitle || literatureReviewGuideTitle) ? "pedagogical_title" : "pedagogical_body"
    };
  }
  if (sourceType !== "pptx") {
    return {
      kind: "research_document",
      applicableFields: [...RESEARCH_EVIDENCE_FIELDS],
      reason: "document_source"
    };
  }

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
