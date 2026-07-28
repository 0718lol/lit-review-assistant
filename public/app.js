import { api } from "./src/api/client.js";
import { createInitialState } from "./src/state/create-state.js";
import { uploadFileIssue } from "./src/uploads/file-validation.js";
import { cleanUiText, escapeHtml, friendlyText, plainReview } from "./src/shared/text.js";
import { renderJournalReviewDraft, renderReviewDraft } from "./src/review/render.js";
import { createPaperWorkspace } from "./src/paper/workspace.js";

const state = createInitialState(localStorage);

const graph3dCanvasState = {
  main: null,
  fullscreen: null
};

const els = {
  status: document.querySelector("#status"),
  uploadForm: document.querySelector("#uploadForm"),
  fileInput: document.querySelector("#fileInput"),
  filePickerHint: document.querySelector("#filePickerHint"),
  uploadJobs: document.querySelector("#uploadJobs"),
  docCount: document.querySelector("#docCount"),
  edgeCount: document.querySelector("#edgeCount"),
  docList: document.querySelector("#docList"),
  docSearch: document.querySelector("#docSearch"),
  searchModeButtons: document.querySelectorAll("[data-search-mode]"),
  searchSummary: document.querySelector("#searchSummary"),
  showAllDocs: document.querySelector("#showAllDocs"),
  selectionCount: document.querySelector("#selectionCount"),
  selectVisibleDocs: document.querySelector("#selectVisibleDocs"),
  applySelection: document.querySelector("#applySelection"),
  clearSelection: document.querySelector("#clearSelection"),
  scopeLabel: document.querySelector("#scopeLabel"),
  providerBadge: document.querySelector("#providerBadge"),
  providerForm: document.querySelector("#providerForm"),
  providerType: document.querySelector("#providerType"),
  providerBaseUrl: document.querySelector("#providerBaseUrl"),
  providerModel: document.querySelector("#providerModel"),
  providerApiKey: document.querySelector("#providerApiKey"),
  providerStatus: document.querySelector("#providerStatus"),
  testProvider: document.querySelector("#testProvider"),
  edgeList: document.querySelector("#edgeList"),
  matrixTable: document.querySelector("#matrixTable"),
  researchGaps: document.querySelector("#researchGaps"),
  canvas: document.querySelector("#graphCanvas"),
  graphSvg: document.querySelector("#graphSvg"),
  graph3dScene: document.querySelector("#graph3dScene"),
  graph3dInsight: document.querySelector("#graph3dInsight"),
  graph3dSvg: document.querySelector("#graph3dSvg"),
  graph3dFullscreenScene: document.querySelector("#graph3dFullscreenScene"),
  graph3dFullscreenSvg: document.querySelector("#graph3dFullscreenSvg"),
  resetGraphLayout: document.querySelector("#resetGraphLayout"),
  resetGraphLayoutFullscreen: document.querySelector("#resetGraphLayoutFullscreen"),
  graphFullscreen: document.querySelector("#graphFullscreen"),
  graphFullscreenViewport: document.querySelector("#graphFullscreenViewport"),
  openGraphFullscreen: document.querySelector("#openGraphFullscreen"),
  closeGraphFullscreen: document.querySelector("#closeGraphFullscreen"),
  graphWrap: document.querySelector(".graph-wrap"),
  askForm: document.querySelector("#askForm"),
  question: document.querySelector("#question"),
  answer: document.querySelector("#answer"),
  reviewDraft: document.querySelector("#reviewDraft"),
  journalReview: document.querySelector("#journalReview"),
  suggestedQuestions: document.querySelector("#suggestedQuestions"),
  generateJournalReview: document.querySelector("#generateJournalReview"),
  reviewTopic: document.querySelector("#reviewTopic"),
  reviewStructure: document.querySelector("#reviewStructure"),
  reviewWordCount: document.querySelector("#reviewWordCount"),
  reviewCitationFormat: document.querySelector("#reviewCitationFormat"),
  reviewKeepAudit: document.querySelector("#reviewKeepAudit"),
  exportPack: document.querySelector("#exportPack"),
  exportMap: document.querySelector("#exportMap"),
  exportReview: document.querySelector("#exportReview"),
  clearAll: document.querySelector("#clearAll"),
  libraryToggle: document.querySelector("#libraryToggle"),
  closeLibrary: document.querySelector("#closeLibrary"),
  workspaceDashboard: document.querySelector("#workspaceDashboard"),
  inspectorPanel: document.querySelector("#inspectorPanel"),
  docInspector: document.querySelector("#docInspector"),
  closeInspector: document.querySelector("#closeInspector"),
  tabs: document.querySelectorAll(".tab"),
  panes: document.querySelectorAll(".tab-pane")
};

const paperWorkspace = createPaperWorkspace({
  root: document.querySelector("#paperWorkspace"),
  setStatus
});

let searchTimer = null;
let searchRequestId = 0;
let uploadJobsTimer = null;
const uploadJobStatuses = new Map();
let graph3dDragState = null;
let suppressGraph3dClick = false;
let graph3dDragRenderFrame = 0;

function scopedLibraryPath() {
  if (state.activeDocId === "selection" && state.selectedDocIds.length) {
    return `/api/library?docIds=${state.selectedDocIds.map(encodeURIComponent).join(",")}`;
  }
  const docId = state.activeDocId && state.activeDocId !== "all" ? encodeURIComponent(state.activeDocId) : "all";
  return `/api/library?docId=${docId}`;
}

async function loadLibrary() {
  if (state.activeDocId === "selection" && state.selectedDocIds.length < 2) {
    state.activeDocId = "all";
    localStorage.setItem("activeDocId", "all");
  }
  const data = await api(scopedLibraryPath());
  if (!state.activeDocId && data.docs?.[0]?.id) {
    state.activeDocId = data.docs[0].id;
    localStorage.setItem("activeDocId", state.activeDocId);
    applyLibrary(await api(scopedLibraryPath()));
    return;
  }
  applyLibrary(data);
}

function setStatus(text) {
  els.status.textContent = text;
}

function graphManualLayoutScope() {
  const docsKey = (state.graph.nodes || []).map((node) => node.id).sort().join("|") || "empty";
  return `${state.activeDocId || "all"}::${state.graphCenterId || "overview"}::${docsKey}`;
}

function graphManualOffsetsForScope(scope = graphManualLayoutScope()) {
  if (!state.graphNodeOffsets || typeof state.graphNodeOffsets !== "object") state.graphNodeOffsets = {};
  if (!state.graphNodeOffsets[scope] || typeof state.graphNodeOffsets[scope] !== "object") {
    state.graphNodeOffsets[scope] = {};
  }
  return state.graphNodeOffsets[scope];
}

function persistGraphManualOffsets() {
  localStorage.setItem("graphNodeOffsets", JSON.stringify(state.graphNodeOffsets || {}));
}

function resetGraphManualLayout() {
  if (!state.graphNodeOffsets || typeof state.graphNodeOffsets !== "object") return;
  const scope = graphManualLayoutScope();
  if (!state.graphNodeOffsets[scope]) return;
  delete state.graphNodeOffsets[scope];
  persistGraphManualOffsets();
  renderGraph3d();
  if (els.graphFullscreen?.classList.contains("active")) renderGraph3dFullscreen();
  setStatus("已重置当前三维图布局。");
}

function pruneGraphManualOffsets() {
  if (!state.graphNodeOffsets || typeof state.graphNodeOffsets !== "object") return;
  const validIds = new Set((state.graph.nodes || []).map((node) => node.id));
  Object.values(state.graphNodeOffsets).forEach((scopeOffsets) => {
    if (!scopeOffsets || typeof scopeOffsets !== "object") return;
    Object.keys(scopeOffsets).forEach((id) => {
      if (!validIds.has(id)) delete scopeOffsets[id];
    });
  });
  persistGraphManualOffsets();
}

function uploadJobIsActive(job = {}) {
  return ["queued", "parsing", "ocr", "enhancing", "saving", "canceling"].includes(job.status);
}

function uploadJobStatusLabel(job = {}) {
  const labels = {
    queued: "等待解析",
    parsing: "解析中",
    ocr: "OCR 识别",
    enhancing: "证据分析",
    saving: "写入资料库",
    completed: "已完成",
    duplicate: "已存在",
    failed: "失败",
    canceling: "正在取消",
    canceled: "已取消"
  };
  return job.phase || labels[job.status] || "等待处理";
}

function renderUploadJobs() {
  if (!els.uploadJobs) return;
  const jobs = state.uploadJobs.slice(0, 8);
  els.uploadJobs.innerHTML = jobs.map((job) => {
    const active = uploadJobIsActive(job);
    const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
    const pageText = job.totalPages ? `${job.currentPage || 0}/${job.totalPages}` : "";
    const action = job.status === "failed"
      ? `<button type="button" class="upload-job-action" data-job-action="retry" data-job-id="${escapeHtml(job.id)}">重试</button>`
      : active && job.status !== "canceling"
        ? `<button type="button" class="upload-job-action" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">取消</button>`
        : "";
    return `
      <div class="upload-job upload-job-${escapeHtml(job.status || "queued")}">
        <div class="upload-job-head">
          <strong title="${escapeHtml(job.filename || "")}">${escapeHtml(job.filename || "未命名文件")}</strong>
          ${action}
        </div>
        <div class="upload-job-meta">
          <span>${escapeHtml(uploadJobStatusLabel(job))}</span>
          <span>${escapeHtml(pageText || `${progress}%`)}</span>
        </div>
        <div class="upload-job-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
          <span style="width:${progress}%"></span>
        </div>
        ${job.error ? `<div class="upload-job-error">${escapeHtml(job.error)}</div>` : ""}
      </div>
    `;
  }).join("");
}

function scheduleUploadJobsRefresh() {
  clearTimeout(uploadJobsTimer);
  if (!state.uploadJobs.some(uploadJobIsActive)) return;
  uploadJobsTimer = setTimeout(() => refreshUploadJobs().catch((error) => setStatus(error.message)), 900);
}

async function refreshUploadJobs() {
  const data = await api("/api/jobs");
  let libraryChanged = false;
  let completedCount = 0;
  for (const job of data.jobs || []) {
    const previous = uploadJobStatuses.get(job.id);
    if (previous && uploadJobIsActive({ status: previous }) && ["completed", "duplicate"].includes(job.status)) {
      libraryChanged = true;
      completedCount += 1;
    }
    uploadJobStatuses.set(job.id, job.status);
  }
  state.uploadJobs = data.jobs || [];
  renderUploadJobs();
  if (libraryChanged) {
    await loadLibrary();
    setStatus(completedCount > 1 ? `${completedCount} 份资料解析完成，资料库已更新。` : "资料解析完成，资料库已更新。");
  }
  scheduleUploadJobsRefresh();
}

function sourceUnitLabel(doc, { long = false } = {}) {
  if ((doc?.sourceUnit || "") === "slide" || (doc?.sourceType || "") === "pptx") return long ? "幻灯片" : "slide";
  return long ? "页" : "p.";
}

function sourcePositionLabel(doc, page) {
  if (!page) return "";
  return (doc?.sourceUnit || doc?.sourceType) === "slide" || doc?.sourceType === "pptx"
    ? `slide ${page}`
    : `p.${page}`;
}

function sourceUrl(doc, page = "") {
  if (!doc?.id) return "#";
  if ((doc.sourceType || "pdf") === "pdf") {
    const suffix = page ? `#page=${encodeURIComponent(page)}` : "";
    return `/api/doc/${encodeURIComponent(doc.id)}/pdf${suffix}`;
  }
  return `/api/doc/${encodeURIComponent(doc.id)}/source`;
}

function selectionHint(count = state.selectedDocIds.length) {
  if (count === 0) return "勾选资料后，可以分析单篇结构图；选择 2 篇以上会生成跨文档矩阵、关系网和综合问答范围。";
  if (count === 1) return "已选择 1 篇；点击后生成这篇资料的二维/三维结构图、证据卡和单篇矩阵。";
  return `已选择 ${count} 篇；点击后只用这些资料重建关系网、矩阵和综述范围。`;
}

function applyLibrary(data) {
  state.docs = data.docs || [];
  if (data.activeDocId) state.activeDocId = data.activeDocId;
  state.selectedDocIds = state.selectedDocIds.filter((id) => state.docs.some((doc) => doc.id === id));
  if (state.activeDocId === "selection" && state.selectedDocIds.length < 2) {
    state.activeDocId = "all";
  }
  localStorage.setItem("selectedDocIds", JSON.stringify(state.selectedDocIds));
  if (state.activeDocId !== "all" && !state.docs.some((doc) => doc.id === state.activeDocId)) {
    if (state.activeDocId !== "selection") state.activeDocId = state.docs[0]?.id || "all";
  }
  localStorage.setItem("activeDocId", state.activeDocId);
  state.activeDocIds = data.activeDocIds || [];
  state.scopedCount = data.scopedCount || 0;
  state.docFlow = data.docFlow || null;
  state.graph = data.graph || { nodes: [], edges: [] };
  pruneGraphManualOffsets();
  if (state.graphCenterId && !state.graph.nodes.some((node) => node.id === state.graphCenterId)) {
    state.graphCenterId = "";
    localStorage.removeItem("graphCenterId");
  }
  if (state.selectedGraphEdgeId && !state.graph.edges.some((edge) => graphEdgeId(edge) === state.selectedGraphEdgeId)) {
    state.selectedGraphEdgeId = "";
  }
  state.matrix = data.matrix || [];
  state.researchGaps = data.researchGaps || null;
  state.review = data.review || "";
  state.impactAnalysis = data.impactAnalysis || state.impactAnalysis || null;
  state.provider = data.provider || null;
  render();
}

function render() {
  els.docCount.textContent = state.docs.length;
  renderRelationCount();
  els.providerBadge.textContent = state.provider?.note || "本地模式";
  renderProviderControls();
  renderWorkspaceDashboard();
  const visibleDocs = filteredDocs();
  renderSelectionTools(visibleDocs);
  renderSearchControls();
  els.searchSummary.innerHTML = renderSearchSummary();
  els.scopeLabel.textContent = scopeText();
  els.docList.innerHTML = visibleDocs.length
    ? visibleDocs.map(docCard).join("")
    : emptyDocList();
  renderDocInspector();
  els.edgeList.innerHTML = renderGraphSideList();
  if (els.graph3dInsight) els.graph3dInsight.innerHTML = renderGraph3dInsight();
  els.matrixTable.innerHTML = renderMatrix();
  if (els.researchGaps) els.researchGaps.innerHTML = renderResearchGaps();
  els.reviewDraft.innerHTML = renderReviewDraft(state.review, "上传文献后自动生成综述草稿。");
  els.journalReview.innerHTML = renderJournalReviewPanel("点击“生成期刊综述”后，这里会单独生成一版按期刊综述结构组织的内容。");
  els.suggestedQuestions.innerHTML = renderSuggestedQuestions();
  paperWorkspace.sync({ docs: state.docs, selectedDocIds: state.selectedDocIds });
  if (activeTab() === "map") drawGraph();
}

function renderWorkspaceDashboard() {
  if (!els.workspaceDashboard) return;
  const docs = state.docs || [];
  const evidence = docs.flatMap((doc) => evidenceAuditItemsForDoc(doc).map(([, , item]) => item));
  const usable = evidence.filter(evidenceItemUsableForExport).length;
  const review = evidence.length - usable;
  const coreEdges = state.graph?.edges?.length || 0;
  const candidateEdges = state.graph?.candidateEdges?.length || 0;
  const selectedCount = state.activeDocId === "selection" ? state.selectedDocIds.length : state.activeDocIds?.length || docs.length;
  const mode = selectedCount <= 1
    ? "单篇证据卡"
    : coreEdges > 0
      ? "跨文档综合"
      : "等待建图";
  const synthesisHint = selectedCount <= 1
    ? "适合先看单篇研究结构，再补同域文献。"
    : candidateEdges
      ? "默认只展示核心关系，候选关系留给审计。"
      : "已进入多文献矩阵、图谱和综述范围。";
  const cards = [
    {
      label: "资料入口",
      value: `${docs.length}`,
      unit: "篇",
      text: "PDF / PPTX 批量解析，按题名和作者检索。"
    },
    {
      label: "证据审计",
      value: `${usable}`,
      unit: "条可用",
      text: review ? `${review} 条字段被标为待核对，避免弱证据直接上屏。` : "完整自然句优先进入可引用证据。"
    },
    {
      label: "关系综合",
      value: `${coreEdges}`,
      unit: candidateEdges ? `核心 / ${candidateEdges} 候选` : "核心关系",
      text: "关系图只把强关系放到主视图，减少“什么都有关”。"
    },
    {
      label: "写作出口",
      value: mode,
      unit: "",
      text: synthesisHint
    }
  ];
  els.workspaceDashboard.innerHTML = `
    <div class="dashboard-title">
      <strong>综述工作流</strong>
      <span>从资料上传到证据、关系、问答和草稿导出，全程保留可核对来源。</span>
    </div>
    <div class="dashboard-steps">
      ${cards.map((card, index) => `
        <div class="dashboard-card">
          <span class="dashboard-step">${index + 1}</span>
          <div>
            <em>${escapeHtml(card.label)}</em>
            <b>${escapeHtml(card.value)}${card.unit ? `<small>${escapeHtml(card.unit)}</small>` : ""}</b>
            <p>${escapeHtml(card.text)}</p>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderRelationCount() {
  if (state.docFlow) {
    const nodes = state.docFlow.nodes?.length || 0;
    const links = state.docFlow.edges?.length || 0;
    if (!els.edgeCount) return;
    els.edgeCount.innerHTML = `
      <span class="relation-count-main">${nodes}</span>
      <span class="relation-count-breakdown">
        <em>结构节点</em>
        <em>${links} 逻辑连线</em>
      </span>
    `;
    const label = document.querySelector("#edgeCountLabel");
    if (label) label.textContent = `单篇二维/三维结构图：${nodes} 个节点，${links} 条逻辑连线`;
    return;
  }
  const core = state.graph.edges?.length || 0;
  const candidate = state.graph.candidateEdges?.length || 0;
  const total = core + candidate;
  if (!els.edgeCount) return;
  els.edgeCount.innerHTML = `
    <span class="relation-count-main">${total}</span>
    <span class="relation-count-breakdown">
      <em>${core} 核心</em>
      <em>${candidate} 候选</em>
    </span>
  `;
  const label = document.querySelector("#edgeCountLabel");
  if (label) {
    label.textContent = candidate
      ? `共 ${total} 条关系，默认显示 ${core} 条`
      : `${core} 条核心关系`;
  }
}

function renderProviderControls() {
  if (!els.providerForm || !state.provider) return;
  const active = document.activeElement;
  if (active && els.providerForm.contains(active)) return;
  const provider = state.provider.provider || "local";
  els.providerType.value = provider;
  els.providerBaseUrl.value = state.provider.baseUrl || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  els.providerModel.value = state.provider.model || (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5");
  els.providerApiKey.value = "";
  els.providerApiKey.placeholder = state.provider.hasApiKey ? "已保存，留空表示保留" : "填写 API Key";
  const local = provider === "local";
  els.providerBaseUrl.disabled = local;
  els.providerModel.disabled = local;
  els.providerApiKey.disabled = local;
  els.testProvider.disabled = local;
  els.providerStatus.textContent = provider === "local"
    ? "本地研究引擎已启用；不需要模型也可以上传、抽取、建图、问答和生成草稿。"
    : `${state.provider.providerName || "模型增强"}：${state.provider.lastStatus || "未测试"}；本地引擎始终可用。`;
}

function providerDefaults(provider) {
  if (provider === "anthropic") return { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" };
  if (provider === "local") return { baseUrl: "", model: "" };
  return { baseUrl: "https://api.openai.com/v1", model: "gpt-5" };
}

function renderDocFlowList() {
  const nodes = state.docFlow.nodes || [];
  if (state.docFlow.mode === "unreadable") {
    return nodes.map((node) => `<div class="edge-item edge-risk"><b>${escapeHtml(node.title)}</b>：${escapeHtml(node.text)}</div>`).join("");
  }
  const links = state.docFlow.edges?.length || 0;
  const note = `
    <div class="relation-display-note">
      当前是单篇资料的二维/三维结构图，不是跨文档关系网；图中按“核心问题、分析路径、作用机制、关键证据、边界风险、结论条件”展示 <b>${nodes.length}</b> 个结构节点和 <b>${links}</b> 条逻辑连线。
    </div>
  `;
  return note + nodes.map((node, index) => `
    <div class="edge-item ${index >= 4 ? "edge-risk" : "edge-source"}">
      <b>${escapeHtml(node.title)}</b>${node.citation ? ` <span>${escapeHtml(node.citation)}</span>` : ""}：${escapeHtml(node.summary || node.text)}
      ${node.evidence ? `<div class="evidence-quote">依据：${escapeHtml(node.evidence)}</div>` : ""}
    </div>
  `).join("");
}

function renderGraphSideList() {
  if (state.docFlow) return renderDocFlowList();
  if (!state.graph.edges.length) {
    return `<div class="edge-item">至少两篇文献出现共同主题后，研究脉络图会自动补充语义连线。</div>`;
  }
  let edges = state.graph.edges;
  if (state.selectedGraphEdgeId) {
    edges = edges.filter((edge) => graphEdgeId(edge) === state.selectedGraphEdgeId);
  } else if (state.graphCenterId) {
    edges = edges.filter((edge) => edge.source === state.graphCenterId || edge.target === state.graphCenterId);
  }
  const empty = `<div class="edge-item">当前节点暂时没有直接关系，点击其他节点查看空间关系。</div>`;
  const title = state.selectedGraphEdgeId
    ? `<div class="graph-list-note">当前只显示选中的关系。点击空白处恢复中心视图。</div>`
    : state.graphCenterId
      ? `<div class="graph-list-note">当前显示所选节点的直接关系。</div>`
      : "";
  const edgeList = edges.length ? edges.map(edgeCard).join("") : empty;
  if (state.selectedGraphEdgeId) return `${title}${edgeList}${renderImpactAnalysis()}${renderGraphArgument()}`;
  return `${renderImpactAnalysis()}${renderGraphArgument()}${renderRelationDisplayNote()}${title}${edgeList}${renderCandidateEdges()}`;
}

function renderRelationDisplayNote() {
  const core = state.graph.edges?.length || 0;
  const candidate = state.graph.candidateEdges?.length || 0;
  if (!core && !candidate) return "";
  return `
    <div class="relation-display-note">
      <b>${core}</b> 条核心关系用于默认画图；${candidate ? `<b>${candidate}</b> 条候选关系收起在下方，避免图谱过密，可展开复核或在研究包中导出。` : "暂无候选关系被收起。"}
    </div>
  `;
}

function renderCandidateEdges() {
  const total = (state.graph.candidateEdges || []).length;
  const candidates = (state.graph.candidateEdges || []).slice(0, 8);
  if (!candidates.length) return "";
  const countLabel = total > candidates.length ? `${candidates.length}/${total}` : `${candidates.length}`;
  return `
    <details class="edge-item edge-compare">
      <summary>候选关系 ${countLabel} 条 <span>已识别但未默认上图，适合复核或导出</span></summary>
      <div class="candidate-edge-list">
        ${candidates.map(edgeCard).join("")}
      </div>
    </details>
  `;
}

function renderGraphArgument() {
  const argument = state.graph.argument;
  if (!argument?.steps?.length) return "";
  const steps = argument.steps.map((step, index) => `
    <div class="argument-step">
      <div class="argument-index">${index + 1}</div>
      <div>
        <b>${escapeHtml(step.role)}：${escapeHtml(step.title)}</b>
        <p>${escapeHtml(completeUiText(step.text))}</p>
        <p class="argument-proves">证明作用：${escapeHtml(completeUiText(step.proves))}</p>
        ${step.refs?.length ? `<div class="argument-refs">${step.refs.map((ref) => `<span>${escapeHtml(ref)}</span>`).join("")}</div>` : ""}
      </div>
    </div>
  `).join("");
  const weakLinks = (argument.weakLinks || []).slice(0, 3).map((item) => `<li>${escapeHtml(completeUiText(item))}</li>`).join("");
  return `
    <section class="argument-card">
      <h3>这几篇能推出什么</h3>
      <p class="argument-thesis">${escapeHtml(completeUiText(argument.thesis))}</p>
      <div class="argument-chain">${steps}</div>
      <div class="argument-conclusion"><b>综合结论：</b>${escapeHtml(completeUiText(argument.conclusion))}</div>
      ${weakLinks ? `<div class="argument-warning"><b>不能强行推导的地方：</b><ul>${weakLinks}</ul></div>` : ""}
    </section>
  `;
}

function renderImpactAnalysis() {
  const impact = state.impactAnalysis;
  if (!impact || !impact.addedCount) return "";
  const block = (title, items, cls = "edge-source") => items?.length ? `
    <div class="impact-block ${cls}">
      <b>${escapeHtml(title)}</b>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  ` : "";
  return `
    <section class="argument-card impact-card">
      <h3>新增文献影响分析</h3>
      <p class="argument-thesis">新增 ${impact.addedCount} 篇资料后，当前库共 ${impact.totalCount || state.docs.length} 篇。下面只显示会影响综述结构的变化。</p>
      ${block("补强了哪些结论", impact.supports, "edge-source")}
      ${block("挑战或限制了哪些观点", impact.challenges, "edge-risk")}
      ${block("补了哪些空白", impact.fillsGaps, "edge-extend")}
      ${block("综述应更新的位置", impact.reviewUpdates, "edge-compare")}
    </section>
  `;
}

function filteredDocs() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.docs;
  if (state.searchResults?.results) {
    const ids = new Set(state.searchResults.results.map((item) => item.doc.id));
    return state.docs
      .filter((doc) => ids.has(doc.id))
      .sort((a, b) => {
        const ai = state.searchResults.results.findIndex((item) => item.doc.id === a.id);
        const bi = state.searchResults.results.findIndex((item) => item.doc.id === b.id);
        return ai - bi;
      });
  }
  return state.docs.filter((doc) => String(doc.title || "").toLowerCase().includes(query));
}

function renderSearchControls() {
  if (!["title", "author"].includes(state.searchMode)) {
    state.searchMode = "title";
    localStorage.setItem("searchMode", state.searchMode);
  }
  els.searchModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.searchMode === state.searchMode);
  });
}

function searchModeLabel(mode = state.searchMode) {
  return {
    title: "题名",
    author: "作者"
  }[mode] || "题名";
}

function renderSearchSummary() {
  const query = state.search.trim();
  if (!query) return "";
  if (state.searchLoading) return `<div class="search-card">正在检索“${escapeHtml(query)}”。</div>`;
  const data = state.searchResults;
  const mode = searchModeLabel(data?.mode || state.searchMode);
  if (!data) return "";
  if (!data.results?.length) return `<div class="search-card">${mode}检索没有命中“${escapeHtml(query)}”。请换成题名或作者里的准确片段。</div>`;
  const top = data.results.slice(0, 4).map((item) => {
    const reason = item.reason ? `<span class="search-reason">${escapeHtml(item.reason)}</span>` : "";
    const matches = (item.matches || []).slice(0, 2).map((match) => `
      <div class="search-hit">
        ${match.page ? `<a class="page-link" href="${escapeHtml(sourceUrl(item.doc, match.page))}" target="_blank" rel="noopener">${escapeHtml(sourcePositionLabel(item.doc, match.page))}</a>` : "定位待核对"}，
        第 ${escapeHtml(match.paragraph || "?")} 段：${escapeHtml(match.text)}
      </div>
    `).join("");
    return `
      <div class="search-result">
        <button type="button" class="search-open-doc" data-doc-id="${escapeHtml(item.doc.id)}">${escapeHtml(item.doc.title)}</button>
        <span>${reason}${item.matchCount ? ` ${item.matchCount} 个正文片段` : ""}</span>
        ${matches}
      </div>
    `;
  }).join("");
  return `
    <div class="search-card">
      <div class="search-total">${mode}检索命中 ${data.totalDocs} 篇资料；当前显示最相关的 ${Math.min(4, data.results.length)} 篇。</div>
      ${top}
    </div>
  `;
}

function renderSelectionTools(visibleDocs) {
  const count = state.selectedDocIds.length;
  els.selectionCount.textContent = selectionHint(count);
  els.applySelection.disabled = count < 1;
  els.applySelection.title = selectionHint(count);
  els.applySelection.textContent = count === 1 ? "分析这 1 篇" : count > 1 ? `分析选中 ${count} 篇` : "用选中资料分析";
  els.clearSelection.disabled = count === 0;
  els.selectVisibleDocs.disabled = !visibleDocs.length;
}

