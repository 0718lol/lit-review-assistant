export function createPaperWriter({ llmText, providerInfo }) {
  if (typeof llmText !== "function" || typeof providerInfo !== "function") throw new Error("paper writer dependencies are required.");

  async function writeSection({ project, section, claims, evidenceLinks }) {
    const provider = providerInfo();
    if (!provider?.modelAvailable || provider.provider === "local") return null;
    const evidenceById = new Map(evidenceLinks.map((item) => [item.id, item]));
    const source = claims.map((claim) => ({
      claimId: claim.id,
      claimType: claim.type,
      claim: claim.text,
      evidence: claim.evidenceLinkIds.map((id) => evidenceById.get(id)).filter(Boolean).map((item) => ({ quote: item.quote, citation: item.citation, confidence: item.confidence, usable: item.usable }))
    }));
    const prompt = [
      "你是证据约束的文献综述写作助手。请只依据给定论断和原文证据撰写本章节。",
      "禁止引入未给出的作者、文献、数据、指标或结论；证据不足时明确写[待人工核对]。",
      "返回严格 JSON，不要 Markdown：{\"paragraphs\":[{\"topicSentence\":\"主题句\",\"evidenceSentence\":\"证据句\",\"comparisonSentence\":\"比较句\",\"boundarySentence\":\"边界句\",\"inferenceLevel\":\"source_fact|synthesis|interpretation\",\"text\":\"完整段落\",\"claimIds\":[\"使用的claimId\"]}]}。",
      `综述题目：${project.title}`,
      `综述主题：${project.topic || project.title}`,
      `中心论点：${project.theses.find((item) => item.id === project.activeThesisId)?.statement || "待确定"}`,
      `章节：${section.title}`,
      `写作目的：${section.purpose}`,
      `目标字数：${section.targetWords}`,
      `语言：${project.language === "en" ? "English" : "中文"}`,
      `可用论断与证据：${JSON.stringify(source)}`
    ].join("\n");
    const raw = await llmText(prompt, { maxTokens: Math.min(5000, Math.max(800, section.targetWords * 2)) });
    return normalizeModelDraft(raw, new Set(claims.map((claim) => claim.id)));
  }

  return Object.freeze({ writeSection });
}

export function normalizeModelDraft(raw, allowedClaimIds = new Set()) {
  const clean = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(clean); } catch { return null; }
  const paragraphs = Array.isArray(parsed?.paragraphs) ? parsed.paragraphs : [];
  const normalized = paragraphs.map((item) => ({
    text: String(item?.text || "").replace(/\s+/g, " ").trim(),
    claimIds: [...new Set((Array.isArray(item?.claimIds) ? item.claimIds : []).map(String).filter((id) => allowedClaimIds.has(id)))],
    topicSentence: String(item?.topicSentence || "").replace(/\s+/g, " ").trim(),
    evidenceSentence: String(item?.evidenceSentence || "").replace(/\s+/g, " ").trim(),
    comparisonSentence: String(item?.comparisonSentence || "").replace(/\s+/g, " ").trim(),
    boundarySentence: String(item?.boundarySentence || "").replace(/\s+/g, " ").trim(),
    inferenceLevel: ["source_fact", "synthesis", "interpretation"].includes(item?.inferenceLevel) ? item.inferenceLevel : ""
  })).filter((item) => item.text);
  return normalized.length ? normalized : null;
}
