import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeConfig, ensureRuntimeDirectories } from "../src/config/runtime.js";
import { createProviderSettings } from "../src/infrastructure/provider/settings.js";
import { createEvidencePolicies } from "../src/domain/evidence/policies.js";
import { createEvidenceQuality } from "../src/domain/evidence/quality.js";
import { cleanPdfPageTexts, sectionForText } from "../src/infrastructure/parsers/pdf/text-cleaner.js";
import { createAtomicJsonFile } from "../src/infrastructure/storage/atomic-json-file.js";
import { createSerialExecutor } from "../src/shared/async/serial-executor.js";
import { createInitialState, readStoredSelection } from "../public/src/state/create-state.js";
import { uploadFileIssue } from "../public/src/uploads/file-validation.js";
import { escapeHtml, friendlyText } from "../public/src/shared/text.js";
import { renderJournalReviewDraft, renderReviewDraft } from "../public/src/review/render.js";
import { isBoilerplateLine, normalizeText, sentences, toHalfWidth, topKeywords } from "../src/shared/text/core.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lit-review-modules-"));
try {
  const runtime = createRuntimeConfig({ rootDir: tempRoot, env: { DATA_DIR: path.join(tempRoot, "runtime"), PORT: "4321" } });
  await ensureRuntimeDirectories(runtime.paths);
  assert.equal(runtime.port, 4321);
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

  assert.equal(toHalfWidth("ＡＩ　研究"), "AI 研究");
  assert.equal(normalizeText("一段文字\r\n\r\n\r\n另一段"), "一段文字\n\n另一段");
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
  const evidenceQuality = createEvidenceQuality({
    displayText: (value) => String(value || "").replace(/\s+/g, " ").trim(),
    isBoilerplateLine,
    isDataSourceLeadPhrase: evidencePolicies.isDataSourceLeadPhrase,
    isLikelyTitleOrByline: () => false,
    isLowValueChunk: () => false,
    toHalfWidth
  });
  const directQuote = "本文提出一种协同控制方法，并在公开数据集上完成实验验证。";
  assert.equal(evidenceQuality.evidenceTypeForQuote(directQuote).directQuoteEligible, true);
  assert.equal(evidenceQuality.evidenceTypeForQuote("x = y + z，其中 x 为目标变量").directQuoteEligible, false);
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
  console.log("Module regression passed: configuration, evidence, parsers, storage, state, and rendering verified.");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