function emptyDocList() {
  if (state.docs.length && state.search.trim()) {
    return `<div class="doc-card"><h3>没有匹配课题</h3><p>换一个关键词，或点“全部资料”回到完整资料库。</p></div>`;
  }
  return `<div class="doc-card"><h3>还没有资料</h3><p>上传一组 PDF 或 PPTX 后，这里会出现逐份摘要、资料卡片、关键点、关键词和解析状态。</p></div>`;
}

function activeDoc() {
  return state.docs.find((doc) => doc.id === state.activeDocId) || null;
}

function scopeText() {
  if (state.search.trim()) {
    const mode = searchModeLabel();
    return `${mode}检索：${state.search.trim()}（${filteredDocs().length} 篇资料）`;
  }
  if (state.selectedDocIds.length > 1) return `当前范围：勾选资料（${state.selectedDocIds.length} 篇）`;
  if (state.activeDocId === "selection") return `当前范围：选中资料（${state.activeDocIds.length || state.selectedDocIds.length} 篇）`;
  if (state.activeDocId === "all") return `当前范围：全部资料（${state.docs.length} 篇）`;
  const doc = activeDoc();
  return `当前范围：${doc ? doc.title : "当前资料"}（独立分析）`;
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  const query = state.search.trim();
  if (!query) {
    state.searchResults = null;
    state.searchLoading = false;
    render();
    return;
  }
  state.searchLoading = true;
  render();
  searchTimer = setTimeout(runSearch, 260);
}

