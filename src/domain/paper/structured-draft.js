export function buildStructuredDrafts({ section = {}, claims = [], evidenceLinks = [], references = [], modelDraft = null }) {
  const evidenceById = new Map(evidenceLinks.map((item) => [item.id, item]));
  const refNumber = new Map(references.map((item) => [item.docId, item.number]));
  const source = normalizeModelDraft(modelDraft, claims);
  const draftClaims = source?.length ? source : localDraftClaims(section, claims);
  return draftClaims.map((draft, index) => structuredBlockDraft({ section, draft, claims, evidenceById, refNumber, index }));
}

function structuredBlockDraft({ section, draft, claims, evidenceById, refNumber, index }) {
  const allowed = new Map(claims.map((claim) => [claim.id, claim]));
  const blockClaims = [...new Set(draft.claimIds || [])].map((id) => allowed.get(id)).filter(Boolean);
  const links = blockClaims.flatMap((claim) => (claim.evidenceLinkIds || []).map((id) => evidenceById.get(id)).filter(Boolean));
  const docIds = [...new Set(blockClaims.flatMap((claim) => claim.docIds || []))];
  const citations = docIds.map((docId) => refNumber.get(docId)).filter(Boolean);
  const topicSentence = draft.topicSentence || `${section.title}的核心判断是：${shortText(blockClaims[0]?.text || draft.text || "当前证据仍需补充")}`;
  const evidenceSentence = draft.evidenceSentence || evidenceSentenceFor(blockClaims, links);
  const comparisonSentence = draft.comparisonSentence || comparisonSentenceFor(blockClaims, links);
  const boundarySentence = draft.boundarySentence || boundarySentenceFor(blockClaims, links);
  const inferenceLevel = draft.inferenceLevel || (docIds.length >= 2 ? "synthesis" : "source_fact");
  const text = cleanText(draft.text || [topicSentence, evidenceSentence, comparisonSentence, boundarySentence].filter(Boolean).join(""));
  return {
    text: withCitations(text, citations),
    topicSentence,
    evidenceSentence,
    comparisonSentence,
    boundarySentence,
    inferenceLevel,
    claimIds: blockClaims.map((claim) => claim.id),
    citations,
    order: index + 1
  };
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
  if (limitation) return `边界上，${shortText(limitation.text, 100)}`;
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

function shortText(text, limit = 90) {
  const clean = cleanText(text);
  return clean.length > limit ? `${clean.slice(0, limit).replace(/[，,。；;\s]+$/, "")}。` : clean;
}

function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
