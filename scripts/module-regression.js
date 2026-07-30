import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeConfig, ensureRuntimeDirectories } from "../src/config/runtime.js";
import { createProviderSettings } from "../src/infrastructure/provider/settings.js";
import { createEvidencePolicies } from "../src/domain/evidence/policies.js";
import { createEvidenceQuality } from "../src/domain/evidence/quality.js";
import { evidenceFailureStage, summarizeEvidenceCoverage } from "../src/domain/evidence/coverage.js";
import { createEvidenceSelectionState } from "../src/domain/evidence/selection-state.js";
import { classifyEvidenceDocument } from "../src/domain/evidence/document-kind.js";
import { cleanPdfPageTexts, sectionForText } from "../src/infrastructure/parsers/pdf/text-cleaner.js";
import { assessPdfPageText, assessPdfTextCoverage, mergeRecoveredPageTexts, shouldRoutePdfPages } from "../src/infrastructure/parsers/pdf/quality-router.js";
import { createAtomicJsonFile } from "../src/infrastructure/storage/atomic-json-file.js";
import { createSerialExecutor } from "../src/shared/async/serial-executor.js";
import { auditPaperProject, buildClaimInventory, createPaperProject, projectImpact } from "../src/domain/paper/project.js";
import { createJsonProjectRepository } from "../src/infrastructure/paper/json-project-repository.js";
import { createPaperProjectService } from "../src/application/paper/project-service.js";
import { createPaperDocx } from "../src/infrastructure/paper/docx-export.js";
import { createPaperWriter, normalizeModelDraft } from "../src/infrastructure/provider/paper-writer.js";
import { createInitialState, readStoredSelection } from "../public/src/state/create-state.js";
import { uploadFileIssue } from "../public/src/uploads/file-validation.js";
import { cleanUiText, escapeHtml, friendlyText } from "../public/src/shared/text.js";
import { renderJournalReviewDraft, renderReviewDraft } from "../public/src/review/render.js";
import { isBoilerplateLine, isFundingOrMetadataNoise, normalizeText, sentences, toHalfWidth, topKeywords } from "../src/shared/text/core.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lit-review-modules-"));
try {
  const runtime = createRuntimeConfig({ rootDir: tempRoot, env: { DATA_DIR: path.join(tempRoot, "runtime"), HOST: "127.0.0.1", PORT: "4321" } });
  await ensureRuntimeDirectories(runtime.paths);
  assert.equal(runtime.port, 4321);
  assert.equal(runtime.host, "127.0.0.1");
  await fs.access(runtime.paths.pendingUploadDir);

  const settings = createProviderSettings({
    configPath: runtime.paths.providerConfigPath,
    env: { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "fixture-model" },
    defaultOpenAIModel: "fixture-model",
    defaultAnthropicModel: "fixture-claude"
  });
  const loaded = await settings.load();
  assert.equal(loaded.config.provider, "openai");
  assert.equal(loaded.config.apiKey, "test-key");
  await settings.save(loaded.config);
  assert.equal(JSON.parse(await fs.readFile(runtime.paths.providerConfigPath, "utf8")).apiKey, undefined);
  assert.throws(() => settings.sanitize({ provider: "openai", baseUrl: "http://127.0.0.1:8080", model: "x" }));
  assert.equal(
    settings.sanitize({ provider: "openai-compatible", baseUrl: "https://relay.example.com/v1", model: "relay-model" }).baseUrl,
    "https://relay.example.com/v1"
  );
  assert.throws(() => settings.sanitize({ provider: "openai-compatible", baseUrl: "https://127.0.0.1:8080/v1", model: "x" }));
  await fs.writeFile(runtime.paths.providerConfigPath, JSON.stringify({
    provider: "openai-compatible",
    baseUrl: "https://relay.example.com/v1",
    model: "relay-model"
  }, null, 2));
  const relayWithoutMatchingEnvKey = await settings.load();
  assert.equal(relayWithoutMatchingEnvKey.config.provider, "openai-compatible");
  assert.equal(relayWithoutMatchingEnvKey.config.apiKey, "");

  assert.equal(toHalfWidth("ＡＩ　研究"), "AI 研究");
  assert.equal(normalizeText("一段文字\r\n\r\n\r\n另一段"), "一段文字\n\n另一段");
  assert.equal(cleanUiText("分别综述了古代文学(。"), "分别综述了古代文学");
  assert.equal(isFundingOrMetadataNoise("Based on the 本文系教育部人文社会科学研究专项任务项目的阶段性研究成果"), true);
  assert.equal(isBoilerplateLine("本文系教育部人文社会科学研究专项任务项目的阶段性研究成果"), true);
  assert.equal(cleanUiText("核心结论是贡献结论:Based on the 本文系教育部人文社会科学研究专项任务项目的阶段性研究成果。"), "");
  assert.equal(isBoilerplateLine("DOI: 10.1000/test"), true);
  assert.equal(sentences("本文提出一种可验证的研究方法，并在公开数据集上完成实验。结果表明该方法能够改善预测效果。").length, 2);
  assert(topKeywords("智能体方法用于智能体研究和智能体实验", 3).length > 0);
  const evidencePolicies = createEvidencePolicies({ displayText: (value) => String(value || "").trim() });
  const sumoQuote = "实验设计基于SUMO微观仿真软件搭建交通仿真实验场景。";
  assert.equal(evidencePolicies.isDataSourceLeadPhrase(sumoQuote), true);
  assert.equal(evidencePolicies.fieldSelectionBoost("data_or_materials", sumoQuote) > 40, true);
  assert.equal(evidencePolicies.candidateMatchesFieldContext("research_question", {
    quote: "实验在三组交通需求场景中生成车辆轨迹数据。",
    candidateTypes: ["research_question", "data_or_materials"]
  }, "method"), false);
  assert.equal(evidencePolicies.claimTypeForField("limitations"), "limitation");
  const selection = createEvidenceSelectionState();
  selection.select("span-1", "method");
  assert.equal(selection.has("span-1", "method"), true);
  assert.equal(selection.has("span-1", "limitations"), false);
  assert.equal(selection.penalty("span-1", "limitations"), 14);
  assert.deepEqual(selection.fields("span-1"), ["method"]);
  assert.equal(classifyEvidenceDocument({ sourceType: "pdf" }).kind, "research_document");
  assert.equal(classifyEvidenceDocument({
    sourceType: "pptx",
    chunks: [{ text: "Research question: How do agents learn?" }, { text: "Method: We compare two policies." }]
  }).kind, "research_presentation");
  assert.deepEqual(classifyEvidenceDocument({
    sourceType: "pptx",
    title: "人工智能：从示例中学习",
    chunks: [{ text: "Decision trees and example problems" }]
  }).applicableFields, []);
  assert.equal(classifyEvidenceDocument({
    sourceType: "pptx",
    title: "人工智能：自然语言处理",
    chunks: [{ text: "Results: current systems have a low word error rate." }]
  }).kind, "teaching_or_reference_material");
  assert.equal(classifyEvidenceDocument({
    sourceType: "pptx",
    title: "大语言模型（LLM）人文研究入门",
    chunks: [{ text: "Research methods and examples for humanists." }]
  }).kind, "teaching_or_reference_material");
  const evidenceQuality = createEvidenceQuality({
    displayText: (value) => String(value || "").replace(/\s+/g, " ").trim(),
    isBoilerplateLine,
    isDataSourceLeadPhrase: evidencePolicies.isDataSourceLeadPhrase,
    isFundingOrMetadataNoise,
    isLikelyTitleOrByline: () => false,
    isLowValueChunk: () => false,
    toHalfWidth
  });
  const directQuote = "本文提出一种协同控制方法，并在公开数据集上完成实验验证。";
  assert.equal(evidenceQuality.evidenceTypeForQuote(directQuote).directQuoteEligible, true);
  assert.equal(evidenceQuality.evidenceTypeForQuote("x = y + z，其中 x 为目标变量").directQuoteEligible, false);
  assert.equal(evidenceQuality.evidenceTypeForQuote("研究材料获取难是该方向的重要研究局限（图10）。").directQuoteEligible, true);
  assert.equal(evidenceQuality.evidenceTypeForQuote("本文使用CiteSpace绘制知识图谱并分析关键词演化过程。").directQuoteEligible, true);
  assert.equal(evidenceQuality.evidenceTypeForQuote("实验结果如图5所示。").directQuoteEligible, false);
  assert.equal(evidenceQuality.evidenceTypeForQuote("结果如图9所示，可以看出模型误差在不同时段存在明显差异。").directQuoteEligible, true);
  assert.equal(evidenceQuality.evidenceTypeForQuote("Current systems have a word error rate of about 3% to 5%.").directQuoteEligible, true);
  assert.equal(evidenceQuality.isEvidenceNoise("基金项目：国家自然科学基金"), true);
  assert.equal(evidenceQuality.isIncompleteEvidenceFragment(sumoQuote), false);
  assert.equal(evidenceQuality.quoteQualityAssessment(directQuote, { key: "method" }).score >= 0.5, true);
  assert.match(evidenceQuality.notUsableReason({
    quote: { text: "图 2 模型结构" },
    dimension: { audit: "dimension_supported" },
    support: { level: "strong" },
    quoteQuality: { score: 0.8, issues: [] },
    evidenceType: { type: "figure_evidence", directQuoteEligible: false }
  }), /^not_direct_quote:/);
  const healthyPage = "本文提出一种面向复杂交通场景的协同控制方法，并在公开数据集上完成实验验证。结果表明该方法能够降低预测误差。";
  assert.equal(assessPdfPageText(healthyPage).status, "healthy");
  assert.equal(assessPdfPageText("第 1 页").status, "unreadable");
  const partialCoverage = assessPdfTextCoverage([healthyPage, "", healthyPage], 3);
  assert.equal(partialCoverage.status, "partial");
  assert.deepEqual(partialCoverage.recoveryPages, [2]);
  assert.equal(shouldRoutePdfPages(partialCoverage), true);
  assert.equal(mergeRecoveredPageTexts([healthyPage, "", healthyPage], ["", healthyPage, ""], partialCoverage)[1], healthyPage);
  assert.equal(evidenceFailureStage({ quote: "" }, { candidateCount: 3, parseStatus: "readable" }), "selection_rejected");
  const coverage = summarizeEvidenceCoverage([
    { id: "readable", title: "可解析", wordCount: 100, chunks: [{ text: healthyPage }], evidenceCard: { method: { quote: healthyPage, is_usable: true }, evidence_candidates: [{}] } },
    { id: "broken", title: "损坏", sourceType: "pdf", pages: 2, wordCount: 0, chunks: [], evidenceCard: { method: { quote: "", is_usable: false } } }
  ]);
  assert.equal(coverage.eligible.total, 1);
  assert.equal(coverage.eligible.rate, 1);
  assert.equal(coverage.unreadableDocuments, 1);
  const teachingCoverage = summarizeEvidenceCoverage([{
    id: "slides",
    title: "课程讲义",
    sourceType: "pptx",
    wordCount: 100,
    chunks: [{ text: healthyPage }],
    evidenceCard: { document_kind: "teaching_or_reference_material", applicable_fields: [], method: { quote: healthyPage, is_usable: true } }
  }]);
  assert.equal(teachingCoverage.eligible.total, 0);
  const cleanedPages = cleanPdfPageTexts([
    "测试学报 2026 第1期\n本文提出一种面向复杂交通场景的协同控制方法\n并在多个公开实验场景中完成对比验证。",
    "测试学报 2026 第1期\n结果表明模型有效。"
  ]);
  assert.equal(cleanedPages.every((page) => !page.includes("测试学报")), true);
  assert.equal(cleanedPages[0].includes("本文提出一种面向复杂交通场景的协同控制方法并在多个公开实验场景中完成对比验证。"), true);
  assert.equal(sectionForText("3 实验结果"), "results");
  const jsonFile = createAtomicJsonFile({ filePath: path.join(tempRoot, "atomic.json"), fallback: () => ({ count: 0 }) });
  assert.deepEqual(await jsonFile.read(), { count: 0 });
  await jsonFile.write({ count: 2 });
  assert.deepEqual(await jsonFile.read(), { count: 2 });
  const serial = createSerialExecutor();
  const order = [];
  await Promise.all([
    serial.run(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push(1); }),
    serial.run(async () => { order.push(2); })
  ]);
  assert.deepEqual(order, [1, 2]);
  const values = new Map([["activeDocId", "doc-1"], ["selectedDocIds", "[\"doc-1\",\"doc-2\"]"]]);
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  assert.deepEqual(readStoredSelection(storage), ["doc-1", "doc-2"]);
  assert.equal(createInitialState(storage).activeDocId, "doc-1");
  assert.equal(uploadFileIssue({ name: "paper.pdf", type: "application/pdf" }), "");
  assert.match(uploadFileIssue({ name: "legacy.ppt", type: "" }), /旧版 PPT/);
  assert.equal(escapeHtml("<b>证据</b>"), "&lt;b&gt;证据&lt;/b&gt;");
  assert.match(friendlyText("AI agent uses API"), /人工智能/);
  assert.match(renderReviewDraft("核心主题\n- 原文证据", "空"), /review-rendered/);
  assert.match(renderJournalReviewDraft("研究综述\n摘要\n正文", "空"), /journal-article/);

  const paperDoc = {
    id: "paper-doc-1",
    title: "证据驱动的文献综述",
    authors: ["测试作者"],
    publicationYear: "2026",
    sourceType: "pdf",
    evidenceCard: {
      research_question: { claim: "研究关注如何保持综述结论可追溯。", quote: "本研究关注如何保持综述结论可追溯。", page: 2, confidence: 0.9, audit: "dimension_supported", is_usable: true },
      method: { claim: "系统使用结构化证据卡连接论断和原文。", quote: "系统使用结构化证据卡连接论断和原文。", page: 4, confidence: 0.92, audit: "dimension_supported", is_usable: true },
      contribution: { claim: "证据映射能够降低引用失配风险。", quote: "证据映射能够降低引用失配风险。", page: 8, confidence: 0.88, audit: "dimension_supported", is_usable: true },
      main_claims: [], evidence: [], limitations: []
    }
  };
  const paperProject = createPaperProject({ title: "测试论文", topic: "证据驱动综述", documentIds: [paperDoc.id] }, { id: "project-1", now: "2026-01-01T00:00:00.000Z" });
  const inventory = buildClaimInventory(paperProject, [paperDoc]);
  assert.equal(inventory.claims.length, 3);
  assert.equal(inventory.topicClusters.length, 1);
  assert.equal(inventory.topicClusters[0].scope, "single_source_boundary");
  assert.equal(inventory.topicClusters[0].canSynthesize, false);
  assert.equal(inventory.evidenceLinks.every((item) => item.docId === paperDoc.id && item.usable), true);
  const auditableProject = { ...paperProject, ...inventory, draftBlocks: [{ id: "block-1", sectionId: "section-1", text: "证据映射能够降低风险[1]。", claimIds: [inventory.claims[2].id], citations: [1] }] };
  assert.equal(auditPaperProject(auditableProject).status, "ready");
  assert.equal(projectImpact(auditableProject, [paperDoc.id]).blocks.length, 1);

  const paperRepository = createJsonProjectRepository({ filePath: runtime.paths.paperProjectsPath });
  let idCounter = 0;
  const paperService = createPaperProjectService({ repository: paperRepository, loadDocuments: async () => [paperDoc], createId: () => `generated-${++idCounter}`, createDocx: createPaperDocx, now: () => "2026-01-02T00:00:00.000Z" });
  let savedProject = await paperService.create({ title: "服务测试论文", topic: "可追溯综述", documentIds: [paperDoc.id] });
  assert.equal(savedProject.topicClusters[0].writingMode, "单篇述评");
  savedProject = await paperService.suggestTheses(savedProject.id);
  assert.equal(savedProject.theses.length, 3);
  assert.match(savedProject.theses[0].scopeNote, /单篇述评/);
  savedProject = await paperService.generateOutline(savedProject.id);
  assert.equal(savedProject.outline.length, 6);
  assert.equal(savedProject.outline.every((section) => section.claimIds.length > 0), true);
  const abstractSection = savedProject.outline.find((section) => section.title === "摘要");
  savedProject = await paperService.generateSection(savedProject.id, abstractSection.id);
  const abstractBlocks = savedProject.draftBlocks.filter((block) => block.sectionId === abstractSection.id);
  assert.equal(abstractBlocks.length, 1);
  assert.equal(abstractBlocks[0].mode, "abstract");
  assert.equal(Boolean(abstractBlocks[0].topicSentence || abstractBlocks[0].evidenceSentence), false);
  assert.doesNotMatch(abstractBlocks[0].text, /\[\d+\]/);
  const evidenceSection = savedProject.outline.find((section) => section.claimIds.length && section.title !== "摘要");
  savedProject = await paperService.generateSection(savedProject.id, evidenceSection.id);
  assert.equal(savedProject.draftBlocks.some((block) => block.sectionId === evidenceSection.id && block.citations.length), true);
  assert.equal(savedProject.draftBlocks.some((block) => block.sectionId === evidenceSection.id && block.topicSentence && block.evidenceSentence && block.inferenceLevel), true);
  savedProject = await paperService.runAudit(savedProject.id);
  assert.equal(["ready", "needs_review"].includes(savedProject.audit.status), true);
  assert.match(await paperService.exportMarkdown(savedProject.id), /参考文献/);
  const docxBytes = await paperService.exportDocx(savedProject.id);
  assert.equal(docxBytes.subarray(0, 2).toString(), "PK");

  const mismatchDoc = {
    id: "mismatch-doc-1",
    title: "近三十年域外汉籍研究的现状与展望",
    authors: ["测试作者"],
    publicationYear: "2026",
    sourceType: "pdf",
    abstract: "本文基于中国知网文献数据，使用CiteSpace和VOSviewer绘制域外汉籍研究知识图谱。",
    evidenceCard: {
      research_question: { claim: "本研究分析近三十年域外汉籍研究的演进趋势。", quote: "本研究分析近三十年域外汉籍研究的演进趋势。", page: 1, confidence: 0.9, audit: "dimension_supported", is_usable: true },
      method: { claim: "研究使用CiteSpace和VOSviewer绘制知识图谱。", quote: "研究使用CiteSpace和VOSviewer绘制知识图谱。", page: 2, confidence: 0.9, audit: "dimension_supported", is_usable: true },
      contribution: { claim: "研究总结域外汉籍研究热点和演进趋势。", quote: "研究总结域外汉籍研究热点和演进趋势。", page: 8, confidence: 0.9, audit: "dimension_supported", is_usable: true },
      main_claims: [], evidence: [], limitations: []
    }
  };
  const mismatchRepository = createJsonProjectRepository({ filePath: path.join(runtime.paths.dataDir, "mismatch-paper-projects.json") });
  const mismatchService = createPaperProjectService({ repository: mismatchRepository, loadDocuments: async () => [mismatchDoc], createId: () => `mismatch-generated-${++idCounter}`, createDocx: createPaperDocx, now: () => "2026-01-04T00:00:00.000Z" });
  let mismatchProject = await mismatchService.create({ title: "大语言智能体研究综述", topic: "", documentIds: [mismatchDoc.id] });
  mismatchProject = await mismatchService.suggestTheses(mismatchProject.id);
  assert.match(mismatchProject.generationNotice, /项目名称或主题与已选文献范围不一致/);
  assert.doesNotMatch(mismatchProject.theses.map((item) => `${item.title} ${item.statement}`).join(" "), /大语言智能体/);
  assert.match(mismatchProject.theses.map((item) => `${item.title} ${item.statement}`).join(" "), /文献计量|知识图谱|域外汉籍/);

  const guideDoc = {
    id: "guide-doc-1",
    title: "Why do we write literature reviews?",
    authors: ["Writing Center"],
    publicationYear: "2026",
    sourceType: "pdf",
    abstract: "这是一份文献综述写作指南，说明综述写作需要围绕研究问题组织资料、比较已有研究并形成可核对判断。",
    fullSummary: "这是一份文献综述写作指南，适合用于理解综述结构、资料选择、证据组织和写作边界。它不能作为某一研究领域的实证结论来源。",
    chunks: [{ text: "A literature review should organize sources around a research question, compare relevant studies, and identify gaps for future work.", page: 1 }],
    evidenceCard: { document_kind: "teaching_or_reference_material", evidence_candidates: [{ quote: "A literature review should organize sources around a research question, compare relevant studies, and identify gaps for future work.", page: 1 }], main_claims: [], evidence: [], limitations: [] }
  };
  const guideProject = createPaperProject({ title: "写作指南项目", topic: "文献综述写作", documentIds: [guideDoc.id] }, { id: "guide-project-1", now: "2026-01-01T00:00:00.000Z" });
  const guideInventory = buildClaimInventory(guideProject, [guideDoc]);
  assert.equal(guideInventory.claims.length >= 3, true);
  assert(guideInventory.claims.every((claim) => /资料|写作|边界|综述|研究/.test(claim.text)), "Reference material claims should be natural Chinese writing claims.");
  const guideRepository = createJsonProjectRepository({ filePath: path.join(runtime.paths.dataDir, "guide-paper-projects.json") });
  const guideService = createPaperProjectService({ repository: guideRepository, loadDocuments: async () => [guideDoc], createId: () => `guide-generated-${++idCounter}`, createDocx: createPaperDocx, now: () => "2026-01-03T00:00:00.000Z" });
  let savedGuideProject = await guideService.create({ title: "写作指南项目", topic: "文献综述写作", documentIds: [guideDoc.id] });
  savedGuideProject = await guideService.suggestTheses(savedGuideProject.id);
  savedGuideProject = await guideService.generateOutline(savedGuideProject.id);
  assert.equal(savedGuideProject.outline.every((section) => section.claimIds.length > 0), true);
  for (const section of savedGuideProject.outline) {
    savedGuideProject = await guideService.generateSection(savedGuideProject.id, section.id);
    const blocks = savedGuideProject.draftBlocks.filter((block) => block.sectionId === section.id);
    assert(blocks.length >= 1, `Reference material section should not be blank: ${section.title}`);
    assert(!blocks.some((block) => /本节尚未生成正文|\[待人工核对\]/.test(block.text)), "Generated writing sections should not expose blank placeholders.");
    assert(blocks.some((block) => /资料|写作|边界|综述|研究/.test(block.text)), "Generated reference-material sections should use natural Chinese writing text.");
  }
  assert.deepEqual(normalizeModelDraft('{"paragraphs":[{"topicSentence":"主题","evidenceSentence":"证据","comparisonSentence":"比较","boundarySentence":"边界","inferenceLevel":"synthesis","text":"证据约束段落","claimIds":["allowed","invented"]}]}', new Set(["allowed"])), [{ text: "证据约束段落", claimIds: ["allowed"], topicSentence: "主题", evidenceSentence: "证据", comparisonSentence: "比较", boundarySentence: "边界", inferenceLevel: "synthesis" }]);
  assert.equal(normalizeModelDraft("not-json", new Set()), null);
  let paperWriterCalls = 0;
  const localPaperWriter = createPaperWriter({ llmText: async () => { paperWriterCalls += 1; }, providerInfo: () => ({ provider: "local", modelAvailable: false }) });
  assert.equal(await localPaperWriter.writeSection({ project: {}, section: {}, claims: [], evidenceLinks: [] }), null);
  assert.equal(paperWriterCalls, 0);
  assert.equal((await paperService.list()).length, 1);
  console.log("Module regression passed: configuration, evidence, parsers, storage, state, and rendering verified.");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
