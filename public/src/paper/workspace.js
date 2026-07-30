import { api } from "../api/client.js";
import { escapeHtml, friendlyText } from "../shared/text.js";

export function createPaperWorkspace({ root, setStatus }) {
  const state = { projects: [], project: null, docs: [], selectedDocIds: [], sectionId: "", creating: false, loading: false, impact: null };
  if (!root) return { init: async () => {}, sync: () => {} };

  async function init() {
    bindEvents();
    await loadProjects();
  }

  function sync({ docs = [], selectedDocIds = [] } = {}) {
    state.docs = docs;
    state.selectedDocIds = selectedDocIds;
    render();
  }

  async function loadProjects(preferredId = "") {
    state.loading = true;
    render();
    try {
      const data = await api("/api/paper-projects");
      state.projects = data.projects || [];
      const id = preferredId || state.project?.id || state.projects[0]?.id;
      state.project = id ? await api(`/api/paper-projects/${encodeURIComponent(id)}`) : null;
      state.sectionId = validSectionId(state.sectionId) || state.project?.outline?.[0]?.id || "";
    } finally {
      state.loading = false;
      render();
    }
  }

  function bindEvents() {
    root.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      try {
        if (form.matches("[data-paper-create]")) await createProject(form);
        if (form.matches("[data-paper-settings]")) await saveSettings(form);
        if (form.matches("[data-paper-section-settings]")) await saveSection(form);
      } catch (error) { setStatus(error.message); }
    });
    root.addEventListener("change", async (event) => {
      if (event.target.matches("[data-paper-project-select]")) {
        await loadProjects(event.target.value);
        setStatus("已切换综述项目。");
      }
    });
    root.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-paper-action]");
      if (!action) return;
      try { await handleAction(action); } catch (error) { setStatus(error.message); }
    });
  }

  async function handleAction(button) {
    const action = button.dataset.paperAction;
    if (action === "new") { state.creating = true; state.project = null; render(); return; }
    if (action === "cancel-create") { state.creating = false; await loadProjects(); return; }
    if (!state.project) return;
    if (action === "theses") await mutateProject("theses", {}, "已生成候选中心论点。");
    if (action === "outline") await mutateProject("outline", {}, "已生成大纲和首节草稿。");
    if (action === "audit") await mutateProject("audit", {}, "综述证据审计已完成。");
    if (action === "select-thesis") await patchProject({ activeThesisId: button.dataset.thesisId }, "已选择中心论点。");
    if (action === "select-section") {
      state.sectionId = button.dataset.sectionId;
      render();
      await ensureSectionDraft(state.sectionId);
    }
    if (action === "generate-section") await generateSection(button.dataset.sectionId);
    if (action === "save-block") await saveBlock(button.dataset.blockId);
    if (action === "impact") await inspectImpact(button.dataset.docId);
    if (action === "clear-impact") { state.impact = null; render(); }
    if (action === "restore") await restoreRevision(button.dataset.revisionId);
    if (action === "delete") await deleteProject();
  }

  async function createProject(form) {
    const body = formBody(form);
    body.documentIds = [...form.querySelectorAll('[name="documentIds"]:checked')].map((input) => input.value);
    if (!body.documentIds.length) throw new Error("请至少选择一篇资料。");
    setBusy(true, "正在创建综述项目。");
    try {
      const project = await api("/api/paper-projects", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
      state.creating = false;
      await loadProjects(project.id);
      setStatus("综述项目已创建，下一步生成候选论点。");
    } finally { setBusy(false); }
  }

  async function saveSettings(form) {
    const body = formBody(form);
    body.documentIds = [...form.querySelectorAll('[name="documentIds"]:checked')].map((input) => input.value);
    await patchProject(body, "项目设置已保存；文献范围变化时，大纲和正文会重置。");
  }

  async function patchProject(body, message) {
    setBusy(true, "正在保存综述项目。");
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}`, { method: "PATCH", headers: jsonHeaders(), body: JSON.stringify(body) });
      state.sectionId = validSectionId(state.sectionId) || state.project.outline?.[0]?.id || "";
      await refreshSummaries();
      setStatus(message);
    } finally { setBusy(false); }
  }

  async function mutateProject(endpoint, body, message) {
    setBusy(true, `正在处理${endpoint === "audit" ? "综述审计" : "写作结构"}。`);
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/${endpoint}`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
      state.sectionId = validSectionId(state.sectionId) || state.project.outline?.[0]?.id || "";
      if (endpoint === "outline" && state.sectionId) {
        state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/sections/${encodeURIComponent(state.sectionId)}/generate`, { method: "POST" });
      }
      await refreshSummaries();
      setStatus(message);
    } finally { setBusy(false); }
  }

  async function generateSection(sectionId) {
    setBusy(true, "正在根据已绑定证据生成章节。");
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/sections/${encodeURIComponent(sectionId)}/generate`, { method: "POST" });
      state.sectionId = sectionId;
      await refreshSummaries();
      setStatus("章节已生成；请检查右侧证据后再编辑正文。");
    } finally { setBusy(false); }
  }

  async function ensureSectionDraft(sectionId) {
    const section = state.project?.outline?.find((item) => item.id === sectionId);
    if (!section || section.locked) return;
    const hasBlocks = state.project.draftBlocks.some((item) => item.sectionId === sectionId);
    if (hasBlocks) return;
    setBusy(true, "正在生成当前章节正文。");
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/sections/${encodeURIComponent(sectionId)}/generate`, { method: "POST" });
      state.sectionId = sectionId;
      await refreshSummaries();
      setStatus("已生成当前章节草稿。");
    } finally { setBusy(false); }
  }

  async function saveBlock(blockId) {
    const field = root.querySelector(`[data-paper-block="${cssEscape(blockId)}"]`);
    if (!field) return;
    const locked = root.querySelector(`[data-paper-lock="${cssEscape(blockId)}"]`)?.checked || false;
    setBusy(true, "正在保存正文段落。");
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/blocks/${encodeURIComponent(blockId)}`, { method: "PATCH", headers: jsonHeaders(), body: JSON.stringify({ text: field.value, locked }) });
      setStatus("正文段落已保存。");
    } finally { setBusy(false); }
  }

  async function saveSection(form) {
    const sectionId = form.dataset.sectionId;
    const data = new FormData(form);
    setBusy(true, "正在保存章节设置。");
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/sections/${encodeURIComponent(sectionId)}`, { method: "PATCH", headers: jsonHeaders(), body: JSON.stringify({ title: data.get("title"), purpose: data.get("purpose"), targetWords: Number(data.get("targetWords")), locked: data.get("locked") === "on" }) });
      setStatus("大纲章节已保存。");
    } finally { setBusy(false); }
  }

  async function inspectImpact(docId) {
    state.impact = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/impact`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ documentIds: [docId] }) });
    render();
    setStatus("已计算移除这篇文献会影响的论断与正文。");
  }

  async function restoreRevision(revisionId) {
    if (!confirm("恢复这个论文版本？当前状态会先作为新版本保留。")) return;
    setBusy(true, "正在恢复论文版本。");
    try {
      state.project = await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}/revisions/${encodeURIComponent(revisionId)}/restore`, { method: "POST" });
      state.sectionId = state.project.outline?.[0]?.id || "";
      setStatus("综述项目已恢复到所选版本。");
    } finally { setBusy(false); }
  }

  async function deleteProject() {
    if (!confirm(`删除综述项目“${state.project.title}”？资料库文献不会被删除。`)) return;
    await api(`/api/paper-projects/${encodeURIComponent(state.project.id)}`, { method: "DELETE" });
    state.project = null;
    state.sectionId = "";
    await loadProjects();
    setStatus("综述项目已删除，资料库未受影响。");
  }

  async function refreshSummaries() {
    const data = await api("/api/paper-projects");
    state.projects = data.projects || [];
    render();
  }

  function render() {
    if (state.loading) { root.innerHTML = '<div class="paper-empty">正在加载综述项目…</div>'; return; }
    if (state.creating || (!state.project && !state.projects.length)) { root.innerHTML = renderCreateForm(); return; }
    if (!state.project) { root.innerHTML = renderProjectToolbar() + '<div class="paper-empty">选择一个项目，或创建新的综述项目。</div>'; return; }
    root.innerHTML = `${renderProjectToolbar()}${renderProjectSettings()}${renderScopeWarning()}${renderTopicClusters()}${renderWorkflow()}${renderAudit()}${renderImpact()}${renderHistory()}${renderWritingSurface()}`;
  }

  function renderProjectToolbar() {
    const projectControl = state.project && state.projects.length <= 1
      ? `<div class="paper-current-project"><b>${escapeHtml(state.project.title || "当前综述项目")}</b><span>${escapeHtml(projectProgressText(state.project))}</span></div>`
      : `<label><span>综述项目</span><select data-paper-project-select>${state.projects.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.project?.id ? "selected" : ""}>${escapeHtml(item.title)}</option>`).join("")}</select></label>`;
    return `<div class="paper-toolbar">${projectControl}<button type="button" data-paper-action="new">新建项目</button>${state.project ? `<a class="paper-export" href="/api/paper-projects/${encodeURIComponent(state.project.id)}/export/docx">导出 Word</a><a class="paper-export secondary-link" href="/api/paper-projects/${encodeURIComponent(state.project.id)}/export/markdown">导出 Markdown</a><button type="button" class="danger" data-paper-action="delete">删除项目</button>` : ""}</div>`;
  }

  function projectProgressText(project = {}) {
    const docs = project.documentIds?.length || 0;
    const theses = project.theses?.length || 0;
    const outline = project.outline?.length || 0;
    const blocks = project.draftBlocks?.length || 0;
    const cluster = dominantProjectCluster(project);
    const clusterText = cluster?.label ? ` · 当前主题：${cluster.label}` : "";
    return `已纳入 ${docs} 篇资料 · ${theses} 个候选论点 · ${outline} 个章节 · ${blocks} 段正文${clusterText}`;
  }

  function renderCreateForm() {
    return `${state.projects.length ? renderProjectToolbar() : ""}<form class="paper-create" data-paper-create><div class="paper-create-head"><div><h3>创建综述项目</h3><p>优先使用资料库中已勾选的文献。</p></div>${state.projects.length ? '<button type="button" class="secondary" data-paper-action="cancel-create">取消</button>' : ""}</div>${settingsFields({ title: "", topic: "", paperType: "review", targetWords: 5000, citationStyle: "gbt", documentIds: state.selectedDocIds })}<button type="submit">创建并提取论断</button></form>`;
  }

  function renderProjectSettings() {
    return `<details class="paper-settings"><summary>项目设置与文献范围</summary><form data-paper-settings>${settingsFields(state.project)}<button type="submit">保存设置</button></form></details>`;
  }

  function settingsFields(project) {
    const selected = new Set(project.documentIds || []);
    const docs = state.docs.map((doc) => `<div class="paper-doc-option"><label><input type="checkbox" name="documentIds" value="${escapeHtml(doc.id)}" ${selected.has(doc.id) ? "checked" : ""}><span>${escapeHtml(friendlyText(doc.title))}</span></label>${state.project ? `<button type="button" class="secondary" data-paper-action="impact" data-doc-id="${escapeHtml(doc.id)}">影响</button>` : ""}</div>`).join("");
    return `<div class="paper-fields"><label><span>项目名称</span><input name="title" required value="${escapeHtml(project.title || "")}" placeholder="例如：大语言模型智能体研究综述"></label><label><span>综述主题</span><input name="topic" value="${escapeHtml(project.topic || "")}" placeholder="明确综述讨论的核心主题"></label><label><span>目标期刊</span><input name="targetJournal" value="${escapeHtml(project.targetJournal || "")}" placeholder="可暂时留空"></label><label><span>类型</span><select name="paperType"><option value="review" ${project.paperType === "review" ? "selected" : ""}>文献综述</option><option value="research" ${project.paperType === "research" ? "selected" : ""}>研究论文</option><option value="course" ${project.paperType === "course" ? "selected" : ""}>课程论文</option></select></label><label><span>语言</span><select name="language"><option value="zh-CN" ${project.language !== "en" ? "selected" : ""}>中文</option><option value="en" ${project.language === "en" ? "selected" : ""}>English</option></select></label><label><span>目标字数</span><input name="targetWords" type="number" min="800" max="30000" value="${Number(project.targetWords || 5000)}"></label><label><span>引用格式</span><select name="citationStyle"><option value="gbt" ${project.citationStyle === "gbt" ? "selected" : ""}>GB/T 7714</option><option value="apa" ${project.citationStyle === "apa" ? "selected" : ""}>APA</option></select></label></div><div class="paper-doc-options">${docs || "资料库中暂无文献。"}</div>`;
  }

  function renderWorkflow() {
    const audit = state.project.audit || {};
    const readiness = auditReadiness(state.project, audit);
    return `<div class="paper-workflow"><button type="button" data-paper-action="theses">1. 生成候选论点</button><button type="button" data-paper-action="outline" ${state.project.theses.length ? "" : "disabled"}>2. 生成大纲</button><button type="button" data-paper-action="audit" ${state.project.draftBlocks.length ? "" : "disabled"}>3. 复查正文证据</button><span class="paper-audit ${escapeHtml(readiness.status)}">${escapeHtml(readiness.label)}</span></div>${readiness.note ? `<div class="paper-generation-notice paper-audit-note">${escapeHtml(readiness.note)}</div>` : ""}${state.project.generationNotice ? `<div class="paper-generation-notice">${escapeHtml(state.project.generationNotice)}</div>` : ""}${renderTheses()}`;
  }

  function renderTopicClusters() {
    const clusters = state.project.topicClusters || [];
    if (!clusters.length) return "";
    return `<section class="paper-clusters"><div class="paper-column-head"><b>文献主题分组</b><span>${clusters.length} 组 · ${clusters.some((item) => item.scope === "unrelated_sources") ? "存在不宜硬合并的资料" : "已判断写作范围"}</span></div>${clusters.map((item) => `<article class="${item.id === state.project.activeClusterId ? "active" : ""}"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.writingMode)} · ${item.documentIds.length} 篇 · ${clusterScopeLabel(item.scope)}</span><em>${escapeHtml((item.keywords || []).slice(0, 6).join(" / "))}</em></article>`).join("")}</section>`;
  }

  function renderScopeWarning() {
    const warning = projectScopeWarning(state.project);
    if (!warning) return "";
    return `<section class="paper-scope-warning"><b>项目范围不一致</b><span>${escapeHtml(warning)}</span></section>`;
  }

  function renderTheses() {
    if (!state.project.theses.length) return '<div class="paper-callout">先生成候选论点。系统会说明每个论点使用了哪些结构化证据。</div>';
    return `<div class="paper-theses">${state.project.theses.map((item) => `<button type="button" class="paper-thesis ${item.id === state.project.activeThesisId ? "active" : ""}" data-paper-action="select-thesis" data-thesis-id="${escapeHtml(item.id)}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.statement)}</span><em>${escapeHtml(item.scopeNote || "")} · ${item.documentIds.length} 篇资料 · ${item.evidenceStatus === "supported" ? "证据可用" : "需补充证据"}</em></button>`).join("")}</div>`;
  }

  function renderAudit() {
    const audit = state.project.audit || {};
    if (!audit.issues?.length) return "";
    return `<details class="paper-results" ${audit.status === "blocked" ? "open" : ""}><summary>证据审计详情 · ${audit.issues.length} 项</summary><div>${audit.issues.map((item) => `<p class="${escapeHtml(item.severity)}"><b>${item.severity === "blocker" ? "阻止项" : item.severity === "warning" ? "待核对" : "提示"}</b><span>${escapeHtml(item.message)}</span></p>`).join("")}</div></details>`;
  }

  function renderImpact() {
    if (!state.impact) return "";
    const impact = state.impact;
    return `<section class="paper-impact"><div><b>移除文献影响</b><span>${impact.claims.length} 条论断 · ${impact.blocks.length} 个正文段落 · ${impact.sections.length} 个章节</span></div><button type="button" class="secondary" data-paper-action="clear-impact">关闭</button></section>`;
  }

  function renderHistory() {
    const revisions = [...(state.project.revisions || [])].reverse().slice(0, 12);
    const latest = revisions[0];
    if (!revisions.length) {
      return `<details class="paper-history"><summary>版本历史 · 自动保存到本项目</summary><div><article><div><b>当前项目已保存</b><span>后续生成论点、大纲、正文或编辑设置时，会自动写入本项目历史。</span></div><em>暂无历史</em></article></div></details>`;
    }
    return `<details class="paper-history"><summary>版本历史 · ${state.project.revisions.length} 次保存 · 最新 ${escapeHtml(latest ? new Date(latest.createdAt).toLocaleString("zh-CN") : "")}</summary><div>${revisions.map((item, index) => {
      const isCurrent = index === 0;
      const action = isCurrent
        ? '<em>当前版本</em>'
        : `<button type="button" class="secondary" data-paper-action="restore" data-revision-id="${escapeHtml(item.id)}" ${!item.snapshot ? "disabled" : ""}>恢复</button>`;
      return `<article><div><b>${escapeHtml(item.summary || "自动保存")}</b><span>${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN"))} · ${item.sectionCount} 节 · ${item.draftBlockCount} 段 · 已保存到本项目</span></div>${action}</article>`;
    }).join("")}</div></details>`;
  }

  function renderWritingSurface() {
    if (!state.project.outline.length) return '<div class="paper-empty">选择中心论点后生成综述大纲。</div>';
    const section = state.project.outline.find((item) => item.id === state.sectionId) || state.project.outline[0];
    const blocks = state.project.draftBlocks.filter((item) => item.sectionId === section.id).sort((a, b) => a.order - b.order);
    const claimById = new Map(state.project.claims.map((item) => [item.id, item]));
    const evidenceById = new Map(state.project.evidenceLinks.map((item) => [item.id, item]));
    const claims = section.claimIds.map((id) => claimById.get(id)).filter(Boolean);
    return `<div class="paper-surface"><aside class="paper-outline"><div class="paper-column-head"><b>综述章节</b><span>${state.project.outline.length} 节</span></div>${state.project.outline.map((item) => `<button type="button" class="paper-section ${item.id === section.id ? "active" : ""}" data-paper-action="select-section" data-section-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.title)}</span><em>${item.targetWords} 字 · ${sectionStatus(item.status)}</em></button>`).join("")}</aside><main class="paper-editor"><form class="paper-editor-head paper-section-form" data-paper-section-settings data-section-id="${escapeHtml(section.id)}"><label><span>章节标题</span><input name="title" value="${escapeHtml(section.title)}"></label><label><span>本节任务</span><input name="purpose" value="${escapeHtml(section.purpose)}"></label><label class="paper-word-target"><span>目标字数</span><input name="targetWords" type="number" min="100" max="10000" value="${section.targetWords}"></label><label class="paper-lock-section"><input name="locked" type="checkbox" ${section.locked ? "checked" : ""}> 锁定本节</label><button type="submit" class="secondary">保存章节设置</button><button type="button" data-paper-action="generate-section" data-section-id="${escapeHtml(section.id)}" ${section.locked ? "disabled" : ""}>${blocks.length ? "重新生成本节" : "生成本节正文"}</button></form><div class="paper-editor-title"><b>当前章节正文</b><span>正文可直接编辑，右侧显示本节引用证据。</span></div>${blocks.length ? blocks.map(renderBlock).join("") : renderSectionEmpty(section, claims)}</main><aside class="paper-evidence"><div class="paper-column-head"><b>本节引用证据</b><span>${claims.length} 条论断</span></div>${claims.length ? claims.map((claim) => renderClaimEvidence(claim, evidenceById)).join("") : '<div class="paper-empty compact">当前章节还没有绑定证据。生成正文前，建议先确认本节论点和文献范围。</div>'}</aside></div>`;
  }

  function renderSectionEmpty(section, claims) {
    return `<div class="paper-empty compact paper-section-empty"><b>当前章节还没有正文</b><span>${claims.length ? `已绑定 ${claims.length} 条论断，生成后会得到可编辑正文。` : "系统会先从项目证据中选择最接近本节任务的材料，再生成可编辑正文。"}</span><button type="button" data-paper-action="generate-section" data-section-id="${escapeHtml(section.id)}" ${section.locked ? "disabled" : ""}>生成本节正文</button></div>`;
  }

  function renderBlock(block) {
    const origin = block.origin === "edited" ? "人工编辑" : block.origin === "model" ? "模型生成" : "本地规则生成";
    const section = state.project?.outline?.find((item) => item.id === block.sectionId) || {};
    const isAbstract = block.mode === "abstract" || /^(摘要|abstract)$/i.test(String(section.title || "").trim());
    const structure = [block.topicSentence && ["主题句", block.topicSentence], block.evidenceSentence && ["证据句", block.evidenceSentence], block.comparisonSentence && ["比较句", block.comparisonSentence], block.boundarySentence && ["边界句", block.boundarySentence]].filter(Boolean);
    return `<article class="paper-block ${isAbstract ? "paper-block-abstract" : ""}">${isAbstract ? `<div class="paper-abstract-label"><b>摘要正文</b><span>一段式摘要，可直接编辑</span></div>` : structure.length ? `<div class="paper-block-structure">${structure.map(([label, text]) => `<p><b>${label}</b><span>${escapeHtml(text)}</span></p>`).join("")}</div>` : ""}<textarea data-paper-block="${escapeHtml(block.id)}" rows="${isAbstract ? 9 : 5}">${escapeHtml(block.text)}</textarea><div><span>生成方式：${escapeHtml(origin)}；证据类型：${escapeHtml(inferenceLabel(block.inferenceLevel))}；已绑定 ${block.citations.length} 条证据</span><label><input type="checkbox" data-paper-lock="${escapeHtml(block.id)}" ${block.locked ? "checked" : ""}> 锁定本段</label><button type="button" data-paper-action="save-block" data-block-id="${escapeHtml(block.id)}">保存正文</button></div></article>`;
  }

  function renderClaimEvidence(claim, evidenceById) {
    const evidence = claim.evidenceLinkIds.map((id) => evidenceById.get(id)).filter(Boolean);
    return `<article class="paper-evidence-item"><b>${escapeHtml(claim.text)}</b><span class="${claim.status}">${claim.status === "supported" ? "已支撑" : "待核对"}</span>${evidence.map((item) => `<blockquote>${escapeHtml(item.quote || "暂无可直接引用原文")}<cite>${escapeHtml(item.citation || "来源待核对")}</cite><a href="/api/doc/${encodeURIComponent(item.docId)}/source" target="_blank" rel="noopener">打开原文</a></blockquote>`).join("")}</article>`;
  }

  function setBusy(busy, message = "") { state.loading = busy; if (message) setStatus(message); render(); }
  function validSectionId(id) { return state.project?.outline?.some((section) => section.id === id) ? id : ""; }
  return { init, sync };
}

function formBody(form) { const data = new FormData(form); return { title: data.get("title"), topic: data.get("topic"), targetJournal: data.get("targetJournal"), paperType: data.get("paperType"), language: data.get("language"), targetWords: Number(data.get("targetWords")), citationStyle: data.get("citationStyle") }; }
function jsonHeaders() { return { "Content-Type": "application/json" }; }
function sectionStatus(status) { return ({ planned: "待生成", drafted: "已生成", needs_evidence: "缺证据" })[status] || status; }
function auditReadiness(project = {}, audit = {}) {
  const evidenceCount = (project.evidenceLinks || []).length;
  const usableCount = (project.evidenceLinks || []).filter((item) => item.usable).length;
  const blockCount = (project.draftBlocks || []).length;
  if (audit.status === "ready") return { status: "ready", label: "正文审计通过", note: "" };
  if (audit.status === "blocked") return { status: "blocked", label: `${audit.counts?.blocker || 0} 个阻止项`, note: "正文里有事实性段落缺引用或证据越界，建议先看审计详情。" };
  if (audit.status === "needs_review") return { status: "needs_review", label: `${audit.counts?.warning || 0} 个待核对`, note: "正文已自动审计，但仍有弱证据、薄综合或边界说明需要人工确认。" };
  if (!evidenceCount) return { status: "blocked", label: "缺少证据卡", note: "当前项目还没有可用于写作的结构化证据，请先确认文献解析结果。" };
  if (!blockCount) return { status: "evidence_ready", label: `文献证据已审计 ${usableCount}/${evidenceCount}`, note: "这里审的是论文正文引用；请先生成一个章节，系统会自动复查正文是否被证据支撑。" };
  return { status: "needs_review", label: "正文待复查", note: "正文已生成但还没有最新审计结果，点击“复查正文证据”即可更新。" };
}
function clusterScopeLabel(scope) { return ({ same_domain_topic: "可综合", cross_domain_methodology: "只做方法比较", single_source_boundary: "单篇述评", unrelated_sources: "分主题写" })[scope] || "待判断"; }
function inferenceLabel(level) { return ({ source_fact: "原文事实", synthesis: "跨文档综合", interpretation: "解释推断" })[level] || "证据段落"; }
function cssEscape(value) { return String(value).replace(/["\\]/g, "\\$&"); }
function projectScopeWarning(project = {}) {
  const cluster = dominantProjectCluster(project);
  const text = String(project.topic || project.title || "").trim();
  if (!cluster?.label || !text || projectTextMatchesCluster(text, cluster)) return "";
  return `当前项目名称/主题是“${text}”，但已选文献更接近“${cluster.label}”。系统会优先按已选文献生成正文；建议修改项目名称，或重新选择与项目主题一致的文献。`;
}
function dominantProjectCluster(project = {}) {
  const clusters = project.topicClusters || [];
  return clusters.find((item) => item.id === project.activeClusterId) || clusters.find((item) => item.scope === "same_domain_topic") || clusters[0] || null;
}
function projectTextMatchesCluster(text, cluster) {
  const clean = String(text || "").trim();
  if (!clean || !cluster) return true;
  if (cluster.label && clean.includes(cluster.label)) return true;
  const stop = /^(项目|论文|综述|研究|文献|分析|报告|课程|毕业|the|and|for|with)$/i;
  const terms = new Set((clean.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9-]{2,}/g) || []).filter((term) => !stop.test(term)));
  const clusterTerms = [cluster.label, ...(cluster.keywords || [])].flatMap((item) => String(item || "").match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9-]{2,}/g) || []);
  return clusterTerms.some((term) => terms.has(term) || clean.includes(term));
}
