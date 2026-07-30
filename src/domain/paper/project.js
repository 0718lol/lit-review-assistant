import { buildTopicClusters } from "./topic-clusters.js";

const PROJECT_TYPES = new Set(["review", "research", "course"]);
const CITATION_STYLES = new Set(["gbt", "apa"]);
const CLAIM_TYPES = new Set(["source_fact", "synthesis", "inference", "proposal"]);

export function createPaperProject(input = {}, context = {}) {
  const now = context.now || new Date().toISOString();
  const docIds = uniqueStrings(input.documentIds);
  return {
    id: requiredText(context.id, "project id"),
    title: cleanText(input.title) || "未命名综述项目",
    topic: cleanText(input.topic),
    paperType: PROJECT_TYPES.has(input.paperType) ? input.paperType : "review",
    targetJournal: cleanText(input.targetJournal),
    language: input.language === "en" ? "en" : "zh-CN",
    targetWords: clampNumber(input.targetWords, 800, 30000, 5000),
    citationStyle: CITATION_STYLES.has(input.citationStyle) ? input.citationStyle : "gbt",
    documentIds: docIds,
    activeThesisId: "",
    theses: [],
    activeClusterId: "",
    topicClusters: [],
    outline: [],
    claims: [],
    evidenceLinks: [],
    draftBlocks: [],
    references: [],
    generationNotice: "",
    audit: emptyAudit(),
    revisions: [],
    createdAt: now,
    updatedAt: now
  };
}

export function updatePaperProject(project, patch = {}, now = new Date().toISOString()) {
  const next = structuredClone(project);
  if (Object.hasOwn(patch, "title")) next.title = cleanText(patch.title) || next.title;
  if (Object.hasOwn(patch, "topic")) next.topic = cleanText(patch.topic);
  if (PROJECT_TYPES.has(patch.paperType)) next.paperType = patch.paperType;
  if (Object.hasOwn(patch, "targetJournal")) next.targetJournal = cleanText(patch.targetJournal);
  if (["zh-CN", "en"].includes(patch.language)) next.language = patch.language;
  if (Object.hasOwn(patch, "targetWords")) next.targetWords = clampNumber(patch.targetWords, 800, 30000, next.targetWords);
  if (CITATION_STYLES.has(patch.citationStyle)) next.citationStyle = patch.citationStyle;
  if (Array.isArray(patch.documentIds)) next.documentIds = uniqueStrings(patch.documentIds);
  if (Object.hasOwn(patch, "activeThesisId")) next.activeThesisId = cleanText(patch.activeThesisId);
  next.updatedAt = now;
  return next;
}

export function buildClaimInventory(project, documents = []) {
  const claims = [];
  const evidenceLinks = [];
  const references = [];
  documents.forEach((doc, docIndex) => {
    const card = doc.evidenceCard || {};
    references.push(referenceForDocument(doc, docIndex + 1));
    const fields = card.document_kind === "teaching_or_reference_material"
      ? referenceMaterialFields(doc, card)
      : [
      ["research_question", "研究问题", card.research_question],
      ["method", "方法", card.method],
      ["data_or_materials", "数据与材料", card.data_or_materials],
      ["contribution", "贡献", card.contribution],
      ...asItems(card.main_claims).map((item, index) => [`main_claim_${index + 1}`, "核心发现", item]),
      ...asItems(card.evidence).map((item, index) => [`evidence_${index + 1}`, "结果证据", item]),
      ...asItems(card.limitations).map((item, index) => [`limitation_${index + 1}`, "局限", item])
    ];
    fields.forEach(([fieldKey, label, item], index) => {
      if (!item || !cleanText(item.claim || item.normalized_claim || item.quote)) return;
      const evidenceId = stableId("evidence", doc.id, fieldKey, index);
      const claimId = stableId("claim", doc.id, fieldKey, index);
      const audit = cleanText(item.audit || item.dimension_audit || "needs_review");
      const usable = item.is_usable === true || (/supported|strong/i.test(audit) && item.direct_quote_eligible !== false);
      evidenceLinks.push({
        id: evidenceId,
        docId: doc.id,
        fieldKey,
        label,
        quote: cleanText(item.quote || ""),
        page: Number(item.page || 0),
        citation: cleanText(item.citation || sourceCitation(doc, item.page)),
        confidence: Number(item.confidence || 0),
        audit,
        usable,
        relation: "supports"
      });
      claims.push({
        id: claimId,
        text: cleanText(item.claim || item.normalized_claim || item.quote),
        type: "source_fact",
        status: usable ? "supported" : "needs_review",
        fieldKey,
        docIds: [doc.id],
        evidenceLinkIds: [evidenceId],
        sectionId: ""
      });
    });
  });
  return { claims, evidenceLinks, references, topicClusters: buildTopicClusters(documents, claims) };
}

