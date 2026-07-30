import {
  auditPaperProject,
  buildClaimInventory,
  createPaperProject,
  emptyAudit,
  projectImpact,
  updatePaperProject
} from "../../domain/paper/project.js";
import { buildStructuredDrafts } from "../../domain/paper/structured-draft.js";
import { dominantCluster } from "../../domain/paper/topic-clusters.js";
import { createSerialExecutor } from "../../shared/async/serial-executor.js";

export function createPaperProjectService({ repository, loadDocuments, createId, createDocx, writeSection = async () => null, now = () => new Date().toISOString() }) {
  if (!repository || typeof loadDocuments !== "function" || typeof createId !== "function" || typeof createDocx !== "function") throw new Error("paper project service dependencies are required.");
  const mutations = createSerialExecutor();

  async function list() { return repository.list(); }

  async function get(id) {
    const project = await repository.get(id);
    if (!project) throw notFound();
    return project;
  }

  async function create(input = {}) {
    return mutations.run(async () => {
      const docs = await selectedDocuments(input.documentIds);
      if (!docs.length) throw badRequest("请至少选择一篇资料创建综述项目。");
      let project = createPaperProject(input, { id: createId(), now: now() });
      project.documentIds = docs.map((doc) => doc.id);
      project = refreshInventory(project, docs);
      project.revisions.push(revision("created", "创建综述项目", project));
      return repository.save(project);
    });
  }

  async function update(id, patch = {}) {
    return mutations.run(async () => {
      let project = await get(id);
      const documentsChanged = Array.isArray(patch.documentIds) && !sameIds(project.documentIds, patch.documentIds);
      project = updatePaperProject(project, patch, now());
      if (documentsChanged) {
        const docs = await selectedDocuments(project.documentIds);
        if (!docs.length) throw badRequest("综述项目至少需要保留一篇资料。");
        project.documentIds = docs.map((doc) => doc.id);
        project = refreshInventory(project, docs);
        project.outline = [];
        project.draftBlocks = [];
        project.audit = emptyAudit();
      }
      project.revisions.push(revision("updated", "更新项目设置", project));
      return repository.save(project);
    });
  }

  async function remove(id) {
    return mutations.run(async () => {
      if (!await repository.remove(id)) throw notFound();
      return { ok: true, id };
    });
  }

  async function suggestTheses(id) {
    return mutate(id, "theses_generated", "生成候选论点", async (project) => {
      const cluster = dominantCluster(project);
      const clusterClaimIds = new Set(cluster?.claimIds || []);
      const supported = project.claims.filter((claim) => claim.status === "supported" && (!clusterClaimIds.size || clusterClaimIds.has(claim.id)));
      const subject = writingSubject(project, cluster);
      const anchors = supported.slice(0, 6);
      const evidenceDocIds = [...new Set(anchors.flatMap((claim) => claim.docIds))];
      const claimText = anchors.map((claim) => trimClaim(claim.text, 42));
      const scopeNote = cluster ? `${cluster.label} · ${cluster.writingMode}` : "未识别主题簇";
      const theses = thesisBlueprints(subject, cluster, claimText).map((item, index) => ({
        ...item,
        id: createId(),
        rank: index + 1,
        clusterId: cluster?.id || "",
        scopeNote,
        claimIds: anchors.map((claim) => claim.id),
        documentIds: evidenceDocIds,
        evidenceStatus: anchors.length >= Math.min(3, Math.max(1, evidenceDocIds.length)) ? "supported" : "needs_review"
      }));
      project.theses = theses;
      project.activeThesisId = theses[0].id;
      project.activeClusterId = cluster?.id || "";
      project.generationNotice = projectScopeMismatch(project, cluster)
        ? `项目名称或主题与已选文献范围不一致，系统已按“${subject}”组织候选论点；建议同步修改项目名称或重新选择文献。`
        : "";
      return project;
    });
  }

  async function generateOutline(id) {
    return mutate(id, "outline_generated", "生成综述大纲", async (project) => {
      if (!project.theses.length) throw badRequest("请先生成并选择中心论点。");
      const targetWords = project.targetWords || 5000;
      const specs = outlineSpecs(project.paperType);
      project.outline = specs.map((spec, index) => ({
        id: createId(),
        order: index + 1,
        title: spec.title,
        purpose: spec.purpose,
        targetWords: Math.max(120, Math.round(targetWords * spec.ratio)),
        status: "planned",
        claimIds: sectionClaims(project.claims, spec).slice(0, 12).map((claim) => claim.id),
        locked: false
      }));
      project.draftBlocks = [];
      project.audit = emptyAudit();
      return project;
    });
  }

  async function generateSection(id, sectionId) {
    return mutate(id, "section_generated", "生成综述章节", async (project) => {
      const section = project.outline.find((item) => item.id === sectionId);
      if (!section) throw badRequest("章节不存在。");
      if (section.locked) throw conflict("这个章节已锁定，不能自动覆盖。");
      const claimById = new Map(project.claims.map((item) => [item.id, item]));
      const refNumber = new Map(project.references.map((item) => [item.docId, item.number]));
      const selected = selectSectionClaims(project, section, claimById).slice(0, 8);
      let modelDraft = null;
      try {
        modelDraft = await writeSection({ project, section, claims: selected, evidenceLinks: project.evidenceLinks, references: project.references });
        project.generationNotice = "";
      } catch (error) {
        project.generationNotice = `模型增强失败，已使用本地证据编排：${cleanText(error.message || "连接失败")}`;
      }
      const drafts = buildStructuredDrafts({ section, claims: selected, evidenceLinks: project.evidenceLinks, references: project.references, modelDraft });
      const blocks = drafts.map((draft, index) => {
        const blockClaims = draft.claimIds.map((claimId) => claimById.get(claimId)).filter(Boolean);
        const citations = draft.citations?.length ? draft.citations : [...new Set(blockClaims.flatMap((claim) => claim.docIds).map((docId) => refNumber.get(docId)).filter(Boolean))];
        return { id: createId(), sectionId, order: index + 1, text: draft.text, topicSentence: draft.topicSentence, evidenceSentence: draft.evidenceSentence, comparisonSentence: draft.comparisonSentence, boundarySentence: draft.boundarySentence, inferenceLevel: draft.inferenceLevel, mode: draft.mode || "", claimIds: blockClaims.map((claim) => claim.id), citations, locked: false, origin: modelDraft ? "model" : "generated", updatedAt: now() };
      });
      if (!blocks.length) {
        const fallbackClaims = selectSectionClaims(project, section, claimById, true).slice(0, 3);
        const citations = [...new Set(fallbackClaims.flatMap((claim) => claim.docIds).map((docId) => refNumber.get(docId)).filter(Boolean))];
        blocks.push({
          id: createId(),
          sectionId,
          order: 1,
          text: fallbackSectionParagraph(section, fallbackClaims, citations),
          topicSentence: `${section.title}需要围绕“${cleanText(section.purpose || project.topic || project.title)}”展开。`,
          evidenceSentence: fallbackClaims.length ? `当前可用材料包括：${fallbackClaims.map((claim) => trimClaim(claim.text, 48)).join("；")}。` : "当前项目缺少可核对证据，只能形成写作提示。",
          comparisonSentence: "",
          boundarySentence: "正式写作前需要回到右侧证据核对来源，避免把单篇资料写成跨文档共识。",
          inferenceLevel: fallbackClaims.length >= 2 ? "synthesis" : "interpretation",
          claimIds: fallbackClaims.map((claim) => claim.id),
          citations,
          locked: false,
          origin: "generated",
          updatedAt: now()
        });
      }
      project.draftBlocks = project.draftBlocks.filter((item) => item.sectionId !== sectionId).concat(blocks);
      section.status = blocks.some((block) => !block.claimIds.length) ? "needs_evidence" : "drafted";
      project.audit = auditPaperProject(project);
      return project;
    });
  }

  async function updateSection(id, sectionId, patch = {}) {
    return mutate(id, "section_updated", "编辑综述大纲", async (project) => {
      const section = project.outline.find((item) => item.id === sectionId);
      if (!section) throw badRequest("章节不存在。");
      if (Object.hasOwn(patch, "title")) section.title = cleanText(patch.title) || section.title;
      if (Object.hasOwn(patch, "purpose")) section.purpose = cleanText(patch.purpose);
      if (Object.hasOwn(patch, "targetWords")) section.targetWords = Math.max(100, Math.min(10000, Number(patch.targetWords) || section.targetWords));
      if (Object.hasOwn(patch, "locked")) section.locked = Boolean(patch.locked);
      return project;
    });
  }

  async function updateBlock(id, blockId, patch = {}) {
    return mutate(id, "block_updated", "编辑正文段落", async (project) => {
      const block = project.draftBlocks.find((item) => item.id === blockId);
      if (!block) throw badRequest("正文段落不存在。");
      if (Object.hasOwn(patch, "text")) block.text = cleanText(patch.text);
      if (Object.hasOwn(patch, "locked")) block.locked = Boolean(patch.locked);
      block.origin = "edited";
      block.updatedAt = now();
      project.audit = emptyAudit();
      return project;
    });
  }

  async function runAudit(id) {
    return mutate(id, "audit_run", "运行综述审计", async (project) => {
      project.audit = auditPaperProject(project);
      return project;
    });
  }

  async function impact(id, documentIds) { return projectImpact(await get(id), documentIds); }

  async function restoreRevision(id, revisionId) {
    return mutate(id, "revision_restored", "恢复综述项目版本", async (project) => {
      const target = project.revisions.find((item) => item.id === revisionId);
      if (!target?.snapshot) throw badRequest("这个历史版本不能恢复。");
      Object.assign(project, structuredClone(target.snapshot));
      return project;
    });
  }

  async function exportMarkdown(id) {
    const project = await get(id);
    const blocks = new Map(project.outline.map((section) => [section.id, project.draftBlocks.filter((block) => block.sectionId === section.id).sort((a, b) => a.order - b.order)]));
    const body = project.outline.flatMap((section) => [`## ${section.title}`, "", ...(blocks.get(section.id) || []).map((block) => block.text), ""]);
    const references = project.references.map((ref) => `[${ref.number}] ${formatReference(ref, project.citationStyle)}`);
    const audit = project.audit?.status === "ready" ? "" : `\n> 证据审计状态：${project.audit?.status || "not_run"}\n`;
    return `# ${project.title}\n\n${body.join("\n")}\n## 参考文献\n\n${references.join("\n")}\n${audit}`;
  }

  async function exportDocx(id) { return createDocx(await get(id)); }

  async function mutate(id, type, summary, operation) {
    return mutations.run(async () => {
      let project = await get(id);
      project = await operation(structuredClone(project));
      project.updatedAt = now();
      project.revisions.push(revision(type, summary, project));
      project.revisions = project.revisions.slice(-30);
      return repository.save(project);
    });
  }

  async function selectedDocuments(ids) {
    const allowed = new Set((Array.isArray(ids) ? ids : []).map(String));
    const documents = await loadDocuments();
    return documents.filter((doc) => allowed.has(doc.id));
  }

  return Object.freeze({ list, get, create, update, remove, suggestTheses, generateOutline, generateSection, updateSection, updateBlock, runAudit, impact, restoreRevision, exportMarkdown, exportDocx });
}