async function runSearch() {
  const query = state.search.trim();
  const requestId = ++searchRequestId;
  if (!query) return;
  try {
    const docParam = state.searchDocId ? `&docId=${encodeURIComponent(state.searchDocId)}` : "";
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(state.searchMode)}&limit=30${docParam}`);
    if (requestId !== searchRequestId) return;
    state.searchResults = data;
    state.searchLoading = false;
    render();
  } catch (error) {
    if (requestId !== searchRequestId) return;
    state.searchLoading = false;
    state.searchResults = { query, results: [], totalDocs: 0, totalMatches: 0, error: error.message };
    setStatus(error.message);
    render();
  }
}

function renderJournalReviewPanel(emptyText) {
  const variants = Array.isArray(state.journalReviewVariants) ? state.journalReviewVariants : [];
  if (variants.length > 1) {
    const index = Math.min(Math.max(Number(state.activeJournalVariantIndex || 0), 0), variants.length - 1);
    const current = variants[index] || variants[0];
    return `
      <div class="journal-switcher" role="group" aria-label="跨主题综述切换">
        <label for="journalVariantSelect">主题版本</label>
        <select id="journalVariantSelect">
          ${variants.map((item, variantIndex) => `
            <option value="${variantIndex}" ${variantIndex === index ? "selected" : ""}>${escapeHtml(item.label || item.title || `主题 ${variantIndex + 1}`)}</option>
          `).join("")}
        </select>
        <span>${escapeHtml(current.note || "多篇资料主题差异较大，系统拆成多个可切换的综述版本。")}</span>
      </div>
      ${renderJournalReviewDraft(current.review || state.journalReview, emptyText)}
    `;
  }
  return renderJournalReviewDraft(state.journalReview, emptyText);
}

function docCard(doc) {
  const selected = state.selectedDocIds.includes(doc.id);
  const card = doc.analysisCard || doc.researchCard || {};
  const scene = normalizeScene(card.reviewSlot || card.useCase, doc);
  const documentKind = doc.evidenceCard?.document_kind || card.documentKind || "research_document";
  const kindLabel = documentKind === "teaching_or_reference_material" ? "参考材料" : "研究文献";
  const sourceLabel = (doc.sourceType || "pdf").toUpperCase();
  const inspectorOpen = inspectorDoc()?.id === doc.id;
  return `
    <article class="doc-card doc-list-item ${doc.id === state.activeDocId ? "active" : ""} ${selected ? "selected" : ""} ${inspectorOpen ? "inspecting" : ""}">
      <label class="doc-select">
        <input type="checkbox" class="select-doc" data-doc-id="${escapeHtml(doc.id)}" ${selected ? "checked" : ""} />
        <span class="sr-only">纳入对比</span>
      </label>
      <button type="button" class="doc-title-button" data-doc-id="${escapeHtml(doc.id)}">
        <span>${escapeHtml(friendlyText(doc.title))}</span>
        <small>${escapeHtml(sourceLabel)} · ${doc.pages || 0} ${escapeHtml(sourceUnitLabel(doc, { long: true }))} · ${escapeHtml(kindLabel)}</small>
      </button>
      <span class="doc-scene-dot" title="${escapeHtml(scene)}"></span>
    </article>
  `;
}

function inspectorDoc() {
  return state.docs.find((doc) => doc.id === state.expandedDocId) || null;
}

function renderDocInspector() {
  if (!els.docInspector || !els.inspectorPanel) return;
  const doc = inspectorDoc();
  els.inspectorPanel.classList.toggle("has-document", Boolean(doc));
  document.body.classList.toggle("inspector-open", Boolean(doc));
  if (!doc) {
    els.docInspector.innerHTML = `<div class="inspector-empty"><b>选择一篇文献</b><span>这里会显示来源信息、证据质量、原文定位和文献操作。</span></div>`;
    return;
  }
  const keywords = (doc.keywords || []).slice(0, 8).map((item) => `<span class="chip">${escapeHtml(item.term)}</span>`).join("");
  const points = (doc.keyPoints || []).slice(0, 3).map((point) => {
    const page = point.page ? ` <span class="chip">${escapeHtml(sourcePositionLabel(doc, point.page))}</span>` : "";
    return `<p><b>原话摘录：</b>${escapeHtml(friendlyText(point.text))}${page}</p>`;
  }).join("");
  const card = doc.analysisCard || doc.researchCard || {};
  const scene = normalizeScene(card.reviewSlot || card.useCase, doc);
  const warnings = (doc.evidenceCard?.warnings || []).map((item) => `<div class="warning evidence-warning">${escapeHtml(item)}</div>`).join("");
  els.docInspector.innerHTML = `
    <article class="doc-card expanded doc-inspector-content">
      <div class="inspector-title-block">
        <span class="scene-badge">${escapeHtml(scene)}</span>
        <h2>${escapeHtml(friendlyText(doc.title))}</h2>
        <div class="doc-meta"><span>${doc.pages || 0} ${escapeHtml(sourceUnitLabel(doc, { long: true }))}</span><span>${doc.wordCount || 0} 词</span></div>
      </div>
      <div class="inspector-primary-actions">
        <button type="button" class="open-doc" data-doc-id="${escapeHtml(doc.id)}">${doc.id === state.activeDocId ? "当前分析" : "独立分析"}</button>
        <a class="pdf-open-link" href="${escapeHtml(sourceUrl(doc))}" target="_blank" rel="noopener">打开原文</a>
      </div>
      <div class="doc-actions">
        <button type="button" class="find-in-pdf" data-doc-id="${escapeHtml(doc.id)}">打开原文</button>
        <button type="button" class="rename-doc" data-doc-id="${escapeHtml(doc.id)}">重命名</button>
        <button type="button" class="reparse-doc" data-doc-id="${escapeHtml(doc.id)}">重解析</button>
        <button type="button" class="delete-doc danger-inline" data-doc-id="${escapeHtml(doc.id)}">删除</button>
      </div>
      ${renderDocSourceMeta(doc)}
      ${renderDocEvidenceCard(doc)}
      ${points}
      <div class="chips">${keywords}${doc.ocrUsed ? `<span class="chip">OCR 识别</span>` : ""}${doc.llmEnhanced ? `<span class="chip">模型增强</span>` : ""}</div>
      ${warnings}
      ${doc.parseWarning ? `<div class="warning">${escapeHtml(doc.parseWarning)}</div>` : ""}
    </article>
  `;
}

function renderDocSourceMeta(doc) {
  const meta = doc.sourceMeta || {};
  const source = meta.journal || doc.journal || "期刊/来源待核对";
  const authors = (doc.authors || meta.authors || []).join("、");
  const issue = meta.issue || [doc.publicationYear || meta.publicationYear, meta.doi ? `DOI ${meta.doi}` : ""].filter(Boolean).join(" · ");
  const abstract = friendlyText(doc.abstract || meta.abstract || "");
  return `
    <section class="doc-source-card">
      <div class="source-row">
        <b>作者：</b>
        <span>${escapeHtml(authors || "作者待核对")}</span>
      </div>
      <div class="source-row">
        <b>期刊/来源：</b>
        <span>${escapeHtml(source)}</span>
      </div>
      ${issue ? `<div class="source-row"><b>卷期信息：</b><span>${escapeHtml(issue)}</span></div>` : ""}
      ${meta.doi && !issue.includes(meta.doi) ? `<div class="source-row"><b>DOI：</b><span>${escapeHtml(meta.doi)}</span></div>` : ""}
      <p class="doc-abstract"><b>摘要：</b>${escapeHtml(abstract || "当前没有稳定抽出摘要，请点击重解析或回到原文首页核对。")}</p>
    </section>
  `;
}

function renderDocEvidenceCard(doc) {
  const card = doc.evidenceCard || {};
  if (card.document_kind === "teaching_or_reference_material") {
    return `
      <section class="doc-evidence-card reference-material-card">
        <div class="doc-evidence-head"><b>参考材料</b><span>研究字段不适用</span></div>
        <div class="evidence-policy-note">这份资料被识别为教学或参考材料。系统保留原始幻灯片和定位，但不会强行生成研究问题、方法、贡献和局限。</div>
        <div class="research-grid evidence-grid">
          <div><b>建议用途：</b>概念背景、课程脉络或术语说明</div>
          <div><b>引用边界：</b>引用具体观点时仍需回到对应 slide 核对上下文</div>
        </div>
      </section>
    `;
  }
  const mainFinding = (card.main_claims || []).find((item) => item?.claim) || card.contribution || {};
  const quote = (card.quotes || []).find((item) => item?.text) || {};
  const fields = [
    card.research_question,
    card.method,
    card.data_or_materials,
    mainFinding,
    ...((card.evidence || []).slice(0, 2)),
    ...((card.limitations || []).slice(0, 2))
  ].filter(Boolean);
  const weakFields = fields.filter(isWeakAuditItem);
  const missingQuoteCount = fields.filter((item) => !item.quote && !item.text && /missing|weak|review/.test(itemAuditText(item))).length;
  const directlyQuotableCount = fields.filter(isDirectlyQuotableEvidence).length;
  const metricEvidenceCount = (card.metric_evidence || []).length;
  const auditSummary = fields.length ? `
    <div class="doc-audit-strip ${weakFields.length ? "has-risk" : "is-clean"}">
      <span><b>${directlyQuotableCount}</b> 个可直接引用</span>
      <span><b>${metricEvidenceCount}</b> 个指标/图表证据</span>
      <span><b>${missingQuoteCount}</b> 个缺原文</span>
    </div>
  ` : "";
  const weakList = weakFields.slice(0, 4).map((item) => `
    <div class="doc-weak-row">
      <span>${escapeHtml(item.dimension || item.label || "证据字段")}</span>
      <b>${escapeHtml(auditLabel(item.audit || item.dimension_audit || item.dimensionAudit || "needs_review"))}</b>
      <em>${escapeHtml(friendlyText(item.evidence_role || item.claim || item.reason || "需要回到原文核对。"))}</em>
    </div>
  `).join("");
  const metricEvidence = (card.metric_evidence || []).slice(0, 3).map((item) => `
    <div class="metric-evidence-row">
      <span>${escapeHtml(item.evidence_role || "指标证据，需回原文核对")}</span>
      <em>${escapeHtml(friendlyText(item.quote || ""))}${pageLink(doc, item.page)}</em>
    </div>
  `).join("");
  const row = (label, item, fallback = "待核对") => {
    const audit = item?.audit || item?.dimension_audit || item?.dimensionAudit || "";
    const confidence = Number(item?.confidence || 0);
    const badge = audit ? `<span class="audit-pill ${auditClass(audit)}">${escapeHtml(auditLabel(audit))}${confidence ? ` ${Math.round(confidence * 100)}%` : ""}</span>` : "";
    return `<div><b>${escapeHtml(label)}：</b>${escapeHtml(friendlyText(item?.claim || fallback))}${badge}</div>`;
  };
  return `
    <section class="doc-evidence-card">
      <div class="doc-evidence-head">
        <b>证据卡</b>
        <span>整体置信度 ${Math.round(Number(card.confidence || 0) * 100)}%</span>
      </div>
      <div class="evidence-policy-note">
        系统只把完整自然句标为可直接引用；公式、图表、表格和指标性证据会单独标为“需回原文核对”，避免把残片误写成原话引用。
      </div>
      ${auditSummary}
      <div class="research-grid evidence-grid">
        ${row("研究问题", card.research_question)}
        ${row("方法路径", card.method)}
        ${row("数据/材料", card.data_or_materials)}
        ${row("核心发现", mainFinding)}
        ${row("局限风险", (card.limitations || [])[0])}
        <div><b>适合写入：</b>${escapeHtml(reviewSectionForDoc(doc))}</div>
      </div>
      ${weakList ? `<details class="doc-weak-fields"><summary>查看待核对字段</summary>${weakList}</details>` : ""}
      <div class="quote-line"><b>可引用原文：</b>${quote.text ? `${escapeHtml(friendlyText(quote.text))}${pageLink(doc, quote.page)}` : "暂无可直接引用原文"}</div>
      ${metricEvidence ? `<details class="doc-weak-fields"><summary>查看指标/图表证据</summary>${metricEvidence}</details>` : ""}
    </section>
  `;
}

function isDirectlyQuotableEvidence(item = {}) {
  const quote = item.quote || item.text || "";
  if (!quote || item.direct_quote_eligible === false) return false;
  if (isWeakAuditItem(item)) return false;
  return /strong|supported|ok/.test(itemAuditText(item)) || Number(item.confidence || 0) >= 0.6;
}

function pageLink(docOrId, page) {
  const doc = docById(docOrId);
  if (!doc.id || !page) return "";
  return ` <a class="page-link" href="${escapeHtml(sourceUrl(doc, page))}" target="_blank" rel="noopener">${escapeHtml(sourcePositionLabel(doc, page))}</a>`;
}

function itemAuditText(item = {}) {
  return [
    item?.audit,
    item?.dimension_audit,
    item?.dimensionAudit,
    item?.support_level,
    item?.not_usable_reason
  ].filter(Boolean).join(" ");
}

function isWeakAuditItem(item = {}) {
  return /missing|weak|review|mismatch|low_quote_quality|not_usable/i.test(itemAuditText(item));
}

function auditLabel(audit = "") {
  if (audit === "missing_quote") return "无原文";
  if (audit === "weak_support") return "弱支撑";
  if (audit === "needs_review") return "待核对";
  if (audit === "missing_page") return "缺定位";
  if (audit === "dimension_mismatch") return "维度错位";
  return "已支撑";
}

function reviewSectionForDoc(doc) {
  const profile = state.graph.nodes.find((node) => node.id === doc.id)?.profile || {};
  if (/理论|机制|影响|演进|背景/.test(`${profile.problemType} ${profile.evidenceType}`)) return "研究背景 / 理论脉络";
  if (/方法|框架|流程|建模|控制/.test(`${profile.methodType}`)) return "方法谱系 / 技术路线";
  if (/实验|指标|案例|计量/.test(`${profile.evidenceType}`)) return "证据比较 / 结果评估";
  if (/风险|边界|局限/.test(`${profile.riskType}`)) return "局限与未来方向";
  return "相关工作综述";
}

function normalizeScene(scene, doc) {
  if (!scene || scene === "资料背景" || scene === "相关研究背景") return inferSceneFromDoc(doc);
  return scene;
}

function inferSceneFromDoc(doc) {
  const text = `${doc.title || ""} ${doc.filename || ""} ${doc.abstract || ""} ${doc.takeaway || ""}`;
  if (/project-plan|implementation plan|项目实施方案|实施方案/i.test(text)) return "项目执行";
  if (/budget-summary|budget summary|预算说明|预算摘要/i.test(text)) return "预算与成本";
  if (/risk-register|risk register|风险清单|风险台账/i.test(text)) return "风险与合规";
  if (/customer-feedback|customer feedback|用户反馈|客户反馈/i.test(text)) return "用户与反馈";
  if (/vendor-comparison|vendor comparison|供应商对比|竞品对比/i.test(text)) return "供应商与对比";
  if (/预算|成本|费用|报价|budget|cost|price/i.test(text)) return "预算与成本";
  if (/风险|安全|回滚|合规|risk|security|compliance/i.test(text)) return "风险与合规";
  if (/用户|客户|反馈|投诉|customer|user|feedback/i.test(text)) return "用户与反馈";
  if (/供应商|竞品|对比|vendor|competitor|comparison/i.test(text)) return "供应商与对比";
  if (/方案|计划|实施|上线|迁移|plan|implementation|migration/i.test(text)) return "项目执行";
  return "资料背景";
}

function edgeCard(edge) {
  const aNode = state.graph.nodes.find((node) => node.id === edge.source) || {};
  const bNode = state.graph.nodes.find((node) => node.id === edge.target) || {};
  const a = graphLogicLabel(aNode);
  const b = graphLogicLabel(bNode);
  const details = (edge.evidence?.details || []).slice(0, 3).map((item) => `<li>${escapeHtml(completeUiText(item))}</li>`).join("");
  const sources = (edge.evidence?.sources || []).slice(0, 2).map((item, index) => `
    <div class="edge-source-line"><b>${index === 0 ? "A" : "B"}</b>${escapeHtml(completeUiText(item.quote || ""))}${item.citation ? ` <span>${escapeHtml(item.citation)}</span>` : ""}</div>
  `).join("");
  return `
    <div class="edge-item ${relationClass(edge.relation)}">
      <div><b>${escapeHtml(edge.relation)}</b>${edge.relationKind ? ` <span class="relation-kind">${escapeHtml(edge.relationKind)}</span>` : ""}：${escapeHtml(a)} ↔ ${escapeHtml(b)}</div>
      <div class="edge-why">${escapeHtml(completeUiText(edge.evidence?.why || `共享 ${(edge.shared || []).join("、") || "少量主题"}`))}</div>
      <details class="edge-explain">
        <summary>查看关系依据</summary>
        ${edge.shared?.length ? `<div class="edge-shared"><b>共享概念</b>${escapeHtml(edge.shared.join("、"))}</div>` : ""}
        ${details ? `<ul class="edge-details">${details}</ul>` : ""}
        ${sources ? `<div class="edge-sources">${sources}</div>` : ""}
      </details>
    </div>
  `;
}

function graphLogicLabel(node = {}) {
  const profile = node.profile || {};
  return [profile.domain, profile.problemType, profile.methodType]
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ") || "待核对研究逻辑";
}

function graphSourceLabel(node = {}) {
  const clean = friendlyText(node.title || node.label || "");
  return clean.replace(/[，,]\s*[^，,]{1,8}(?:等)?$/g, "");
}

function completeUiText(value) {
  return friendlyText(value).replace(/\.{3}|…/g, "").trim();
}

function renderMatrix() {
  if (!state.matrix.length) return `<div class="edge-item">上传 PDF 或 PPTX 后生成资料矩阵：单篇用于拆研究逻辑，多篇用于横向对比。</div>`;
  if (state.matrix.some((row) => row.mode === "single-doc" || row.dimension)) return renderSingleDocMatrix();
  return renderMultiDocMatrix();
}

function renderSingleDocMatrix() {
  const rows = state.matrix.map((row) => `
    <tr>
      <td><div class="matrix-title">${escapeHtml(friendlyText(row.dimension))}</div></td>
      <td><div class="matrix-cell matrix-cell-open">${escapeHtml(friendlyText(row.claim))}</div></td>
      <td><div class="matrix-cell matrix-cell-open">${escapeHtml(friendlyText(row.evidence))}</div></td>
      <td>${escapeHtml(row.citation || "待核对")}</td>
      <td><div class="matrix-cell matrix-cell-open">${escapeHtml(friendlyText(row.notes))}</div></td>
    </tr>
  `).join("");
  return `
    <table class="single-doc-matrix">
      <thead><tr><th>维度</th><th>核心内容</th><th>依据片段</th><th>定位</th><th>用途/备注</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMultiDocMatrix() {
  const rows = state.matrix.map((row) => `
    <tr>
      <td><div class="matrix-title">${escapeHtml(friendlyText(row.title))}</div></td>
      <td><div class="matrix-cell">${escapeHtml(friendlyText(row.question))}</div></td>
      <td><div class="matrix-cell">${escapeHtml(friendlyText(row.method))}</div></td>
      <td><div class="matrix-cell">${escapeHtml(friendlyText(row.dataOrMaterials || "待核对"))}</div></td>
      <td><div class="matrix-cell">${escapeHtml(friendlyText(row.findings))}</div></td>
      <td>
        ${renderMatrixEvidenceStatus(row)}
      </td>
      <td><div class="matrix-cell">${escapeHtml(friendlyText(row.limitations))}</div></td>
      <td><span class="scene-badge compact">${escapeHtml(normalizeScene(row.reviewSlot, row))}</span></td>
    </tr>
  `).join("");
  return `
    <table>
      <thead><tr><th>资料</th><th>研究问题</th><th>方法</th><th>数据/材料</th><th>核心发现</th><th>证据状态</th><th>风险或限制</th><th>适用场景</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMatrixEvidenceStatus(row) {
  const status = matrixEvidenceStatus(row);
  const quote = friendlyText(row.quote || row.evidence || "");
  return `
    <div class="matrix-evidence-status">
      <span class="matrix-status-pill ${status.className}">${escapeHtml(status.label)}</span>
      <span class="matrix-confidence">${Math.round(Number(row.confidence || 0) * 100)}%</span>
    </div>
    <details class="matrix-evidence-detail">
      <summary>查看证据</summary>
      <div class="matrix-cell matrix-cell-open">${escapeHtml(quote || "暂无可直接引用原文")}</div>
      <div class="matrix-proof-meta">
        ${row.page ? pageLink(row.id, row.page) : `<span>未定位位置</span>`}
        <span>${escapeHtml(row.audit || "待核对")}</span>
      </div>
    </details>
  `;
}

function matrixEvidenceStatus(row) {
  const audit = String(row.audit || "");
  const confidence = Number(row.confidence || 0);
  if (/字段不适用|not_applicable/i.test(audit)) return { label: "不适用", className: "neutral" };
  if (/缺原文|无原文|missing_quote/i.test(audit) || (!row.quote && !row.evidence)) return { label: "缺原文", className: "bad" };
  if (/弱|待核对|missing|review|weak/i.test(audit)) return { label: "弱支撑", className: "warn" };
  if (!row.page && (row.quote || row.evidence)) return { label: "有原文", className: "ok" };
  if (confidence >= 0.72 && row.page) return { label: "强证据", className: "strong" };
  if (row.page) return { label: "有原文", className: "ok" };
  return { label: "待核对", className: "warn" };
}

function renderResearchGaps() {
  const gaps = state.researchGaps;
  if (!gaps) return `<div class="edge-item">上传或选择多篇文献后生成研究空白候选。</div>`;
  const candidates = researchGapCandidates(gaps);
  if (!candidates.length) return `<div class="edge-item">当前范围暂未形成稳定研究空白候选。可以先补充资料，或到文献矩阵中核对证据状态。</div>`;
  return `
    <section class="gap-board">
      <div class="gap-board-head">
        <div>
          <h3>研究空白候选</h3>
          <p>这里优先给出可写进综述的 gap 句式，以及下一步验证路线。弱证据只作为线索。</p>
        </div>
        <span>${candidates.length} 条</span>
      </div>
      <div class="gap-candidate-list">
        ${candidates.map(renderGapCandidate).join("")}
      </div>
    </section>
  `;
}

function researchGapCandidates(gaps) {
  const typed = [
    ...(gaps.candidateTopics || []).map((item) => ({ ...item, _priority: 0 })),
    ...(gaps.underEvaluatedMethods || []).map((item) => ({ ...item, _priority: 1 })),
    ...(gaps.missingScenarios || []).map((item) => ({ ...item, _priority: 2 })),
    ...(gaps.repeatedProblems || []).map((item) => ({ ...item, _priority: 3 })),
    ...(gaps.theorySources || []).map((item) => ({ ...item, _priority: 4 })),
    ...(gaps.empiricalSources || []).map((item) => ({ ...item, _priority: 5 }))
  ];
  const seen = new Set();
  return typed
    .filter((item) => {
      const key = friendlyText(item.gapSentence || item.title || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a._priority - b._priority)
    .slice(0, 6);
}

function renderGapCandidate(item, index) {
  const sources = (item.sources || [])
    .slice(0, 4)
    .map((source) => `${source.marker || ""}${friendlyText(source.title || "")}`)
    .filter(Boolean)
    .join("、");
  const proposal = item.proposal || {};
  const scopeClass = item.gapScope === "single_source_boundary"
    ? "scope-lead"
    : item.canBeThesisTopic === false
      ? "scope-method"
      : "scope-topic";
  return `
    <article class="gap-candidate">
      <div class="gap-candidate-top">
        <span>${index + 1}</span>
        <b>${escapeHtml(item.gapType || "研究空白候选")}</b>
        <em class="${scopeClass}">${escapeHtml(item.scopeLabel || (item.canBeThesisTopic === false ? "方法论启发" : "可开题"))}</em>
      </div>
      <p class="gap-sentence">${escapeHtml(friendlyText(item.gapSentence || item.title || "当前只有研究线索，尚不能写成强结论。"))}</p>
      ${proposal.researchQuestion ? `
        <section class="gap-proposal">
          <div><b>研究问题</b><span>${escapeHtml(friendlyText(proposal.researchQuestion))}</span></div>
          <div><b>自变量</b><span>${escapeHtml(friendlyText(proposal.independentVariable || "待界定"))}</span></div>
          <div><b>因变量</b><span>${escapeHtml(friendlyText(proposal.dependentVariable || "待界定"))}</span></div>
          <div><b>评价指标</b><span>${escapeHtml(friendlyText(proposal.metrics || "待补充"))}</span></div>
        </section>
      ` : ""}
      <div class="gap-plan">
        <b>验证路线</b>
        ${renderGapVerificationSteps(item)}
      </div>
      <details class="gap-support">
        <summary>依据与风险</summary>
        ${item.missingEvidence ? `<div><b>缺口</b><span>${escapeHtml(friendlyText(item.missingEvidence))}</span></div>` : ""}
        ${item.whyItMatters ? `<div><b>价值</b><span>${escapeHtml(friendlyText(item.whyItMatters))}</span></div>` : ""}
        ${proposal.dataNeeded ? `<div><b>需补数据</b><span>${escapeHtml(friendlyText(proposal.dataNeeded))}</span></div>` : ""}
        ${proposal.expectedContribution ? `<div><b>预期贡献</b><span>${escapeHtml(friendlyText(proposal.expectedContribution))}</span></div>` : ""}
        ${proposal.literatureGroup ? `<div><b>文献组</b><span>${escapeHtml(friendlyText(proposal.literatureGroup))}</span></div>` : ""}
        ${sources ? `<div><b>来源</b><span>${escapeHtml(sources)}</span></div>` : ""}
      </details>
    </article>
  `;
}

function renderGapVerificationSteps(item) {
  const steps = Array.isArray(item.verificationSteps) ? item.verificationSteps : [];
  if (steps.length) {
    return `
      <ol class="gap-step-list">
        ${steps.slice(0, 3).map((step) => `
          <li>
            <span>${escapeHtml(friendlyText(step.action || step))}</span>
            ${step.criterion ? `<em>${escapeHtml(friendlyText(step.criterion))}</em>` : ""}
          </li>
        `).join("")}
      </ol>
    `;
  }
  return `<span>${escapeHtml("当前候选缺少结构化验证步骤，请重新加载资料库或重新生成研究空白。")}</span>`;
}

function suggestedQuestions() {
  const fromReview = String(state.review || "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-•]\s*/, "").trim())
    .filter((line) => /[？?]$/.test(line))
    .slice(0, 4);
  if (fromReview.length) return fromReview;
  const active = activeDoc();
  if (state.activeDocId !== "all" && active) {
    const title = shortTitle(active.title || active.filename || "当前资料", 34);
    const terms = (active.keywords || []).slice(0, 4).map((item) => item.term).filter(Boolean).join("、");
    if (state.matrix.some((row) => /无法定位|正文不可读|结构不完整|无法可靠抽取/.test(`${row.citation || ""} ${row.evidence || ""}`))) {
      return [
        `《${title}》目前哪些内容只能作为待核对判断？`,
        `围绕${terms || title}，还需要补充核对哪些原文证据？`,
        `这份资料如果要进入研究包，哪些结论不能直接引用？`
      ];
    }
    return [
      `《${title}》的核心研究问题是什么？`,
      `这篇资料围绕${terms || title}提出了什么方法或机制？`,
      `文中哪些证据支撑了主要结论，定位在哪里？`,
      `这篇资料有哪些局限、风险或待确认点？`
    ];
  }
  const terms = state.docs
    .flatMap((doc) => (doc.keywords || []).slice(0, 2).map((item) => item.term))
    .filter(Boolean)
    .slice(0, 5)
    .join("、");
  return [
    `这些资料围绕${terms || "核心主题"}分别解决什么问题？`,
    "这些资料在方法、证据和适用边界上有什么关键差异？",
    "哪些结论是多份资料共同支持的，哪些只来自单一来源？",
    "如果写成综述，应该按问题、方法还是应用场景组织？"
  ];
}

function renderSuggestedQuestions() {
  if (!state.docs.length) return "";
  const items = suggestedQuestions().map((question) => `
    <div class="suggested-item">
      <span>${escapeHtml(question)}</span>
      <button type="button" class="answer-suggested" data-question="${escapeHtml(question)}">解答</button>
    </div>
  `).join("");
  return `
    <div class="panel-head suggested-head">
      <h2>可继续追问</h2>
      <span>点击后直接生成回答</span>
    </div>
    <div class="suggested-list">${items}</div>
  `;
}

function relationClass(relation = "") {
  if (/问题延续/.test(relation)) return "edge-source";
  if (/方法迁移|应用扩展/.test(relation)) return "edge-extend";
  if (/证据补强|证据类型不同/.test(relation)) return "edge-compare";
  if (/边界约束|不能强行合并/.test(relation)) return "edge-risk";
  if (/共同研究空白/.test(relation)) return "edge-gap";
  if (/同一问题域|共同问题/.test(relation)) return "edge-source";
  if (/方法路径|跨场景|技术方法/.test(relation)) return "edge-extend";
  if (/证据类型/.test(relation)) return "edge-compare";
  if (/边界|风险|对照/.test(relation)) return "edge-risk";
  if (/评估|对比|benchmark|metric/i.test(relation)) return "edge-compare";
  if (/治理|约束|风险|limitation|risk/i.test(relation)) return "edge-risk";
  if (/grounding|可信|检索|来源|证据/i.test(relation)) return "edge-source";
  if (/扩展|链条|能力|agent|智能体|规划|工具/i.test(relation)) return "edge-extend";
  return "edge-shared";
}

function relationColor(relation = "") {
  if (/问题延续/.test(relation)) return "#0f766e";
  if (/方法迁移|应用扩展/.test(relation)) return "#285f9f";
  if (/证据补强|证据类型不同/.test(relation)) return "#b7791f";
  if (/边界约束|不能强行合并/.test(relation)) return "#b42318";
  if (/共同研究空白/.test(relation)) return "#7c3aed";
  if (/同一问题域|共同问题/.test(relation)) return "#0f766e";
  if (/方法路径|跨场景|技术方法/.test(relation)) return "#285f9f";
  if (/证据类型/.test(relation)) return "#b7791f";
  if (/边界|风险|对照/.test(relation)) return "#b42318";
  if (/评估|对比|benchmark|metric/i.test(relation)) return "#b7791f";
  if (/治理|约束|风险|limitation|risk/i.test(relation)) return "#b42318";
  if (/grounding|可信|检索|来源|证据/i.test(relation)) return "#0f766e";
  if (/扩展|链条|能力|agent|智能体|规划|工具/i.test(relation)) return "#285f9f";
  return "#64748b";
}

function docById(docOrId) {
  if (typeof docOrId === "object" && docOrId) return docOrId;
  return state.docs.find((doc) => doc.id === docOrId) || { id: docOrId, sourceType: "pdf", sourceUnit: "page" };
}

function nodeScene(node) {
  if (node.profile?.domain) return node.profile.domain;
  const doc = docById(node.id);
  const card = doc.analysisCard || doc.researchCard || {};
  return normalizeScene(card.reviewSlot || card.useCase || "资料背景", doc);
}

function shortTitle(text, limit = 46) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit).replace(/[，,、；;:：-]+$/, "") : clean;
}

function activeTab() {
  return document.querySelector(".tab.active")?.dataset.tab || "map";
}

function layoutGraph(width, height) {
  const laneOrder = [
    "智能体设计",
    "接口安全检测",
    "交通流预测",
    "交通控制",
    "消费研究智能化",
    "生成式人工智能影响",
    "文献计量与知识图谱",
    "智能体能力与可靠性",
    "检索增强与可信问答",
    "评估方法与证据",
    "治理与风险控制",
    "资料背景"
  ];
  const rawNodes = state.graph.nodes.map((node) => ({ ...node, scene: nodeScene(node), doc: docById(node.id) }));
  const scenes = [...new Set(rawNodes.map((node) => node.scene))].sort((a, b) => {
    const ai = laneOrder.indexOf(a);
    const bi = laneOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b, "zh-CN");
  });
  const maxLanes = width < 720 ? 1 : width < 980 ? 2 : 3;
  const visibleScenes = scenes.slice(0, maxLanes);
  const grouped = new Map(visibleScenes.map((scene) => [scene, []]));
  if (scenes.length > maxLanes) grouped.set("其他主题", []);
  for (const node of rawNodes) {
    const key = grouped.has(node.scene) ? node.scene : "其他主题";
    grouped.get(key).push(node);
  }
  const lanes = [...grouped.entries()].filter(([, nodes]) => nodes.length);
  const padding = 26;
  const top = 128;
  const laneGap = 16;
  const laneWidth = (width - padding * 2 - laneGap * Math.max(0, lanes.length - 1)) / Math.max(1, lanes.length);
  const maxStack = Math.max(1, ...lanes.map(([, nodes]) => nodes.length));
  const cardWidth = Math.max(178, Math.min(260, laneWidth - 24));
  const cardHeight = 106;
  const stackGap = 138;
  const contentHeight = top + maxStack * stackGap + 52;
  const nodes = [];
  lanes.forEach(([scene, laneNodes], laneIndex) => {
    laneNodes
      .sort((a, b) => (a.doc.createdAt || "").localeCompare(b.doc.createdAt || "") || a.title.localeCompare(b.title, "zh-CN"))
      .forEach((node, index) => {
        const laneX = padding + laneIndex * (laneWidth + laneGap);
        nodes.push({
          ...node,
          lane: scene,
          x: laneX + laneWidth / 2,
          y: top + index * stackGap + cardHeight / 2,
          w: cardWidth,
          h: cardHeight,
          laneX,
          laneWidth
        });
      });
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return { nodes, byId, lanes, laneWidth, laneGap, padding, top, cardHeight, contentHeight };
}

function vectorGraphLayout(width) {
  if (state.docFlow) return vectorDocFlowLayout(width);
  const nodes = state.graph.nodes.map((node) => ({ ...node, scene: nodeScene(node), doc: docById(node.id) }));
  if (!nodes.length) {
    return {
      width,
      height: 560,
      markup: `<rect width="${width}" height="560" fill="#f8fafc"></rect><text x="${width / 2}" y="280" text-anchor="middle" fill="#64748b" font-size="15">上传资料后生成研究脉络图</text>`
    };
  }
  const layout = state.graphCenterId
    ? centeredVectorLayout(nodes, state.graph.edges, width)
    : laneVectorLayout(nodes, state.graph.edges, width);
  const defs = `
    <defs>
      <marker id="arrowBlue" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L9,4.5 L0,9 Z" fill="#64748b"></path>
      </marker>
    </defs>
  `;
  return {
    width: layout.width,
    height: layout.height,
    markup: `${defs}<rect width="${layout.width}" height="${layout.height}" fill="#f8fafc"></rect>${svgGraphHeader(layout.width)}${layout.edges}${layout.nodes}${layout.legend}`
  };
}

function laneVectorLayout(_rawNodes, rawEdges, width) {
  const probe = layoutGraph(width, 720);
  const height = Math.max(560, probe.contentHeight || 720);
  const positioned = probe.nodes;
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const lanes = probe.lanes.map(([scene], index) => {
    const x = probe.padding + index * (probe.laneWidth + probe.laneGap);
    return `
      <rect x="${x}" y="82" width="${probe.laneWidth}" height="${height - 108}" rx="10" fill="${index % 2 ? "#ffffff" : "#f3f7fb"}" stroke="#dde5ef"></rect>
      <text x="${x + probe.laneWidth / 2}" y="108" text-anchor="middle" fill="#334155" font-size="13" font-weight="700">${escapeHtml(scene)}</text>
    `;
  }).join("");
  return {
    width,
    height,
    legend: svgGraphLegend(width),
    edges: `${lanes}${svgGraphEdges(rawEdges.slice(0, 24), byId)}`,
    nodes: positioned.map((node) => svgGraphNode(node)).join("")
  };
}

function centeredVectorLayout(rawNodes, rawEdges, width) {
  const center = rawNodes.find((node) => node.id === state.graphCenterId) || rawNodes[0];
  const directIds = new Set(rawEdges
    .filter((edge) => edge.source === center.id || edge.target === center.id)
    .flatMap((edge) => [edge.source, edge.target])
    .filter((id) => id !== center.id));
  const directNodes = rawNodes.filter((node) => directIds.has(node.id));
  const outerNodes = rawNodes.filter((node) => node.id !== center.id && !directIds.has(node.id));
  const height = Math.max(660, 180 + Math.max(1, directNodes.length) * 58);
  const cx = width / 2;
  const cy = height / 2 + 26;
  const positioned = [{ ...center, x: cx, y: cy, w: 270, h: 122, center: true }];
  const radiusX = Math.min(360, width * 0.34);
  const radiusY = Math.min(230, height * 0.32);
  directNodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(1, directNodes.length));
    positioned.push({
      ...node,
      x: cx + Math.cos(angle) * radiusX,
      y: cy + Math.sin(angle) * radiusY,
      w: 238,
      h: 108,
      direct: true
    });
  });
  outerNodes.forEach((node, index) => {
    const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(outerNodes.length))));
    const col = index % cols;
    const row = Math.floor(index / cols);
    positioned.push({
      ...node,
      x: 130 + col * 250,
      y: height - 72 - row * 118,
      w: 218,
      h: 96,
      muted: true
    });
  });
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const centerEdges = rawEdges.filter((edge) => edge.source === center.id || edge.target === center.id);
  const centerEdgeIds = new Set(centerEdges.map(graphEdgeId));
  const otherEdges = rawEdges.filter((edge) => !centerEdgeIds.has(graphEdgeId(edge))).slice(0, 8);
  return {
    width,
    height,
    legend: svgGraphLegend(width),
    edges: svgGraphEdges([...centerEdges, ...otherEdges], byId),
    nodes: positioned.map((node) => svgGraphNode(node)).join("")
  };
}

function vectorDocFlowLayout(width) {
  const layout = layoutDocFlowLayered(width);
  const defs = `
    <defs>
      <marker id="arrowFlow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L9,4.5 L0,9 Z" fill="#285f9f"></path>
      </marker>
    </defs>
  `;
  return {
    width: layout.width,
    height: layout.height,
    markup: `${defs}<rect width="${layout.width}" height="${layout.height}" fill="#f8fafc"></rect>${svgGraphHeader(layout.width, "单篇结构图", state.docFlow.title || "当前资料")}${svgDocFlowEdges(state.docFlow.edges || [], layout.byId)}${layout.positioned.map(svgFlowNode).join("")}`
  };
}

function layoutDocFlowLayered(width) {
  const rawNodes = state.docFlow.nodes || [];
  const rawEdges = state.docFlow.edges || [];
  const cardW = 340;
  const colGap = 76;
  const rowGap = 74;
  const left = 44;
  const right = 96;
  const top = 94;
  const bottom = 64;
  const cardMeta = new Map(rawNodes.map((node) => {
    const titleLines = flowNodeTitleLines(node);
    const summaryLines = flowNodeSummaryLines(node);
    const height = Math.max(116, 72 + titleLines.length * 16 + summaryLines.length * 15);
    return [node.id, { titleLines, summaryLines, height }];
  }));
  const nodeIds = new Set(rawNodes.map((node) => node.id));
  const indegree = new Map(rawNodes.map((node) => [node.id, 0]));
  const outgoing = new Map(rawNodes.map((node) => [node.id, []]));
  rawEdges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  });
  const depth = new Map(rawNodes.map((node) => [node.id, 0]));
  const queue = rawNodes.filter((node) => !indegree.get(node.id)).map((node) => node.id);
  const work = queue.length ? queue.slice() : rawNodes.map((node) => node.id);
  const guard = new Set();
  while (work.length) {
    const id = work.shift();
    if (guard.has(`${id}:${depth.get(id)}`)) continue;
    guard.add(`${id}:${depth.get(id)}`);
    for (const target of outgoing.get(id) || []) {
      const nextDepth = Math.max(depth.get(target) || 0, (depth.get(id) || 0) + 1);
      if (nextDepth !== depth.get(target)) depth.set(target, nextDepth);
      indegree.set(target, Math.max(0, (indegree.get(target) || 0) - 1));
      if (!indegree.get(target)) work.push(target);
    }
  }
  rawNodes.forEach((node, index) => {
    if (!Number.isFinite(depth.get(node.id))) depth.set(node.id, index);
  });
  const layers = new Map();
  rawNodes.forEach((node, index) => {
    const rank = depth.get(node.id) ?? index;
    if (!layers.has(rank)) layers.set(rank, []);
    layers.get(rank).push({ node, index });
  });
  const orderedItems = [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, items]) => items.sort((a, b) => a.index - b.index));
  const availableCols = Math.max(1, Math.floor((width - left - right + colGap) / (cardW + colGap)));
  const cols = Math.max(1, Math.min(3, availableCols, orderedItems.length || 1));
  const rows = [];
  orderedItems.forEach((item, index) => {
    const rowIndex = Math.floor(index / cols);
    if (!rows[rowIndex]) rows[rowIndex] = [];
    rows[rowIndex].push(item);
  });
  const contentWidth = cols * cardW + Math.max(0, cols - 1) * colGap;
  const graphWidth = Math.max(width, left + contentWidth + right);
  const rowHeights = rows.map((items) => Math.max(...items.map((item) => cardMeta.get(item.node.id)?.height || 116)));
  const contentHeight = rowHeights.reduce((sum, height, index) => sum + height + (index ? rowGap : 0), 0);
  const graphHeight = Math.max(360, top + contentHeight + bottom);
  const positioned = [];
  let cursorY = top;
  rows.forEach((items, rowIndex) => {
    const rowHeight = rowHeights[rowIndex] || 116;
    items.forEach(({ node }, colIndex) => {
      const meta = cardMeta.get(node.id) || {};
      const cardH = meta.height || 116;
      positioned.push({
        ...node,
        titleLines: meta.titleLines || flowNodeTitleLines(node),
        summaryLines: meta.summaryLines || flowNodeSummaryLines(node),
        x: left + colIndex * (cardW + colGap) + cardW / 2,
        y: cursorY + (rowHeight - cardH) / 2 + cardH / 2,
        w: cardW,
        h: cardH,
        rowIndex,
        colIndex
      });
    });
    cursorY += rowHeight + rowGap;
  });
  return {
    width: graphWidth,
    height: graphHeight,
    positioned,
    byId: new Map(positioned.map((node) => [node.id, node]))
  };
}

function flowNodeTitleLines(node) {
  return splitSvgText(node.title || node.id, 14, null, { noEllipsis: true });
}

function flowNodeSummaryLines(node) {
  return splitSvgText(node.summary || node.text || "", 24, null, { noEllipsis: true });
}

function svgDocFlowEdges(edges, byId) {
  return edges.map((edge, index) => {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) return "";
    const id = graphEdgeId(edge);
    const selected = id === state.selectedGraphEdgeId;
    const color = selected ? "#1d4ed8" : "#285f9f";
    const path = svgDocFlowEdgePath(a, b, index);
    return `
      <g class="svg-edge flow-edge ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
        <path d="${path}" fill="none" stroke="transparent" stroke-width="14"></path>
        <path d="${path}" fill="none" stroke="${color}" stroke-width="${selected ? 3 : 2}" stroke-opacity="${selected ? 0.88 : 0.34}" marker-end="url(#arrowFlow)" pointer-events="none"></path>
      </g>
    `;
  }).join("");
}

function svgDocFlowEdgePath(a, b, index = 0) {
  const sameRow = a.rowIndex === b.rowIndex;
  if (sameRow) {
    const sx = a.x + a.w / 2;
    const sy = a.y;
    const ex = b.x - b.w / 2;
    const ey = b.y;
    const mx = sx + (ex - sx) / 2 + ((index % 3) - 1) * 4;
    return `M ${sx} ${sy} L ${mx} ${sy} L ${mx} ${ey} L ${ex} ${ey}`;
  }
  const sx = a.x;
  const sy = a.y + a.h / 2;
  const ex = b.x;
  const ey = b.y - b.h / 2;
  const laneY = sy + Math.max(28, (ey - sy) / 2) + (index % 3) * 3;
  return `M ${sx} ${sy} L ${sx} ${laneY} L ${ex} ${laneY} L ${ex} ${ey}`;
}

function svgGraphHeader(width, title = "研究脉络图", subtitle = "点击节点设为中心；点击连线查看关系依据。") {
  return `
    <text x="26" y="32" fill="#0f172a" font-size="16" font-weight="700">${escapeHtml(title)}</text>
    <text x="26" y="56" fill="#64748b" font-size="12">${escapeHtml(subtitle)}</text>
  `;
}

function svgGraphLegend(width) {
  const items = [
    ["共同问题", "#0f766e"],
    ["方法扩展", "#285f9f"],
    ["证据比较", "#b7791f"],
    ["边界风险", "#b42318"]
  ];
  return items.map(([label, color], index) => {
    const x = width - 360 + index * 88;
    return `<line x1="${x}" y1="24" x2="${x + 16}" y2="24" stroke="${color}" stroke-width="4"></line><text x="${x + 22}" y="28" fill="#64748b" font-size="11">${label}</text>`;
  }).join("");
}

function svgGraphEdges(edges, byId) {
  return edges.map((edge) => {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) return "";
    const color = relationColor(edge.relation || edge.relationKind || "");
    const id = graphEdgeId(edge);
    const selected = id === state.selectedGraphEdgeId;
    const path = svgEdgePath(a, b);
    const mid = svgEdgeMidpoint(a, b);
    const label = edgeLineLabel(edge, a, b);
    return `
      <g class="svg-edge ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
        <path d="${path}" fill="none" stroke="${color}" stroke-width="${selected ? 3.2 : Math.max(1.4, Math.min(2.8, Number(edge.weight || 0.5) * 3))}" stroke-opacity="${selected ? 0.95 : 0.48}" marker-end="url(#arrowBlue)"></path>
        <rect x="${mid.x - 95}" y="${mid.y - 13}" width="190" height="25" rx="12.5" fill="rgba(255,255,255,0.94)" stroke="${color}" stroke-opacity="0.35"></rect>
        <text x="${mid.x}" y="${mid.y + 4}" text-anchor="middle" fill="${color}" font-size="11" font-weight="700">${escapeHtml(shortTitle(label, 18))}</text>
      </g>
    `;
  }).join("");
}

function svgGraphNode(node) {
  const left = node.x - node.w / 2;
  const top = node.y - node.h / 2;
  const accent = relationColor(node.lane || node.scene || node.profile?.domain || "");
  const selected = node.id === state.graphCenterId;
  const opacity = node.muted ? 0.62 : 1;
  const profile = node.profile || {};
  return `
    <g class="svg-node ${selected ? "center" : ""}" data-doc-id="${escapeHtml(node.id)}" opacity="${opacity}">
      <rect x="${left}" y="${top}" width="${node.w}" height="${node.h}" rx="8" fill="#ffffff" stroke="${selected ? "#285f9f" : "#cfd8e3"}" stroke-width="${selected ? 2.4 : 1.2}"></rect>
      <rect x="${left}" y="${top + 1}" width="5" height="${node.h - 2}" fill="${accent}" rx="2"></rect>
      ${svgTextLines(profile.domain || node.scene || "待核对领域", left + 20, top + 24, node.w - 34, 2, "#0f172a", 12, 700)}
      <text x="${left + 20}" y="${top + node.h - 47}" fill="#475569" font-size="11">${escapeHtml(shortTitle(profile.problemType || "待核对问题", 22))}</text>
      <text x="${left + 20}" y="${top + node.h - 29}" fill="#64748b" font-size="11">${escapeHtml(shortTitle(profile.methodType || "待核对方法", 24))}</text>
      <text x="${left + 20}" y="${top + node.h - 12}" fill="#94a3b8" font-size="10">${escapeHtml(shortTitle(profile.evidenceType || "待核对证据", 26))}</text>
    </g>
  `;
}

function svgFlowNode(node) {
  const left = node.x - node.w / 2;
  const top = node.y - node.h / 2;
  const titleLines = node.titleLines || flowNodeTitleLines(node);
  const summaryLines = node.summaryLines || flowNodeSummaryLines(node);
  return `
    <g class="svg-node flow" data-flow-id="${escapeHtml(node.id)}">
      <rect x="${left}" y="${top}" width="${node.w}" height="${node.h}" rx="9" fill="#ffffff" stroke="#ccd6e2"></rect>
      <rect x="${left}" y="${top + 1}" width="5" height="${node.h - 2}" fill="#285f9f" rx="2"></rect>
      ${titleLines.map((line, index) => `<text x="${left + 20}" y="${top + 25 + index * 16}" fill="#0f172a" font-size="12" font-weight="700">${escapeHtml(line)}</text>`).join("")}
      ${summaryLines.map((line, index) => `<text x="${left + 20}" y="${top + 60 + index * 15}" fill="#475569" font-size="11" font-weight="400">${escapeHtml(line)}</text>`).join("")}
    </g>
  `;
}

function svgTextLines(text, x, y, maxWidth, maxLines, color, fontSize, weight) {
  const charsPerLine = Math.max(10, Math.floor(Number(maxWidth || 160) / 7));
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const lines = [];
  for (let index = 0; index < clean.length && lines.length < maxLines; index += charsPerLine) {
    let line = clean.slice(index, index + charsPerLine);
    if (lines.length === maxLines - 1 && index + charsPerLine < clean.length) line = line.slice(0, Math.max(1, line.length - 1)).replace(/[，。；、:：-]+$/, "");
    lines.push(line);
  }
  return lines.map((line, index) => `<text x="${x}" y="${y + index * (fontSize + 4)}" fill="${color}" font-size="${fontSize}" font-weight="${weight}">${escapeHtml(line)}</text>`).join("");
}

function svgEdgePath(a, b) {
  const sx = a.x + (a.x < b.x ? a.w / 2 : -a.w / 2);
  const sy = a.y;
  const ex = b.x + (a.x < b.x ? -b.w / 2 : b.w / 2);
  const ey = b.y;
  const curve = Math.max(42, Math.abs(ex - sx) * 0.35);
  const dir = Math.sign(ex - sx || 1);
  return `M ${sx} ${sy} C ${sx + dir * curve} ${sy}, ${ex - dir * curve} ${ey}, ${ex} ${ey}`;
}

function svgEdgeMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function graphEdgeId(edge) {
  return `${edge.source || ""}--${edge.target || ""}--${edge.relationKind || edge.relation || ""}`;
}

function drawGraph() {
  if (els.canvas?.closest("details")?.open) drawGraphCanvasFallback();
  if (els.graph3dScene?.closest("details")?.open || els.graph3dSvg?.closest("details")?.open) renderGraph3d();
  if (els.graphFullscreen?.classList.contains("active")) renderGraph3dFullscreen();
}

function renderVectorGraph() {
  if (!els.graphSvg) return drawGraphCanvasFallback();
  const rect = (els.graphWrap || els.graphSvg).getBoundingClientRect();
  const cssWidth = Math.max(980, Math.floor(rect.width || 1100));
  const graphData = vectorGraphLayout(cssWidth);
  els.graphSvg.setAttribute("viewBox", `0 0 ${graphData.width} ${graphData.height}`);
  els.graphSvg.style.width = `${graphData.width}px`;
  els.graphSvg.style.height = `${graphData.height}px`;
  els.graphSvg.innerHTML = graphData.markup;
}

function renderGraph3d() {
  if (!els.graph3dSvg) return;
  const rect = (els.graph3dSvg.parentElement || els.graph3dSvg).getBoundingClientRect();
  if (els.graph3dScene) els.graph3dScene.style.display = "none";
  if (els.graph3dInsight) {
    els.graph3dInsight.innerHTML = renderGraph3dInsight();
  }
  els.graph3dSvg.style.display = "block";
  const width = state.docFlow ? Math.max(760, Math.floor(rect.width || 1100)) : 1400;
  const graphData = graph3dLayout(width);
  const availableHeight = Math.max(380, window.innerHeight - rect.top - 28);
  const fittedHeight = Math.max(520, Math.min(900, availableHeight));
  els.graph3dSvg.setAttribute("viewBox", `0 0 ${graphData.width} ${graphData.height}`);
  if (state.docFlow) {
    els.graph3dSvg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    els.graph3dSvg.style.width = `${graphData.width}px`;
    els.graph3dSvg.style.height = `${graphData.height}px`;
    els.graph3dSvg.style.maxWidth = "none";
    els.graph3dSvg.parentElement?.style.setProperty("overflow", "auto");
  } else {
    els.graph3dSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    els.graph3dSvg.style.width = "100%";
    els.graph3dSvg.style.height = `${fittedHeight}px`;
    els.graph3dSvg.style.maxWidth = "100%";
    els.graph3dSvg.parentElement?.style.setProperty("overflow", "hidden");
  }
  els.graph3dSvg.style.setProperty("--graph-3d-height", `${state.docFlow ? graphData.height : fittedHeight}px`);
  els.graph3dSvg.innerHTML = graphData.markup;
}

function renderGraph3dInsight() {
  if (!state.graph.nodes.length) return `<div class="insight-empty">上传多篇资料后显示图谱解读。</div>`;
  const selectedNode = state.graph.nodes.find((node) => node.id === state.graphCenterId);
  const selectedDoc = selectedNode ? docById(selectedNode.id) : null;
  const selectedEdge = state.selectedGraphEdgeId
    ? state.graph.edges.find((edge) => graphEdgeId(edge) === state.selectedGraphEdgeId)
    : null;
  const edges = selectedNode
    ? state.graph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    : state.graph.edges;
  const stats = graphRelationStats(state.graph.edges);
  const strong = edges.filter((edge) => Number(edge.weight || 0) >= 0.65 && !isWeakGraphRelation(edge)).slice(0, 4);
  const weak = edges.filter(isWeakGraphRelation).slice(0, 4);
  const cards = (selectedEdge ? [selectedEdge] : [...strong, ...weak].slice(0, 6)).map((edge) => graphInsightEdgeCard(edge)).join("");
  const nodeProfile = selectedNode ? renderGraphNodeInsight(selectedNode, selectedDoc, edges) : "";
  const focusSummary = selectedNode ? graphNodeFocusSummary(selectedNode, selectedDoc) : "";
  return `
    <div class="insight-head">
      <b>${selectedNode ? `中心视图：${escapeHtml(selectedNode.profile?.domain || selectedDoc?.title || "当前节点")}` : "图谱解读"}</b>
      <span>${selectedNode ? `围绕 ${escapeHtml(focusSummary)} 展开；下方只列直接相关关系。` : "全局视图按问题域、证据可用度和关系中心性摆放；点击节点可切换中心。"}</span>
    </div>
    <div class="insight-stats">
      ${stats.map((item) => `<span style="--accent:${item.color}">${escapeHtml(item.label)} ${item.count}</span>`).join("")}
    </div>
    ${selectedEdge ? `<div class="insight-selected">已选中一条关系；这里显示读图概览，完整原文见“关系证据详情”。</div>` : ""}
    ${nodeProfile}
    <div class="insight-note">${weak.length ? "含跨领域或弱对照关系：这些不能直接合并结论，只能作为边界、方法或证据写法对照。" : "当前高权重关系较多，可优先看同一问题域、方法迁移和证据补强。"}</div>
    <div class="insight-list">${cards || `<div class="insight-empty">点击节点查看相关关系；完整原文依据在“关系证据详情”。</div>`}</div>
  `;
}

function renderGraphNodeInsight(node, doc, edges) {
  const profile = node.profile || {};
  const card = doc?.evidenceCard || {};
  const confidence = Math.round(Number(card.confidence || 0) * 100);
  const weakCount = [
    card.research_question,
    card.method,
    card.data_or_materials,
    ...((card.main_claims || []).slice(0, 2)),
    ...((card.evidence || []).slice(0, 2)),
    ...((card.limitations || []).slice(0, 2))
  ].filter(isWeakAuditItem).length;
  return `
    <div class="insight-node-card">
      <div><b>问题域</b><span>${escapeHtml(profile.problemType || profile.domain || nodeScene(node))}</span></div>
      <div><b>方法</b><span>${escapeHtml(profile.methodType || "方法待核对")}</span></div>
      <div><b>证据</b><span>${confidence || "待核对"}% 置信度 / ${edges.length} 条关系 / ${weakCount} 个弱字段</span></div>
    </div>
  `;
}

function graphNodeFocusSummary(node = {}, doc = {}) {
  const profile = node.profile || {};
  const problem = profile.problemType || profile.domain || node.scene || "问题域待核对";
  const method = profile.methodType || "方法待核对";
  const confidence = Math.round(Number(doc?.evidenceCard?.confidence || 0) * 100);
  const evidence = confidence ? `证据 ${confidence}%` : "证据待核对";
  return `${problem} / ${method} / ${evidence}`;
}

function graphRelationStats(edges = []) {
  const buckets = [
    { label: "同域/问题", color: "#0f766e", test: (edge) => /same_problem|problem|问题|同一/.test(`${edge.relationKind} ${edge.relation}`) },
    { label: "方法/扩展", color: "#285f9f", test: (edge) => /method|application|方法|扩展|迁移/.test(`${edge.relationKind} ${edge.relation}`) },
    { label: "证据", color: "#b7791f", test: (edge) => /evidence|证据/.test(`${edge.relationKind} ${edge.relation}`) },
    { label: "弱/不可合并", color: "#b42318", test: isWeakGraphRelation }
  ];
  return buckets.map((bucket) => ({
    ...bucket,
    count: edges.filter(bucket.test).length
  }));
}

function isWeakGraphRelation(edge = {}) {
  return /cannot_merge|evidence_gap|不能强行合并|弱对照|边界对照|差异较大/.test(`${edge.relationKind || ""} ${edge.relation || ""} ${edge.evidence?.why || ""}`) ||
    Number(edge.weight || 0) < 0.45;
}

function graphInsightEdgeCard(edge) {
  const a = docById(edge.source);
  const b = docById(edge.target);
  const weak = isWeakGraphRelation(edge);
  const id = graphEdgeId(edge);
  const weight = Math.round(Number(edge.weight || 0) * 100);
  const kind = edgeTypeLabel(edge);
  return `
    <button type="button" class="insight-edge ${weak ? "weak" : ""} ${state.selectedGraphEdgeId === id ? "active" : ""}" data-edge-id="${escapeHtml(id)}">
      <span>${escapeHtml(kind)}</span>
      <b>${escapeHtml(shortTitle(a.title || edge.source, 18))} ↔ ${escapeHtml(shortTitle(b.title || edge.target, 18))}</b>
      <em>${weak ? "弱关系 / 只作边界或对照" : `关系强度 ${weight || "待核对"}% / 可点选后核证据`}</em>
    </button>
  `;
}

function renderGraph3dFullscreen() {
  if (!els.graph3dFullscreenSvg) return;
  if (els.graph3dFullscreenScene) els.graph3dFullscreenScene.style.display = "none";
  els.graph3dFullscreenSvg.style.display = "block";
  const graphData = graph3dLayout(1600, { fullscreen: true });
  const viewportWidth = Math.max(900, (els.graphFullscreenViewport?.clientWidth || window.innerWidth) - 144);
  const viewportHeight = Math.max(560, (els.graphFullscreenViewport?.clientHeight || window.innerHeight) - 120);
  els.graph3dFullscreenSvg.setAttribute("viewBox", `0 0 ${graphData.width} ${graphData.height}`);
  els.graph3dFullscreenSvg.setAttribute("preserveAspectRatio", state.docFlow ? "xMinYMin meet" : "xMidYMid meet");
  if (state.docFlow) {
    els.graph3dFullscreenSvg.style.width = `${graphData.width}px`;
    els.graph3dFullscreenSvg.style.height = `${graphData.height}px`;
    els.graph3dFullscreenSvg.style.maxWidth = "none";
  } else {
    els.graph3dFullscreenSvg.style.width = `${Math.max(graphData.width, viewportWidth)}px`;
    els.graph3dFullscreenSvg.style.height = `${Math.max(graphData.height, viewportHeight)}px`;
    els.graph3dFullscreenSvg.style.maxWidth = "none";
  }
  els.graph3dFullscreenSvg.innerHTML = graphData.markup;
  if (els.graphFullscreenViewport) {
    els.graphFullscreenViewport.scrollLeft = 0;
    els.graphFullscreenViewport.scrollTop = 0;
  }
}

function renderCanvas3dScene(container, key, width, height, options = {}) {
  if (!container) return;
  if (graph3dCanvasState[key]?.frame) cancelAnimationFrame(graph3dCanvasState[key].frame);
  container.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "graph-3d-canvas";
  canvas.width = Math.floor(width * (window.devicePixelRatio || 1));
  canvas.height = Math.floor(height * (window.devicePixelRatio || 1));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rawNodes = state.graph.nodes.map((node) => ({ ...node, scene: nodeScene(node), doc: docById(node.id) }));
  const rawEdges = state.graph.edges || [];
  const layout = graph3dNetworkLayout(rawNodes, rawEdges, width, height);
  const baseNodes = layout.nodes.map((node, index) => ({
    ...node,
    indexLabel: node.indexLabel || String(index + 1),
    x3: (node.x - width / 2) * 1.05,
    y3: (node.y - height / 2) * 0.68,
    zBase: (node.z3 || 0) * 1.45
  }));
  const camera = options.fullscreen ? 1180 : 980;
  const stateRef = { frame: null, hitNodes: [], angle: 0, canvas, width, height };
  graph3dCanvasState[key] = stateRef;

  const draw = () => {
    stateRef.angle += 0.0035;
    drawCanvas3dFrame(ctx, width, height, baseNodes, rawEdges, camera, stateRef);
    stateRef.frame = requestAnimationFrame(draw);
  };
  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = [...stateRef.hitNodes].reverse().find((node) => Math.hypot(node.x - x, node.y - y) <= node.hitR);
    if (!hit) return;
    state.graphCenterId = state.graphCenterId === hit.id ? "" : hit.id;
    if (state.graphCenterId) localStorage.setItem("graphCenterId", state.graphCenterId);
    else localStorage.removeItem("graphCenterId");
    setStatus(state.graphCenterId ? "已聚焦三维关系节点。" : "已取消三维节点聚焦。");
    if (els.graph3dInsight) els.graph3dInsight.innerHTML = renderGraph3dInsight();
    drawGraph();
  });
  draw();
}

function drawCanvas3dFrame(ctx, width, height, nodes, edges, camera, stateRef) {
  ctx.clearRect(0, 0, width, height);
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#f8fafc");
  bg.addColorStop(1, "#eef4fb");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  draw3dGrid(ctx, width, height);
  const projected = fitProjectedNodes(nodes.map((node) => projectCanvasNode(node, width, height, camera, stateRef.angle)), width, height);
  const byId = new Map(projected.map((node) => [node.id, node]));
  const sortedEdges = edges
    .map((edge) => ({ edge, a: byId.get(edge.source), b: byId.get(edge.target) }))
    .filter((item) => item.a && item.b)
    .sort((left, right) => ((left.a.z + left.b.z) / 2) - ((right.a.z + right.b.z) / 2));
  sortedEdges.forEach((item) => drawCanvas3dEdge(ctx, item.edge, item.a, item.b));
  const sortedNodes = [...projected].sort((a, b) => a.z - b.z);
  stateRef.hitNodes = sortedNodes.map((node) => ({ id: node.id, x: node.x, y: node.y, hitR: node.r + 12 }));
  sortedNodes.forEach((node) => drawCanvas3dNode(ctx, node));
  drawCanvas3dHud(ctx, width, height);
}

function fitProjectedNodes(nodes, width, height) {
  if (!nodes.length) return nodes;
  const bounds = nodes.reduce((box, node) => {
    const labelPad = 54;
    return {
      minX: Math.min(box.minX, node.x - node.r - 76),
      maxX: Math.max(box.maxX, node.x + node.r + 76),
      minY: Math.min(box.minY, node.y - node.r - 22),
      maxY: Math.max(box.maxY, node.y + node.r + labelPad)
    };
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const pad = 54;
  const scale = Math.min(
    1,
    (width - pad * 2) / Math.max(1, bounds.maxX - bounds.minX),
    (height - pad * 2) / Math.max(1, bounds.maxY - bounds.minY)
  );
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const targetX = width / 2;
  const targetY = height / 2 + 8;
  return nodes.map((node) => ({
    ...node,
    x: targetX + (node.x - cx) * scale,
    y: targetY + (node.y - cy) * scale,
    r: node.r * scale,
    scale: node.scale * scale
  }));
}

function projectCanvasNode(node, width, height, camera, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const xRot = node.x3 * cos - node.zBase * sin;
  const zRot = node.x3 * sin + node.zBase * cos;
  const scale = camera / (camera - zRot);
  const profile = node.profile || {};
  return {
    ...node,
    x: width / 2 + xRot * scale,
    y: height / 2 - 24 + node.y3 * scale,
    z: zRot,
    scale,
    r: Math.max(16, Math.min(42, (node.r || 30) * scale * 0.72)),
    label: shortTitle(profile.domain || node.scene || node.doc?.title || "文献", node.role === "outer" ? 10 : 13),
    sub: shortTitle(profile.problemType || node.doc?.title || "", 16)
  };
}

function draw3dGrid(ctx, width, height) {
  const cx = width / 2;
  const cy = height / 2 + 40;
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.24)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 170 + i * 92, 54 + i * 31, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([5, 9]);
  for (let i = 0; i < 8; i += 1) {
    const angle = (Math.PI * 2 * i) / 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * Math.min(width * 0.42, 560), cy + Math.sin(angle) * Math.min(height * 0.3, 260));
    ctx.stroke();
  }
  ctx.restore();
}

function drawCanvas3dEdge(ctx, edge, a, b) {
  const color = relationColor(edge.relation || edge.relationKind || "");
  const selected = graphEdgeId(edge) === state.selectedGraphEdgeId;
  const focus = state.graphCenterId && (edge.source === state.graphCenterId || edge.target === state.graphCenterId);
  ctx.save();
  ctx.strokeStyle = hexToRgba(color, selected ? 0.9 : focus ? 0.52 : 0.24);
  ctx.lineWidth = selected ? 3.6 : focus ? 2.2 : 1.2;
  ctx.beginPath();
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - Math.max(-50, Math.min(50, (a.z + b.z) / 18));
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(mx, my, b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function drawCanvas3dNode(ctx, node) {
  const accent = relationColor(node.scene || node.profile?.domain || "");
  const selected = state.graphCenterId === node.id;
  const glow = selected ? 18 : node.role === "center" ? 10 : 0;
  ctx.save();
  if (glow) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r + glow, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(accent, selected ? 0.16 : 0.08);
    ctx.fill();
  }
  const grd = ctx.createRadialGradient(node.x - node.r * 0.35, node.y - node.r * 0.35, node.r * 0.12, node.x, node.y, node.r);
  grd.addColorStop(0, "#ffffff");
  grd.addColorStop(0.45, "#eaf2ff");
  grd.addColorStop(1, accent);
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.strokeStyle = selected ? accent : "rgba(100,116,139,0.35)";
  ctx.lineWidth = selected ? 3 : 1.3;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = `900 ${Math.max(10, Math.min(14, node.r * 0.42))}px Inter, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(node.indexLabel || "", node.x, node.y);
  const labelW = Math.min(158, Math.max(78, ctx.measureText(node.label).width + 26));
  const labelH = 24;
  const labelY = node.y + node.r + 12;
  roundRect(ctx, node.x - labelW / 2, labelY, labelW, labelH, 7);
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fill();
  ctx.strokeStyle = hexToRgba(accent, 0.36);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#0f172a";
  ctx.font = "800 11px Inter, sans-serif";
  ctx.fillText(node.label, node.x, labelY + labelH / 2 + 0.5);
  if (selected && node.sub) {
    ctx.fillStyle = "#475569";
    ctx.font = "700 10px Inter, sans-serif";
    ctx.fillText(node.sub, node.x, labelY + labelH + 15);
  }
  ctx.restore();
}

function drawCanvas3dHud(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = "#0f172a";
  ctx.font = "700 14px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("三维研究空间", 22, 28);
  ctx.fillStyle = "#64748b";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText("坐标、深度与节点大小都对应研究信息；点击节点聚焦，二维图用于证据泳道审计。", 22, 50);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("Canvas 3D projection", width - 22, height - 20);
  ctx.restore();
}

function legacyGraph3dLayout(width, options = {}) {
  const nodes = state.graph.nodes.map((node) => ({ ...node, scene: nodeScene(node), doc: docById(node.id) }));
  const compactSmallGraph = nodes.length > 2 && nodes.length <= 4;
  const height = compactSmallGraph
    ? (nodes.length === 4 ? (options.fullscreen ? 1800 : 1600) : (options.fullscreen ? 1120 : 980))
    : (options.fullscreen ? 960 : 860);
  if (!nodes.length) {
    return {
      width,
      height,
    markup: `<rect width="${width}" height="${height}" fill="#f8fafc"></rect><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#64748b" font-size="15">上传资料后生成 3D 关系图</text>`
    };
  }
  if (nodes.length === 1) return graph3dSingleLayout(nodes, width, height, options);
  if (nodes.length === 2) return graph3dPairLayout(nodes, width, height, options);
  if (nodes.length <= 4) return graph3dSmallLayout(nodes, width, height, options);
  const centerNode = nodes.find((node) => node.id === state.graphCenterId) || nodes[0];
  const directEdges = state.graph.edges.filter((edge) => edge.source === centerNode.id || edge.target === centerNode.id);
  const directIds = new Set(directEdges.flatMap((edge) => [edge.source, edge.target]).filter((id) => id !== centerNode.id));
  const directNodes = nodes.filter((node) => directIds.has(node.id));
  const outerNodes = nodes.filter((node) => node.id !== centerNode.id && !directIds.has(node.id));
  const cx = width / 2;
  const cy = height / 2 + 48;
  const camera = 780;
  const projected = [];
  projected.push(project3dNode({ ...centerNode, x3: 0, y3: 0, z3: 170, role: "center" }, cx, cy, camera));
  directNodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(1, directNodes.length));
    const radius = 380 + (index % 2) * 80;
    const z = Math.sin(angle * 1.4) * 235;
    projected.push(project3dNode({
      ...node,
      x3: Math.cos(angle) * radius,
      y3: Math.sin(angle) * radius * 0.54,
      z3: z,
      role: "direct"
    }, cx, cy, camera));
  });
  outerNodes.forEach((node, index) => {
    const angle = index * (Math.PI * 2 / Math.max(1, outerNodes.length)) + Math.PI / 5;
    const radius = 540 + (index % 3) * 48;
    projected.push(project3dNode({
      ...node,
      x3: Math.cos(angle) * radius,
      y3: Math.sin(angle) * radius * 0.46,
      z3: -230 + (index % 3) * 90,
      role: "outer"
    }, cx, cy, camera));
  });
  projected.sort((a, b) => a.z3 - b.z3);
  const byId = new Map(projected.map((node) => [node.id, node]));
  const edges = state.graph.edges
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
    .sort((a, b) => {
      const az = ((byId.get(a.source)?.z3 || 0) + (byId.get(a.target)?.z3 || 0)) / 2;
      const bz = ((byId.get(b.source)?.z3 || 0) + (byId.get(b.target)?.z3 || 0)) / 2;
      return az - bz;
    });
  return {
    width,
    height,
    markup: `
      <defs>
        <radialGradient id="planetNode" cx="35%" cy="30%" r="72%">
          <stop offset="0%" stop-color="#ffffff"></stop>
          <stop offset="55%" stop-color="#eef6ff"></stop>
          <stop offset="100%" stop-color="#c7d2fe"></stop>
        </radialGradient>
        <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#1e293b" flood-opacity="0.18"></feDropShadow>
        </filter>
      </defs>
      <rect width="${width}" height="${height}" fill="#f8fafc"></rect>
      ${options.fullscreen ? "" : svgGraphHeader(width, "3D 关系可视化图", "点击节点切换空间中心；点击连线查看关系依据。")}
      ${graph3dOrbits(cx, cy)}
      ${edges.map((edge) => svg3dEdgePath(edge, byId)).join("")}
      ${projected.map((node) => svg3dNode(node)).join("")}
      ${edges.map((edge, index) => svg3dEdgeLabel(edge, byId, index)).join("")}
    `
  };
}

