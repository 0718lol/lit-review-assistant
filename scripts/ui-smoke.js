import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { writeTestDataDir } from "./test-fixture.js";

const { chromium } = await import("playwright");

const chromiumCandidates = [
  process.env.CHROMIUM_EXECUTABLE_PATH,
  "/opt/ms-playwright/chromium-1217/chrome-linux64/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
].filter(Boolean);

function chromiumExecutablePath() {
  return chromiumCandidates.find((item) => fs.existsSync(item));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const port = await freePort();
const testDataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "lit-review-ui-"));
await writeTestDataDir(testDataDir);
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: testDataDir },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
child.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

let browser;

try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  const executablePath = chromiumExecutablePath();
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

  const initial = await page.evaluate(() => ({
    modelOpen: document.querySelector(".model-settings")?.open,
    graphPanels: [...document.querySelectorAll(".graph-panel")].map((panel) => ({
      title: panel.querySelector("summary")?.textContent?.trim(),
      open: panel.open
    })),
    graph3dCanvasCount: document.querySelectorAll("#graph3dScene canvas").length,
    edgeCountText: document.querySelector("#edgeCount")?.textContent?.trim() || "",
    edgeCountLabel: document.querySelector("#edgeCountLabel")?.textContent?.trim() || ""
  }));

  assert(initial.modelOpen === false, "Model settings should be collapsed on first load.");
  assert(initial.graphPanels.length >= 4, "Expected graph panels for 3D, relation insight, 2D, and evidence explanation.");
  assert(initial.graphPanels.some((panel) => panel.title === "图谱解读"), "Graph insight panel should exist.");
  assert(initial.graphPanels.every((panel) => panel.open === false), "All graph panels should be collapsed on first load.");
  assert(initial.graph3dCanvasCount === 0, "3D canvas should not render before the panel is opened.");
  assert(!/\d+\+\d+/.test(initial.edgeCountText), "Relation count should not use ambiguous plus notation.");
  if (/单篇/.test(initial.edgeCountLabel)) {
    assert(/结构节点/.test(initial.edgeCountText) && /逻辑连线/.test(initial.edgeCountText), "Single-document count should show structure nodes and logic links.");
  } else {
    assert(/核心/.test(initial.edgeCountText) && /候选/.test(initial.edgeCountText), "Relation count should show core and candidate counts explicitly.");
  }
  assert(/默认显示|核心关系|单篇二维\/三维结构图/.test(initial.edgeCountLabel), "Relation count label should explain the current relation scope.");

  const englishTitle = "Learning From Examples for Intelligent Agents";
  const englishTitleButton = page.locator(".doc-title-button", { hasText: englishTitle });
  assert(await englishTitleButton.count() === 1, "Pure English document titles should remain visible.");
  await englishTitleButton.click();
  const englishCardText = await page.locator(".doc-card.expanded", { hasText: englishTitle }).textContent();
  assert(
    englishCardText?.includes("intelligent agents learn reliable policies from labeled examples"),
    "Pure English evidence should remain visible after expanding a document."
  );

  await page.locator('[data-tab="paper"]').click();
  await page.waitForSelector("#paperWorkspace [data-paper-create]");
  await page.locator('[data-paper-create] input[name="title"]').fill("界面回归论文项目");
  await page.locator('[data-paper-create] input[name="topic"]').fill("证据驱动的智能体研究综述");
  const projectDocOptions = page.locator('[data-paper-create] input[name="documentIds"]');
  const projectDocOptionCount = await projectDocOptions.count();
  assert(projectDocOptionCount > 0, "Paper project creation should expose library documents.");
  await projectDocOptions.first().check();
  await page.locator('[data-paper-create] button[type="submit"]').click();
  await page.waitForSelector(".paper-workflow");
  await page.locator('[data-paper-action="theses"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".paper-thesis").length === 3);
  await page.locator('[data-paper-action="outline"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".paper-section").length >= 6);
  await page.locator('[data-paper-action="generate-section"]').click();
  await page.waitForSelector(".paper-block");
  await page.locator('[data-paper-action="audit"]').click();
  await page.waitForFunction(() => {
    const audit = document.querySelector(".paper-audit");
    return audit && !audit.textContent?.includes("尚未审计");
  });
  const paperUiState = await page.evaluate(() => ({
    thesisCount: document.querySelectorAll(".paper-thesis").length,
    clusterCount: document.querySelectorAll(".paper-clusters article").length,
    clusterText: document.querySelector(".paper-clusters")?.textContent?.trim() || "",
    sectionCount: document.querySelectorAll(".paper-section").length,
    blockCount: document.querySelectorAll(".paper-block").length,
    structuredRows: document.querySelectorAll(".paper-block-structure p").length,
    evidenceCount: document.querySelectorAll(".paper-evidence-item").length,
    wordExport: document.querySelector('.paper-export[href$="/export/docx"]')?.textContent?.trim() || "",
    markdownExport: document.querySelector('.paper-export[href$="/export/markdown"]')?.textContent?.trim() || ""
  }));
  assert(paperUiState.thesisCount === 3 && paperUiState.sectionCount >= 6, `Paper workspace should render thesis candidates and a structured outline: ${JSON.stringify(paperUiState)}`);
  assert(paperUiState.clusterCount >= 1 && /单篇述评|综合综述|方法论比较|分主题写作/.test(paperUiState.clusterText), `Paper workspace should render topic-cluster writing mode: ${JSON.stringify(paperUiState)}`);
  assert(paperUiState.blockCount > 0, "Paper workspace should render editable draft blocks.");
  assert(paperUiState.structuredRows >= 2, "Paper workspace should render topic/evidence/boundary structure for generated blocks.");
  assert(paperUiState.evidenceCount > 0, "Paper workspace should keep section evidence visible beside the draft.");
  assert(paperUiState.wordExport === "导出 Word" && paperUiState.markdownExport === "导出 Markdown", "Paper workspace should expose Word and Markdown exports.");
  await page.locator('[data-tab="map"]').click();

  await page.locator("#fileInput").setInputFiles({
    name: "background-job-invalid.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from("invalid pptx fixture")
  });
  await page.locator("#uploadForm button[type=submit]").click();
  await page.waitForSelector(".upload-job");
  await page.waitForFunction(() => document.querySelector(".upload-job-failed"));
  const failedUploadJob = await page.evaluate(() => ({
    filename: document.querySelector(".upload-job-failed strong")?.textContent?.trim() || "",
    retryText: document.querySelector('.upload-job-failed [data-job-action="retry"]')?.textContent?.trim() || "",
    progressbar: Boolean(document.querySelector('.upload-job-failed [role="progressbar"]'))
  }));
  assert(failedUploadJob.filename === "background-job-invalid.pptx", "Background upload jobs should show the source filename.");
  assert(failedUploadJob.retryText === "重试", "Failed background upload jobs should expose a retry action.");
  assert(failedUploadJob.progressbar, "Background upload jobs should render stable progress UI.");

  const selectionState = await page.evaluate(() => {
    const first = document.querySelector(".select-doc");
    if (!first) return { skipped: true };
    first.click();
    return {
      skipped: false,
      disabled: document.querySelector("#applySelection")?.disabled,
      text: document.querySelector("#applySelection")?.textContent?.trim() || "",
      hint: document.querySelector("#selectionCount")?.textContent?.trim() || "",
      title: document.querySelector("#applySelection")?.getAttribute("title") || ""
    };
  });
  if (!selectionState.skipped) {
    assert(selectionState.disabled === false, "Selection analysis should allow one selected document for single-document structure graphs.");
    assert(selectionState.text.includes("分析这 1 篇"), "Single-selection button should run single-document analysis.");
    assert(selectionState.hint.includes("二维/三维结构图"), "Single-selection hint should explain the single-document graph output.");
    assert(selectionState.title.includes("二维/三维结构图"), "Single-selection title should expose the single-document graph output.");
  }
  const multiSelectionState = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".select-doc")];
    if (boxes.length < 2) return { skipped: true };
    if (!boxes[0].checked) boxes[0].click();
    const unrelated = boxes[boxes.length - 1];
    if (!unrelated.checked) unrelated.click();
    return {
      skipped: false,
      selected: boxes.filter((box) => box.checked).length,
      activeText: document.querySelector("#scopeLabel")?.textContent?.trim() || ""
    };
  });

  await page.locator("summary", { hasText: "三维关系图" }).click();
  await page.waitForFunction(() => {
    const panel = [...document.querySelectorAll(".graph-panel")].find((item) => item.querySelector("summary")?.textContent?.includes("三维关系图"));
    const svg = document.querySelector("#graph3dSvg");
    return panel?.open && (
      document.querySelectorAll("#graph3dScene canvas").length === 1 ||
      (getComputedStyle(svg).display !== "none" && svg.innerHTML.trim().length > 0)
    );
  });
  const after3d = await page.evaluate(() => ({
    open: [...document.querySelectorAll(".graph-panel")].find((item) => item.querySelector("summary")?.textContent?.includes("三维关系图"))?.open,
    canvasCount: document.querySelectorAll("#graph3dScene canvas").length,
    svgDisplay: getComputedStyle(document.querySelector("#graph3dSvg")).display,
    svgContentLength: document.querySelector("#graph3dSvg")?.innerHTML.trim().length || 0
  }));
  assert(after3d.open === true, "3D graph panel should open after clicking its summary.");
  assert(
    after3d.canvasCount === 1 || (after3d.svgDisplay !== "none" && after3d.svgContentLength > 0),
    "3D graph panel should render either the multi-document canvas or the single-document SVG after opening."
  );

  await page.locator("summary", { hasText: "二维证据泳道图" }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#graphCanvas");
    return canvas && canvas.width > 0 && canvas.height > 0;
  });
  const after2d = await page.evaluate(() => ({
    open: [...document.querySelectorAll(".graph-panel")].find((item) => item.querySelector("summary")?.textContent?.includes("二维证据泳道图"))?.open,
    width: document.querySelector("#graphCanvas")?.width,
    height: document.querySelector("#graphCanvas")?.height
  }));
  assert(after2d.open === true, "2D evidence lane panel should open after clicking its summary.");
  assert(after2d.width > 0 && after2d.height > 0, "2D evidence lane canvas should have drawable dimensions.");

  await page.locator("summary", { hasText: "图谱解读" }).click();
  const afterInsight = await page.evaluate(() => ({
    open: [...document.querySelectorAll(".graph-panel")].find((item) => item.querySelector("summary")?.textContent?.includes("图谱解读"))?.open,
    insightExists: Boolean(document.querySelector("#graph3dInsight")),
    insightText: document.querySelector("#graph3dInsight")?.textContent?.trim() || ""
  }));
  assert(afterInsight.open === true, "Relation insight panel should open after clicking its summary.");
  assert(afterInsight.insightExists, "Relation insight container should exist.");
  assert(afterInsight.insightText.length > 0, "Relation insight panel should render content when opened.");

  await page.locator("summary", { hasText: "关系证据详情" }).click();
  const afterList = await page.evaluate(() => ({
    open: [...document.querySelectorAll(".graph-panel")].find((item) => item.querySelector("summary")?.textContent?.includes("关系证据详情"))?.open,
    edgeListExists: Boolean(document.querySelector("#edgeList")),
    relationNote: document.querySelector(".relation-display-note")?.textContent?.trim() || "",
    edgeCountLabel: document.querySelector("#edgeCountLabel")?.textContent?.trim() || ""
  }));
  assert(afterList.open === true, "Relation explanation panel should open after clicking its summary.");
  assert(afterList.edgeListExists, "Relation explanation container should exist.");
  if (/单篇/.test(afterList.edgeCountLabel)) {
    assert(/结构节点/.test(afterList.relationNote) && /逻辑连线/.test(afterList.relationNote), "Single-document explanation should clarify structure nodes and links.");
  } else {
    assert(/核心关系/.test(afterList.relationNote) && /候选关系/.test(afterList.relationNote), "Relation explanation should clarify core vs candidate relationships.");
  }

  const exportCsvState = await page.evaluate(() => ({
    evidenceAuditHeader: window.__litReviewExportCsv?.evidenceAuditCsv?.().split("\n")[0] || "",
    metricEvidenceHeader: window.__litReviewExportCsv?.metricEvidenceCsv?.().split("\n")[0] || "",
    candidateEdgesHeader: window.__litReviewExportCsv?.candidateEdgesCsv?.().split("\n")[0] || "",
    candidateEdgesText: window.__litReviewExportCsv?.candidateEdgesCsv?.() || "",
    exportButtonText: document.querySelector("#exportPack")?.textContent?.trim() || ""
  }));
  assert(exportCsvState.evidenceAuditHeader.includes("source") && exportCsvState.evidenceAuditHeader.includes("quote") && exportCsvState.evidenceAuditHeader.includes("usable"), "Export pack should include evidence-audit.csv fields.");
  assert(exportCsvState.metricEvidenceHeader.includes("needs_original_check") && exportCsvState.metricEvidenceHeader.includes("confidence"), "Export pack should include metric-evidence.csv fields.");
  assert(exportCsvState.candidateEdgesHeader.includes("relation_kind") && exportCsvState.candidateEdgesHeader.includes("status"), "Export pack should include candidate-edges.csv fields.");
  assert(exportCsvState.candidateEdgesText.includes("candidate_not_default_graph") || exportCsvState.candidateEdgesText.split("\n").length === 1, "Candidate edge CSV should mark hidden graph candidates when present.");

  await page.locator('[data-tab="review"]').click();
  let journalRequestBody = null;
  await page.route("**/api/review/journal", async (route) => {
    journalRequestBody = JSON.parse(route.request().postData() || "{}");
    await route.continue();
  });
  await page.locator("#generateJournalReview").click();
  await page.waitForFunction(() => document.querySelector("#journalReview .journal-article h1"));
  if (!multiSelectionState.skipped) {
    assert(Array.isArray(journalRequestBody?.docIds) && journalRequestBody.docIds.length >= 2, "Journal review should use checked documents even before applying the selection scope.");
  }
  const journalState = await page.evaluate(() => ({
    article: Boolean(document.querySelector("#journalReview .journal-article")),
    title: document.querySelector("#journalReview .journal-article h1")?.textContent?.trim() || "",
    variantCount: document.querySelectorAll("#journalVariantSelect option").length,
    blockCount: document.querySelectorAll("#journalReview .review-block").length,
    headings: [...document.querySelectorAll("#journalReview .journal-article h2")].map((item) => item.textContent?.trim() || ""),
    borderStyle: getComputedStyle(document.querySelector("#journalReview .journal-article")).borderStyle,
    containerBorderStyle: getComputedStyle(document.querySelector("#journalReview")).borderStyle,
    containerBackground: getComputedStyle(document.querySelector("#journalReview")).backgroundColor
  }));
  if (!multiSelectionState.skipped) {
    assert(journalState.variantCount >= 2, "Unrelated checked documents should render a topic-version dropdown.");
  }
  assert(journalState.article, "Journal review should render as a continuous article.");
  assert(!/高水平期刊式文献综述草稿|文献综述草稿|相关领域研究综述|当前资料研究综述/.test(journalState.title), "Journal review should not show generic template titles.");
  assert(journalState.blockCount === 0, "Journal review should not render section cards.");
  assert(journalState.headings.includes("摘要") && journalState.headings.includes("1 引言") && journalState.headings.includes("6 结论与展望"), "Journal review should show basic academic review headings.");
  assert(journalState.borderStyle === "none", "Journal article body should not have boxed section borders.");
  assert(journalState.containerBorderStyle === "none", "Journal review container should not look like a boxed panel.");
  assert(journalState.containerBackground === "rgba(0, 0, 0, 0)", "Journal review container should use the page background.");
  const exportJournalState = await page.evaluate(async () => {
    const files = await window.__litReviewExportCsv?.journalReviewFilesForExport?.();
    return {
      names: (files || []).map((file) => file.name),
      texts: (files || []).map((file) => new TextDecoder().decode(file.data || new Uint8Array()))
    };
  });
  assert(exportJournalState.names.some((name) => name.startsWith("期刊综述/")), "Export pack should include journal review files.");
  if (!multiSelectionState.skipped) {
    assert(exportJournalState.names.filter((name) => /^期刊综述\/\d{2}-/.test(name)).length >= 2, "Unrelated checked documents should export separate journal review files.");
  }
  const staleJournalState = await page.evaluate(() => {
    const target = document.querySelector("#journalReview");
    target.innerHTML = window.__litReviewRenderers.renderJournalReviewDraft("高水平期刊式文献综述草稿\n\n摘要\n旧结果正文", "旧模板标题已失效，请重新生成期刊综述。");
    return {
      text: target.textContent || "",
      title: target.querySelector(".journal-article h1")?.textContent?.trim() || ""
    };
  });
  assert(!/高水平期刊式文献综述草稿/.test(staleJournalState.text), "Stale journal template titles should be stripped before rendering.");
  assert(staleJournalState.title !== "摘要", "Journal renderer should not promote abstract heading to title after stripping stale template titles.");

  console.log("UI smoke passed: paper writing workflow, evidence-backed draft blocks, graph rendering, exports, and journal article rendering verified.");
} catch (error) {
  console.error(serverOutput.trim());
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
  await fsPromises.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
}