export function auditPaperProject(project) {
  const documentIds = new Set(project.documentIds || []);
  const evidenceById = new Map((project.evidenceLinks || []).map((item) => [item.id, item]));
  const claimById = new Map((project.claims || []).map((item) => [item.id, item]));
  const issues = [];
  for (const claim of project.claims || []) {
    if (!CLAIM_TYPES.has(claim.type)) issues.push(issue("blocker", "invalid_claim_type", `论断“${claim.text}”的类型无效。`, claim.id));
    const links = (claim.evidenceLinkIds || []).map((id) => evidenceById.get(id)).filter(Boolean);
    if (claim.type === "source_fact" && !links.length) issues.push(issue("blocker", "unsupported_claim", `事实性论断“${claim.text}”没有关联原文证据。`, claim.id));
    if (links.some((link) => !documentIds.has(link.docId))) issues.push(issue("blocker", "source_out_of_scope", `论断“${claim.text}”引用了项目范围外的文献。`, claim.id));
    if (links.length && links.every((link) => !link.usable)) issues.push(issue("warning", "weak_evidence", `论断“${claim.text}”目前只有待核对证据。`, claim.id));
  }
  for (const block of project.draftBlocks || []) {
    const claims = (block.claimIds || []).map((id) => claimById.get(id)).filter(Boolean);
    if (block.text && !claims.length) issues.push(issue("warning", "unmapped_paragraph", "正文段落没有关联论断，需人工核对。", block.id));
    if (claims.some((claim) => claim.type === "source_fact") && !(block.citations || []).length) issues.push(issue("blocker", "missing_citation", "事实性段落缺少正文引用。", block.id));
    if (block.inferenceLevel === "synthesis" && new Set(claims.flatMap((claim) => claim.docIds || [])).size < 2) issues.push(issue("warning", "thin_synthesis", "综合段落至少需要两篇资料支撑，否则应降级为单篇事实。", block.id));
    if (block.inferenceLevel === "interpretation" && !cleanText(block.boundarySentence)) issues.push(issue("warning", "missing_boundary", "解释性段落需要写明证据边界。", block.id));
  }
  const usedDocIds = new Set((project.evidenceLinks || []).filter((link) => link.usable).map((link) => link.docId));
  for (const reference of project.references || []) {
    if (!usedDocIds.has(reference.docId)) issues.push(issue("info", "unused_reference", `参考文献“${reference.title}”尚未用于可用证据。`, reference.id));
  }
  const counts = { blocker: 0, warning: 0, info: 0 };
  issues.forEach((item) => { counts[item.severity] += 1; });
  return { status: counts.blocker ? "blocked" : counts.warning ? "needs_review" : "ready", counts, issues, checkedAt: new Date().toISOString() };
}