function graph3dDefs() {
  return `
    <defs>
      <radialGradient id="planetNode" cx="35%" cy="30%" r="72%">
        <stop offset="0%" stop-color="#ffffff"></stop>
        <stop offset="55%" stop-color="#eef6ff"></stop>
        <stop offset="100%" stop-color="#c7d2fe"></stop>
      </radialGradient>
      <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#1e293b" flood-opacity="0.18"></feDropShadow>
      </filter>
    </defs>
  `;
}

function graph3dSingleLayout(nodes, width, height, options = {}) {
  const cx = width / 2;
  const cy = height / 2 + (options.fullscreen ? 0 : 36);
  const node = { ...nodes[0], x: cx, y: cy, z3: 180, scale: 1, r: options.fullscreen ? 118 : 96, role: "small", opacity: 1 };
  return {
    width,
    height,
    markup: `
      ${graph3dNetworkDefs()}
      <rect width="${width}" height="${height}" fill="#f8fafc"></rect>
      ${options.fullscreen ? "" : svgGraphHeader(width, "3D 关系可视化图", "当前只有一篇文献；继续上传后会生成文献之间的关系。")}
      <ellipse cx="${cx}" cy="${cy}" rx="${node.r + 92}" ry="${(node.r + 92) * 0.36}" fill="none" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="6 8" opacity="0.45"></ellipse>
      ${svg3dNode(node)}
    `
  };
}

function graph3dPairLayout(nodes, width, height, options = {}) {
  const selectedId = state.graphCenterId;
  const y = height * (options.fullscreen ? 0.53 : 0.56);
  const left = {
    ...nodes[0],
    x: width * 0.25,
    y,
    z3: selectedId === nodes[0].id ? 95 : 35,
    scale: 1,
    r: selectedId === nodes[0].id ? 98 : 92,
    role: "pair",
    opacity: 1
  };
  const right = {
    ...nodes[1],
    x: width * 0.75,
    y,
    z3: selectedId === nodes[1].id ? 95 : 35,
    scale: 1,
    r: selectedId === nodes[1].id ? 98 : 92,
    role: "pair",
    opacity: 1
  };
  const projected = selectedId === right.id ? [left, right] : [right, left];
  const byId = new Map([[left.id, left], [right.id, right]]);
  const edges = state.graph.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const mainEdge = edges[0] || null;
  const relationText = mainEdge ? graph3dRelationLabel(mainEdge, left, right) : "暂无稳定关系证据，需补充抽取或重新构建";
  const bridgeY = y - 6;
  const guideY = y + 168;
  return {
    width,
    height,
    markup: `
      ${graph3dNetworkDefs()}
      <rect width="${width}" height="${height}" fill="#f8fafc"></rect>
      ${options.fullscreen ? "" : svgGraphHeader(width, "3D 关系可视化图", "两篇文献使用对照布局；点击任一节点可切换观察中心。")}
      ${svgPairDepthGrid(width, height, y)}
      ${svgPairNodeHalo(left, "#285f9f")}
      ${svgPairNodeHalo(right, "#0f766e")}
      ${svgPairSatellites(left, "left")}
      ${svgPairSatellites(right, "right")}
      ${svgPairRelationBridge(left, right, relationText, mainEdge)}
      <path d="M ${left.x + left.r + 22} ${guideY} C ${width * 0.42} ${guideY + 58}, ${width * 0.58} ${guideY + 58}, ${right.x - right.r - 22} ${guideY}" fill="none" stroke="#cbd5e1" stroke-width="1.4" stroke-dasharray="8 8" opacity="0.62"></path>
      ${pairComparisonHints(left, right, width, y)}
      ${edges.length > 1 ? edges.slice(1).map((edge, index) => svg3dPairEdgePath(edge, byId, index + 1)).join("") : ""}
      ${projected.map((node) => svg3dNode(node)).join("")}
      ${edges.slice(1).map((edge, index) => svg3dPairEdgeLabel(edge, byId, index + 1)).join("")}
    `
  };
}

function graph3dSmallLayout(nodes, width, height, options = {}) {
  const selectedNode = nodes.find((node) => node.id === state.graphCenterId);
  const cx = width / 2;
  const cy = height * (options.fullscreen ? 0.52 : 0.55);
  const radiusX = width * (options.fullscreen ? 0.34 : 0.31);
  const radiusY = height * (nodes.length === 4 ? (options.fullscreen ? 0.32 : 0.31) : (options.fullscreen ? 0.29 : 0.27));
  const focusEdgeIds = new Set((state.graph.edges || [])
    .filter((edge) => selectedNode && (edge.source === selectedNode.id || edge.target === selectedNode.id))
    .flatMap((edge) => [edge.source, edge.target]));
  const projected = selectedNode
    ? smallFocusedLayout(nodes, selectedNode, cx, cy, radiusX, radiusY, focusEdgeIds)
    : nodes.map((node, index) => {
    const selected = selectedNode?.id === node.id;
    const related = !selectedNode || selected || focusEdgeIds.has(node.id);
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / nodes.length);
    return {
      ...node,
      x: cx + Math.cos(angle) * radiusX,
      y: cy + Math.sin(angle) * radiusY,
      z3: 40 + Math.sin(angle) * 80,
      scale: 1,
      r: selected ? 88 : 74,
      role: selected ? "center" : "small",
      opacity: related ? 1 : 0.42,
      focusSelected: selected,
      focusRelated: related,
      angle
    };
  });
  const byId = new Map(projected.map((node) => [node.id, node]));
  const edges = state.graph.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const focusNode = selectedNode ? byId.get(selectedNode.id) : null;
  const nodeRects = projected.map((node) => nodeSafeRect(node));
  const satelliteCards = placeSmallSatelliteCards(projected, cx, cy, width, height, nodeRects);
  const relationOccupied = [...nodeRects, ...satelliteCards.map((card) => card.rect)];
  const relationChips = edges.map((edge, index) => {
    const chip = smallRelationChipPlacement(edge, byId, index, cx, cy, width, height, projected, selectedNode?.id || "", relationOccupied);
    if (chip) relationOccupied.push(chip.rect);
    return chip;
  }).filter(Boolean);
  return {
    width,
    height,
    markup: `
      ${graph3dNetworkDefs()}
      <rect width="${width}" height="${height}" fill="#f8fafc"></rect>
      ${options.fullscreen ? "" : svgGraphHeader(width, "3D 关系可视化图", "三到四篇文献使用均衡空间布局；点击节点切换中心。")}
      ${svgSmallDepthGrid(cx, cy, radiusX, radiusY)}
      ${focusNode ? svgSmallFocusHalo(focusNode, cx, cy) : ""}
      ${satelliteCards.map((card) => svgSmallNodeSatelliteLink(card)).join("")}
      ${edges.map((edge, index) => svg3dSmallEdgePath(edge, byId, index, cx, cy, selectedNode?.id || "")).join("")}
      ${projected.map((node) => svg3dNode(node)).join("")}
      ${satelliteCards.map((card) => svgSmallNodeSatelliteCard(card)).join("")}
      ${relationChips.map((chip) => svg3dSmallRelationChip(chip)).join("")}
    `
  };
}

function smallFocusedLayout(nodes, selectedNode, cx, cy, radiusX, radiusY, focusEdgeIds) {
  const others = nodes.filter((node) => node.id !== selectedNode.id);
  const selectedIndex = Math.max(0, nodes.findIndex((node) => node.id === selectedNode.id));
  const baseAngle = -Math.PI / 2 + selectedIndex * (Math.PI * 2 / nodes.length);
  const satelliteAngles = others.length === 2
    ? [baseAngle + Math.PI * 0.72, baseAngle - Math.PI * 0.72]
    : others.map((_, index) => baseAngle + Math.PI + (index - (others.length - 1) / 2) * 1.25);
  const focusNode = {
    ...selectedNode,
    x: cx,
    y: cy,
    z3: 160,
    scale: 1,
    r: 92,
    role: "center",
    opacity: 1,
    focusSelected: true,
    focusRelated: true,
    angle: baseAngle
  };
  const satellites = others.map((node, index) => {
    const angle = satelliteAngles[index];
    const related = focusEdgeIds.has(node.id);
    return {
      ...node,
      x: cx + Math.cos(angle) * radiusX * 0.82,
      y: cy + Math.sin(angle) * radiusY * 0.82,
      z3: 25 + Math.sin(angle) * 70,
      scale: 1,
      r: related ? 76 : 70,
      role: "small",
      opacity: related ? 0.96 : 0.46,
      focusSelected: false,
      focusRelated: related,
      angle
    };
  });
  return [focusNode, ...satellites];
}

function svgSmallFocusHalo(node, cx, cy) {
  const accent = relationColor(node.scene || node.profile?.domain || "");
  return `
    <g class="small-focus-halo" pointer-events="none">
      <circle cx="${node.x}" cy="${node.y}" r="${node.r + 20}" fill="none" stroke="${accent}" stroke-width="2.4" stroke-opacity="0.54"></circle>
      <circle cx="${node.x}" cy="${node.y}" r="${node.r + 42}" fill="none" stroke="${accent}" stroke-width="1.4" stroke-dasharray="9 10" stroke-opacity="0.34"></circle>
      <ellipse cx="${node.x}" cy="${node.y + 8}" rx="${node.r + 74}" ry="${node.r + 28}" fill="none" stroke="${accent}" stroke-width="1.2" stroke-dasharray="5 9" stroke-opacity="0.26"></ellipse>
      <path d="M ${node.x} ${node.y} C ${(node.x + cx) / 2} ${node.y - 80}, ${(node.x + cx) / 2} ${cy + 80}, ${cx} ${cy}" fill="none" stroke="${accent}" stroke-width="1.4" stroke-opacity="0.26" stroke-dasharray="6 8"></path>
      <text x="${node.x}" y="${node.y - node.r - 28}" text-anchor="middle" fill="${accent}" font-size="12" font-weight="900">当前焦点</text>
    </g>
  `;
}

