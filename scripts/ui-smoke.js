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

async function openGraphPanel(page, title) {
  const alreadyOpen = await page.evaluate((panelTitle) => [...document.querySelectorAll(".graph-panel")].some((item) => item.open && item.querySelector("summary")?.textContent?.includes(panelTitle)), title);
  if (!alreadyOpen) await page.locator("summary", { hasText: title }).click();
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
    providerOverlayOpen: document.querySelector("#providerSettingsOverlay")?.classList.contains("active"),
    providerOpenButtonVisible: Boolean(document.querySelector("#openProviderSettings")?.offsetParent),
    graphPanels: [...document.querySelectorAll(".graph-panel")].map((panel) => ({
      title: panel.querySelector("summary")?.textContent?.trim(),
      open: panel.open
    })),
    graph3dCanvasCount: document.querySelectorAll("#graph3dScene canvas").length,
    edgeCountText: document.querySelector("#edgeCount")?.textContent?.trim() || "",
    edgeCountLabel: document.querySelector("#edgeCountLabel")?.textContent?.trim() || ""
  }));

  assert(initial.providerOverlayOpen === false && initial.providerOpenButtonVisible, "Model settings should start as a closed overlay with a visible entry button.");
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

  await page.locator('[data-tab="map"]').click();
  const mapFocusState = await page.evaluate(() => ({
    focusMode: document.body.classList.contains("focus-mode"),
    focusTitle: document.querySelector("#focusTitle")?.textContent?.trim() || "",
    tabsVisible: getComputedStyle(document.querySelector(".tabs")).display !== "none",
    libraryVisible: getComputedStyle(document.querySelector(".library-panel")).display !== "none",
    openPanels: [...document.querySelectorAll('.tab-pane[data-pane="map"] .graph-panel')].filter((panel) => panel.open).map((panel) => panel.querySelector("summary")?.textContent?.trim() || ""),
    graphMarkupLength: document.querySelector("#graph3dSvg")?.innerHTML?.length || 0,
    edgeCountLabel: document.querySelector("#edgeCountLabel")?.textContent?.trim() || "",
    mindNodeCount: document.querySelectorAll("#graph3dSvg .doc-mind-node").length,
    legacyFlowNodeCount: document.querySelectorAll("#graph3dSvg .svg-node.flow").length,
    visibleMindRectCount: [...document.querySelectorAll("#graph3dSvg .doc-mind-node rect, #graph3dSvg .doc-mind-center rect")]
      .filter((rect) => rect.getAttribute("fill") !== "transparent").length
  }));
  assert(mapFocusState.focusMode && mapFocusState.focusTitle === "研究脉络图", `Map tab should enter focused reading mode: ${JSON.stringify(mapFocusState)}`);
  assert(!mapFocusState.tabsVisible && !mapFocusState.libraryVisible, "Map focused mode should hide tabs and side panels.");
  assert(mapFocusState.openPanels.includes("三维关系图") && mapFocusState.openPanels.includes("图谱解读"), `Map focused mode should auto-open graph panels: ${JSON.stringify(mapFocusState)}`);
  if (/单篇/.test(mapFocusState.edgeCountLabel)) {
    assert(mapFocusState.mindNodeCount >= 1 && mapFocusState.legacyFlowNodeCount === 0, `Single-document 3D graph should render as a draggable mind map, not the 2D flow layout: ${JSON.stringify(mapFocusState)}`);
    assert(mapFocusState.visibleMindRectCount === 0, `Single-document 3D graph should not use visible card rectangles that clip text: ${JSON.stringify(mapFocusState)}`);
  }
  assert(mapFocusState.graphMarkupLength > 100, "Map focused mode should render the inline graph.");
  await page.locator("#exitFocusMode").click();
  await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));

  await page.locator(".doc-title-button").first().click();
  await page.waitForSelector("#docInspector .doc-full-summary");
  const inspectorSummary = await page.evaluate(() => document.querySelector("#docInspector .doc-full-summary")?.textContent?.trim() || "");
  assert(inspectorSummary.includes("完整摘要") && inspectorSummary.length >= 60, "Document inspector should expose a complete prose summary after selecting a document.");

  const relationCountLayout = await page.evaluate(() => {
    const card = document.querySelector(".relation-count-card")?.getBoundingClientRect();
    const count = document.querySelector("#edgeCount")?.getBoundingClientRect();
    const label = document.querySelector("#edgeCountLabel")?.getBoundingClientRect();
    if (!card || !count || !label) return null;
    return {
      cardTop: card.top,
      cardRight: card.right,
      cardBottom: card.bottom,
      cardLeft: card.left,
      countTop: count.top,
      countRight: count.right,
      countBottom: count.bottom,
      countLeft: count.left,
      labelTop: label.top,
      labelRight: label.right,
      labelBottom: label.bottom,
      labelLeft: label.left
    };
  });
  assert(relationCountLayout, "Relation count card should be measurable.");
  assert(
    relationCountLayout.countBottom <= relationCountLayout.cardBottom + 1 &&
      relationCountLayout.labelBottom <= relationCountLayout.cardBottom + 1 &&
      relationCountLayout.countTop >= relationCountLayout.cardTop - 1 &&
      relationCountLayout.labelTop >= relationCountLayout.cardTop - 1,
    "Relation count text should fit vertically inside the summary card."
  );
  assert(
    relationCountLayout.countRight <= relationCountLayout.labelLeft + 1 &&
      relationCountLayout.labelRight <= relationCountLayout.cardRight + 1,
    "Relation count text and label should not overlap horizontally."
  );

  await page.locator('[data-tab="matrix"]').click();
  const matrixFocusState = await page.evaluate(() => ({
    focusMode: document.body.classList.contains("focus-mode"),
    focusTitle: document.querySelector("#focusTitle")?.textContent?.trim() || "",
    tabsVisible: getComputedStyle(document.querySelector(".tabs")).display !== "none",
    libraryVisible: getComputedStyle(document.querySelector(".library-panel")).display !== "none"
  }));
  assert(matrixFocusState.focusMode && matrixFocusState.focusTitle === "文献矩阵", `Matrix tab should enter focused reading mode: ${JSON.stringify(matrixFocusState)}`);
  assert(!matrixFocusState.tabsVisible && !matrixFocusState.libraryVisible, "Focused reading mode should hide tabs and side panels.");
  await page.locator("#exitFocusMode").click();
  await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));

  await page.locator('[data-tab="gaps"]').click();
  const gapBucketState = await page.evaluate(() => ({
    headings: [...document.querySelectorAll(".gap-evidence-bucket > b")].map((item) => item.textContent?.trim() || ""),
    text: document.querySelector("#researchGaps")?.textContent || ""
  }));
  assert(["共同支持", "单篇支持", "不能推出"].every((label) => gapBucketState.headings.includes(label)), `Research gaps should show evidence buckets: ${JSON.stringify(gapBucketState.headings)}`);
  assert(!/\[\d+\]/.test(gapBucketState.text), "Research gap UI should not expose numeric source markers like [2] or [5].");
  await page.locator("#exitFocusMode").click();
  await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));

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
  const scopeWarningText = await page.locator(".paper-scope-warning").textContent().catch(() => "");
  assert(/项目范围不一致|已选文献/.test(scopeWarningText || ""), `Paper workspace should warn when project topic and selected documents diverge: ${scopeWarningText}`);
  await page.locator('[data-paper-action="outline"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".paper-section").length >= 6);
  await page.locator('[data-paper-action="generate-section"]').click();
  await page.waitForSelector(".paper-block-abstract");
  const abstractBlockState = await page.evaluate(() => ({
    label: document.querySelector(".paper-abstract-label")?.textContent || "",
    structureRows: document.querySelectorAll(".paper-block-structure p").length,
    text: document.querySelector(".paper-block-abstract textarea")?.value || ""
  }));
  assert(abstractBlockState.label.includes("摘要正文"), `Abstract section should render as one complete summary block: ${JSON.stringify(abstractBlockState)}`);
  assert(abstractBlockState.structureRows === 0, "Abstract section should not expose topic/evidence/comparison sentence rows.");
  assert(!/\[\d+\]/.test(abstractBlockState.text), "Abstract text should not append bracketed citation numbers.");
  await page.locator(".paper-section").nth(1).click();
  await page.locator('[data-paper-action="generate-section"]').click();
  await page.waitForSelector(".paper-block-structure");
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
    historyOpen: Boolean(document.querySelector(".paper-history")?.open),
    wordExport: document.querySelector('.paper-export[href$="/export/docx"]')?.textContent?.trim() || "",
    markdownExport: document.querySelector('.paper-export[href$="/export/markdown"]')?.textContent?.trim() || ""
  }));
  assert(paperUiState.thesisCount === 3 && paperUiState.sectionCount >= 6, `Paper workspace should render thesis candidates and a structured outline: ${JSON.stringify(paperUiState)}`);
  assert(paperUiState.clusterCount >= 1 && /单篇述评|综合综述|方法论比较|分主题写作/.test(paperUiState.clusterText), `Paper workspace should render topic-cluster writing mode: ${JSON.stringify(paperUiState)}`);
  assert(paperUiState.blockCount > 0, "Paper workspace should render editable draft blocks.");
  assert(paperUiState.structuredRows >= 2, "Paper workspace should render topic/evidence/boundary structure for generated blocks.");
  assert(paperUiState.evidenceCount > 0, "Paper workspace should keep section evidence visible beside the draft.");
  assert(paperUiState.historyOpen === false, "Paper workspace version history should be collapsed by default.");
  assert(paperUiState.wordExport === "导出 Word" && paperUiState.markdownExport === "导出 Markdown", "Paper workspace should expose Word and Markdown exports.");
  await page.locator("#exitFocusMode").click();
  await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));

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
      title: document.querySelector("#applySelection")?.getAttribute("title") || "",
      exportDocCount: window.__litReviewExportCsv?.scopedDocsForExport?.().length || 0
    };
  });
  if (!selectionState.skipped) {
    assert(selectionState.disabled === false, "Selection analysis should allow one selected document for single-document structure graphs.");
    assert(selectionState.text.includes("分析这 1 篇"), "Single-selection button should run single-document analysis.");
    assert(selectionState.hint.includes("二维/三维结构图"), "Single-selection hint should explain the single-document graph output.");
    assert(selectionState.title.includes("二维/三维结构图"), "Single-selection title should expose the single-document graph output.");
    assert(selectionState.exportDocCount === 1, `Evidence export should honor a single checked document: ${JSON.stringify(selectionState)}`);
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
      activeText: document.querySelector("#scopeLabel")?.textContent?.trim() || "",
      exportDocCount: window.__litReviewExportCsv?.scopedDocsForExport?.().length || 0
    };
  });
  if (!multiSelectionState.skipped) {
    assert(multiSelectionState.exportDocCount === multiSelectionState.selected, `Evidence export should honor all checked documents: ${JSON.stringify(multiSelectionState)}`);
    await page.locator("#applySelection").click();
    await page.waitForFunction(() => /选中资料|勾选资料/.test(document.querySelector("#scopeLabel")?.textContent || ""));
    await page.waitForSelector("#docInspector .scope-inspector-content");
    const scopeInspectorState = await page.evaluate(() => ({
      panelOpen: document.querySelector("#inspectorPanel")?.classList.contains("has-document"),
      bodyOpen: document.body.classList.contains("inspector-open"),
      title: document.querySelector("#docInspector .inspector-title-block h2")?.textContent?.trim() || "",
      text: document.querySelector("#docInspector")?.textContent || "",
      docCards: document.querySelectorAll("#docInspector .scope-doc-evidence").length,
      evidenceRows: document.querySelectorAll("#docInspector .scope-evidence-row").length,
      hasEmptySingleDocPrompt: /选择一篇文献/.test(document.querySelector("#docInspector")?.textContent || "")
    }));
    assert(scopeInspectorState.panelOpen && scopeInspectorState.bodyOpen, `Multi-selection should keep the evidence inspector open: ${JSON.stringify(scopeInspectorState)}`);
    assert(scopeInspectorState.title.includes("证据检查器") && scopeInspectorState.title.includes("篇资料"), `Multi-selection inspector should show selected scope title: ${JSON.stringify(scopeInspectorState)}`);
    assert(scopeInspectorState.text.includes("选中范围") && scopeInspectorState.text.includes("可用证据") && scopeInspectorState.text.includes("待核对证据"), "Multi-selection inspector should summarize usable and review-needed evidence.");
    assert(scopeInspectorState.docCards >= 2, `Multi-selection inspector should list selected documents: ${JSON.stringify(scopeInspectorState)}`);
    assert(scopeInspectorState.evidenceRows > 0 || /没有可直接引用证据|没有明显待核对字段/.test(scopeInspectorState.text), "Multi-selection inspector should show evidence rows or an explicit scoped empty reason.");
    assert(!scopeInspectorState.hasEmptySingleDocPrompt, "Multi-selection inspector should not fall back to the single-document empty prompt.");
    await page.locator("#docInspector .inspect-doc").first().click();
    await page.waitForSelector("#docInspector .return-scope-inspector");
    const singleInspectorFromScope = await page.evaluate(() => ({
      activeText: document.querySelector("#scopeLabel")?.textContent?.trim() || "",
      returnText: document.querySelector("#docInspector .return-scope-inspector")?.textContent?.trim() || "",
      hasScopeOverview: Boolean(document.querySelector("#docInspector .scope-inspector-content"))
    }));
    assert(singleInspectorFromScope.returnText === "返回选中范围证据", `Single evidence card opened from scope should expose a return action: ${JSON.stringify(singleInspectorFromScope)}`);
    assert(/选中资料|勾选资料/.test(singleInspectorFromScope.activeText), "Opening a single evidence card from scope should not switch away from the selected analysis range.");
    assert(!singleInspectorFromScope.hasScopeOverview, "Single evidence card should temporarily replace the scope overview.");
    await page.locator("#docInspector .return-scope-inspector").click();
    await page.waitForSelector("#docInspector .scope-inspector-content");
    const returnedScopeInspector = await page.evaluate(() => ({
      activeText: document.querySelector("#scopeLabel")?.textContent?.trim() || "",
      title: document.querySelector("#docInspector .inspector-title-block h2")?.textContent?.trim() || "",
      docCards: document.querySelectorAll("#docInspector .scope-doc-evidence").length
    }));
    assert(/选中资料|勾选资料/.test(returnedScopeInspector.activeText), `Returning from a single evidence card should preserve selected scope: ${JSON.stringify(returnedScopeInspector)}`);
    assert(returnedScopeInspector.title.includes("证据检查器") && returnedScopeInspector.docCards >= 2, `Return action should restore the multi-document evidence inspector: ${JSON.stringify(returnedScopeInspector)}`);
    await page.locator('[data-tab="qa"]').click();
    const suggestedQaState = await page.evaluate(() => ({
      activeTab: document.querySelector(".tab.active")?.dataset.tab || "",
      focusMode: document.body.classList.contains("focus-mode"),
      docCount: document.querySelectorAll(".doc-list-item").length,
      scopeLabel: document.querySelector("#scopeLabel")?.textContent?.trim() || "",
      htmlLength: document.querySelector("#suggestedQuestions")?.innerHTML?.length || 0,
      questions: [...document.querySelectorAll(".suggested-item span")].map((item) => item.textContent?.trim() || "")
    }));
    const suggestedQa = suggestedQaState.questions;
    assert(suggestedQa.length >= 3, `Cross-document QA should expose suggested questions: ${JSON.stringify(suggestedQaState)}`);
    assert(suggestedQa.every((question) => !/^这些资料围绕.*分别解决什么问题[？?]$/.test(question)), "Suggested cross-document questions should not fall back to shallow generic templates.");
    assert(suggestedQa.every((question) => !/\b[a-z]+(?:_[a-z]+)+\b/.test(question)), `Suggested cross-document questions should not expose internal relation keys: ${JSON.stringify(suggestedQa)}`);
    assert(suggestedQa.some((question) => /《[^》]+》/.test(question) || /研究空白|关系|证据|原文|评价指标|外推/.test(question)), `Suggested cross-document questions should be grounded in document-specific evidence or relations: ${JSON.stringify(suggestedQa)}`);
    await page.locator("#exitFocusMode").click();
    await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));
  }

  await page.locator('[data-tab="map"]').click();
  await openGraphPanel(page, "三维关系图");
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

  await openGraphPanel(page, "二维证据泳道图");
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
  await page.locator("#openGraph2dFullscreen").click();
  await page.waitForFunction(() => document.querySelector("#graphFullscreen")?.classList.contains("active") && (document.querySelector("#graph2dFullscreenSvg")?.innerHTML.trim().length || 0) > 0);
  const twoDFullscreen = await page.evaluate(() => ({
    active: document.querySelector("#graphFullscreen")?.classList.contains("active"),
    twoDDisplay: getComputedStyle(document.querySelector("#graph2dFullscreenSvg")).display,
    threeDDisplay: getComputedStyle(document.querySelector("#graph3dFullscreenSvg")).display,
    twoDContentLength: document.querySelector("#graph2dFullscreenSvg")?.innerHTML.trim().length || 0,
    centeredNodeCount: document.querySelectorAll("#graph2dFullscreenSvg .svg-node.center").length,
    visibleEdgeLabelBoxCount: document.querySelectorAll("#graph2dFullscreenSvg .svg-edge rect").length,
    visibleEdgeTextCount: document.querySelectorAll("#graph2dFullscreenSvg .svg-edge text").length,
    resetVisible: getComputedStyle(document.querySelector("#resetGraphLayoutFullscreen")).display !== "none",
    text: document.querySelector("#graph2dFullscreenSvg")?.textContent || ""
  }));
  assert(twoDFullscreen.active && twoDFullscreen.twoDDisplay !== "none", `2D fullscreen should open the shared fullscreen viewer in 2D mode: ${JSON.stringify(twoDFullscreen)}`);
  assert(twoDFullscreen.threeDDisplay === "none" && twoDFullscreen.twoDContentLength > 100, "2D fullscreen should hide the 3D SVG and render the vector 2D map.");
  assert(twoDFullscreen.centeredNodeCount === 0, "2D fullscreen should keep the fixed lane/structure layout without center-focused nodes.");
  assert(twoDFullscreen.visibleEdgeLabelBoxCount === 0, "2D fullscreen should not render edge label boxes that can cover cards.");
  assert(twoDFullscreen.visibleEdgeTextCount >= 1, "2D fullscreen should render lightweight relationship text directly on lines.");
  assert(twoDFullscreen.resetVisible === false, "2D fullscreen should hide the 3D-only layout reset button.");
  assert(/二维|结构图|研究脉络图|证据泳道/.test(twoDFullscreen.text), "2D fullscreen should expose readable graph text.");
  await page.locator("#graph2dFullscreenSvg .svg-node").first().click();
  const twoDAfterNodeClick = await page.evaluate(() => ({
    centeredNodeCount: document.querySelectorAll("#graph2dFullscreenSvg .svg-node.center").length,
    status: document.querySelector("#status")?.textContent || ""
  }));
  assert(twoDAfterNodeClick.centeredNodeCount === 0 && /固定布局|固定结构/.test(twoDAfterNodeClick.status), `Clicking a 2D node should not switch to a center view: ${JSON.stringify(twoDAfterNodeClick)}`);
  await page.locator("#closeGraphFullscreen").click();
  await page.waitForFunction(() => !document.querySelector("#graphFullscreen")?.classList.contains("active"));

  await openGraphPanel(page, "图谱解读");
  const afterInsight = await page.evaluate(() => ({
    open: [...document.querySelectorAll(".graph-panel")].find((item) => item.querySelector("summary")?.textContent?.includes("图谱解读"))?.open,
    insightExists: Boolean(document.querySelector("#graph3dInsight")),
    insightText: document.querySelector("#graph3dInsight")?.textContent?.trim() || ""
  }));
  assert(afterInsight.open === true, "Relation insight panel should open after clicking its summary.");
  assert(afterInsight.insightExists, "Relation insight container should exist.");
  assert(afterInsight.insightText.length > 0, "Relation insight panel should render content when opened.");

  await openGraphPanel(page, "关系证据详情");
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
    assert(/核心关系/.test(afterList.relationNote) && /候选关系/.test(afterList.relationNote), `Relation explanation should clarify core vs candidate relationships: ${JSON.stringify(afterList)}`);
  }

  const exportCsvState = await page.evaluate(() => ({
    evidenceAuditHeader: window.__litReviewExportCsv?.evidenceAuditCsv?.().split("\n")[0] || "",
    metricEvidenceHeader: window.__litReviewExportCsv?.metricEvidenceCsv?.().split("\n")[0] || "",
    candidateEdgesHeader: window.__litReviewExportCsv?.candidateEdgesCsv?.().split("\n")[0] || "",
    candidateEdgesText: window.__litReviewExportCsv?.candidateEdgesCsv?.() || "",
    mermaidText: window.__litReviewExportCsv?.mermaidGraph?.() || "",
    graphMlText: window.__litReviewExportCsv?.graphMl?.() || "",
    mindmapText: window.__litReviewExportCsv?.mindmapMarkdown?.() || "",
    exportButtonText: document.querySelector("#exportPack")?.textContent?.trim() || ""
  }));
  assert(exportCsvState.evidenceAuditHeader.includes("source") && exportCsvState.evidenceAuditHeader.includes("quote") && exportCsvState.evidenceAuditHeader.includes("usable"), "Export pack should include evidence-audit.csv fields.");
  assert(exportCsvState.metricEvidenceHeader.includes("needs_original_check") && exportCsvState.metricEvidenceHeader.includes("confidence"), "Export pack should include metric-evidence.csv fields.");
  assert(exportCsvState.candidateEdgesHeader.includes("relation_type") && exportCsvState.candidateEdgesHeader.includes("relation_kind") && exportCsvState.candidateEdgesHeader.includes("status"), "Export pack should include candidate-edges.csv fields.");
  assert(exportCsvState.candidateEdgesText.includes("candidate_not_default_graph") || exportCsvState.candidateEdgesText.split("\n").length === 1, "Candidate edge CSV should mark hidden graph candidates when present.");
  assert(exportCsvState.mermaidText.includes("```mermaid") && exportCsvState.graphMlText.includes("<graphml") && exportCsvState.mindmapText.includes("PaperAtlas"), "Export pack should include Mermaid, GraphML, and mindmap Markdown graph exports.");

  if (await page.locator("#exitFocusMode").isVisible().catch(() => false)) {
    await page.locator("#exitFocusMode").click();
    await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));
  }
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
    containerBackground: getComputedStyle(document.querySelector("#journalReview")).backgroundColor,
    text: document.querySelector("#journalReview")?.textContent || "",
    reviewPaneCanScroll: (() => {
      const pane = document.querySelector('.tab-pane[data-pane="review"]');
      return Boolean(pane && pane.scrollHeight > pane.clientHeight + 20);
    })()
  }));
  if (!multiSelectionState.skipped) {
    assert(journalState.variantCount >= 2, "Unrelated checked documents should render a topic-version dropdown.");
  }
  assert(journalState.article, "Journal review should render as a continuous article.");
  assert(!/[\u4e00-\u9fa5]{2,3}\*?\d|[,，]\s*\d/.test(journalState.title), `Journal review title should not expose author footnote numbers: ${journalState.title}`);
  assert(!/\[\d+\]/.test(journalState.text), "Rendered journal review should not expose bracketed citation numbers.");
  assert(journalState.reviewPaneCanScroll, "Focused review pane should allow scrolling through the full generated article.");
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

  if (await page.locator("#exitFocusMode").isVisible().catch(() => false)) {
    await page.locator("#exitFocusMode").click();
    await page.waitForFunction(() => !document.body.classList.contains("focus-mode"));
  }
  await page.locator("#fileInput").setInputFiles({
    name: "background-job-valid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("研究问题：测试完成态上传任务是否会自动从解析进度区域隐藏。\n方法：构造一份简短文本资料。\n结论：完成态只应短暂停留，失败态才需要保留操作入口。")
  });
  await page.locator("#uploadForm button[type=submit]").click();
  await page.waitForSelector(".upload-job-completed", { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector(".upload-job-completed"), { timeout: 7000 });
  const completedUploadJobsHidden = await page.evaluate(() => ({
    completedJobs: document.querySelectorAll(".upload-job-completed").length,
    failedJobs: document.querySelectorAll(".upload-job-failed").length,
    uploadJobsText: document.querySelector("#uploadJobs")?.textContent?.trim() || ""
  }));
  assert(completedUploadJobsHidden.completedJobs === 0 && !completedUploadJobsHidden.uploadJobsText.includes("background-job-valid.txt"), "Completed upload jobs should disappear from the progress area after a short confirmation.");
  assert(completedUploadJobsHidden.failedJobs >= 1, "Failed upload jobs should remain visible after completed jobs are hidden.");

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
