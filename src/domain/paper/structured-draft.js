export function buildStructuredDrafts({ section = {}, claims = [], evidenceLinks = [], references = [], modelDraft = null }) {
  const evidenceById = new Map(evidenceLinks.map((item) => [item.id, item]));
  const refNumber = new Map(references.map((item) => [item.docId, item.number]));
  const source = normalizeModelDraft(modelDraft, claims);
  if (isAbstractSection(section)) {
    const draft = source?.length ? mergeAbstractDrafts(source, section, claims) : localAbstractDraft(section, claims);
    return [structuredBlockDraft({ section, draft, claims, evidenceById, refNumber, index: 0, mode: "abstract" })];
  }
  const draftClaims = source?.length ? source : localDraftClaims(section, claims);
  return draftClaims.map((draft, index) => structuredBlockDraft({ section, draft, claims, evidenceById, refNumber, index }));
}

function structuredBlockDraft({ section, draft, claims, evidenceById, refNumber, index, mode = "" }) {
  const allowed = new Map(claims.map((claim) => [claim.id, claim]));
  const blockClaims = [...new Set(draft.claimIds || [])].map((id) => allowed.get(id)).filter(Boolean);
  const links = blockClaims.flatMap((claim) => (claim.evidenceLinkIds || []).map((id) => evidenceById.get(id)).filter(Boolean));
  const docIds = [...new Set(blockClaims.flatMap((claim) => claim.docIds || []))];
  const citations = docIds.map((docId) => refNumber.get(docId)).filter(Boolean);
  const abstractMode = mode === "abstract" || draft.mode === "abstract";
  const topicSentence = abstractMode ? "" : draft.topicSentence || `${section.title}可以围绕“${shortText(plainClaimText(blockClaims[0]?.text || draft.text || "当前证据仍需补充"), 90)}”展开。`;
  const evidenceSentence = abstractMode ? "" : draft.evidenceSentence || evidenceSentenceFor(blockClaims, links);
  const comparisonSentence = abstractMode ? "" : draft.comparisonSentence || comparisonSentenceFor(blockClaims, links);
  const boundarySentence = abstractMode ? "" : draft.boundarySentence || boundarySentenceFor(blockClaims, links);
  const inferenceLevel = draft.inferenceLevel || (docIds.length >= 2 ? "synthesis" : "source_fact");
  const text = cleanText(draft.text || [topicSentence, evidenceSentence, comparisonSentence, boundarySentence].filter(Boolean).join(""));
  return {
    text: abstractMode ? text : withCitations(text, citations),
    topicSentence,
    evidenceSentence,
    comparisonSentence,
    boundarySentence,
    inferenceLevel,
    mode: mode || draft.mode || "",
    claimIds: blockClaims.map((claim) => claim.id),
    citations,
    order: index + 1
  };
}

function isAbstractSection(section = {}) {
  return /^(摘要|abstract)$/i.test(cleanText(section.title));
}

function localAbstractDraft(section, claims) {
  const selected = claims.filter((claim) => claim.status === "supported").slice(0, 6);
  const fallback = claims.slice(0, 6);
  const usable = selected.length ? selected : fallback;
  const topic = shortText(section.purpose || "概括研究主题、方法、主要发现和结论", 80);
  const byField = (patterns) => usable.find((claim) => patterns.some((pattern) => pattern.test(`${claim.fieldKey || ""} ${claim.text || ""}`)))?.text || "";
  const research = byField([/research_question|question|problem|主题|问题|目的/]);
  const method = byField([/method|data|材料|方法|模型|路径|数据/]);
  const finding = byField([/main_claim|contribution|evidence|发现|结论|贡献|证据/]) || usable[0]?.text || "";
  const limitation = byField([/limitation|risk|boundary|局限|风险|边界|不足/]);
  const claimIds = usable.map((claim) => claim.id);
  const parts = [
    research ? `本文围绕${stripLead(research)}展开` : `本文围绕${stripLead(topic)}展开`,
    method ? `在方法上，主要依据${stripLead(method)}组织分析` : "",
    finding ? `研究发现，${stripLead(finding)}` : "",
    limitation ? `同时，${stripLead(limitation)}构成结论外推的主要边界` : ""
  ].filter(Boolean);
  return {
    text: ensureParagraph(parts.join("；")),
    claimIds,
    topicSentence: "",
    evidenceSentence: "",
    comparisonSentence: "",
    boundarySentence: "",
    inferenceLevel: claimIds.length >= 2 ? "synthesis" : "source_fact",
    mode: "abstract"
  };
}