function svgSmallDepthGrid(cx, cy, radiusX, radiusY) {
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${radiusX + 110}" ry="${radiusY + 84}" fill="none" stroke="#dbe4ef" stroke-width="1" stroke-dasharray="8 10" opacity="0.68"></ellipse>
    <ellipse cx="${cx}" cy="${cy}" rx="${radiusX * 0.62}" ry="${radiusY * 0.54}" fill="none" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="5 9" opacity="0.82"></ellipse>
    <circle cx="${cx}" cy="${cy}" r="9" fill="#ffffff" stroke="#94a3b8" stroke-width="1.2" opacity="0.9"></circle>
    <text x="${cx}" y="${cy + 32}" text-anchor="middle" fill="#64748b" font-size="11" font-weight="800">关系核心</text>
  `;
}

function smallNodeSatelliteGeometry(node, cx, cy, allNodes = []) {
  const profile = node.profile || {};
  const dx = node.x - cx;
  const dy = node.y - cy;
  const length = Math.hypot(dx, dy) || 1;
  const fallbackAngle = Number.isFinite(node.angle) ? node.angle : -Math.PI / 2;
  const ux = length > 4 ? dx / length : Math.cos(fallbackAngle);
  const uy = length > 4 ? dy / length : Math.sin(fallbackAngle);
  const sx = node.x + ux * (node.r + 220);
  const sy = node.y + uy * (node.r + 134);
  const item = smallDistinctiveSatelliteItem(node, allNodes);
  const anchorX = node.x + ux * (node.r + 12);
  const anchorY = node.y + uy * (node.r + 8);
  return { item, ux, uy, sx, sy, anchorX, anchorY };
}

function nodeSafeRect(node) {
  const padX = node.focusSelected ? 72 : 58;
  const padTop = node.focusSelected ? 72 : 58;
  const padBottom = node.focusSelected ? 76 : 64;
  return {
    x: node.x - node.r - padX,
    y: node.y - node.r - padTop,
    w: node.r * 2 + padX * 2,
    h: node.r * 2 + padTop + padBottom
  };
}

function placeSmallSatelliteCards(nodes, cx, cy, width, height, occupied = []) {
  const placed = [];
  nodes.forEach((node, index) => {
    const geo = smallNodeSatelliteGeometry(node, cx, cy, nodes);
    const cardW = node.focusSelected ? 360 : 330;
    const maxChars = node.focusSelected ? 32 : 29;
    const lines = splitSvgText(completeUiText(geo.item.text), maxChars, null, { noEllipsis: true });
    const cardH = Math.max(node.focusSelected ? 106 : 96, 38 + lines.length * 15 + 18);
    const candidates = smallSatelliteCandidates(node, geo, cardW, cardH, width, height, index);
    const rect = chooseNonOverlappingRect(candidates, [...occupied, ...placed.map((item) => item.rect)], width, height, cardW, cardH, {
      anchorX: node.x,
      anchorY: node.y,
      pad: 18
    });
    placed.push({ ...geo, node, rect, cardW, cardH, lines, maxChars });
  });
  return placed;
}

function smallSatelliteCandidates(node, geo, cardW, cardH, width, height, index = 0) {
  const tangentialX = -geo.uy;
  const tangentialY = geo.ux;
  const baseDistances = node.focusSelected ? [260, 310, 360, 210, 410] : [214, 260, 306, 168, 352];
  const tangents = [0, 76, -76, 128, -128, 184, -184];
  const candidates = [];
  baseDistances.forEach((distance) => {
    tangents.forEach((offset) => {
      candidates.push({
        x: node.x + geo.ux * (node.r + distance) + tangentialX * (offset + (index % 2 ? 10 : -10)) - cardW / 2,
        y: node.y + geo.uy * (node.r + distance * 0.62) + tangentialY * offset - cardH / 2
      });
    });
  });
  if (node.focusSelected) {
    candidates.unshift(
      { x: width / 2 - cardW / 2, y: 104 },
      { x: width / 2 - cardW / 2, y: height - cardH - 42 },
      { x: 42, y: height / 2 - cardH / 2 },
      { x: width - cardW - 42, y: height / 2 - cardH / 2 }
    );
  }
  return candidates;
}

function chooseNonOverlappingRect(candidates, occupied, width, height, cardW, cardH, options = {}) {
  const anchorX = options.anchorX ?? width / 2;
  const anchorY = options.anchorY ?? height / 2;
  const pad = options.pad ?? 12;
  const expanded = [
    ...candidates,
    ...perimeterRectCandidates(cardW, cardH, width, height),
    ...gridRectCandidates(cardW, cardH, width, height)
  ];
  let best = null;
  let bestScore = Infinity;
  expanded.forEach((candidate, index) => {
    const rect = clampRect(candidate, cardW, cardH, width, height);
    const collisionArea = occupied.reduce((sum, item) => sum + rectOverlapArea(expandRect(rect, pad), expandRect(item, pad)), 0);
    const collisions = occupied.filter((item) => rectsOverlapWithPad(rect, item, pad)).length;
    const distance = Math.hypot(rect.x + rect.w / 2 - anchorX, rect.y + rect.h / 2 - anchorY);
    const edgePenalty = rect.y < 96 ? 50 : 0;
    const score = collisionArea * 12 + collisions * 4200 + distance * 0.18 + index * 3 + edgePenalty;
    if (score < bestScore) {
      best = rect;
      bestScore = score;
      if (!collisions && distance < 80) return;
    }
  });
  return best || clampRect(expanded[0] || { x: 30, y: 90 }, cardW, cardH, width, height);
}

function smallDistinctiveSatelliteItem(node, allNodes = []) {
  const profile = node.profile || {};
  const card = node.doc?.evidenceCard || {};
  const items = [
    { label: "对象", text: profile.domain || node.scene || "", color: "#285f9f" },
    { label: "问题", text: profile.problemType || card.research_question?.normalized_claim || card.research_question?.claim || "", color: "#0f766e" },
    { label: "方法", text: profile.methodType || card.method?.normalized_claim || card.method?.claim || "", color: "#285f9f" },
    { label: "证据", text: profile.evidenceType || card.evidence?.[0]?.normalized_claim || card.evidence?.[0]?.claim || "", color: "#b7791f" },
    { label: "边界", text: profile.riskType || card.limitations?.[0]?.normalized_claim || card.limitations?.[0]?.claim || "", color: "#b42318" },
    { label: "结论", text: card.contribution?.normalized_claim || card.contribution?.claim || profile.finding || "", color: "#7c3aed" }
  ].map((item) => ({ ...item, text: completeUiText(item.text || "") })).filter((item) => item.text);
  const otherText = allNodes
    .filter((other) => other.id !== node.id)
    .flatMap((other) => {
      const otherProfile = other.profile || {};
      const otherCard = other.doc?.evidenceCard || {};
      return [
        otherProfile.domain,
        otherProfile.problemType,
        otherProfile.methodType,
        otherProfile.evidenceType,
        otherProfile.riskType,
        otherCard.contribution?.normalized_claim || otherCard.contribution?.claim
      ].map((item) => completeUiText(item || ""));
    })
    .join(" ");
  const scored = items.map((item) => {
    const terms = new Set(tokensForUi(item.text));
    const overlap = [...terms].filter((term) => otherText.includes(term)).length;
    const specificity = Math.min(8, Math.max(0, item.text.length / 8));
    const labelBonus = ({ 边界: 3.2, 证据: 2.8, 对象: 2.4, 结论: 2.2, 方法: 1.8, 问题: 1.4 }[item.label] || 1);
    return { ...item, score: specificity + labelBonus - overlap * 1.2 };
  }).sort((a, b) => b.score - a.score);
  const picked = scored[0] || items[0] || { label: "对象", text: "待核对", color: "#64748b" };
  const second = scored.find((item) => item.label !== picked.label && item.score > picked.score - 2.4);
  return {
    ...picked,
    label: second ? `差异: ${picked.label}+${second.label}` : `差异: ${picked.label}`,
    text: second ? `${picked.text} / ${second.text}` : (picked.text || "待核对")
  };
}

function tokensForUi(text) {
  return String(text || "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .flatMap((part) => {
      if (/^[\u4e00-\u9fa5]+$/.test(part) && part.length > 4) {
        const pieces = [];
        for (let i = 0; i < part.length - 1; i += 2) pieces.push(part.slice(i, i + 2));
        return pieces;
      }
      return [part];
    })
    .filter((part) => part.length >= 2)
    .slice(0, 18);
}

function svgSmallNodeSatelliteLink(card) {
  const { item, anchorX, anchorY, rect } = card;
  const targetX = rect.x + rect.w / 2;
  const targetY = rect.y + rect.h / 2;
  const dx = targetX - anchorX;
  const dy = targetY - anchorY;
  return `
    <g class="pair-satellite small-satellite-link">
      <path d="M ${anchorX} ${anchorY} C ${anchorX + dx * 0.34} ${anchorY + dy * 0.24}, ${targetX - dx * 0.32} ${targetY - dy * 0.12}, ${targetX} ${targetY}" fill="none" stroke="${item.color}" stroke-width="1.4" stroke-opacity="0.32"></path>
    </g>
  `;
}

function svgSmallNodeSatelliteCard(card) {
  const { item, rect, lines, maxChars } = card;
  const tx = rect.x + rect.w / 2;
  return `
    <g class="pair-satellite small-satellite">
      <rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="8" fill="#ffffff" stroke="${item.color}" stroke-width="1.1" opacity="0.98"></rect>
      <text x="${tx}" y="${rect.y + 18}" text-anchor="middle" fill="${item.color}" font-size="11" font-weight="900">${escapeHtml(item.label)}</text>
      ${svgMultilineText(completeUiText(item.text), tx, rect.y + 58, {
        maxChars,
        maxLines: null,
        lines,
        noEllipsis: true,
        color: "#334155",
        fontSize: 11,
        weight: 700,
        lineGap: 4,
        className: "svg-small-diff-label"
      })}
    </g>
  `;
}

function svg3dSmallEdgePath(edge, byId, index = 0, cx = 0, cy = 0, focusId = "") {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return "";
  const color = relationColor(edge.relation || edge.relationKind || "");
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  const focusRelated = focusId && (edge.source === focusId || edge.target === focusId);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const pull = selected || focusRelated ? 0.3 : 0.2;
  const qx = midX + (cx - midX) * pull;
  const qy = midY + (cy - midY) * pull;
  const width = selected ? 4.6 : focusRelated ? 3.8 : 1.8;
  const opacity = selected ? 0.98 : focusRelated ? 0.88 : (focusId ? 0.18 : 0.54);
  return `
    <g class="svg-edge svg-3d-edge ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
      <path d="M ${a.x} ${a.y} Q ${qx} ${qy} ${b.x} ${b.y}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}"></path>
    </g>
  `;
}

function smallRelationChipPlacement(edge, byId, index = 0, cx = 0, cy = 0, width = 1400, height = 860, allNodes = [], focusId = "", occupiedRects = []) {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return null;
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  const focusRelated = focusId && (edge.source === focusId || edge.target === focusId);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  let vx = midX - cx;
  let vy = midY - cy;
  const length = Math.hypot(vx, vy) || 1;
  vx /= length;
  vy /= length;
  const stagger = ((index % 3) - 1) * 34;
  const labelW = selected || focusRelated ? 470 : 410;
  const maxChars = selected || focusRelated ? 42 : 37;
  const labelLines = splitSvgText(graph3dRelationLabel(edge, a, b), maxChars, null, { noEllipsis: true });
  const labelH = Math.max(selected || focusRelated ? 118 : 102, 42 + labelLines.length * (selected || focusRelated ? 17 : 16) + 18);
  const base = {
    x: midX + vx * 132 - labelW / 2 + (-vy * stagger),
    y: midY + vy * 112 - labelH / 2 + (vx * stagger)
  };
  const rect = avoidNodeOverlapRect(
    { ...base, w: labelW, h: labelH },
    allNodes.length ? allNodes : [a, b],
    width,
    height,
    vx,
    vy,
    occupiedRects
  );
  return { edge, a, b, id, selected, focusRelated, rect, labelW, labelH, labelLines, maxChars };
}

function svg3dSmallRelationChip(chip) {
  const { edge, a, b, id, selected, focusRelated, rect, labelW, labelH, labelLines, maxChars } = chip;
  const color = relationColor(edge.relation || edge.relationKind || "");
  const x = rect.x;
  const y = rect.y;
  const text = graph3dRelationLabel(edge, a, b);
  const opacity = selected || focusRelated || !state.graphCenterId ? 1 : 0.34;
  return `
    <g class="svg-edge-label-hit small-relation-chip" data-edge-id="${escapeHtml(id)}" opacity="${opacity}">
      <rect x="${x}" y="${y}" width="${labelW}" height="${labelH}" rx="8" fill="#ffffff" stroke="${color}" stroke-width="${selected ? 1.8 : 1.2}" opacity="0.96"></rect>
      <text x="${x + labelW / 2}" y="${y + 18}" text-anchor="middle" fill="${color}" font-size="11" font-weight="900">${escapeHtml(edge.relation || edge.relationKind || "关系")}</text>
      ${svgMultilineText(text, x + labelW / 2, y + (selected || focusRelated ? 66 : 58), {
        maxChars,
        maxLines: null,
        lines: labelLines,
        noEllipsis: true,
        color: "#0f172a",
        fontSize: selected || focusRelated ? 12 : 11,
        weight: 800,
        className: "svg-3d-bridge-label"
      })}
    </g>
  `;
}

function avoidNodeOverlapRect(rect, nodes, width, height, vx, vy, occupiedRects = []) {
  let next = { ...rect };
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const hit = nodes.some((node) => circleRectOverlap(node.x, node.y, node.r + 42, next));
    const rectHit = occupiedRects.some((item) => rectsOverlapWithPad(next, item, 14));
    if (!hit && !rectHit) break;
    const turn = attempt % 2 === 0 ? 1 : -1;
    next.x += vx * 34 + (-vy * 26 * turn);
    next.y += vy * 34 + (vx * 26 * turn);
  }
  let clamped = {
    x: Math.max(28, Math.min(width - rect.w - 28, next.x)),
    y: Math.max(86, Math.min(height - rect.h - 28, next.y)),
    w: rect.w,
    h: rect.h
  };
  if (occupiedRects.some((item) => rectsOverlapWithPad(clamped, item, 14))) {
    clamped = chooseNonOverlappingRect(relationRectCandidates(rect, vx, vy), occupiedRects, width, height, rect.w, rect.h, {
      anchorX: rect.x + rect.w / 2,
      anchorY: rect.y + rect.h / 2,
      pad: 18
    });
  }
  return clamped;
}

function circleRectOverlap(cx, cy, r, rect) {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return Math.hypot(cx - closestX, cy - closestY) < r;
}

function relationRectCandidates(rect, vx, vy) {
  const candidates = [];
  const nx = -vy;
  const ny = vx;
  [0, 48, 86, 124, 168, 214, 268].forEach((forward) => {
    [0, 44, -44, 82, -82, 126, -126].forEach((side) => {
      candidates.push({
        x: rect.x + vx * forward + nx * side,
        y: rect.y + vy * forward + ny * side
      });
    });
  });
  return candidates;
}

function rectsOverlapWithPad(a, b, pad = 0) {
  return rectsOverlap(expandRect(a, pad), expandRect(b, pad));
}

function expandRect(rect, pad = 0) {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
}

function rectOverlapArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function perimeterRectCandidates(w, h, canvasWidth, canvasHeight) {
  const margin = 34;
  return [
    { x: margin, y: 96 },
    { x: canvasWidth - w - margin, y: 96 },
    { x: margin, y: canvasHeight - h - margin },
    { x: canvasWidth - w - margin, y: canvasHeight - h - margin },
    { x: canvasWidth / 2 - w / 2, y: 96 },
    { x: canvasWidth / 2 - w / 2, y: canvasHeight - h - margin },
    { x: margin, y: canvasHeight / 2 - h / 2 },
    { x: canvasWidth - w - margin, y: canvasHeight / 2 - h / 2 }
  ];
}

function gridRectCandidates(w, h, canvasWidth, canvasHeight) {
  const candidates = [];
  const left = 34;
  const top = 96;
  const right = Math.max(left, canvasWidth - w - 34);
  const bottom = Math.max(top, canvasHeight - h - 28);
  const columns = 8;
  const rows = 9;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      candidates.push({
        x: left + (right - left) * (col / Math.max(1, columns - 1)),
        y: top + (bottom - top) * (row / Math.max(1, rows - 1))
      });
    }
  }
  return candidates;
}

function pairComparisonHints(left, right, width, y) {
  const leftText = left.profile?.problemType || "研究问题";
  const rightText = right.profile?.problemType || "研究问题";
  return `
    <text x="${left.x}" y="${y - 182}" text-anchor="middle" fill="#64748b" font-size="13" font-weight="800">${escapeHtml(shortTitle(leftText, 24))}</text>
    <text x="${right.x}" y="${y - 182}" text-anchor="middle" fill="#64748b" font-size="13" font-weight="800">${escapeHtml(shortTitle(rightText, 24))}</text>
  `;
}

function svgPairDepthGrid(width, height, y) {
  const cy = y + 18;
  return `
    <ellipse cx="${width / 2}" cy="${cy}" rx="${width * 0.35}" ry="${height * 0.18}" fill="none" stroke="#dbe4ef" stroke-width="1" stroke-dasharray="7 10" opacity="0.72"></ellipse>
    <ellipse cx="${width / 2}" cy="${cy}" rx="${width * 0.25}" ry="${height * 0.12}" fill="none" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="5 9" opacity="0.9"></ellipse>
    <path d="M ${width * 0.18} ${cy} C ${width * 0.34} ${cy - 120}, ${width * 0.66} ${cy - 120}, ${width * 0.82} ${cy}" fill="none" stroke="#e2e8f0" stroke-width="1" opacity="0.75"></path>
    <path d="M ${width * 0.18} ${cy} C ${width * 0.34} ${cy + 120}, ${width * 0.66} ${cy + 120}, ${width * 0.82} ${cy}" fill="none" stroke="#e2e8f0" stroke-width="1" opacity="0.75"></path>
  `;
}

function svgPairNodeHalo(node, color) {
  return `
    <ellipse cx="${node.x}" cy="${node.y + 8}" rx="${node.r + 86}" ry="${node.r + 38}" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="8 9" opacity="0.26"></ellipse>
    <ellipse cx="${node.x}" cy="${node.y + 8}" rx="${node.r + 132}" ry="${node.r + 66}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="4 10" opacity="0.16"></ellipse>
  `;
}

function pairSatelliteItems(node) {
  const profile = node.profile || {};
  const card = node.doc?.evidenceCard || node.doc?.analysisCard || {};
  const firstClaim = Array.isArray(card.main_claims) ? card.main_claims[0]?.claim || card.main_claims[0] : "";
  const evidence = Array.isArray(card.evidence) ? card.evidence[0]?.claim || card.evidence[0] : "";
  return [
    { label: "问题", text: profile.problemType || card.research_question?.claim || "研究问题待核对", color: "#285f9f" },
    { label: "方法", text: profile.methodType || card.method?.claim || "方法路径待核对", color: "#0f766e" },
    { label: "证据", text: profile.evidenceType || evidence || "证据类型待核对", color: "#b7791f" },
    { label: "边界", text: profile.riskType || card.limitations?.[0]?.claim || firstClaim || "局限边界待核对", color: "#b42318" }
  ];
}

function svgPairSatellites(node, side) {
  const dir = side === "left" ? -1 : 1;
  const items = pairSatelliteItems(node);
  const positions = [
    { x: node.x + dir * 210, y: node.y - 150 },
    { x: node.x + dir * 254, y: node.y - 42 },
    { x: node.x + dir * 240, y: node.y + 78 },
    { x: node.x + dir * 174, y: node.y + 180 }
  ];
  return items.map((item, index) => {
    const pos = positions[index];
    const anchorX = node.x + dir * (node.r + 14);
    const anchorY = node.y + [-42, -14, 28, 56][index];
    return `
      <g class="pair-satellite">
        <path d="M ${anchorX} ${anchorY} C ${node.x + dir * 128} ${anchorY}, ${pos.x - dir * 86} ${pos.y}, ${pos.x - dir * 74} ${pos.y}" fill="none" stroke="${item.color}" stroke-width="1.5" stroke-opacity="0.36"></path>
        <circle cx="${pos.x - dir * 82}" cy="${pos.y}" r="5" fill="${item.color}" opacity="0.82"></circle>
        <rect x="${pos.x - 88}" y="${pos.y - 24}" width="176" height="48" rx="8" fill="#ffffff" stroke="${item.color}" stroke-width="1.2" opacity="0.96"></rect>
        <text x="${pos.x}" y="${pos.y - 7}" text-anchor="middle" fill="${item.color}" font-size="11" font-weight="900">${escapeHtml(item.label)}</text>
        <text x="${pos.x}" y="${pos.y + 12}" text-anchor="middle" fill="#334155" font-size="11" font-weight="700">${escapeHtml(shortTitle(completeUiText(item.text), 18))}</text>
      </g>
    `;
  }).join("");
}

function svgPairRelationBridge(left, right, relationText, edge) {
  const color = edge ? relationColor(edge.relation || edge.relationKind || "") : "#64748b";
  const id = edge ? graphEdgeId(edge) : "";
  const selected = id && id === state.selectedGraphEdgeId;
  const cx = (left.x + right.x) / 2;
  const cy = left.y - 8;
  const w = Math.max(330, right.x - left.x - left.r - right.r - 126);
  return `
    <g class="${edge ? `svg-edge svg-3d-edge ${selected ? "selected" : ""}` : ""}" ${edge ? `data-edge-id="${escapeHtml(id)}"` : ""}>
      <path d="M ${left.x + left.r + 22} ${left.y - 18} C ${cx - 170} ${cy - 112}, ${cx + 170} ${cy - 112}, ${right.x - right.r - 22} ${right.y - 18}" fill="none" stroke="${color}" stroke-width="${selected ? 5 : 3.4}" stroke-opacity="${selected ? 0.98 : 0.82}"></path>
      <path d="M ${left.x + left.r + 22} ${left.y + 34} C ${cx - 170} ${cy + 118}, ${cx + 170} ${cy + 118}, ${right.x - right.r - 22} ${right.y + 34}" fill="none" stroke="${color}" stroke-width="2.1" stroke-opacity="0.44"></path>
      <rect x="${cx - w / 2}" y="${cy - 78}" width="${w}" height="116" rx="10" fill="#ffffff" stroke="${color}" stroke-width="1.4" opacity="0.97"></rect>
      <text x="${cx}" y="${cy - 50}" text-anchor="middle" fill="${color}" font-size="12" font-weight="900">关系判断</text>
      ${svgMultilineText(relationText, cx, cy - 7, {
        maxChars: selected ? 38 : 34,
        maxLines: selected ? 4 : 3,
        color: "#0f172a",
        fontSize: selected ? 15 : 14,
        weight: 900,
        className: "svg-3d-bridge-label"
      })}
    </g>
  `;
}

function svg3dPairFallbackEdge(left, right) {
  return `
    <path d="M ${left.x + left.r + 18} ${left.y} C ${left.x + 245} ${left.y - 160}, ${right.x - 245} ${right.y - 160}, ${right.x - right.r - 18} ${right.y}" fill="none" stroke="#64748b" stroke-width="2.4" stroke-opacity="0.45"></path>
    <text class="svg-3d-edge-label" x="${(left.x + right.x) / 2}" y="${left.y - 154}" text-anchor="middle" fill="#64748b" font-size="14" font-weight="900">暂无稳定关系证据，需补充抽取或重新构建</text>
  `;
}

function svg3dPairEdgePath(edge, byId, index = 0) {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return "";
  const color = relationColor(edge.relation || edge.relationKind || "");
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  const direction = index % 2 === 0 ? -1 : 1;
  const curveY = a.y + direction * (145 + Math.floor(index / 2) * 58);
  return `
    <g class="svg-edge svg-3d-edge ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
      <path d="M ${a.x} ${a.y} C ${a.x + (b.x - a.x) * 0.28} ${curveY}, ${a.x + (b.x - a.x) * 0.72} ${curveY}, ${b.x} ${b.y}" fill="none" stroke="${color}" stroke-width="${selected ? 4 : 2.8}" stroke-opacity="${selected ? 0.98 : 0.72}"></path>
    </g>
  `;
}

function svg3dPairEdgeLabel(edge, byId, index = 0) {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return "";
  const color = relationColor(edge.relation || edge.relationKind || "");
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  const direction = index % 2 === 0 ? -1 : 1;
  const labelY = a.y + direction * (166 + Math.floor(index / 2) * 62);
  const text = graph3dRelationLabel(edge, a, b);
  return `
    <g class="svg-edge-label-hit" data-edge-id="${escapeHtml(id)}">
      ${svgMultilineText(text, (a.x + b.x) / 2, labelY, {
        maxChars: selected ? 34 : 30,
        maxLines: selected ? 4 : 3,
        color,
        fontSize: selected ? 15 : 14,
        weight: 900,
        anchor: "middle",
        className: "svg-3d-edge-label"
      })}
    </g>
  `;
}

function project3dNode(node, cx, cy, camera) {
  const scale = camera / (camera - node.z3);
  return {
    ...node,
    x: cx + node.x3 * scale,
    y: cy + node.y3 * scale,
    scale,
    r: Math.max(48, Math.min(92, (node.role === "center" ? 78 : 60) * scale)),
    opacity: node.role === "outer" ? 0.66 : Math.max(0.68, Math.min(1, 0.78 + node.z3 / 700))
  };
}

function graph3dOrbits(cx, cy) {
  return [360, 505, 660].map((radius, index) => `
    <ellipse cx="${cx}" cy="${cy}" rx="${radius}" ry="${radius * 0.43}" fill="none" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="${index === 1 ? "8 8" : "4 8"}" opacity="${0.5 - index * 0.08}"></ellipse>
  `).join("");
}

function svg3dEdgeGeometry(edge, byId, index = 0) {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return null;
  const color = relationColor(edge.relation || edge.relationKind || "");
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  const avgZ = (a.z3 + b.z3) / 2;
  const opacity = selected ? 0.95 : Math.max(0.18, Math.min(0.62, 0.38 + avgZ / 900));
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2 - Math.max(-70, Math.min(70, avgZ / 4));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;
  const spread = ((index % 5) - 2) * 18;
  const baseOffset = selected ? 66 : 48;
  const labelX = midX + normalX * (baseOffset + spread);
  const labelY = midY + normalY * (baseOffset + spread);
  return { a, b, color, id, selected, avgZ, opacity, midX, midY, labelX, labelY, edge };
}

function svg3dEdgePath(edge, byId) {
  const geo = svg3dEdgeGeometry(edge, byId);
  if (!geo) return "";
  const { a, b, color, id, selected, avgZ, opacity, midX, midY } = geo;
  return `
    <g class="svg-edge svg-3d-edge ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
      <path d="M ${a.x} ${a.y} Q ${midX} ${midY} ${b.x} ${b.y}" fill="none" stroke="${color}" stroke-width="${selected ? 3.4 : Math.max(1.2, 1.9 + avgZ / 500)}" stroke-opacity="${opacity}"></path>
    </g>
  `;
}

function graph3dRelationLabel(edge, a = {}, b = {}) {
  const why = completeUiText(edge.evidence?.why || "").replace(/\s+/g, " ").trim();
  if (why && why.length >= 12) return why;
  const relation = String(edge.relation || edge.relationKind || "").trim();
  const logic = edgeLineLabel(edge, a, b);
  if (relation && relation !== logic) return `${relation}：${logic}`;
  return logic;
}

function splitSvgText(text, maxChars = 28, maxLines = 3, options = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const chunks = [];
  let current = "";
  for (const char of clean) {
    current += char;
    if (current.length >= maxChars || /[，。；、:：]/.test(char)) {
      chunks.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  const limit = options.noEllipsis || maxLines == null ? chunks.length : maxLines;
  const lines = chunks.slice(0, limit);
  if (!options.noEllipsis && maxLines != null && chunks.length > maxLines && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[，。；、:：-]+$/, "");
  }
  return lines;
}

function svgMultilineText(text, x, y, options = {}) {
  const fontSize = options.fontSize || 13;
  const lineGap = options.lineGap || 5;
  const lines = options.lines || splitSvgText(text, options.maxChars || 28, options.maxLines ?? 3, {
    noEllipsis: Boolean(options.noEllipsis)
  });
  const startY = y - ((lines.length - 1) * (fontSize + lineGap)) / 2;
  const anchor = options.anchor || "middle";
  const weight = options.weight || 800;
  const color = options.color || "#334155";
  const className = options.className ? ` class="${options.className}"` : "";
  return lines.map((line, index) => (
    `<text${className} x="${x}" y="${startY + index * (fontSize + lineGap)}" text-anchor="${anchor}" fill="${color}" font-size="${fontSize}" font-weight="${weight}">${escapeHtml(line)}</text>`
  )).join("");
}

function svg3dEdgeLabel(edge, byId, index = 0) {
  const geo = svg3dEdgeGeometry(edge, byId, index);
  if (!geo) return "";
  const { a, b, color, id, selected, labelX, labelY } = geo;
  const smallLayout = ["pair", "small"].includes(a.role) || ["pair", "small"].includes(b.role);
  const label = smallLayout ? graph3dRelationLabel(edge, a, b) : shortTitle(edgeLineLabel(edge, a, b), selected ? 30 : 16);
  const showLabel = selected || a.role === "center" || b.role === "center" || smallLayout;
  if (!showLabel) return "";
  return `
    <g class="svg-edge-label-hit" data-edge-id="${escapeHtml(id)}">
      ${smallLayout ? svgMultilineText(label, labelX, labelY + 4, {
        maxChars: selected ? 32 : 26,
        maxLines: selected ? 4 : 3,
        color,
        fontSize: selected ? 14 : 12,
        weight: 900,
        className: "svg-3d-edge-label"
      }) : `<text class="svg-3d-edge-label" x="${labelX}" y="${labelY + 4}" text-anchor="middle" fill="${color}" font-size="${selected ? 14 : 12}" font-weight="900">${escapeHtml(label)}</text>`}
    </g>
  `;
}

function svg3dNode(node) {
  const profile = node.profile || {};
  const label = profile.domain || shortTitle(node.doc?.title || node.title || "文献", 12);
  const sub = profile.problemType || "待核对问题";
  const selected = node.id === state.graphCenterId;
  const accent = relationColor(node.scene || profile.domain || "");
  return `
    <g class="svg-node svg-3d-node ${selected ? "center" : ""}" data-doc-id="${escapeHtml(node.id)}" opacity="${node.opacity}">
      <circle cx="${node.x}" cy="${node.y}" r="${node.r}" fill="url(#planetNode)" stroke="${selected ? "#285f9f" : accent}" stroke-width="${selected ? 3.2 : 1.8}" filter="url(#softShadow)"></circle>
      <circle cx="${node.x - node.r * 0.28}" cy="${node.y - node.r * 0.25}" r="${Math.max(5, node.r * 0.13)}" fill="#ffffff" opacity="0.86"></circle>
      <text x="${node.x}" y="${node.y - 5}" text-anchor="middle" fill="#0f172a" font-size="${Math.max(12, Math.min(16, node.r / 3.4))}" font-weight="800">${escapeHtml(shortTitle(label, 11))}</text>
      <text x="${node.x}" y="${node.y + 16}" text-anchor="middle" fill="#475569" font-size="11">${escapeHtml(shortTitle(sub, 14))}</text>
    </g>
  `;
}

function graph3dLayout(width, options = {}) {
  if (state.docFlow) return vectorDocFlowLayout(width);
  const nodes = state.graph.nodes.map((node) => ({ ...node, scene: nodeScene(node), doc: docById(node.id) }));
  const edges = state.graph.edges || [];
  const height = options.fullscreen ? 960 : 860;
  if (!nodes.length) {
    return {
      width,
      height,
    markup: `<rect width="${width}" height="${height}" fill="#f8fafc"></rect><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#64748b" font-size="15">上传资料后生成关系网络</text>`
    };
  }
  const layout = graph3dNetworkLayout(nodes, edges, width, height);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const visibleEdges = edges
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
    .sort((a, b) => Number(a.weight || 0) - Number(b.weight || 0));
  return {
    width,
    height,
    markup: `
      ${graph3dNetworkDefs()}
      <rect width="${width}" height="${height}" fill="#f8fafc"></rect>
      ${graphNetworkBackdrop(width, height, layout)}
      ${options.fullscreen ? "" : graph3dHeader(layout, width)}
      ${graph3dNetworkLegend(width)}
      <g class="network-edge-layer">${visibleEdges.map((edge) => svg3dNetworkEdge(edge, byId)).join("")}</g>
      <g class="network-label-layer">${visibleEdges.map((edge, index) => svg3dNetworkEdgeLabel(edge, byId, index)).join("")}</g>
      <g class="network-node-layer">${layout.nodes.map((node) => svg3dNetworkNode(node)).join("")}</g>
    `
  };
}