export function projectImpact(project, documentIds = []) {
  const removed = new Set(uniqueStrings(documentIds));
  const evidence = (project.evidenceLinks || []).filter((item) => removed.has(item.docId));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const claims = (project.claims || []).filter((item) => (item.evidenceLinkIds || []).some((id) => evidenceIds.has(id)));
  const claimIds = new Set(claims.map((item) => item.id));
  const blocks = (project.draftBlocks || []).filter((item) => (item.claimIds || []).some((id) => claimIds.has(id)));
  const sections = (project.outline || []).filter((item) => blocks.some((block) => block.sectionId === item.id));
  return { documentIds: [...removed], evidence, claims, blocks, sections };
}

export function emptyAudit() {
  return { status: "not_run", counts: { blocker: 0, warning: 0, info: 0 }, issues: [], checkedAt: "" };
}

function referenceForDocument(doc, index) {
  const meta = doc.sourceMeta || {};
  return { id: `ref-${doc.id}`, docId: doc.id, number: index, title: cleanText(doc.title), authors: doc.authors || meta.authors || [], year: doc.publicationYear || meta.publicationYear || "", journal: meta.journal || doc.journal || "", doi: meta.doi || "" };
}

function referenceMaterialFields(doc, card) {
  const title = cleanText(doc.title || doc.filename || "这份资料");
  const quote = referenceQuote(doc, card);
  const page = Number(quote.page || 0);
  const base = { quote: quote.text, page, confidence: quote.text ? 0.82 : 0.45, audit: quote.text ? "dimension_supported" : "needs_review", is_usable: Boolean(quote.text) };
  const summary = cleanText(doc.fullSummary || doc.abstract || card.summary || "");
  const isGuide = /综述|写作|literature review|review writing|writing guide|论文|格式|规范/i.test(`${title} ${summary}`);
  const materialLabel = isGuide ? "写作指导资料" : "背景参考资料";
  return [
    ["reference_summary", "资料定位", {
      ...base,
      claim: `${title}应作为${materialLabel}使用，用来说明写作目标、组织方式或资料使用边界，而不是直接当作某一研究领域的实证结论。`
    }],
    ["reference_use", "可用内容", {
      ...base,
      claim: isGuide
        ? `${title}可用于设计综述结构、解释文献筛选和证据组织方式，并帮助区分资料汇总、观点比较与研究判断。`
        : `${title}可用于交代概念背景、规范说明或写作依据，但需要和研究论文证据分开呈现。`
    }],
    ["reference_boundary", "使用边界", {
      ...base,
      claim: `${title}不能单独推出跨文档研究共识、方法效果或研究空白；这些判断至少需要两篇以上同主题研究文献共同支撑。`
    }]
  ];
}

function referenceQuote(doc, card) {
  const items = [
    ...asItems(card.evidence_candidates),
    ...asItems(card.main_claims),
    ...asItems(card.evidence),
    card.method,
    card.research_question,
    card.contribution,
    ...asItems(doc.keyPoints).map((text) => ({ quote: text })),
    ...asItems(doc.chunks).slice(0, 4).map((chunk) => ({ quote: chunk.text, page: chunk.page }))
  ].filter(Boolean);
  const found = items.find((item) => cleanText(item.quote || item.text || item.normalized_claim || item.claim).length >= 25);
  return { text: cleanText(found?.quote || found?.text || found?.normalized_claim || found?.claim || doc.abstract || ""), page: Number(found?.page || 0) };
}

function sourceCitation(doc, page) {
  const position = page ? `, ${doc.sourceType === "pptx" ? "slide" : "p."} ${page}` : "";
  return `${cleanText(doc.title || doc.filename)}${position}`;
}

function issue(severity, code, message, targetId) { return { severity, code, message, targetId }; }
function asItems(value) { return Array.isArray(value) ? value : []; }
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function requiredText(value, label) { const text = cleanText(value); if (!text) throw new Error(`${label} is required.`); return text; }
function uniqueStrings(values) { return [...new Set((Array.isArray(values) ? values : []).map(cleanText).filter(Boolean))]; }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback; }
function stableId(prefix, docId, field, index) { return `${prefix}-${cleanText(docId).replace(/[^a-zA-Z0-9_-]/g, "-")}-${field}-${index}`; }