function refreshInventory(project, docs) { const inventory = buildClaimInventory(project, docs); return { ...project, ...inventory, updatedAt: new Date().toISOString() }; }
function revision(type, summary, project) { return { id: `${project.id}-${Date.now()}-${project.revisions.length + 1}`, type, summary, documentCount: project.documentIds.length, sectionCount: project.outline.length, draftBlockCount: project.draftBlocks.length, createdAt: new Date().toISOString(), snapshot: projectSnapshot(project) }; }
function projectSnapshot(project) { return structuredClone({ title: project.title, topic: project.topic, paperType: project.paperType, targetJournal: project.targetJournal, language: project.language, targetWords: project.targetWords, citationStyle: project.citationStyle, documentIds: project.documentIds, activeThesisId: project.activeThesisId, activeClusterId: project.activeClusterId, theses: project.theses, topicClusters: project.topicClusters, outline: project.outline, claims: project.claims, evidenceLinks: project.evidenceLinks, draftBlocks: project.draftBlocks, references: project.references, generationNotice: project.generationNotice, audit: project.audit }); }
function matchingClaims(claims, fields) { return claims.filter((claim) => fields.some((field) => claim.fieldKey.includes(field))); }
function sectionClaims(claims, spec) {
  const direct = matchingClaims(claims, spec.fields || []);
  if (direct.length) return direct;
  const title = `${spec.title || ""} ${spec.purpose || ""}`;
  const fallback = claims.filter((claim) => sectionRelevanceScore(claim, title) > 0).sort((a, b) => sectionRelevanceScore(b, title) - sectionRelevanceScore(a, title));
  return fallback.length ? fallback : claims;
}
function selectSectionClaims(project, section, claimById, includeAll = false) {
  const bound = (section.claimIds || []).map((claimId) => claimById.get(claimId)).filter(Boolean);
  if (bound.length) return bound;
  const ranked = (project.claims || []).filter(Boolean).sort((a, b) => sectionRelevanceScore(b, `${section.title} ${section.purpose}`) - sectionRelevanceScore(a, `${section.title} ${section.purpose}`));
  const relevant = ranked.filter((claim) => sectionRelevanceScore(claim, `${section.title} ${section.purpose}`) > 0);
  return relevant.length || !includeAll ? relevant : ranked;
}
function sectionRelevanceScore(claim, sectionText) {
  const text = `${claim.fieldKey || ""} ${claim.text || ""}`;
  let score = claim.status === "supported" ? 2 : 1;
  if (/摘要|结论|展望/.test(sectionText) && /main_claim|contribution|reference_summary|reference_use|limitation/.test(text)) score += 4;
  if (/引言|背景|价值|结构/.test(sectionText) && /research_question|contribution|reference_summary|reference_use/.test(text)) score += 4;
  if (/主题|理论|脉络|核心|论述/.test(sectionText) && /research_question|contribution|main_claim|reference_summary|reference_use/.test(text)) score += 3;
  if (/方法|证据|比较|案例|讨论|结果/.test(sectionText) && /method|data_or_materials|evidence|main_claim|reference_use/.test(text)) score += 4;
  if (/局限|空白|边界|不足/.test(sectionText) && /limitation|reference_boundary|risk|boundary/.test(text)) score += 5;
  if (/结论|展望|方向/.test(sectionText) && /main_claim|contribution|limitation|reference_boundary|reference_use/.test(text)) score += 3;
  return score;
}
function fallbackSectionParagraph(section, claims, citations = []) {
  const suffix = citations.length ? citations.map((number) => `[${number}]`).join("") : "";
  if (!claims.length) return `本节应围绕${cleanText(section.purpose || section.title)}展开，但当前项目还缺少可核对证据。请先补充文献解析结果或在右侧绑定证据后再扩写。`;
  const lead = `${section.title}可以先围绕${cleanText(section.purpose || "本节目标")}组织论述`;
  const evidence = claims.map((claim) => trimClaim(claim.text, 70)).join("；");
  return `${lead}。现有资料可支持的内容包括：${evidence}。写作时应把可直接引用的原文事实和跨文档综合判断分开呈现，不能把单篇资料直接扩展成领域共识。${suffix}`;
}
function writingSubject(project, cluster) {
  const topic = cleanText(project.topic);
  if (topic && projectTextMatchesCluster(topic, cluster)) return topic;
  if (topic && cluster?.label) return cluster.label;
  const title = cleanText(project.title);
  return projectTextMatchesCluster(title, cluster) ? title : cleanText(cluster?.label || topic || title);
}
function projectScopeMismatch(project, cluster) {
  const text = cleanText(project.topic || project.title);
  return Boolean(cluster?.label && text && !projectTextMatchesCluster(text, cluster));
}
function projectTextMatchesCluster(text, cluster) {
  const clean = cleanText(text);
  if (!clean || !cluster) return true;
  if (cluster.label && clean.includes(cluster.label)) return true;
  const terms = new Set((clean.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9-]{2,}/g) || []).filter((term) => !/^(项目|论文|综述|研究|文献|分析|报告|课程|毕业|the|and|for|with)$/i.test(term)));
  const clusterTerms = [cluster.label, ...(cluster.keywords || [])].flatMap((item) => cleanText(item).match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9-]{2,}/g) || []);
  return clusterTerms.some((term) => terms.has(term) || clean.includes(term));
}
function outlineSpecs(type) {
  if (type === "research") return baseSpecs(["研究设计", "method|data_or_materials", 0.2], ["研究结果", "main_claim|evidence", 0.25]);
  if (type === "course") return baseSpecs(["核心论述", "main_claim|contribution", 0.3], ["案例与讨论", "evidence|limitation", 0.2]);
  return baseSpecs(["研究主题与理论脉络", "research_question|contribution", 0.23], ["方法与证据比较", "method|data_or_materials|evidence", 0.27]);
}
function baseSpecs(middleA, middleB) { return [
  { title: "摘要", purpose: "概括研究主题、方法、主要发现和结论。", ratio: 0.06, fields: ["main_claim", "contribution"] },
  { title: "1 引言", purpose: "说明问题背景、研究价值和论文结构。", ratio: 0.14, fields: ["research_question", "contribution"] },
  { title: `2 ${middleA[0]}`, purpose: "组织核心概念和已有研究。", ratio: middleA[2], fields: middleA[1].split("|") },
  { title: `3 ${middleB[0]}`, purpose: "比较文献的主要证据、共识与差异。", ratio: middleB[2], fields: middleB[1].split("|") },
  { title: "4 局限与研究空白", purpose: "陈述证据边界、研究局限和待解决问题。", ratio: 0.18, fields: ["limitation"] },
  { title: "5 结论与展望", purpose: "回到中心论点并提出后续方向。", ratio: 0.12, fields: ["main_claim", "contribution", "limitation"] }
]; }
function formatReference(ref, style) { const authors = ref.authors.join(", ") || "作者待核对"; return style === "apa" ? `${authors}. (${ref.year || "n.d."}). ${ref.title}. ${ref.journal}.` : `${authors}. ${ref.title}[J]. ${ref.journal || "来源待核对"}, ${ref.year || "年份待核对"}.`; }
function thesisBlueprints(subject, cluster, claimText) {
  const label = cluster?.label || subject;
  const anchors = claimText.filter(Boolean);
  const basis = anchors.length ? `已有证据集中指向“${anchors.slice(0, 2).join("；")}”` : "当前证据仍需补充";
  if (cluster?.scope === "single_source_boundary") return [
    { title: `${label}的单篇文献述评`, statement: `${label}目前只能形成单篇述评：${basis}，但不足以直接推出跨文档综合结论。`, rationale: "适合先写单篇述评，再补充同类文献。" },
    { title: `${label}的证据边界`, statement: `${label}的可写内容应限制在已核对证据内，重点说明方法、材料和局限，而不是扩展成领域综述。`, rationale: "避免把单篇资料误写成领域共识。" },
    { title: `${label}的后续补文献方向`, statement: `${label}若要升级为开题或综述，需要补充至少两篇同域、方法或证据可比的文献。`, rationale: "适合作为后续检索和补充阅读计划。" }
  ];
  if (cluster?.scope === "cross_domain_methodology") return [
    { title: `${label}的方法论比较`, statement: `${subject}可以从方法论层面比较不同场景的证据链：${basis}，但不能把跨域材料强行合并为同一个具体研究对象。`, rationale: "适合跨领域方法启发。" },
    { title: `${label}的证据强弱差异`, statement: `${label}的关键差异不在主题是否一致，而在数据来源、评价指标和可复现性是否足以支撑相似结论。`, rationale: "适合写方法和证据质量评述。" },
    { title: `${label}的迁移边界`, statement: `${label}只能形成方法迁移或比较启发，具体结论必须回到各自领域单独论证。`, rationale: "明确跨域写作边界。" }
  ];
  return [
    { title: `${label}的综合研究脉络`, statement: `${subject}可以围绕${label}形成综合综述：${basis}，并进一步比较不同文献的方法、证据和适用边界。`, rationale: "适合以主题为主线组织综述。" },
    { title: `${label}的方法与证据比较`, statement: `${label}的研究价值取决于方法路径是否清楚、数据材料是否可核对、结果证据是否足以支持结论。`, rationale: "适合突出方法比较和证据审计。" },
    { title: `${label}的研究空白`, statement: `${label}的下一步突破应聚焦可复现证据、边界条件和跨文档差异，而不是简单累加单篇摘要。`, rationale: "适合问题导向或展望型论文。" }
  ];
}
function trimClaim(text, limit) { const clean = cleanText(text).replace(/^(研究问题|方法路径|数据\/材料|贡献结论|证据|局限边界)[:：]/, ""); return clean.length > limit ? `${clean.slice(0, limit).replace(/[，,。；;\s]+$/, "")}。` : clean; }
function sameIds(left = [], right = []) { const a = [...new Set(left.map(String))].sort(); const b = [...new Set(right.map(String))].sort(); return a.length === b.length && a.every((value, index) => value === b[index]); }
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function badRequest(message) { return httpError(400, message); }
function notFound() { return httpError(404, "综述项目不存在。"); }
function conflict(message) { return httpError(409, message); }