function graph3dHeader(layout, width) {
  if (layout.focused) {
    const center = layout.nodes.find((node) => node.id === layout.focusId);
    const doc = center ? docById(center.id) : {};
    const title = `中心视图：文献 ${center?.indexLabel || ""}`;
    const subtitle = `${shortTitle(doc.title || center?.title || "当前文献", 26)}；右侧只看与它直接相关的论文。`;
    return svgGraphHeader(width, title, subtitle);
  }
  return svgGraphHeader(
    width,
    "三维研究空间：论文节点图",
    "每个节点是一篇论文；X=问题/领域，Y=证据可用度，大小/前后=关系中心性。"
  );
}

function graph3dNetworkLayout(nodes, edges, width, height) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + Number(edge.weight || 0.4));
    degree.set(edge.target, (degree.get(edge.target) || 0) + Number(edge.weight || 0.4));
  });
  const explicitFocus = nodes.find((node) => node.id === state.graphCenterId);
  const focus = explicitFocus ||
    [...nodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))[0];
  const focusEdges = edges.filter((edge) => edge.source === focus?.id || edge.target === focus?.id);
  const relatedIds = new Set(focusEdges.flatMap((edge) => [edge.source, edge.target]).filter((id) => id !== focus?.id));
  const cx = width / 2;
  const cy = height / 2 + 42;
  const positioned = [];
  if (focus && explicitFocus) {
    positioned.push(networkProjectNode(
      focus,
      width * 0.25,
      cy,
      190,
      degree.get(focus.id),
      "center",
      true
    ));
  }
  const related = nodes.filter((node) => relatedIds.has(node.id));
  const outer = nodes.filter((node) => node.id !== focus?.id && !relatedIds.has(node.id));
  if (explicitFocus) {
    const columns = related.length <= 4 ? 1 : 2;
    const startX = columns === 1 ? width * 0.66 : width * 0.55;
    const gapX = width * 0.23;
    const rowGap = Math.max(142, Math.min(178, (height - 260) / Math.max(1, Math.ceil(related.length / columns))));
    const startY = cy - rowGap * (Math.ceil(related.length / columns) - 1) / 2;
    related
      .sort((a, b) => Number(edgeWeightBetween(focus.id, b.id, edges)) - Number(edgeWeightBetween(focus.id, a.id, edges)) || a.scene.localeCompare(b.scene, "zh-CN"))
      .forEach((node, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        positioned.push(networkProjectNode(
          node,
          startX + col * gapX,
          startY + row * rowGap + (col % 2 ? rowGap * 0.22 : 0),
          70 - row * 12,
          degree.get(node.id),
          "related",
          true
        ));
      });
    outer.forEach((node, index) => {
      positioned.push(networkProjectNode(
        node,
        width * 0.18 + (index % 6) * width * 0.12,
        height - 76,
        -160,
        degree.get(node.id),
        "outer",
        false
      ));
    });
    return { nodes: labelNetworkNodes(applyGraphManualOffsets(relaxNetworkNodes(positioned, width, height), width, height).sort((a, b) => a.z3 - b.z3)), focusId: focus?.id || "", cx: width * 0.25, cy, focused: true };
  }
  const maxDegree = Math.max(1, ...nodes.map((node) => degree.get(node.id) || 0));
  const sceneBuckets = [...new Set(nodes.map((node) => node.scene || node.profile?.domain || "其他").filter(Boolean))];
  const methodBuckets = [...new Set(nodes.map((node) => node.profile?.methodType || node.scene || "待核对").filter(Boolean))];
  nodes
    .sort((a, b) => (a.scene || "").localeCompare(b.scene || "", "zh-CN") || (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
    .forEach((node, index) => {
      const pos = semanticGraphPosition(node, index, nodes.length, {
        width,
        height,
        sceneBuckets,
        methodBuckets,
        degree: degree.get(node.id) || 0,
        maxDegree
      });
      const role = (degree.get(node.id) || 0) > maxDegree * 0.62 ? "related" : "outer";
      const evidenceOk = Number(node.doc?.evidenceCard?.confidence || 0) >= 0.7;
      const weak = isWeakNodeEvidence(node);
      positioned.push(networkProjectNode(
        node,
        pos.x,
        pos.y,
        pos.z3,
        degree.get(node.id),
        role,
        evidenceOk && !weak
      ));
    });
  return { nodes: labelNetworkNodes(applyGraphManualOffsets(relaxNetworkNodes(positioned, width, height), width, height).sort((a, b) => a.z3 - b.z3)), focusId: "", cx, cy, semantic: true };
}

function applyGraphManualOffsets(nodes, width, height) {
  const offsets = graphManualOffsetsForScope();
  return nodes.map((node) => {
    const offset = offsets[node.id];
    if (!offset) return node;
    const halfW = (node.labelWidth || node.w || node.r * 2 || 120) / 2 + 16;
    const halfH = (node.h || node.r * 2 || 80) / 2 + node.r + 24;
    return {
      ...node,
      x: Math.max(50 + halfW, Math.min(width - 50 - halfW, node.x + Number(offset.dx || 0))),
      y: Math.max(112 + halfH, Math.min(height - 42 - halfH, node.y + Number(offset.dy || 0))),
      manuallyMoved: true
    };
  });
}

function semanticGraphPosition(node, index, total, options) {
  const { width, height, sceneBuckets, methodBuckets, degree, maxDegree } = options;
  const sceneIndex = Math.max(0, sceneBuckets.indexOf(node.scene || node.profile?.domain || "其他"));
  const methodIndex = Math.max(0, methodBuckets.indexOf(node.profile?.methodType || node.scene || "待核对"));
  const xBase = 150 + (sceneIndex + 0.5) * ((width - 300) / Math.max(1, sceneBuckets.length));
  const methodOffset = ((methodIndex % 3) - 1) * 54;
  const confidence = Number(node.doc?.evidenceCard?.confidence || 0);
  const weakPenalty = isWeakNodeEvidence(node) ? 0.18 : 0;
  const evidenceScore = Math.max(0.05, Math.min(0.95, (confidence || 0.46) - weakPenalty));
  const yBase = height - 112 - evidenceScore * (height - 260);
  const spread = ((index % 4) - 1.5) * 22;
  const degreeScore = Math.max(0, Math.min(1, degree / Math.max(1, maxDegree)));
  return {
    x: xBase + methodOffset,
    y: yBase + spread,
    z3: -130 + degreeScore * 300
  };
}

function isWeakNodeEvidence(node = {}) {
  const card = node.doc?.evidenceCard || {};
  return [
    card.research_question,
    card.method,
    card.data_or_materials,
    ...((card.main_claims || []).slice(0, 2)),
    ...((card.evidence || []).slice(0, 2)),
    ...((card.limitations || []).slice(0, 2))
  ].some(isWeakAuditItem);
}

function labelNetworkNodes(nodes) {
  return nodes.map((node, index) => ({ ...node, indexLabel: String(index + 1) }));
}

function networkProjectNode(node, x, y, z3, degree = 0, role = "outer", related = false) {
  const scale = 0.9 + Math.max(-120, Math.min(180, z3)) / 900;
  const base = role === "center" ? 46 : role === "related" ? 38 : 30;
  const label = node.profile?.domain || node.scene || node.doc?.title || node.title || "文献";
  const w = role === "center" ? 156 : role === "related" ? 136 : 116;
  const h = role === "center" ? 82 : role === "related" ? 74 : 66;
  return {
    ...node,
    x,
    y,
    z3,
    role,
    related,
    labelWidth: Math.max(w, Math.min(role === "center" ? 190 : 150, String(label).length * 12 + 34)),
    r: Math.max(24, Math.min(52, (base + Math.min(8, Number(degree || 0) * 3)) * scale)),
    w,
    h,
    opacity: role === "outer" && state.graphCenterId ? 0.18 : role === "outer" ? 0.78 : 1
  };
}

function relaxNetworkNodes(nodes, width, height) {
  const padding = 76;
  const relaxed = nodes.map((node) => ({ ...node }));
  const rectFor = (node) => ({
    x: node.x - (node.labelWidth || node.w || 120) / 2 - 12,
    y: node.y - (node.h || 70) / 2 - 12,
    w: (node.labelWidth || node.w || 120) + 24,
    h: (node.h || 70) + 24
  });
  for (let pass = 0; pass < 90; pass += 1) {
    let moved = false;
    for (let i = 0; i < relaxed.length; i += 1) {
      for (let j = i + 1; j < relaxed.length; j += 1) {
        const a = relaxed[i];
        const b = relaxed[j];
        const ar = rectFor(a);
        const br = rectFor(b);
        const overlapX = Math.min(ar.x + ar.w, br.x + br.w) - Math.max(ar.x, br.x);
        const overlapY = Math.min(ar.y + ar.h, br.y + br.h) - Math.max(ar.y, br.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const dx = b.x - a.x || (j % 2 ? 1 : -1);
        const dy = b.y - a.y || (j % 3 ? 1 : -1);
        if (overlapX < overlapY) {
          const push = overlapX / 2 + 5;
          const dir = Math.sign(dx);
          a.x -= push * dir;
          b.x += push * dir;
        } else {
          const push = overlapY / 2 + 5;
          const dir = Math.sign(dy);
          a.y -= push * dir;
          b.y += push * dir;
        }
        moved = true;
      }
    }
    relaxed.forEach((node) => {
      const halfW = (node.labelWidth || node.w || 120) / 2 + 14;
      const halfH = (node.h || 70) / 2 + 14;
      node.x = Math.max(padding + halfW, Math.min(width - padding - halfW, node.x));
      node.y = Math.max(128 + halfH, Math.min(height - 72 - halfH, node.y));
    });
    if (!moved) break;
  }
  return relaxed;
}

function edgeWeightBetween(aId, bId, edges = []) {
  const edge = edges.find((item) => (
    (item.source === aId && item.target === bId) ||
    (item.source === bId && item.target === aId)
  ));
  return Number(edge?.weight || 0);
}

function graphNetworkBackdrop(width, height, layout) {
  const { cx, cy } = layout;
  if (layout.semantic) {
    const left = 118;
    const right = width - 118;
    const top = 146;
    const bottom = height - 112;
    const axisColor = "#94a3b8";
    const gridLines = Array.from({ length: 5 }, (_, index) => {
      const y = bottom - index * ((bottom - top) / 4);
      return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 8"></line>`;
    }).join("");
    const verticals = Array.from({ length: 6 }, (_, index) => {
      const x = left + index * ((right - left) / 5);
      return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="#eef2f7" stroke-width="1"></line>`;
    }).join("");
    return `
      <rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="8" fill="#ffffff" fill-opacity="0.55" stroke="#dbe4ef"></rect>
      ${gridLines}
      ${verticals}
      <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${axisColor}" stroke-width="1.6" marker-end="url(#networkArrow)"></line>
      <line x1="${left}" y1="${bottom}" x2="${left}" y2="${top}" stroke="${axisColor}" stroke-width="1.6" marker-end="url(#networkArrow)"></line>
      <line x1="${right - 130}" y1="${top + 72}" x2="${right - 34}" y2="${top + 18}" stroke="#64748b" stroke-width="1.4" marker-end="url(#networkArrow)" stroke-dasharray="6 6"></line>
      <text x="${(left + right) / 2}" y="${bottom + 34}" text-anchor="middle" fill="#475569" font-size="12" font-weight="900">X：问题域 / 方法谱系</text>
      <text x="${left - 70}" y="${(top + bottom) / 2}" text-anchor="middle" transform="rotate(-90 ${left - 70} ${(top + bottom) / 2})" fill="#475569" font-size="12" font-weight="900">Y：证据可用度</text>
      <text x="${right - 44}" y="${top + 14}" text-anchor="end" fill="#475569" font-size="12" font-weight="900">Z/大小：关系中心性</text>
      <text x="${left + 8}" y="${bottom - 10}" fill="#94a3b8" font-size="11">弱证据或缺原文</text>
      <text x="${left + 8}" y="${top + 18}" fill="#64748b" font-size="11">可直接进入综述的强证据</text>
    `;
  }
  if (layout.focused) {
    const center = layout.nodes.find((node) => node.id === layout.focusId);
    const centerSummary = center ? graphNodeFocusSummary(center, docById(center.id)) : "当前中心";
    const relatedCount = layout.nodes.filter((node) => node.role === "related").length;
    return `
      <rect x="24" y="72" width="${width - 48}" height="42" rx="8" fill="#eff6ff" stroke="#bfd4ef"></rect>
      <text x="42" y="98" fill="#285f9f" font-size="12" font-weight="900">已切到中心邻接视图：左边固定为当前论文，右边只显示直接相关论文；这不是重新生成新主题。</text>
      <line x1="${width * 0.39}" y1="126" x2="${width * 0.39}" y2="${height - 126}" stroke="#dbe4ef" stroke-width="1"></line>
      <text x="${width * 0.25}" y="126" text-anchor="middle" fill="#64748b" font-size="12" font-weight="800">当前中心论文</text>
      ${svgMultilineText(centerSummary, width * 0.25, 150, {
        maxChars: 18,
        maxLines: 2,
        color: "#285f9f",
        fontSize: 11,
        weight: 900
      })}
      <text x="${width * 0.66}" y="126" text-anchor="middle" fill="#64748b" font-size="12" font-weight="800">直接相关文献 ${relatedCount}</text>
      <text x="${width * 0.66}" y="148" text-anchor="middle" fill="#94a3b8" font-size="11">按关系强度和证据状态排序</text>
      <text x="${width * 0.5}" y="${height - 46}" text-anchor="middle" fill="#94a3b8" font-size="11">弱相关主题会收到底部，避免遮住当前分析对象</text>
    `;
  }
  const scenes = [...new Set(layout.nodes.map((node) => node.scene).filter(Boolean))].slice(0, 8);
  const axes = scenes.map((scene, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(1, scenes.length));
    const x = cx + Math.cos(angle) * Math.min(610, width * 0.41);
    const y = cy + Math.sin(angle) * Math.min(300, height * 0.34);
    return `
      <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="5 9" opacity="0.62"></line>
    `;
  }).join("");
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${Math.min(600, width * 0.41)}" ry="${Math.min(290, height * 0.33)}" fill="none" stroke="#dbe4ef" stroke-width="1" stroke-dasharray="9 11"></ellipse>
    <ellipse cx="${cx}" cy="${cy}" rx="${Math.min(430, width * 0.3)}" ry="${Math.min(205, height * 0.24)}" fill="none" stroke="#e2e8f0" stroke-width="1"></ellipse>
    ${axes}
  `;
}

function graph3dNetworkDefs() {
  return `
    <defs>
      <filter id="softShadow" x="-35%" y="-35%" width="170%" height="170%">
        <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#0f172a" flood-opacity="0.13"></feDropShadow>
      </filter>
      <marker id="networkArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L8,4 L0,8 Z" fill="#64748b"></path>
      </marker>
    </defs>
  `;
}

function graph3dNetworkLegend(width) {
  const items = [
    ["支持/问题", "#0f766e"],
    ["扩展/方法", "#285f9f"],
    ["证据比较", "#b7791f"],
    ["冲突/边界", "#b42318"],
    ["研究空白", "#7c3aed"]
  ];
  return `
    <g class="network-legend" opacity="0.9">
      ${items.map(([label, color], index) => {
        const x = width - 520 + index * 96;
        return `<line x1="${x}" y1="54" x2="${x + 20}" y2="54" stroke="${color}" stroke-width="4" stroke-linecap="round"></line><text x="${x + 27}" y="58" fill="#64748b" font-size="11" font-weight="700">${label}</text>`;
      }).join("")}
    </g>
  `;
}

function svg3dNetworkEdge(edge, byId) {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return "";
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  const focusRelated = state.graphCenterId && (edge.source === state.graphCenterId || edge.target === state.graphCenterId);
  const color = relationColor(edge.relation || edge.relationKind || "");
  const width = selected ? 4.8 : Math.max(0.9, Math.min(2.4, Number(edge.weight || 0.5) * 2.1));
  const opacity = selected ? 0.96 : focusRelated ? 0.55 : !state.graphCenterId ? 0.28 : 0.06;
  const path = networkEdgePath(a, b);
  return `
    <g class="svg-edge svg-3d-edge network-edge ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
      <path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round"></path>
    </g>
  `;
}

function networkEdgePath(a, b) {
  const start = nodeEdgePort(a, b);
  const end = nodeEdgePort(b, a);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const nx = -dy / distance;
  const ny = dx / distance;
  const depth = ((a.z3 || 0) + (b.z3 || 0)) / 2;
  const bow = Math.max(-90, Math.min(90, depth * 0.28));
  return `M ${start.x} ${start.y} Q ${(start.x + end.x) / 2 + nx * bow} ${(start.y + end.y) / 2 + ny * bow} ${end.x} ${end.y}`;
}

function nodeEdgePort(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const halfW = (from.w || from.r * 2 || 120) / 2;
  const halfH = (from.h || from.r * 2 || 80) / 2;
  if (Math.abs(dx) * halfH > Math.abs(dy) * halfW) {
    return {
      x: from.x + Math.sign(dx || 1) * halfW,
      y: from.y + dy / Math.max(1, Math.abs(dx)) * halfW
    };
  }
  return {
    x: from.x + dx / Math.max(1, Math.abs(dy)) * halfH,
    y: from.y + Math.sign(dy || 1) * halfH
  };
}

function svg3dNetworkEdgeLabel(edge, byId, index = 0) {
  const a = byId.get(edge.source);
  const b = byId.get(edge.target);
  if (!a || !b) return "";
  const id = graphEdgeId(edge);
  const selected = id === state.selectedGraphEdgeId;
  if (!selected) return "";
  const color = relationColor(edge.relation || edge.relationKind || "");
  const label = graph3dRelationLabel(edge, a, b);
  const lines = splitSvgText(label, 34, 3);
  const x = (a.x + b.x) / 2;
  const y = (a.y + b.y) / 2 - 26 + ((index % 3) - 1) * 18;
  const w = 330;
  const h = 72;
  return `
    <g class="svg-edge-label-hit network-edge-label ${selected ? "selected" : ""}" data-edge-id="${escapeHtml(id)}">
      <rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="6" fill="#ffffff" stroke="${color}" stroke-width="1.8" opacity="0.97"></rect>
      ${svgMultilineText(label, x, y + 2, {
        lines,
        color,
        fontSize: 12,
        weight: 900,
        className: "svg-3d-edge-label"
      })}
    </g>
  `;
}

function edgeTypeLabel(edge = {}) {
  const text = `${edge.relation || ""} ${edge.relationKind || ""}`;
  if (/问题|same_problem|problem/.test(text)) return "共同问题";
  if (/方法|迁移|扩展|method|extend|application/.test(text)) return "方法扩展";
  if (/证据|support|evidence/.test(text)) return "证据关系";
  if (/边界|风险|不能|冲突|contrast|limit/.test(text)) return "边界/冲突";
  if (/空白|gap/.test(text)) return "研究空白";
  return shortTitle(edge.relation || "关系", 10);
}

function svg3dNetworkNode(node) {
  const profile = node.profile || {};
  const selected = node.id === state.graphCenterId;
  const accent = relationColor(node.scene || profile.domain || "");
  const title = node.doc?.title || node.title || profile.title || "文献";
  const theme = profile.domain || node.scene || "主题待核对";
  const label = `文献 ${node.indexLabel || ""}`;
  const sub = `标签：${shortTitle(theme, 12)}`;
  const chipW = Math.max(96, Math.min(node.labelWidth || 148, Math.max(label.length * 12 + 32, sub.length * 10 + 28)));
  const chipH = node.role === "outer" ? 28 : 46;
  const chipX = node.x - chipW / 2;
  const chipY = node.y + node.r + 8;
  const halo = selected ? 12 : node.role === "center" ? 8 : 0;
  return `
    <g class="svg-node svg-3d-node network-node ${selected ? "center" : ""} ${node.manuallyMoved ? "manual-position" : ""}" data-doc-id="${escapeHtml(node.id)}" opacity="${node.opacity}">
      <title>文献：${escapeHtml(title)}&#10;主题标签：${escapeHtml(theme)}&#10;${escapeHtml(graphNodeFocusSummary(node, node.doc || {}))}</title>
      ${halo ? `<circle class="network-focus-ring" cx="${node.x}" cy="${node.y}" r="${node.r + halo}" fill="${selected ? accent : "none"}" fill-opacity="${selected ? 0.06 : 0}" stroke="${accent}" stroke-width="${selected ? 2 : 1.3}" stroke-opacity="${selected ? 0.48 : 0.26}"></circle>` : ""}
      <circle cx="${node.x}" cy="${node.y}" r="${node.r}" fill="#ffffff" stroke="${selected ? accent : "#cbd5e1"}" stroke-width="${selected ? 2.6 : 1.5}" filter="url(#softShadow)"></circle>
      <circle cx="${node.x}" cy="${node.y}" r="${Math.max(7, node.r * 0.38)}" fill="${accent}" fill-opacity="${selected ? 0.95 : 0.72}"></circle>
      <text x="${node.x}" y="${node.y + 4}" text-anchor="middle" fill="#ffffff" font-size="${node.role === "outer" ? 10 : 11}" font-weight="900">${escapeHtml(String(node.indexLabel || "").slice(0, 2) || "●")}</text>
      <rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="6" fill="#ffffff" stroke="${accent}" stroke-width="1" stroke-opacity="0.38"></rect>
      <text x="${node.x}" y="${chipY + 18}" text-anchor="middle" fill="#0f172a" font-size="${node.role === "outer" ? 10 : 11}" font-weight="900">${escapeHtml(label)}</text>
      <text x="${node.x}" y="${chipY + 34}" text-anchor="middle" fill="#64748b" font-size="10" font-weight="700">${escapeHtml(sub)}</text>
    </g>
  `;
}

function svg3dNodeDetails(node) {
  if (node.role !== "center" && !(node.id === state.graphCenterId)) return "";
  const profile = node.profile || {};
  const rows = nodeInfoRows(node, profile).slice(1);
  const accent = relationColor(node.scene || profile.domain || "");
  const cardW = 142;
  const cardH = 58;
  const gap = 10;
  const totalW = cardW * 2 + gap;
  const startX = node.x - totalW / 2;
  const startY = node.y + node.h / 2 + 18;
  return `
    <g class="network-detail-modules" pointer-events="none">
      ${rows.slice(0, 4).map((row, index) => {
        const col = index % 2;
        const r = Math.floor(index / 2);
        const x = startX + col * (cardW + gap);
        const y = startY + r * (cardH + gap);
        return `
          <g class="network-detail-module">
            <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="7" fill="#ffffff" stroke="${accent}" stroke-width="1" stroke-opacity="0.28"></rect>
            <text x="${x + 10}" y="${y + 18}" fill="${accent}" font-size="10" font-weight="900">${escapeHtml(row.label)}</text>
            ${svgMultilineText(row.text, x + 10, y + 38, {
              anchor: "start",
              maxChars: 15,
              maxLines: 2,
              color: "#475569",
              fontSize: 10,
              weight: 700,
              lineGap: 2,
              className: "network-detail-text"
            })}
          </g>
        `;
      }).join("")}
    </g>
  `;
}

function nodeInfoRows(node, profile = {}) {
  const doc = node.doc || {};
  const card = doc.evidenceCard || {};
  return [
    ["主题", profile.domain || node.scene || ""],
    ["问题", profile.problemType || card.research_question?.normalized_claim || card.research_question?.claim || ""],
    ["方法", profile.methodType || card.method?.normalized_claim || card.method?.claim || ""],
    ["证据", profile.evidenceType || card.evidence?.[0]?.normalized_claim || card.evidence?.[0]?.claim || ""],
    ["边界", profile.riskType || card.limitations?.[0]?.normalized_claim || card.limitations?.[0]?.claim || ""]
  ].map(([label, text]) => ({ label, text: completeUiText(text || "待核对") }));
}

function svgNodeInfoRow(row, x, y, maxWidth, accent) {
  const labelW = 32;
  const text = shortTitle(row.text, Math.max(10, Math.floor((maxWidth - labelW - 8) / 9)));
  return `
    <text x="${x}" y="${y}" fill="${accent}" font-size="10" font-weight="900">${escapeHtml(row.label)}</text>
    <text x="${x + labelW + 5}" y="${y}" fill="#475569" font-size="10" font-weight="700">${escapeHtml(text)}</text>
  `;
}

function drawGraphCanvasFallback() {
  if (state.docFlow) return drawDocFlow();
  const canvas = els.canvas;
  const rect = (els.graphWrap || canvas).getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1040, Math.floor(rect.width || 1100));
  const layoutProbe = layoutGraph(cssWidth, Math.max(560, Math.floor(rect.height || 720)));
  const cssHeight = Math.max(560, layoutProbe.contentHeight || Math.floor(rect.height || 720));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);

  if (!state.graph.nodes.length) {
    ctx.fillStyle = "#64748b";
    ctx.font = "15px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("上传资料后生成研究脉络图", width / 2, height / 2);
    return;
  }

  const { nodes, byId, lanes, laneWidth, laneGap, padding, top } = layoutGraph(width, height);

  ctx.fillStyle = "#0f172a";
  ctx.font = "600 16px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("二维证据泳道图", 26, 32);
  ctx.fillStyle = "#64748b";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText("按主题泳道组织文献卡，用于横向审计；三维图只负责关系网络。", 26, 56);
  drawLegend(ctx, width);

  lanes.forEach(([scene], index) => {
    const x = padding + index * (laneWidth + laneGap);
    roundRect(ctx, x, 82, laneWidth, height - 108, 10);
    ctx.fillStyle = index % 2 ? "#ffffff" : "#f3f7fb";
    ctx.fill();
    ctx.strokeStyle = "#dde5ef";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#334155";
    ctx.font = "600 13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fitText(ctx, scene, laneWidth - 24), x + laneWidth / 2, 108);
  });

  const edgeLabels = [];
  for (const edge of state.graph.edges.slice(0, 18)) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const color = relationColor(edge.relation);
    const alpha = Math.min(0.58, 0.2 + edge.weight * 0.42);
    ctx.strokeStyle = hexToRgba(color, alpha);
    ctx.lineWidth = Math.max(1.2, Math.min(2.6, edge.weight * 3.2));
    const curve = graphEdgeCurve(a, b);
    drawSegmentedBezier(ctx, curve, nodes);
    edgeLabels.push({ edge, a, b, curve, color });
  }

  for (const node of nodes) {
    const doc = node.doc || {};
    const profile = node.profile || {};
    const accent = relationColor(node.lane);
    const left = node.x - node.w / 2;
    const topY = node.y - node.h / 2;
    const textX = left + 22;
    const textWidth = node.w - 34;
    roundRect(ctx, node.x - node.w / 2, node.y - node.h / 2, node.w, node.h, 8);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.fillStyle = accent || "#285f9f";
    ctx.fillRect(left, topY + 1, 5, node.h - 2);
    ctx.fillStyle = "#0f172a";
    ctx.font = "600 12px Inter, sans-serif";
    ctx.textAlign = "left";
    wrapText(ctx, profile.domain || "待核对领域", textX, topY + 22, textWidth, 15, 2);
    ctx.fillStyle = "#475569";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText(fitText(ctx, profile.problemType || "待核对问题", textWidth), textX, node.y + node.h / 2 - 42);
    ctx.fillStyle = "#64748b";
    ctx.fillText(fitText(ctx, profile.methodType || "待核对方法", textWidth), textX, node.y + node.h / 2 - 25);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px Inter, sans-serif";
    ctx.fillText(fitText(ctx, profile.evidenceType || "待核对证据", textWidth), textX, node.y + node.h / 2 - 8);
    roundRect(ctx, left, topY, node.w, node.h, 8);
    ctx.strokeStyle = "#cfd8e3";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  ctx.strokeStyle = "#d8e0ea";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(26, top - 18);
  ctx.lineTo(width - 26, top - 18);
  ctx.stroke();

  drawGraphEdgeLabels(ctx, edgeLabels, nodes, width, height);
}

function graphEdgeCurve(a, b) {
  const startX = a.x + (a.x < b.x ? a.w / 2 : -a.w / 2);
  const endX = b.x + (a.x < b.x ? -b.w / 2 : b.w / 2);
  const startY = a.y;
  const endY = b.y;
  const curve = Math.max(34, Math.abs(endX - startX) * 0.35);
  const direction = Math.sign(endX - startX || 1);
  return {
    p0: { x: startX, y: startY },
    p1: { x: startX + direction * curve, y: startY },
    p2: { x: endX - direction * curve, y: endY },
    p3: { x: endX, y: endY }
  };
}

function bezierPoint(curve, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * curve.p0.x + 3 * uu * t * curve.p1.x + 3 * u * tt * curve.p2.x + ttt * curve.p3.x,
    y: uuu * curve.p0.y + 3 * uu * t * curve.p1.y + 3 * u * tt * curve.p2.y + ttt * curve.p3.y
  };
}

function pointInGraphNode(point, nodes) {
  return nodes.some((node) => (
    point.x > node.x - node.w / 2 - 2 &&
    point.x < node.x + node.w / 2 + 2 &&
    point.y > node.y - node.h / 2 - 2 &&
    point.y < node.y + node.h / 2 + 2
  ));
}

function drawSegmentedBezier(ctx, curve, nodes) {
  const steps = 72;
  let drawing = false;
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const point = bezierPoint(curve, i / steps);
    if (pointInGraphNode(point, nodes)) {
      drawing = false;
      continue;
    }
    if (!drawing) {
      ctx.moveTo(point.x, point.y);
      drawing = true;
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.stroke();
}

function drawGraphEdgeLabels(ctx, edgeLabels, nodes, width, height) {
  const occupied = nodes.map((node) => ({
    x: node.x - node.w / 2 - 8,
    y: node.y - node.h / 2 - 8,
    w: node.w + 16,
    h: node.h + 16
  }));
  const sorted = [...edgeLabels].sort((left, right) => (right.edge.weight || 0) - (left.edge.weight || 0));
  for (const item of sorted) {
    const rect = drawEdgeLabel(ctx, item.edge, item.a, item.b, item.curve, item.color, occupied, width, height);
    if (rect) occupied.push({ x: rect.x - 4, y: rect.y - 4, w: rect.w + 8, h: rect.h + 8 });
  }
}

function drawEdgeLabel(ctx, edge, a, b, curve, color, occupied = [], canvasWidth = 1100, canvasHeight = 720) {
  const label = edgeLineLabel(edge, a, b);
  if (!label) return null;
  ctx.save();
  ctx.font = "700 11px Inter, sans-serif";
  const paddingX = 7;
  const displayLabel = fitText(ctx, label, 244);
  const labelWidth = Math.min(260, ctx.measureText(displayLabel).width + paddingX * 2);
  const labelHeight = 23;
  const placement = edgeLabelPlacement(curve, labelWidth, labelHeight, occupied, canvasWidth, canvasHeight);
  if (!placement) {
    ctx.restore();
    return null;
  }
  const x = placement.x;
  const y = placement.y;
  roundRect(ctx, x, y, labelWidth, labelHeight, 999);
  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.42);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(displayLabel, x + labelWidth / 2, y + labelHeight / 2 + 0.5);
  ctx.restore();
  return { x, y, w: labelWidth, h: labelHeight };
}

function edgeLabelPlacement(curve, labelWidth, labelHeight, occupied, canvasWidth, canvasHeight) {
  const center = bezierPoint(curve, 0.5);
  const before = bezierPoint(curve, 0.45);
  const after = bezierPoint(curve, 0.55);
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const length = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / length, y: dx / length };
  const candidates = [];
  for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
    const base = bezierPoint(curve, t);
    for (const offset of [0, 24, -24, 46, -46, 68, -68]) {
      candidates.push({
        x: base.x + normal.x * offset - labelWidth / 2,
        y: base.y + normal.y * offset - labelHeight / 2
      });
    }
  }
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const rect = clampRect(candidate, labelWidth, labelHeight, canvasWidth, canvasHeight);
    const collisions = occupied.filter((item) => rectsOverlap(rect, item)).length;
    if (collisions) continue;
    const distance = Math.hypot(rect.x + labelWidth / 2 - center.x, rect.y + labelHeight / 2 - center.y);
    const edgePenalty = rect.y < 76 ? 80 : 0;
    const score = distance + edgePenalty;
    if (score < bestScore) {
      best = rect;
      bestScore = score;
      if (distance < 8) break;
    }
  }
  return best;
}