function mergeAbstractDrafts(source, section, claims) {
  const claimIds = [...new Set(source.flatMap((item) => item.claimIds || []))];
  const text = cleanText(source.map((item) => item.text).filter(Boolean).join(" "));
  if (text.length >= 80) {
    return {
      text: ensureParagraph(text),
      claimIds,
      topicSentence: "",
      evidenceSentence: "",
      comparisonSentence: "",
      boundarySentence: "",
      inferenceLevel: source.some((item) => item.inferenceLevel === "synthesis") ? "synthesis" : source[0]?.inferenceLevel || "",
      mode: "abstract"
    };
  }
  return localAbstractDraft(section, claims);
}

function localDraftClaims(section, claims) {
  const supported = claims.filter((claim) => claim.status === "supported");
  const groups = [];
  if (supported.length >= 2) groups.push({ claimIds: supported.slice(0, 3).map((claim) => claim.id) });
  for (const claim of supported.slice(groups.length ? 3 : 0, 8)) groups.push({ claimIds: [claim.id] });
  if (!groups.length && claims[0]) groups.push({ claimIds: [claims[0].id], boundarySentence: "当前段落只有待核对证据，正式写作前需要回到原文确认。" });
  return groups;
}

function evidenceSentenceFor(claims, links) {
  const quote = links.find((item) => item.usable && item.quote)?.quote || links.find((item) => item.quote)?.quote || "";
  if (!quote) return "当前论断缺少可直接引用的原文证据。";
  return `可核对证据显示，${shortText(quote, 120)}`;
}

function comparisonSentenceFor(claims, links) {
  const labels = [...new Set(claims.map((claim) => claim.fieldKey).filter(Boolean))];
  const docs = new Set(links.map((item) => item.docId));
  if (docs.size < 2) return "";
  return `这些资料的可比维度集中在${labels.slice(0, 3).join("、") || "方法、证据和边界"}，因此可以做跨文档综合，而不是单篇复述。`;
}

function boundarySentenceFor(claims, links) {
  const limitation = claims.find((claim) => /limitation|局限|边界|不足|风险/.test(`${claim.fieldKey} ${claim.text}`));
  if (limitation) return `边界上，${shortText(plainClaimText(limitation.text), 100)}`;
  if (links.some((item) => !item.usable)) return "其中部分证据仍需核对，不能作为强结论直接引用。";
  return "";
}

function normalizeModelDraft(modelDraft, claims) {
  if (!Array.isArray(modelDraft)) return null;
  const allowed = new Set(claims.map((claim) => claim.id));
  const normalized = modelDraft.map((item) => ({
    text: cleanText(item.text),
    claimIds: [...new Set((item.claimIds || []).map(String).filter((id) => allowed.has(id)))],
    topicSentence: cleanText(item.topicSentence),
    evidenceSentence: cleanText(item.evidenceSentence),
    comparisonSentence: cleanText(item.comparisonSentence),
    boundarySentence: cleanText(item.boundarySentence),
    inferenceLevel: ["source_fact", "synthesis", "interpretation"].includes(item.inferenceLevel) ? item.inferenceLevel : ""
  })).filter((item) => item.text || item.claimIds.length);
  return normalized.length ? normalized : null;
}

function withCitations(text, citations) {
  const suffix = citations.map((number) => `[${number}]`).join("");
  return suffix && !text.endsWith(suffix) ? `${text}${suffix}` : text;
}

function ensureParagraph(text = "") {
  const clean = cleanText(text).replace(/(?:。\\s*){2,}/g, "。").replace(/[；;，,\s]+。/g, "。");
  return /[。！？!?]$/.test(clean) ? clean : `${clean}。`;
}

function stripLead(text = "") {
  return plainClaimText(text)
    .replace(/^(本文|本研究|该文|作者|研究|文章)\s*/g, "")
    .replace(/^(围绕|针对|旨在|目的在于|提出|构建|分析|探讨|研究|采用|使用|通过|基于)\s*/g, "");
}

function plainClaimText(text = "") {
  return cleanText(text)
    .replace(/^(研究问题|方法路径|数据\/材料|数据与材料|贡献结论|核心主张|结果证据|局限边界|资料定位|可用内容|使用边界|证据|局限|方法|贡献)[:：]\s*/g, "");
}

function shortText(text, limit = 90) {
  const clean = cleanText(text);
  return clean.length > limit ? `${clean.slice(0, limit).replace(/[，,。；;\s]+$/, "")}。` : clean;
}

function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
