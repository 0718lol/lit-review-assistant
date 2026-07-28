import {
  auditPaperProject,
  buildClaimInventory,
  createPaperProject,
  emptyAudit,
  projectImpact,
  updatePaperProject
} from "../../domain/paper/project.js";
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
      if (!docs.length) throw badRequest("请至少选择一篇资料创建论文项目。");
      let project = createPaperProject(input, { id: createId(), now: now() });
      project.documentIds = docs.map((doc) => doc.id);
      project = refreshInventory(project, docs);
      project.revisions.push(revision("created", "创建论文项目", project));
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
        if (!docs.length) throw badRequest("论文项目至少需要保留一篇资料。");
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
      const supported = project.claims.filter((claim) => claim.status === "supported");
      const subject = project.topic || project.title;
      const anchors = supported.slice(0, 6);
      const evidenceDocIds = [...new Set(anchors.flatMap((claim) => claim.docIds))];
      const theses = [
        { id: createId(), title: `${subject}的主要研究路径与证据`, statement: `${subject}领域已经形成若干可比较的研究路径，但不同研究在方法、证据和适用边界上仍存在明显差异。`, rationale: "适合以主题为主线组织综述。" },
        { id: createId(), title: `${subject}的方法比较与局限`, statement: `现有研究对${subject}提出了多种方法，但证据强度、数据来源和外部有效性决定了这些方法不能被简单合并。`, rationale: "适合突出方法比较和证据边界。" },
        { id: createId(), title: `${subject}的研究缺口与后续方向`, statement: `${subject}的下一步突破依赖于更透明的证据链、可复现评估和对现有局限的系统回应。`, rationale: "适合问题导向或展望型论文。" }
      ].map((item, index) => ({ ...item, rank: index + 1, claimIds: anchors.map((claim) => claim.id), documentIds: evidenceDocIds, evidenceStatus: anchors.length >= 3 ? "supported" : "needs_review" }));
      project.theses = theses;
      project.activeThesisId = theses[0].id;
      return project;
    });
  }

  async function generateOutline(id) {
    return mutate(id, "outline_generated", "生成论文大纲", async (project) => {
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
        claimIds: matchingClaims(project.claims, spec.fields).slice(0, 12).map((claim) => claim.id),
        locked: false
      }));
      project.draftBlocks = [];
      project.audit = emptyAudit();
      return project;
    });
  }

  async function generateSection(id, sectionId) {
    return mutate(id, "section_generated", "生成论文章节", async (project) => {
      const section = project.outline.find((item) => item.id === sectionId);
      if (!section) throw badRequest("章节不存在。");
      if (section.locked) throw conflict("这个章节已锁定，不能自动覆盖。");
      const claimById = new Map(project.claims.map((item) => [item.id, item]));
      const refNumber = new Map(project.references.map((item) => [item.docId, item.number]));
      const selected = section.claimIds.map((claimId) => claimById.get(claimId)).filter(Boolean).slice(0, 8);
      let modelDraft = null;
      try {
        modelDraft = await writeSection({ project, section, claims: selected, evidenceLinks: project.evidenceLinks, references: project.references });
        project.generationNotice = "";
      } catch (error) {
        project.generationNotice = `模型增强失败，已使用本地证据编排：${cleanText(error.message || "连接失败")}`;
      }
      const drafts = modelDraft || selected.map((claim, index) => ({ claimIds: [claim.id], text: `${index === 0 ? `${section.title}需要首先明确：` : "现有资料进一步表明，"}${claim.text}` }));
      const blocks = drafts.map((draft, index) => {
        const blockClaims = draft.claimIds.map((claimId) => claimById.get(claimId)).filter(Boolean);
        const citations = [...new Set(blockClaims.flatMap((claim) => claim.docIds).map((docId) => refNumber.get(docId)).filter(Boolean))];
        const suffix = citations.map((number) => `[${number}]`).join("");
        return { id: createId(), sectionId, order: index + 1, text: `${draft.text}${suffix}`, claimIds: blockClaims.map((claim) => claim.id), citations, locked: false, origin: modelDraft ? "model" : "generated", updatedAt: now() };
      });
      if (!blocks.length) blocks.push({ id: createId(), sectionId, order: 1, text: "[待人工核对] 当前章节缺少足够的结构化证据，请补充文献或手动撰写。", claimIds: [], citations: [], locked: false, origin: "generated", updatedAt: now() });
      project.draftBlocks = project.draftBlocks.filter((item) => item.sectionId !== sectionId).concat(blocks);
      section.status = blocks.some((block) => !block.claimIds.length) ? "needs_evidence" : "drafted";
      project.audit = emptyAudit();
      return project;
    });
  }

  async function updateSection(id, sectionId, patch = {}) {
    return mutate(id, "section_updated", "编辑论文大纲", async (project) => {
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
    return mutate(id, "audit_run", "运行论文审计", async (project) => {
      project.audit = auditPaperProject(project);
      return project;
    });
  }

  async function impact(id, documentIds) { return projectImpact(await get(id), documentIds); }

  async function restoreRevision(id, revisionId) {
    return mutate(id, "revision_restored", "恢复论文项目版本", async (project) => {
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
function projectSnapshot(project) { return structuredClone({ title: project.title, topic: project.topic, paperType: project.paperType, targetJournal: project.targetJournal, language: project.language, targetWords: project.targetWords, citationStyle: project.citationStyle, documentIds: project.documentIds, activeThesisId: project.activeThesisId, theses: project.theses, outline: project.outline, claims: project.claims, evidenceLinks: project.evidenceLinks, draftBlocks: project.draftBlocks, references: project.references, generationNotice: project.generationNotice, audit: project.audit }); }
function matchingClaims(claims, fields) { return claims.filter((claim) => fields.some((field) => claim.fieldKey.includes(field))); }
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
function sameIds(left = [], right = []) { const a = [...new Set(left.map(String))].sort(); const b = [...new Set(right.map(String))].sort(); return a.length === b.length && a.every((value, index) => value === b[index]); }
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function badRequest(message) { return httpError(400, message); }
function notFound() { return httpError(404, "论文项目不存在。"); }
function conflict(message) { return httpError(409, message); }