function clampRect(point, w, h, canvasWidth, canvasHeight) {
  return {
    x: Math.max(18, Math.min(canvasWidth - w - 18, point.x)),
    y: Math.max(76, Math.min(canvasHeight - h - 18, point.y)),
    w,
    h
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function edgeLineLabel(edge, a = {}, b = {}) {
  const relation = String(edge.relation || "");
  if (/问题延续/.test(relation)) return "问题定义推出后续深化";
  if (/方法迁移/.test(relation)) return "方法链条迁移到新对象";
  if (/证据补强/.test(relation)) return "实验证据补强框架判断";
  if (/证据类型不同/.test(relation)) return "同类证据需要分场景比较";
  if (/边界约束/.test(relation)) return "局限条件限制结论外推";
  if (/共同研究空白/.test(relation)) return "共同缺口推出新问题";
  if (/应用扩展/.test(relation)) return "通用方法扩展到应用场景";
  if (/不能强行合并/.test(relation)) return "证据链不同不能合并";
  if (/跨场景迁移/.test(relation)) return "方法框架推出场景应用";
  if (/技术方法与应用场景/.test(relation)) return "方法能力推出场景检验";
  if (/同一问题域|共同问题/.test(relation)) return "共同问题推出方法比较";
  if (/证据类型/.test(relation)) return "证据结构支撑横向比较";
  if (/边界|风险/.test(relation)) return "证据结论推出边界约束";
  if (/概念/.test(relation)) return "共享概念需要证据复核";
  const from = a.profile?.problemType || "问题";
  const to = b.profile?.methodType || "方法";
  return `${from}推出${to}`;
}

function drawDocFlow() {
  const canvas = els.canvas;
  const rect = (els.graphWrap || canvas).getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1040, Math.floor(rect.width || 1100));
  const layout = layoutDocFlowLayered(cssWidth);
  const cssHeight = layout.height;
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.floor(layout.width * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, layout.width, cssHeight);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, layout.width, cssHeight);

  ctx.fillStyle = "#0f172a";
  ctx.font = "600 16px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("单篇结构图", 26, 32);
  ctx.fillStyle = "#64748b";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(fitText(ctx, state.docFlow.title || "当前资料", layout.width - 52), 26, 56);

  const positions = new Map();
  layout.positioned.forEach((node) => {
    positions.set(node.id, {
      x: node.x - node.w / 2,
      y: node.y - node.h / 2,
      cx: node.x,
      cy: node.y,
      w: node.w,
      h: node.h,
      rowIndex: node.rowIndex,
      colIndex: node.colIndex
    });
  });

  for (const [index, edge] of (state.docFlow.edges || []).entries()) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const points = canvasDocFlowEdgePoints(a, b, index);
    ctx.strokeStyle = graphEdgeId(edge) === state.selectedGraphEdgeId ? "rgba(29, 78, 216, 0.85)" : "rgba(40, 95, 159, 0.34)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    points.forEach((point, pointIndex) => {
      if (pointIndex === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    const tail = points[points.length - 2];
    const head = points[points.length - 1];
    drawArrow(ctx, tail.x, tail.y, head.x, head.y);
  }

  const palette = ["#285f9f", "#0f766e", "#b7791f", "#7c3aed", "#b42318", "#475569"];
  layout.positioned.forEach((node, index) => {
    const pos = positions.get(node.id);
    const accent = palette[index % palette.length];
    roundRect(ctx, pos.x, pos.y, pos.w, pos.h, 9);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#ccd6e2";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(pos.x, pos.y, 5, pos.h);

    ctx.fillStyle = accent;
    ctx.font = "700 13px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(node.title || "结构节点", pos.x + 16, pos.y + 24);
    ctx.fillStyle = "#64748b";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText(node.citation || "来源片段", pos.x + pos.w - 58, pos.y + 24);
    ctx.fillStyle = "#1f2937";
    ctx.font = "12px Inter, sans-serif";
    const summaryLines = node.summaryLines || flowNodeSummaryLines(node);
    summaryLines.forEach((line, lineIndex) => {
      ctx.fillText(fitText(ctx, line, pos.w - 32), pos.x + 16, pos.y + 48 + lineIndex * 16);
    });
  });
}

function canvasDocFlowEdgePoints(a, b, index = 0) {
  if (a.rowIndex === b.rowIndex) {
    const sx = a.x + a.w;
    const sy = a.y + a.h / 2;
    const ex = b.x;
    const ey = b.y + b.h / 2;
    const mx = sx + (ex - sx) / 2 + ((index % 3) - 1) * 4;
    return [{ x: sx, y: sy }, { x: mx, y: sy }, { x: mx, y: ey }, { x: ex, y: ey }];
  }
  const sx = a.x + a.w / 2;
  const sy = a.y + a.h;
  const ex = b.x + b.w / 2;
  const ey = b.y;
  const laneY = sy + Math.max(28, (ey - sy) / 2) + (index % 3) * 3;
  return [{ x: sx, y: sy }, { x: sx, y: laneY }, { x: ex, y: laneY }, { x: ex, y: ey }];
}

function drawArrow(ctx, ax, ay, bx, by) {
  const angle = Math.atan2(by - ay, bx - ax);
  const size = 7;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size / 2);
  ctx.lineTo(-size, size / 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(40, 95, 159, 0.55)";
  ctx.fill();
  ctx.restore();
}

function drawLegend(ctx, width) {
  const items = [
    ["扩展/能力", "#285f9f"],
    ["可信/溯源", "#0f766e"],
    ["评估/对比", "#b7791f"],
    ["风险/约束", "#b42318"]
  ];
  let x = Math.max(26, width - 398);
  ctx.textAlign = "left";
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(x, 20, 16, 4);
    ctx.fillStyle = "#64748b";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText(label, x + 22, 26);
    x += 88;
  }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 4) {
  const words = Array.from(String(text || ""));
  let line = "";
  let lineCount = 0;
  for (const word of words) {
    const test = line ? `${line}${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lineCount += 1;
      ctx.fillText(lineCount === maxLines ? fitText(ctx, line, maxWidth) : line, x, y);
      if (lineCount >= maxLines) return y;
      line = word;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(fitText(ctx, line, maxWidth), x, y);
  return y;
}

function fitText(ctx, text, maxWidth) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean || ctx.measureText(clean).width <= maxWidth) return clean;
  let clipped = clean;
  while (clipped.length > 1 && ctx.measureText(clipped).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return clipped.replace(/[，。；、:：-]+$/, "");
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const int = parseInt(value, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function renderFilePickerHint() {
  if (!els.filePickerHint) return;
  const files = [...(els.fileInput.files || [])];
  els.filePickerHint.textContent = files.length > 1
    ? `已选择 ${files.length} 个文件`
    : files[0]?.name || "PDF / PPTX，可批量";
}

els.fileInput.addEventListener("change", renderFilePickerHint);

els.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!els.fileInput.files.length) return setStatus("请选择 PDF 或 PPTX 文件。");
  const files = [...els.fileInput.files];
  const invalid = files.map(uploadFileIssue).filter(Boolean);
  if (invalid.length) {
    els.fileInput.value = "";
    renderFilePickerHint();
    return setStatus(invalid[0]);
  }
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  setStatus("正在把文件加入后台解析队列。");
  els.uploadForm.querySelector("button").disabled = true;
  try {
    const data = await api("/api/upload", { method: "POST", body: form });
    const queuedCount = data.jobs?.length || 0;
    const skippedCount = data.skipped?.length || 0;
    const parts = [];
    if (queuedCount) parts.push(`${queuedCount} 份资料已进入后台队列`);
    if (skippedCount) parts.push(`跳过 ${skippedCount} 份重复或无效文件`);
    setStatus(parts.join("；") || "没有可解析的新文件。");
    els.fileInput.value = "";
    renderFilePickerHint();
    await refreshUploadJobs();
  } catch (error) {
    setStatus(error.message);
  } finally {
    els.uploadForm.querySelector("button").disabled = false;
  }
});

els.uploadJobs?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-job-action][data-job-id]");
  if (!button) return;
  const jobId = button.dataset.jobId;
  button.disabled = true;
  try {
    if (button.dataset.jobAction === "retry") {
      await api(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
      setStatus("任务已重新加入解析队列。");
    } else {
      await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      setStatus("正在取消解析任务。");
    }
    await refreshUploadJobs();
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
  }
});

els.askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = els.question.value.trim();
  if (!question) return;
  await answerQuestion(question);
});

els.generateJournalReview.addEventListener("click", async () => {
  if (!state.docs.length) return setStatus("请先上传 PDF 或 PPTX。");
  const selectedForReview = state.selectedDocIds.length > 1;
  const body = selectedForReview || state.activeDocId === "selection"
    ? { docIds: state.selectedDocIds }
    : { docId: state.activeDocId };
  body.topic = els.reviewTopic?.value?.trim() || "";
  body.structure = els.reviewStructure?.value || "topic";
  body.wordCount = Number(els.reviewWordCount?.value || 3000);
  body.citationFormat = els.reviewCitationFormat?.value || "gbt";
  body.keepAuditMarkers = Boolean(els.reviewKeepAudit?.checked);
  els.generateJournalReview.disabled = true;
  const previous = els.generateJournalReview.textContent;
  els.generateJournalReview.textContent = "生成中";
  setStatus("正在按期刊综述结构重组证据。");
  try {
    const data = await api("/api/review/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    state.journalReview = data.review || "";
    state.journalReviewVariants = Array.isArray(data.variants) ? data.variants : [];
    state.activeJournalVariantIndex = 0;
    els.journalReview.innerHTML = renderJournalReviewPanel("没有生成期刊综述。");
    setStatus(`已生成 ${data.scopedCount || 0} 篇资料的期刊综述${state.journalReviewVariants.length > 1 ? `；已拆分为 ${state.journalReviewVariants.length} 个主题版本。` : "。"}`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    els.generateJournalReview.disabled = false;
    els.generateJournalReview.textContent = previous;
  }
});

els.journalReview?.addEventListener("change", (event) => {
  const select = event.target.closest("#journalVariantSelect");
  if (!select) return;
  state.activeJournalVariantIndex = Number(select.value || 0);
  els.journalReview.innerHTML = renderJournalReviewPanel("没有生成期刊综述。");
});

async function answerQuestion(question) {
  els.answer.classList.remove("empty");
  els.answer.textContent = state.activeDocId === "all" || state.activeDocId === "selection"
    ? "正在跨资料检索、对比和综合。"
    : "正在当前资料内检索和回答。";
  const body = state.activeDocId === "selection"
    ? { question, docIds: state.selectedDocIds }
    : { question, docId: state.activeDocId };
  try {
    const data = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    state.lastAnswer = { question, data, text: answerToText(question, data) };
    els.answer.innerHTML = renderAnswer(data);
  } catch (error) {
    els.answer.textContent = error.message;
  }
}

function answerToText(question, data) {
  const lines = [
    `问题：${question}`,
    "",
    data.llmEnhanced ? "模型增强回答" : "本地综合回答",
    cleanUiText(data.answer || ""),
    ""
  ];
  if (data.claims?.length) {
    lines.push("判断依据");
    data.claims.forEach((claim, index) => {
      lines.push(`${index + 1}. ${cleanUiText(claim.text || "")} ${claim.type || "综合推断"} ${(claim.citations || []).join(" ")}`.trim());
    });
    lines.push("");
  }
  if (data.consensus?.length) {
    lines.push("共识", ...data.consensus.map((item) => `- ${cleanUiText(item)}`), "");
  }
  if (data.disagreements?.length) {
    lines.push("分歧", ...data.disagreements.map((item) => `- ${cleanUiText(item)}`), "");
  }
  if (data.uncertainty) lines.push(`不确定性：${cleanUiText(data.uncertainty)}`, "");
  if (data.comparison?.length) {
    lines.push("来源证据");
    data.comparison.forEach((item) => {
      lines.push(`${item.source || ""} ${cleanUiText(item.title || "")}`.trim());
      lines.push(`原文证据：${cleanUiText(item.view || "")}`);
      lines.push(`补充依据：${cleanUiText(item.differsBy || "")}`);
      lines.push("");
    });
  }
  return lines.join("\n").trim();
}

function renderAnswer(data) {
  const direct = cleanUiText(data.directConclusion || data.answer || "");
  const claims = (data.claims || []).map((claim) => `
    <div class="claim-row">
      <div class="claim-text">${escapeHtml(cleanUiText(claim.text || ""))}</div>
      <div class="claim-meta">${escapeHtml(claim.type || "综合推断")} ${escapeHtml((claim.citations || []).join(" "))}</div>
    </div>
  `).join("");
  const consensus = (data.consensus || []).map((item) => `<li>${escapeHtml(cleanUiText(item))}</li>`).join("");
  const disagreements = (data.disagreements || []).map((item) => `<li>${escapeHtml(cleanUiText(item))}</li>`).join("");
  const evidenceStrength = (data.evidenceStrength || []).map((item) => `<li>${escapeHtml(cleanUiText(item))}</li>`).join("");
  const cannotInfer = (data.cannotInfer || []).map((item) => `<li>${escapeHtml(cleanUiText(item))}</li>`).join("");
  const stanceItems = (data.stanceMatrix?.length ? data.stanceMatrix : data.stances) || [];
  const stances = stanceItems.map((item) => `
    <div class="stance-row">
      <div class="source-title">${escapeHtml(item.source || "")} ${escapeHtml(item.title || "")}</div>
      <div><b>立场</b>${escapeHtml(friendlyText(item.stance || ""))}</div>
      ${item.supportingEvidence || item.evidence ? `<div><b>证据</b>${escapeHtml(friendlyText(item.supportingEvidence || item.evidence))}</div>` : ""}
      ${item.sameAs?.length ? `<div><b>相同</b>${escapeHtml(item.sameAs.map(cleanUiText).join("、"))}</div>` : ""}
      ${item.differentFrom?.length ? `<div><b>不同</b>${escapeHtml(item.differentFrom.map(cleanUiText).join("、"))}</div>` : ""}
      ${item.canInfer ? `<div><b>可推出</b>${escapeHtml(friendlyText(item.canInfer))}</div>` : ""}
      ${item.cannotInfer || item.limitation ? `<div><b>不可推出</b>${escapeHtml(friendlyText(item.cannotInfer || item.limitation))}</div>` : ""}
    </div>
  `).join("");
  const comparisons = (data.comparison || []).map((item) => `
    <div class="source">
      <div class="source-title">${escapeHtml(item.source)} ${escapeHtml(cleanUiText(item.title))}</div>
      <div><b>定位证据</b>${escapeHtml(cleanUiText(item.view))}</div>
      <div><b>补充证据</b>${escapeHtml(cleanUiText(item.differsBy))}</div>
    </div>
  `).join("");
  const weakFields = renderAnswerWeakFields(data.sources || []);
  const matrix = renderAnswerEvidenceMatrix(data.sources || []);
  return `
    <div class="answer-section answer-main">
      <div class="answer-label">直接结论</div>
      <div class="answer-text">${escapeHtml(direct)}</div>
    </div>
    ${data.answer && cleanUiText(data.answer) !== direct ? `<div class="answer-section"><div class="answer-label">${data.llmEnhanced ? "模型增强论证" : "本地论证展开"}</div><div class="answer-text">${escapeHtml(cleanUiText(data.answer))}</div></div>` : ""}
    ${claims ? `<div class="answer-section"><div class="answer-label">判断依据</div>${claims}</div>` : ""}
    ${consensus ? `<div class="answer-section"><div class="answer-label">共识</div><ul>${consensus}</ul></div>` : ""}
    ${disagreements ? `<div class="answer-section"><div class="answer-label">分歧</div><ul>${disagreements}</ul></div>` : ""}
    ${evidenceStrength ? `<div class="answer-section"><div class="answer-label">证据强弱</div><ul>${evidenceStrength}</ul></div>` : ""}
    ${stances ? `<div class="answer-section"><div class="answer-label">每篇文献的立场</div><div class="stance-list">${stances}</div></div>` : ""}
    ${cannotInfer ? `<div class="answer-section cannot-infer"><div class="answer-label">哪些结论不能推出</div><ul>${cannotInfer}</ul></div>` : ""}
    ${weakFields}
    ${matrix}
    ${data.uncertainty ? `<div class="warning">不确定性：${escapeHtml(cleanUiText(data.uncertainty))}</div>` : ""}
    ${comparisons ? `
      <details class="answer-section evidence-layer">
        <summary>来源证据 <span>${(data.comparison || []).length} 条，点击展开</span></summary>
        <div class="source-list">${comparisons}</div>
      </details>
    ` : ""}
  `;
}

function renderAnswerWeakFields(sources) {
  const fields = sources.flatMap((source) => (source.weakFields || []).map((field) => ({ source, field })));
  if (!fields.length) return "";
  const cards = fields.slice(0, 8).map(({ source, field }) => `
    <div class="weak-field-card">
      <div class="weak-field-head">
        <b>${escapeHtml(source.marker || "")}</b>
        <span>${escapeHtml(field.dimension || "证据字段")}</span>
        <em>${escapeHtml(auditLabel(field.audit || field.dimension_audit || field.dimensionAudit || "needs_review"))}</em>
      </div>
      <p>${escapeHtml(friendlyText(field.claim || field.reason || field.text || "该字段缺少足够原文绑定，正式引用前需要核对。"))}</p>
      <small>${escapeHtml(friendlyText(source.title || ""))}</small>
    </div>
  `).join("");
  return `
    <section class="answer-section weak-field-section">
      <div class="answer-label">待核对证据字段</div>
      <div class="weak-field-list">${cards}</div>
    </section>
  `;
}

function renderAnswerEvidenceMatrix(sources) {
  const allRows = sources.flatMap((source) => (source.matrix || []).map((row) => ({ source, row })));
  const priority = (item) => isWeakAuditItem(item.row) ? 0 : 1;
  const rows = [...allRows].sort((a, b) => priority(a) - priority(b)).slice(0, 4);
  if (!rows.length) return "";
  const renderRows = (items) => items.map(({ source, row }) => `
    <tr class="${auditClass(row.audit)}">
      <td>${escapeHtml(source.marker || "")}</td>
      <td>${escapeHtml(source.title || "")}</td>
      <td>${escapeHtml(row.dimension || "")}</td>
      <td>${escapeHtml(friendlyText(row.claim || ""))}</td>
      <td>${row.quote ? escapeHtml(friendlyText(row.quote)) : "<b>无原文支撑</b>"}</td>
      <td>${row.page ? pageLink(source.docId, row.page) : "待核对"}</td>
      <td>${Math.round(Number(row.confidence || 0) * 100)}%${row.dimensionIssue ? `<div class="matrix-audit-note">${escapeHtml(row.dimensionIssue)}</div>` : ""}</td>
    </tr>
  `).join("");
  return `
    <details class="answer-section evidence-matrix" open>
      <summary>证据矩阵 <span>优先显示 ${rows.length} / ${allRows.length} 条，红色为弱证据、错位或无原文支撑</span></summary>
      <div class="answer-matrix-wrap">
        <table>
          <thead><tr><th>来源</th><th>资料</th><th>维度</th><th>观点</th><th>绑定原文</th><th>定位</th><th>置信度</th></tr></thead>
          <tbody>${renderRows(rows)}</tbody>
        </table>
        ${allRows.length > rows.length ? `
          <details class="all-evidence-fields">
            <summary>展开全部证据字段</summary>
            <table>
              <thead><tr><th>来源</th><th>资料</th><th>维度</th><th>观点</th><th>绑定原文</th><th>定位</th><th>置信度</th></tr></thead>
              <tbody>${renderRows(allRows)}</tbody>
            </table>
          </details>
        ` : ""}
      </div>
    </details>
  `;
}

function auditClass(audit = "") {
  if (/missing|weak|mismatch/.test(audit)) return "audit-bad";
  if (/review|dimension/.test(audit)) return "audit-warn";
  return "audit-ok";
}

function svgPointFromEvent(svg, event) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: event.clientX, y: event.clientY };
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function scheduleGraph3dDragRender(svg) {
  if (graph3dDragRenderFrame) cancelAnimationFrame(graph3dDragRenderFrame);
  graph3dDragRenderFrame = requestAnimationFrame(() => {
    graph3dDragRenderFrame = 0;
    if (svg === els.graph3dFullscreenSvg) renderGraph3dFullscreen();
    else renderGraph3d();
  });
}

function handleGraph3dPointerDown(event) {
  if (event.button !== 0) return;
  const node = event.target.closest(".svg-3d-node[data-doc-id]");
  if (!node) return;
  const svg = event.currentTarget;
  const point = svgPointFromEvent(svg, event);
  const scope = graphManualLayoutScope();
  const offsets = graphManualOffsetsForScope(scope);
  const id = node.dataset.docId || "";
  graph3dDragState = {
    svg,
    id,
    scope,
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
    baseDx: Number(offsets[id]?.dx || 0),
    baseDy: Number(offsets[id]?.dy || 0),
    moved: false
  };
  svg.setPointerCapture?.(event.pointerId);
}

function handleGraph3dPointerMove(event) {
  if (!graph3dDragState || graph3dDragState.pointerId !== event.pointerId) return;
  const { svg, id, scope, startX, startY, baseDx, baseDy } = graph3dDragState;
  const point = svgPointFromEvent(svg, event);
  const dx = point.x - startX;
  const dy = point.y - startY;
  if (!graph3dDragState.moved && Math.hypot(dx, dy) < 5) return;
  graph3dDragState.moved = true;
  suppressGraph3dClick = true;
  const offsets = graphManualOffsetsForScope(scope);
  offsets[id] = { dx: Math.round(baseDx + dx), dy: Math.round(baseDy + dy) };
  persistGraphManualOffsets();
  event.preventDefault();
  scheduleGraph3dDragRender(svg);
}

function handleGraph3dPointerUp(event) {
  if (!graph3dDragState || graph3dDragState.pointerId !== event.pointerId) return;
  const { svg, moved } = graph3dDragState;
  svg.releasePointerCapture?.(event.pointerId);
  graph3dDragState = null;
  if (moved) {
    suppressGraph3dClick = true;
    window.setTimeout(() => {
      suppressGraph3dClick = false;
    }, 0);
    setStatus("已手动调整三维图节点位置；可继续点击节点切换中心，或重置当前布局。");
  }
}

function handleGraphSvgClick(event) {
  if (suppressGraph3dClick) {
    suppressGraph3dClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const edge = event.target.closest(".svg-edge, .svg-edge-label-hit");
  if (edge) {
    state.selectedGraphEdgeId = edge.dataset.edgeId || "";
    syncGraphEdgeSelection();
    els.edgeList.innerHTML = renderGraphSideList();
    if (els.graph3dInsight) els.graph3dInsight.innerHTML = renderGraph3dInsight();
    setStatus("已选中一条关系，可展开下方“图谱解读”或“关系证据详情”查看。");
    return;
  }
  const node = event.target.closest(".svg-node[data-doc-id]");
  if (node) {
    state.graphCenterId = node.dataset.docId || "";
    state.selectedGraphEdgeId = "";
    localStorage.setItem("graphCenterId", state.graphCenterId);
    const centerNode = state.graph.nodes.find((item) => item.id === state.graphCenterId);
    const centerDoc = docById(state.graphCenterId);
    render();
    setStatus(`已切换为中心视图：${graphNodeFocusSummary(centerNode, centerDoc)}。`);
    return;
  }
  if (state.selectedGraphEdgeId || state.graphCenterId) {
    state.selectedGraphEdgeId = "";
    state.graphCenterId = "";
    localStorage.removeItem("graphCenterId");
    render();
  }
}

function syncGraphEdgeSelection() {
  document.querySelectorAll(".svg-edge, .svg-edge-label-hit").forEach((item) => {
    item.classList.toggle("selected", Boolean(state.selectedGraphEdgeId) && item.dataset.edgeId === state.selectedGraphEdgeId);
  });
}

els.graphSvg?.addEventListener("click", handleGraphSvgClick);
els.graph3dSvg?.addEventListener("click", handleGraphSvgClick);
els.graph3dFullscreenSvg?.addEventListener("click", handleGraphSvgClick);
els.graph3dSvg?.addEventListener("pointerdown", handleGraph3dPointerDown);
els.graph3dSvg?.addEventListener("pointermove", handleGraph3dPointerMove);
els.graph3dSvg?.addEventListener("pointerup", handleGraph3dPointerUp);
els.graph3dSvg?.addEventListener("pointercancel", handleGraph3dPointerUp);
els.graph3dFullscreenSvg?.addEventListener("pointerdown", handleGraph3dPointerDown);
els.graph3dFullscreenSvg?.addEventListener("pointermove", handleGraph3dPointerMove);
els.graph3dFullscreenSvg?.addEventListener("pointerup", handleGraph3dPointerUp);
els.graph3dFullscreenSvg?.addEventListener("pointercancel", handleGraph3dPointerUp);
els.resetGraphLayout?.addEventListener("click", resetGraphManualLayout);
els.resetGraphLayoutFullscreen?.addEventListener("click", resetGraphManualLayout);

els.graph3dInsight?.addEventListener("click", (event) => {
  const button = event.target.closest(".insight-edge[data-edge-id]");
  if (!button) return;
  state.selectedGraphEdgeId = state.selectedGraphEdgeId === button.dataset.edgeId ? "" : button.dataset.edgeId;
  els.edgeList.innerHTML = renderGraphSideList();
  els.graph3dInsight.innerHTML = renderGraph3dInsight();
  setStatus(state.selectedGraphEdgeId ? "已选中关系，完整依据见下方“关系证据详情”。" : "已取消关系选中。");
});

document.querySelectorAll(".graph-panel").forEach((panel) => {
  panel.addEventListener("toggle", () => {
    if (!panel.open || activeTab() !== "map") return;
    if (panel.querySelector("#graph3dScene, #graph3dSvg")) renderGraph3d();
    if (panel.querySelector("#graph3dInsight")) els.graph3dInsight.innerHTML = renderGraph3dInsight();
    if (panel.querySelector("#graphCanvas")) drawGraphCanvasFallback();
  });
});

els.providerType?.addEventListener("change", () => {
  const defaults = providerDefaults(els.providerType.value);
  els.providerBaseUrl.value = defaults.baseUrl;
  els.providerModel.value = defaults.model;
  const local = els.providerType.value === "local";
  els.providerBaseUrl.disabled = local;
  els.providerModel.disabled = local;
  els.providerApiKey.disabled = local;
  els.testProvider.disabled = local;
  els.providerStatus.textContent = local
    ? "本地研究引擎已启用；保存后将完全不依赖外部模型。"
    : "填写接口后可测试模型增强；本地引擎不会受影响。";
});

els.providerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = els.providerType.value;
  els.providerStatus.textContent = "正在保存接口。";
  try {
    const data = await api("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        baseUrl: els.providerBaseUrl.value.trim(),
        model: els.providerModel.value.trim(),
        apiKey: els.providerApiKey.value.trim(),
        keepApiKey: !els.providerApiKey.value.trim() && Boolean(state.provider?.hasApiKey) && state.provider?.provider === provider
      })
    });
    state.provider = data;
    renderProviderControls();
    els.providerStatus.textContent = "已保存接口配置。";
    setStatus(data.note || "模型接口已保存。");
  } catch (error) {
    els.providerStatus.textContent = `保存失败：${error.message}`;
    setStatus(`保存模型接口失败：${error.message}`);
  }
});

els.testProvider?.addEventListener("click", async () => {
  els.providerStatus.textContent = "正在测试连接。";
  try {
    const data = await api("/api/provider/test", { method: "POST" });
    state.provider = data.provider || state.provider;
    renderProviderControls();
    els.providerStatus.textContent = `测试成功：${data.text || "OK"}`;
    setStatus("模型接口测试成功。");
  } catch (error) {
    els.providerStatus.textContent = `测试失败：${error.message}`;
    setStatus(`模型接口测试失败：${error.message}`);
  }
});

els.openGraphFullscreen?.addEventListener("click", () => {
  els.graphFullscreen.classList.add("active");
  els.graphFullscreen.setAttribute("aria-hidden", "false");
  document.body.classList.add("graph-fullscreen-active");
  renderGraph3dFullscreen();
});

els.closeGraphFullscreen?.addEventListener("click", () => {
  els.graphFullscreen.classList.remove("active");
  els.graphFullscreen.setAttribute("aria-hidden", "true");
  document.body.classList.remove("graph-fullscreen-active");
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !els.graphFullscreen?.classList.contains("active")) return;
  els.closeGraphFullscreen.click();
});

els.exportMap.addEventListener("click", async () => {
  drawGraph();
  const blob = await svgMapBlob();
  if (!blob) return setStatus("地图导出失败，请刷新后重试。");
  const link = document.createElement("a");
  link.download = "evidence-map.png";
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
});

function reviewScopeBodyForExport() {
  if (state.selectedDocIds.length > 1) return { docIds: state.selectedDocIds };
  if (state.activeDocId === "selection") return { docIds: state.activeDocIds?.length ? state.activeDocIds : state.selectedDocIds };
  return { docId: state.activeDocId || "all" };
}

async function journalReviewFilesForExport() {
  const body = {
    ...reviewScopeBodyForExport(),
    topic: els.reviewTopic?.value?.trim() || "",
    structure: els.reviewStructure?.value || "topic",
    wordCount: Number(els.reviewWordCount?.value || 3000),
    citationFormat: els.reviewCitationFormat?.value || "gbt",
    keepAuditMarkers: Boolean(els.reviewKeepAudit?.checked)
  };
  const data = await api("/api/review/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const variants = Array.isArray(data.variants) ? data.variants : [];
  if (variants.length > 1) {
    const files = [{
      name: "期刊综述/导出说明.txt",
      data: textBytes(`当前导出范围包含多个不相关主题，已拆分为 ${variants.length} 份期刊综述。\n\n${variants.map((item, index) => `${index + 1}. ${item.label || `主题 ${index + 1}`}：${(item.docIds || []).length} 篇资料`).join("\n")}`)
    }];
    variants.forEach((item, index) => {
      files.push({
        name: `期刊综述/${String(index + 1).padStart(2, "0")}-${safeFilename(item.label || `主题${index + 1}`)}.txt`,
        data: textBytes(plainReview(item.review) || "暂无期刊综述。")
      });
    });
    return files;
  }
  return [{
    name: "期刊综述/综合期刊综述.txt",
    data: textBytes(plainReview(data.review) || plainReview(state.journalReview) || "暂无期刊综述。")
  }];
}

els.exportPack.addEventListener("click", async () => {
  if (!state.docs.length) return setStatus("请先上传 PDF 或 PPTX。");
  const previousStatus = els.status.textContent;
  els.exportPack.disabled = true;
  setStatus("正在生成研究包。");
  try {
    const mapData = await safeMapBytes();
    const journalFiles = await journalReviewFilesForExport();
    const files = [
      { name: "范围说明.txt", data: textBytes(scopeText()) },
      { name: "输出草稿.txt", data: textBytes(plainReview(state.review) || "暂无输出草稿。") },
      ...journalFiles,
      { name: "资料矩阵.csv", data: textBytes(matrixCsv()) },
      { name: "evidence-audit.csv", data: csvBytes(evidenceAuditCsv()) },
      { name: "metric-evidence.csv", data: csvBytes(metricEvidenceCsv()) },
      { name: "candidate-edges.csv", data: csvBytes(candidateEdgesCsv()) },
      { name: state.docFlow ? "单篇结构说明.txt" : "关系说明.txt", data: textBytes(edgeText()) },
      { name: "综合问答.txt", data: textBytes(state.lastAnswer?.text || "暂无综合问答记录。") }
    ];
    if (mapData) files.push({ name: state.docFlow ? "单篇结构图.png" : "研究脉络图.png", data: mapData });
    else files.push({ name: "导出说明.txt", data: textBytes("图像导出失败，但文本资料已正常打包。请刷新页面后可单独导出地图 PNG。") });
    const zip = makeZip(files);
    const exportedDocs = scopedDocsForExport();
    const filename = `资料研究包-${dateStamp()}-${exportedDocs.length > 1 ? `${exportedDocs.length}篇` : "当前资料"}.zip`;
    downloadBlob(new Blob([zip], { type: "application/zip" }), filename);
    setStatus("研究包已生成。");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "研究包生成失败。");
  } finally {
    els.exportPack.disabled = false;
    window.setTimeout(() => {
      if (els.status.textContent === "研究包已生成。") setStatus(previousStatus || "就绪");
    }, 2600);
  }
});

els.exportReview.addEventListener("click", () => {
  const blob = new Blob([plainReview(state.review) || ""], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.download = "source-pack-draft.md";
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
});

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("研究脉络图生成失败。"));
    }, "image/png");
  });
}

async function safeMapBytes() {
  try {
    drawGraph();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const blob = await svgMapBlob();
    return new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    console.error("map export failed", error);
    return null;
  }
}

async function svgMapBlob() {
  const activeSvg = document.querySelector(".graph-panel[open] #graph3dSvg") || els.graphSvg;
  if (!activeSvg) {
    drawGraphCanvasFallback();
    return canvasBlob(els.canvas);
  }
  const svg = activeSvg.cloneNode(true);
  const viewBox = svg.getAttribute("viewBox") || "0 0 1200 760";
  const [, , widthRaw, heightRaw] = viewBox.split(/\s+/).map(Number);
  const width = widthRaw || 1200;
  const height = heightRaw || 760;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = els.canvas;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvasBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function textBytes(text) {
  return new TextEncoder().encode(String(text || ""));
}

function csvBytes(text) {
  return textBytes(`\ufeff${String(text || "")}`);
}

function csvCell(value) {
  return `"${String(value || "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(",");
}

function scopedDocsForExport() {
  if (state.selectedDocIds.length > 1) {
    const selected = new Set(state.selectedDocIds);
    return state.docs.filter((doc) => selected.has(doc.id));
  }
  if (state.activeDocId === "selection") {
    const selected = new Set(state.activeDocIds?.length ? state.activeDocIds : state.selectedDocIds);
    return state.docs.filter((doc) => selected.has(doc.id));
  }
  if (state.activeDocId && state.activeDocId !== "all") {
    const doc = activeDoc();
    return doc ? [doc] : [];
  }
  return state.docs;
}

function docMarkerForExport(doc, docs = scopedDocsForExport()) {
  const index = docs.findIndex((item) => item.id === doc.id);
  return index >= 0 ? `[${index + 1}]` : "";
}

function evidenceAuditItemsForDoc(doc) {
  const card = doc.evidenceCard || {};
  const rows = [
    ["research_question", "研究问题", card.research_question],
    ["method", "方法路径", card.method],
    ["data_or_materials", "数据/材料", card.data_or_materials],
    ["contribution", "贡献结论", card.contribution],
    ...((card.main_claims || []).map((item, index) => [`main_claim_${index + 1}`, `主张${index + 1}`, item])),
    ...((card.evidence || []).map((item, index) => [`evidence_${index + 1}`, `证据${index + 1}`, item])),
    ...((card.limitations || []).map((item, index) => [`limitation_${index + 1}`, `局限${index + 1}`, item]))
  ];
  return rows.filter(([, , item]) => item);
}

function evidenceItemType(item = {}) {
  if (item.evidence_type) {
    if (/metric/.test(item.evidence_type)) return "指标证据";
    if (/figure/.test(item.evidence_type)) return "图表证据";
    if (/invalid_fragment|context_only/.test(item.evidence_type)) return "上下文/不可直接引用";
  }
  const text = `${item.quote || ""} ${item.claim || ""}`;
  if (/图\d+|表\d+|如图|如表/.test(text)) return "图表证据";
  if (/%|发现率|准确率|误差|召回率|指标/.test(text)) return "指标证据";
  return "原文事实";
}

function evidenceItemUsableForExport(item = {}) {
  if (item.is_usable === true) return true;
  if (item.is_usable === false || item.direct_quote_eligible === false) return false;
  return isDirectlyQuotableEvidence(item);
}

function evidenceAuditCsv() {
  const docs = scopedDocsForExport();
  const header = [
    "source",
    "doc_id",
    "title",
    "field",
    "claim",
    "page",
    "quote",
    "type",
    "confidence",
    "audit",
    "dimension_audit",
    "usable",
    "not_usable_reason"
  ];
  const rows = docs.flatMap((doc) => evidenceAuditItemsForDoc(doc).map(([fieldKey, fieldLabel, item]) => [
    docMarkerForExport(doc, docs),
    doc.id,
    doc.title || doc.filename || "",
    fieldLabel || fieldKey,
    friendlyText(item.normalized_claim || item.claim || ""),
    item.page ? sourcePositionLabel(doc, item.page) : "",
    friendlyText(item.quote || item.text || ""),
    evidenceItemType(item),
    item.confidence != null ? Number(item.confidence).toFixed(2) : "",
    item.audit || "",
    item.dimension_audit || item.dimensionAudit || "",
    evidenceItemUsableForExport(item) ? "true" : "false",
    item.not_usable_reason || item.missing_reason || item.dimension_issue || ""
  ]));
  return [header, ...rows].map(csvLine).join("\n");
}

function metricEvidenceCsv() {
  const docs = scopedDocsForExport();
  const header = [
    "source",
    "doc_id",
    "title",
    "page",
    "quote",
    "type",
    "role",
    "confidence",
    "field",
    "needs_original_check"
  ];
  const rows = docs.flatMap((doc) => (doc.evidenceCard?.metric_evidence || []).map((item) => [
    docMarkerForExport(doc, docs),
    doc.id,
    doc.title || doc.filename || "",
    item.page ? sourcePositionLabel(doc, item.page) : "",
    friendlyText(item.quote || ""),
    evidenceItemType(item),
    item.evidence_role || "",
    item.confidence != null ? Number(item.confidence).toFixed(2) : "",
    item.field || "",
    "true"
  ]));
  return [header, ...rows].map(csvLine).join("\n");
}

function candidateEdgesCsv() {
  const header = [
    "source_id",
    "source_title",
    "target_id",
    "target_title",
    "relation",
    "relation_kind",
    "weight",
    "shared_terms",
    "evidence_why",
    "status"
  ];
  const rows = (state.graph.candidateEdges || []).map((edge) => {
    const source = state.graph.nodes.find((node) => node.id === edge.source) || {};
    const target = state.graph.nodes.find((node) => node.id === edge.target) || {};
    return [
      edge.source || "",
      source.title || source.label || "",
      edge.target || "",
      target.title || target.label || "",
      edge.relation || "",
      edge.relationKind || "",
      edge.weight != null ? Number(edge.weight).toFixed(2) : "",
      (edge.shared || []).join("、"),
      completeUiText(edge.evidence?.why || ""),
      "candidate_not_default_graph"
    ];
  });
  return [header, ...rows].map(csvLine).join("\n");
}

window.__litReviewExportCsv = {
  evidenceAuditCsv,
  metricEvidenceCsv,
  candidateEdgesCsv,
  journalReviewFilesForExport
};

window.__litReviewRenderers = {
  renderJournalReviewDraft
};

function matrixCsv() {
  const singleDoc = state.matrix.some((row) => row.mode === "single-doc" || row.dimension);
  const header = singleDoc
    ? ["维度", "核心内容", "依据片段", "定位", "用途/备注"]
    : ["标题", "核心问题", "处理方式", "数据/材料", "关键信息", "证据状态", "原文摘录", "定位", "证据审计", "置信度", "风险或限制", "适用场景"];
  const rows = singleDoc
    ? state.matrix.map((row) => [row.dimension, row.claim, row.evidence, row.citation, row.notes].map(friendlyText))
    : state.matrix.map((row) => [
        row.title,
        row.question,
        row.method,
        row.dataOrMaterials,
        row.findings,
        matrixEvidenceStatus(row).label,
        row.quote || row.evidence,
        row.page ? sourcePositionLabel(docById(row.id), row.page) : "",
        row.audit,
        row.confidence ? `${Math.round(Number(row.confidence || 0) * 100)}%` : "",
        row.limitations,
        normalizeScene(row.reviewSlot, row)
      ].map(friendlyText));
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function edgeText() {
  if (state.docFlow?.nodes?.length) {
    return state.docFlow.nodes.map((node, index) => [
      `${index + 1}. ${node.title || "结构节点"}`,
      `来源：${node.citation || "当前资料"}`,
      `概括：${node.summary || node.text || ""}`,
      node.evidence ? `原文依据：${node.evidence}` : ""
    ].join("\n")).join("\n\n");
  }
  if (!state.graph.edges.length) return "暂无文献关系。";
  const argument = state.graph.argument;
  const argumentText = argument?.steps?.length ? [
    "综合论证链",
    "",
      `核心观点：${completeUiText(argument.thesis || "")}`,
    "",
    ...argument.steps.flatMap((step, index) => [
      `${index + 1}. ${step.role}：${step.title}`,
      `   推导内容：${completeUiText(step.text || "")}`,
      `   证明作用：${completeUiText(step.proves || "")}`,
      step.refs?.length ? `   对应逻辑：${step.refs.join("；")}` : ""
    ]),
    "",
    `综合结论：${completeUiText(argument.conclusion || "")}`,
    argument.weakLinks?.length ? `不能强行推导：${argument.weakLinks.map(completeUiText).join("；")}` : "",
    "",
    "关系边说明"
  ].filter(Boolean).join("\n") : "";
  const edges = state.graph.edges.map((edge, index) => {
    const aNode = state.graph.nodes.find((node) => node.id === edge.source) || {};
    const bNode = state.graph.nodes.find((node) => node.id === edge.target) || {};
    const a = graphLogicLabel(aNode);
    const b = graphLogicLabel(bNode);
    const details = (edge.evidence?.details || []).map((item) => `- ${completeUiText(item)}`).join("\n");
    const sources = (edge.evidence?.sources || []).map((item, sourceIndex) => {
      return `${sourceIndex === 0 ? "A" : "B"} 画像：${completeUiText(item.quote || "")}`;
    }).join("\n");
    return [
      `${index + 1}. ${edge.relation || "共享概念"}`,
      `逻辑 A：${a}`,
      `逻辑 B：${b}`,
      `共享关键词：${(edge.shared || []).join("、") || "较少"}`,
      `关系依据：${edge.evidence?.why || "两篇文献在摘要和关键点中出现相近主题。"}`,
      details ? `比较维度：\n${details}` : "",
      sources || ""
    ].join("\n");
  }).join("\n\n");
  const candidateText = (state.graph.candidateEdges || []).slice(0, 8).map((edge, index) => {
    const aNode = state.graph.nodes.find((node) => node.id === edge.source) || {};
    const bNode = state.graph.nodes.find((node) => node.id === edge.target) || {};
    return `${index + 1}. ${edge.relation || "候选关系"}：${graphLogicLabel(aNode)} <-> ${graphLogicLabel(bNode)}`;
  }).join("\n");
  return [argumentText, edges, candidateText ? `候选关系（未默认上图）\n${candidateText}` : ""].filter(Boolean).join("\n\n");
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

function safeFilename(name = "") {
  return String(name || "未命名")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "")
    .slice(0, 80) || "未命名";
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = textBytes(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const time = dosTime(new Date());
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time.time), u16(time.date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
    ]);
    const central = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time.time), u16(time.date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(offset), u16(0)
  ]);
  return concatBytes([...localParts, ...centralParts, end]);
}

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function u16(value) {
  return new Uint8Array([value & 255, (value >> 8) & 255]);
}

function u32(value) {
  return new Uint8Array([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  }
  return (crc ^ -1) >>> 0;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

els.clearAll.addEventListener("click", async () => {
  if (!confirm("清空当前资料库？")) return;
  state.lastAnswer = null;
  state.activeDocId = "all";
  state.expandedDocId = "";
  state.search = "";
  state.searchResults = null;
  state.searchLoading = false;
  state.searchDocId = "";
  els.docSearch.value = "";
  localStorage.setItem("activeDocId", "all");
  localStorage.removeItem("expandedDocId");
  applyLibrary(await api("/api/library", { method: "DELETE" }));
  els.answer.className = "answer empty";
  els.answer.textContent = "等待提问。";
  setStatus("资料库已清空。");
});

async function handleDocAction(event) {
  const button = event.target.closest("button[data-doc-id]");
  if (!button) return;
  const docId = button.dataset.docId || "";
  const doc = state.docs.find((item) => item.id === docId);
  if (!doc) return;
  try {
    if (button.classList.contains("open-doc")) {
      state.activeDocId = docId;
      state.expandedDocId = docId;
      localStorage.setItem("activeDocId", state.activeDocId);
      localStorage.setItem("expandedDocId", state.expandedDocId);
      setStatus("已切换当前资料，正在加载独立分析结果。");
      await loadLibrary();
      return;
    }
    if (button.classList.contains("find-in-pdf")) {
      window.open(sourceUrl(doc), "_blank", "noopener");
      setStatus((doc.sourceType || "pdf") === "pptx"
        ? "已打开原始 PPTX；引用位置按 slide 编号核对。"
        : "已打开原始 PDF。需要定位片段时，再用左侧关键词检索。");
      return;
    }
    if (button.classList.contains("doc-title-button")) {
      const willOpen = state.expandedDocId !== docId;
      state.expandedDocId = willOpen ? docId : "";
      if (willOpen) localStorage.setItem("expandedDocId", docId);
      else localStorage.removeItem("expandedDocId");
      setStatus(state.expandedDocId ? "已展开课题详情。" : "已收起课题详情。");
      render();
      return;
    }
    if (button.classList.contains("rename-doc")) {
      const title = prompt("新的资料标题", doc.title || doc.filename || "");
      if (title === null) return;
      const cleanTitle = title.trim();
      if (!cleanTitle) return setStatus("标题不能为空。");
      setStatus("正在重命名资料。");
      applyLibrary(await api(`/api/doc/${encodeURIComponent(docId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: cleanTitle })
      }));
      setStatus("资料已重命名。");
      return;
    }
    if (button.classList.contains("reparse-doc")) {
      setStatus("正在重新解析当前资料，可能需要一些时间。");
      applyLibrary(await api(`/api/doc/${encodeURIComponent(docId)}/reparse`, { method: "POST" }));
      setStatus("资料已重新解析。");
      return;
    }
    if (button.classList.contains("delete-doc")) {
      if (!confirm(`删除“${doc.title || doc.filename || "这篇资料"}”？`)) return;
      setStatus("正在删除资料。");
      const data = await api(`/api/doc/${encodeURIComponent(docId)}`, { method: "DELETE" });
      state.lastAnswer = null;
      if (state.activeDocId === docId) {
        state.activeDocId = data.activeDocId || "all";
        localStorage.setItem("activeDocId", state.activeDocId);
      }
      if (state.expandedDocId === docId) {
        state.expandedDocId = "";
        localStorage.removeItem("expandedDocId");
      }
      state.selectedDocIds = state.selectedDocIds.filter((id) => id !== docId);
      localStorage.setItem("selectedDocIds", JSON.stringify(state.selectedDocIds));
      applyLibrary(data);
      els.answer.className = "answer empty";
      els.answer.textContent = "等待提问。";
      setStatus("资料已删除。");
    }
  } catch (error) {
    setStatus(error.message);
  }
}

els.docList.addEventListener("click", handleDocAction);
els.docInspector?.addEventListener("click", handleDocAction);

els.closeInspector?.addEventListener("click", () => {
  state.expandedDocId = "";
  localStorage.removeItem("expandedDocId");
  render();
});

function setLibraryOpen(open) {
  document.body.classList.toggle("library-open", open);
  els.libraryToggle?.setAttribute("aria-expanded", String(open));
}

els.libraryToggle?.addEventListener("click", () => setLibraryOpen(!document.body.classList.contains("library-open")));
els.closeLibrary?.addEventListener("click", () => setLibraryOpen(false));

els.docList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".select-doc");
  if (!checkbox) return;
  const docId = checkbox.dataset.docId || "";
  if (!docId) return;
  const selected = new Set(state.selectedDocIds);
  if (checkbox.checked) selected.add(docId);
  else selected.delete(docId);
  state.selectedDocIds = [...selected].filter((id) => state.docs.some((doc) => doc.id === id));
  localStorage.setItem("selectedDocIds", JSON.stringify(state.selectedDocIds));
  render();
});

els.selectVisibleDocs.addEventListener("click", () => {
  const selected = new Set(state.selectedDocIds);
  for (const doc of filteredDocs()) selected.add(doc.id);
  state.selectedDocIds = [...selected];
  localStorage.setItem("selectedDocIds", JSON.stringify(state.selectedDocIds));
  render();
});

els.clearSelection.addEventListener("click", async () => {
  state.selectedDocIds = [];
  localStorage.removeItem("selectedDocIds");
  if (state.activeDocId === "selection") {
    state.activeDocId = "all";
    localStorage.setItem("activeDocId", "all");
    setStatus("已清除选中范围，回到全部资料。");
    await loadLibrary();
    return;
  }
  render();
});

els.applySelection.addEventListener("click", async () => {
  if (state.selectedDocIds.length < 1) {
    render();
    return setStatus(selectionHint(state.selectedDocIds.length));
  }
  const count = state.selectedDocIds.length;
  const singleDocId = count === 1 ? state.selectedDocIds[0] : "";
  state.activeDocId = singleDocId || "selection";
  state.expandedDocId = singleDocId;
  state.search = "";
  state.searchDocId = "";
  els.docSearch.value = "";
  localStorage.setItem("activeDocId", state.activeDocId);
  if (singleDocId) localStorage.setItem("expandedDocId", singleDocId);
  else localStorage.removeItem("expandedDocId");
  els.applySelection.disabled = true;
  setStatus(singleDocId ? "正在生成单篇二维/三维结构图。" : `正在用选中的 ${count} 篇资料构建关系网。`);
  try {
    await loadLibrary();
    const edgeCount = state.graph?.edges?.length || 0;
    const matrixCount = state.matrix?.length || 0;
    setStatus(singleDocId
      ? "已生成单篇二维/三维结构图、证据卡和矩阵。"
      : `已用选中的 ${count} 篇资料构建完成：${edgeCount} 条关系，${matrixCount} 行矩阵。`);
  } catch (error) {
    setStatus(`选中资料分析失败：${error.message}`);
  } finally {
    render();
  }
});

els.showAllDocs.addEventListener("click", async () => {
  state.activeDocId = "all";
  state.expandedDocId = "";
  state.search = "";
  state.searchResults = null;
  state.searchLoading = false;
  state.searchDocId = "";
  state.selectedDocIds = [];
  els.docSearch.value = "";
  localStorage.setItem("activeDocId", "all");
  localStorage.removeItem("selectedDocIds");
  localStorage.removeItem("expandedDocId");
  setStatus("已切换到全部资料模式。");
  await loadLibrary();
});

els.docSearch.addEventListener("input", () => {
  state.search = els.docSearch.value || "";
  state.searchDocId = "";
  scheduleSearch();
});

els.searchModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.searchMode = button.dataset.searchMode || "title";
    localStorage.setItem("searchMode", state.searchMode);
    scheduleSearch();
  });
});

els.searchSummary.addEventListener("click", async (event) => {
  const button = event.target.closest(".search-open-doc");
  if (!button) return;
  const docId = button.dataset.docId;
  if (!docId) return;
  state.activeDocId = docId;
  state.expandedDocId = docId;
  localStorage.setItem("activeDocId", docId);
  localStorage.setItem("expandedDocId", docId);
  setStatus("已打开检索命中的资料。");
  await loadLibrary();
});

window.addEventListener("resize", drawGraph);
els.suggestedQuestions.addEventListener("click", async (event) => {
  const button = event.target.closest(".answer-suggested");
  if (!button) return;
  const question = button.dataset.question || "";
  switchTab("qa");
  els.question.value = question;
  await answerQuestion(question);
});

function switchTab(name) {
  els.tabs.forEach((item) => item.classList.toggle("active", item.dataset.tab === name));
  els.panes.forEach((pane) => pane.classList.toggle("active", pane.dataset.pane === name));
  if (name === "map") requestAnimationFrame(drawGraph);
  setLibraryOpen(false);
}

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchTab(tab.dataset.tab);
  });
});
Promise.all([loadLibrary(), refreshUploadJobs(), paperWorkspace.init()]).catch((error) => setStatus(error.message));
