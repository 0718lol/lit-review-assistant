import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { writeTestDataDir } from "./test-fixture.js";

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
      // Keep polling while the server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertChineseAnalysisText(value, message) {
  const text = String(value || "");
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  assert(cjk >= 8, `${message}: expected Chinese analysis text, got "${text}"`);
  assert(!/\b(?:Research question|Method|Evidence|Limitation|section-aware PDF cleaning|literature review evidence extraction|meaningful body sentences|layout metadata)\b/i.test(text), `${message}: should not expose English source prose, got "${text}"`);
}

async function makeTinyPptx() {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:sldIdLst>
        <p:sldId id="256" r:id="rId1"/>
        <p:sldId id="257" r:id="rId2"/>
      </p:sldIdLst>
    </p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
    </Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>研究问题：比较多篇文献中的智能体任务分解、证据抽取和跨文档综合路径。</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>`);
  zip.file("ppt/slides/slide2.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>方法路径：使用结构化证据卡记录核心主张、原文片段、定位和证据强弱，再生成矩阵与关系图。</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function makeTinyDocx() {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>人工智能智能体文献证据矩阵样例</w:t></w:r></w:p>
        <w:p><w:r><w:t>研究问题：比较智能体论文如何把长期任务分解为可审计子任务，并保留来源定位。</w:t></w:r></w:p>
        <w:p><w:r><w:t>方法路径：使用 claim evidence 表格记录研究问题、方法、证据类型和不能推出边界。</w:t></w:r></w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>共同支持</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>至少两篇文献提供可比证据</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>不能推出</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>跨领域资料不能因为标题相似就合并结论</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
        <w:p><w:r><w:t>证据：样例要求系统识别 Word 段落、表格文本、section 定位和证据卡候选。</w:t></w:r></w:p>
      </w:body>
    </w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

function makeNoisyPdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    for (let page = 1; page <= 3; page += 1) {
      if (page > 1) doc.addPage();
      doc.fontSize(9).text("Journal of Synthetic Evidence Cleaning", 54, 28);
      doc.fontSize(9).text("Vol. 12 No. 3 2026", 410, 28);
      doc.fontSize(11).text("Research question: This study evaluates whether section-aware PDF cleaning improves literature review evidence extraction.", 54, 88);
      doc.text("Method: The pipeline removes repeated headers and footers before sentence chunking, then keeps complete natural-language claims for review writing.");
      doc.text("Evidence: In the controlled upload test, meaningful body sentences remain available while layout metadata is excluded from chunks.");
      doc.moveDown();
      doc.fontSize(10).text("Fig. 1: Workflow of extraction pipeline");
      doc.text("[1] Smith J. Layout noise in PDFs. Journal of Tests. doi:10.0000/noise");
      doc.fontSize(9).text(`Page ${page}`, 285, 742);
    }
    doc.end();
  });
}

function makeEnglishWritingGuidePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    doc.fontSize(16).text("Why do we write literature reviews?");
    doc.moveDown();
    doc.fontSize(11).text("Find models. Look for other literature reviews in your area of interest and read them to get a sense of the types of themes you might want to look for in your own research.");
    doc.text("Narrow your topic. The narrower your topic, the easier it will be to limit the number of sources you need to read.");
    doc.text("Organizing the body. A thematic review is organized around a topic or issue rather than the progression of time.");
    doc.text("Be selective. Select only the most important points in each source to highlight in the review.");
    doc.text("Works consulted. This handout was prepared by a writing center for students learning how to write literature reviews.");
    doc.end();
  });
}

async function postFile(base, bytes, filename, type) {
  const form = new FormData();
  form.append("files", new Blob([bytes], { type }), filename);
  return fetch(`${base}/api/upload`, { method: "POST", body: form });
}

async function waitForUploadJob(base, jobId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (["completed", "duplicate", "failed", "canceled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Upload job did not finish: ${jobId}`);
}

const port = await freePort();
const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lit-review-api-"));
await writeTestDataDir(testDataDir);
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: testDataDir },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/`);

  const library = await (await fetch(`${base}/api/library`)).json();
  assert(Array.isArray(library.docs), "Library response should include docs.");
  assert((library.docs || []).every((doc) => typeof doc.fullSummary === "string" && doc.fullSummary.length >= 40), "Each public document should include a complete prose summary.");
  if (!library.docs.length) {
    assert(library.review === "", "Empty libraries should not generate a synthetic review draft.");
  }
  const flowDoc = library.docs.find((doc) => /交叉口|网约车|智能体|域外汉籍|营销/.test(`${doc.title || ""} ${doc.filename || ""}`)) || library.docs[0];
  if (flowDoc) {
    const flowLibrary = await (await fetch(`${base}/api/library?docId=${encodeURIComponent(flowDoc.id)}`)).json();
    const flowNodes = flowLibrary.docFlow?.nodes || [];
    const flowTitles = flowNodes.map((node) => node.title).join("、");
    assert(flowNodes.length >= 10, `Single-document 3D flow should expose a rich literature-understanding map, not a sparse four-point sketch: ${flowTitles}`);
    assert(["研究对象", "概念基础", "评价指标", "主要发现", "综述写法", "后续问题"].every((title) => flowTitles.includes(title)), `Single-document flow should include expanded research dimensions: ${flowTitles}`);
  }
  const evidenceItems = library.docs.flatMap((doc) => {
    const card = doc.evidenceCard || {};
    return [
      card.research_question,
      card.method,
      card.data_or_materials,
      card.contribution,
      ...((card.main_claims || [])),
      ...((card.evidence || [])),
      ...((card.limitations || []))
    ].filter(Boolean);
  });
  if (evidenceItems.length) {
    assert(evidenceItems.every((item) => "quote_quality_score" in item && "quote_quality_issues" in item && "missing_reason" in item && "suggested_dimension" in item && "claim_atoms" in item && "source_span_id" in item), "Evidence items should expose quality score, missing reason, suggested dimension, claim atoms, and canonical source spans.");
    assert(evidenceItems.every((item) => "evidence_type" in item && "evidence_role" in item && "direct_quote_eligible" in item), "Evidence items should expose evidence type, role, and direct quote eligibility.");
    assert(evidenceItems.every((item) => Number(item.quote_quality_score || 0) >= 0.5 || !item.is_usable), "Low-quality quotes should not be marked usable.");
    assert(evidenceItems.every((item) => item.dimension_audit !== "dimension_mismatch" || !item.is_usable), "Dimension-mismatched fields should not be marked usable.");
    assert(evidenceItems.every((item) => !/metric_evidence|figure_evidence|invalid_fragment|context_only/.test(item.evidence_type || "") || !item.is_usable), "Non-direct evidence types should not be marked usable as direct quotes.");
    assert(library.docs.every((doc) => Array.isArray(doc.evidenceCard?.evidence_candidates)), "Evidence cards should expose the document-level candidate pool.");
    assert(library.docs.every((doc) => (doc.evidenceCard?.evidence_candidates || []).every((item) => item.sourceSpanId)), "Evidence candidates should expose canonical source span IDs.");
    assert(library.docs.every((doc) => Array.isArray(doc.evidenceCard?.metric_evidence)), "Evidence cards should expose separated metric/figure evidence.");
  }
  if (library.docs.length >= 5) {
    assert(library.graph.edges.length < library.docs.length * (library.docs.length - 1) / 2, "Graph should not keep every possible edge.");
    assert(library.matrix.every((row) => "audit" in row && "confidence" in row), "Multi-doc matrix should expose evidence audit fields.");
  }
  if (library.graph.edges.length) {
    const edge = library.graph.edges[0];
    const relationResponse = await fetch(`${base}/api/relations/${encodeURIComponent(edge.source)}/${encodeURIComponent(edge.target)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        relationType: "contrasts_with",
        explanation: "API regression confirms the user can correct a relationship edge.",
        confidence: 0.91
      })
    });
    assert(relationResponse.ok, "Relation override should be accepted.");
    const relationLibrary = await (await fetch(`${base}/api/library?docIds=${encodeURIComponent(edge.source)},${encodeURIComponent(edge.target)}`)).json();
    const corrected = [...(relationLibrary.graph.edges || []), ...(relationLibrary.graph.candidateEdges || [])].find((item) => {
      const ids = [item.source, item.target].sort().join("::");
      return ids === [edge.source, edge.target].sort().join("::");
    });
    assert(corrected?.userOverride === true && corrected.relationType === "contrasts_with", "Graph payload should apply user-corrected relation types.");
    const relationAnswer = await (await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "这两篇文献的关系应该怎样理解？",
        docIds: [edge.source, edge.target]
      })
    })).json();
    assert(JSON.stringify(relationAnswer).includes("人工关系修正"), "Cross-document answer should use user-corrected relationship notes.");
    await fetch(`${base}/api/relations/${encodeURIComponent(edge.source)}/${encodeURIComponent(edge.target)}`, { method: "DELETE" });
  }

  const projectDocIds = library.docs.slice(0, 2).map((doc) => doc.id);
  if (projectDocIds.length) {
    const createdResponse = await fetch(`${base}/api/paper-projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API 回归论文", topic: "证据驱动综述", documentIds: projectDocIds, targetWords: 3200 })
    });
    const createdProject = await createdResponse.json();
    assert(createdResponse.status === 201, "Paper project creation should return 201.");
    assert(createdProject.claims.length > 0 && createdProject.evidenceLinks.length > 0, "Paper projects should persist a claim-to-evidence inventory.");
    const thesisProject = await (await fetch(`${base}/api/paper-projects/${createdProject.id}/theses`, { method: "POST" })).json();
    assert(thesisProject.theses.length === 3 && thesisProject.activeThesisId, "Paper projects should generate selectable thesis candidates.");
    const outlineProject = await (await fetch(`${base}/api/paper-projects/${createdProject.id}/outline`, { method: "POST" })).json();
    assert(outlineProject.outline.length >= 6, "Paper projects should generate a structured outline.");
    const evidenceSection = outlineProject.outline.find((section) => section.claimIds.length);
    const draftedProject = await (await fetch(`${base}/api/paper-projects/${createdProject.id}/sections/${evidenceSection.id}/generate`, { method: "POST" })).json();
    assert(draftedProject.draftBlocks.some((block) => block.sectionId === evidenceSection.id), "Section generation should persist structured draft blocks.");
    const auditedProject = await (await fetch(`${base}/api/paper-projects/${createdProject.id}/audit`, { method: "POST" })).json();
    assert(["ready", "needs_review", "blocked"].includes(auditedProject.audit.status), "Paper audit should return an explicit status.");
    const markdown = await (await fetch(`${base}/api/paper-projects/${createdProject.id}/export/markdown`)).text();
    assert(markdown.includes("参考文献") && markdown.includes(createdProject.title), "Paper projects should export auditable Markdown.");
    const docxResponse = await fetch(`${base}/api/paper-projects/${createdProject.id}/export/docx`);
    const docxBytes = new Uint8Array(await docxResponse.arrayBuffer());
    assert(docxResponse.status === 200 && docxBytes[0] === 0x50 && docxBytes[1] === 0x4b, "Paper projects should export a real DOCX package.");
  }

  const titleSearch = await (await fetch(`${base}/api/search?q=${encodeURIComponent("域外汉籍")}&mode=title&limit=5`)).json();
  assert(titleSearch.totalDocs > 0 && titleSearch.results.every((item) => /题名命中/.test(item.reason || "")), "Title search should use article-title matches.");
  const rejectedModeSearch = await (await fetch(`${base}/api/search?q=${encodeURIComponent("智能体 风险")}&mode=all&limit=5`)).json();
  assert(rejectedModeSearch.mode === "title", "Unsupported search modes should fall back to title search.");
  assert(rejectedModeSearch.results.every((item) => /题名命中/.test(item.reason || "")), "Fallback search should not scan full text.");
  const authorDoc = library.docs.find((doc) => Array.isArray(doc.authors) && doc.authors.length);
  if (authorDoc) {
    const authorSearch = await (await fetch(`${base}/api/search?q=${encodeURIComponent(authorDoc.authors[0])}&mode=author&limit=5`)).json();
    assert(authorSearch.totalDocs > 0 && authorSearch.results.every((item) => /作者命中/.test(item.reason || "")), "Author search should use author metadata only.");
  }

  const unsafeProvider = await fetch(`${base}/api/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "gpt-5",
      apiKey: "should-not-persist"
    })
  });
  const unsafeProviderBody = await unsafeProvider.json();
  assert(unsafeProvider.status === 400, "Unsafe model base URL should be rejected.");
  assert(/https|localhost|内网|地址/.test(unsafeProviderBody.error || ""), "Unsafe model base URL error should explain the security boundary.");

  const safeProvider = await fetch(`${base}/api/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5",
      apiKey: "memory-only-test-key"
    })
  });
  assert(safeProvider.ok, "Safe OpenAI provider config should be accepted.");
  const providerConfigRaw = await fs.readFile(path.join(testDataDir, "provider-config.json"), "utf8").catch(() => "{}");
  assert(!providerConfigRaw.includes("memory-only-test-key") && !providerConfigRaw.includes("apiKey"), "Provider config file should not persist API keys.");
  const relayProvider = await fetch(`${base}/api/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      model: "relay-model",
      apiKey: "relay-memory-only-key"
    })
  });
  assert(relayProvider.ok, "OpenAI-compatible relay provider config should accept non-OpenAI public https hosts.");
  const relayConfigRaw = await fs.readFile(path.join(testDataDir, "provider-config.json"), "utf8").catch(() => "{}");
  assert(!relayConfigRaw.includes("relay-memory-only-key") && !relayConfigRaw.includes("apiKey"), "Relay provider config file should not persist API keys.");
  const unsafeRelayProvider = await fetch(`${base}/api/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai-compatible",
      baseUrl: "https://127.0.0.1:1234/v1",
      model: "relay-model",
      apiKey: "should-not-persist"
    })
  });
  assert(unsafeRelayProvider.status === 400, "OpenAI-compatible relay provider should still reject private/local addresses.");
  await fetch(`${base}/api/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "local", baseUrl: "", model: "" })
  });

  const pptResponse = await postFile(base, new TextEncoder().encode("legacy ppt"), "legacy.ppt", "application/vnd.ms-powerpoint");
  const pptError = await pptResponse.json();
  assert(pptResponse.status === 415, "Legacy .ppt upload should return a clear 415 error.");
  assert(/PPTX|PDF/.test(pptError.error || ""), "Legacy .ppt error should explain conversion to PPTX or PDF.");

  let uploadedPptxId = "";
  const pptxResponse = await postFile(
    base,
    await makeTinyPptx(),
    "api-smoke-literature-slides.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  const pptxQueued = await pptxResponse.json();
  assert(pptxResponse.status === 202, `PPTX upload should enter the background queue: ${pptxQueued.error || ""}`);
  assert(pptxQueued.jobs?.[0]?.status === "queued", "Upload response should return a queued job immediately.");
  const pptxJob = await waitForUploadJob(base, pptxQueued.jobs[0].id);
  assert(pptxJob.status === "completed", `PPTX background job should complete: ${pptxJob.error || ""}`);
  uploadedPptxId = pptxJob.docId || "";
  assert(uploadedPptxId, "PPTX upload should add one document.");
  const pptxData = await (await fetch(`${base}/api/library`)).json();
  const uploadedPptx = (pptxData.docs || []).find((doc) => doc.id === uploadedPptxId);
  const pptxLibraryRaw = JSON.parse(await fs.readFile(path.join(testDataDir, "library.json"), "utf8"));
  const uploadedPptxRaw = (pptxLibraryRaw.docs || []).find((doc) => doc.id === uploadedPptxId) || {};
  assert(uploadedPptx?.sourceType === "pptx", "Uploaded PPTX should be marked as sourceType=pptx.");
  assert(uploadedPptx?.sourceUnit === "slide", "Uploaded PPTX should use slide as the citation unit.");
  assert((uploadedPptx?.keyPoints || []).some((point) => point.page), "Uploaded PPTX should expose slide-level positions.");
  assert(!(uploadedPptxRaw.chunks || []).some((chunk) => /第\s*\d+\s*张幻灯片/.test(chunk.text || "")), "PPTX chunks should not mix generated slide labels into source text.");
  assert((uploadedPptxRaw.evidenceCard?.evidence_candidates || []).length >= 1, "PPTX paragraphs should produce evidence candidates.");
  await fetch(`${base}/api/doc/${encodeURIComponent(uploadedPptxId)}`, { method: "DELETE" });

  let uploadedDocxId = "";
  const docxResponse = await postFile(
    base,
    await makeTinyDocx(),
    "api-smoke-literature-matrix.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  const docxQueued = await docxResponse.json();
  assert(docxResponse.status === 202, `DOCX upload should enter the background queue: ${docxQueued.error || ""}`);
  const docxJob = await waitForUploadJob(base, docxQueued.jobs?.[0]?.id);
  assert(docxJob.status === "completed", `DOCX background job should complete: ${docxJob.error || ""}`);
  uploadedDocxId = docxJob.docId || "";
  const docxData = await (await fetch(`${base}/api/library?docId=${encodeURIComponent(uploadedDocxId)}`)).json();
  const uploadedDocx = (docxData.docs || []).find((doc) => doc.id === uploadedDocxId);
  const docxLibraryRaw = JSON.parse(await fs.readFile(path.join(testDataDir, "library.json"), "utf8"));
  const uploadedDocxRaw = (docxLibraryRaw.docs || []).find((doc) => doc.id === uploadedDocxId) || {};
  assert(uploadedDocx?.sourceType === "docx", "Uploaded DOCX should be marked as sourceType=docx.");
  assert(uploadedDocx?.sourceUnit === "section", "Uploaded DOCX should use section as the citation unit.");
  assert((uploadedDocxRaw.chunks || []).some((chunk) => /共同支持|不能推出|claim evidence/.test(chunk.text || "")), "DOCX chunks should include paragraph and table text.");
  assert((uploadedDocxRaw.evidenceCard?.evidence_candidates || []).length >= 1, "DOCX paragraphs should produce evidence candidates.");
  await fetch(`${base}/api/doc/${encodeURIComponent(uploadedDocxId)}`, { method: "DELETE" });

  let uploadedTextId = "";
  const markdown = [
    "# Agent Planning Evidence Review",
    "",
    "Research question: The note compares how agent planning studies turn long-horizon tasks into auditable subtasks.",
    "",
    "Method: It extracts claim-evidence pairs, preserves paragraph-level citations, and builds a relationship map across documents.",
    "",
    "Evidence: The worked example shows that explicit source links reduce unsupported synthesis in literature review drafts.",
    "",
    "Limitation: The note requires manual review when a relationship edge is based only on conceptual overlap."
  ].join("\n");
  const mdResponse = await postFile(base, new TextEncoder().encode(markdown), "agent-planning-review.md", "text/markdown");
  const mdQueued = await mdResponse.json();
  assert(mdResponse.status === 202, `Markdown upload should enter the background queue: ${mdQueued.error || ""}`);
  const mdJob = await waitForUploadJob(base, mdQueued.jobs?.[0]?.id);
  assert(mdJob.status === "completed", `Markdown background job should complete: ${mdJob.error || ""}`);
  uploadedTextId = mdJob.docId || "";
  const mdData = await (await fetch(`${base}/api/library?docId=${encodeURIComponent(uploadedTextId)}`)).json();
  const uploadedMd = (mdData.docs || []).find((doc) => doc.id === uploadedTextId);
  assert(uploadedMd?.sourceType === "markdown", "Uploaded Markdown should be marked as sourceType=markdown.");
  assert(uploadedMd?.sourceUnit === "section", "Uploaded Markdown should use section as the citation unit.");
  assert((uploadedMd?.evidenceCard?.evidence_candidates || []).length >= 1, "Markdown should produce evidence candidates.");
  await fetch(`${base}/api/doc/${encodeURIComponent(uploadedTextId)}`, { method: "DELETE" });

  let uploadedPdfId = "";
  const noisyPdfResponse = await postFile(
    base,
    await makeNoisyPdf(),
    "api-smoke-noisy-layout.pdf",
    "application/pdf"
  );
  const noisyPdfQueued = await noisyPdfResponse.json();
  assert(noisyPdfResponse.status === 202, `Noisy PDF upload should enter the background queue: ${noisyPdfQueued.error || ""}`);
  const noisyPdfJob = await waitForUploadJob(base, noisyPdfQueued.jobs?.[0]?.id);
  assert(noisyPdfJob.status === "completed", `Noisy PDF background job should complete: ${noisyPdfJob.error || ""}`);
  uploadedPdfId = noisyPdfJob.docId || "";
  assert(uploadedPdfId, "Noisy PDF upload should add one document.");
  const noisyLibraryRaw = JSON.parse(await fs.readFile(path.join(testDataDir, "library.json"), "utf8"));
  const uploadedPdf = (noisyLibraryRaw.docs || []).find((doc) => doc.id === uploadedPdfId) || {};
  assert(uploadedPdf?.pdfCleanVersion >= 1, "Uploaded PDF should record the active PDF cleaning version.");
  const uploadedPdfText = (uploadedPdf?.chunks || []).map((chunk) => chunk.text).join("\n");
  assert(/section-aware PDF cleaning improves literature review evidence extraction/.test(uploadedPdfText), "PDF cleaning should preserve meaningful body evidence.");
  assert(!/Journal of Synthetic Evidence Cleaning|Vol\. 12 No\. 3 2026|Fig\. 1: Workflow|doi:10\.0000\/noise|Page [123]/.test(uploadedPdfText), "PDF cleaning should remove repeated layout lines, figure captions, references, and page numbers from chunks.");
  const noisyPublic = await (await fetch(`${base}/api/library?docId=${encodeURIComponent(uploadedPdfId)}`)).json();
  const noisyPublicDoc = (noisyPublic.docs || []).find((doc) => doc.id === uploadedPdfId) || {};
  const noisyMatrixClaims = (noisyPublic.matrix || []).map((row) => row.claim || row.question || row.method || row.findings || "").filter(Boolean);
  const noisyMatrixEvidence = (noisyPublic.matrix || []).map((row) => row.evidence || "").filter(Boolean);
  assert(noisyMatrixClaims.length >= 3, "English PDF should still produce matrix analysis rows.");
  noisyMatrixClaims.forEach((text) => assertChineseAnalysisText(text, "English PDF matrix analysis should be rewritten in natural Chinese"));
  noisyMatrixEvidence.forEach((text) => assertChineseAnalysisText(text, "English PDF matrix evidence display should be rewritten in natural Chinese"));
  assertChineseAnalysisText(noisyPublicDoc.analysisCard?.question || "", "English PDF public analysis question should be Chinese");
  assertChineseAnalysisText(noisyPublicDoc.analysisCard?.method || "", "English PDF public analysis method should be Chinese");
  const noisyGapText = [
    ...((noisyPublic.researchGaps?.candidateTopics || [])),
    ...((noisyPublic.researchGaps?.underEvaluatedMethods || [])),
    ...((noisyPublic.researchGaps?.missingScenarios || []))
  ].map((item) => `${item.gapSentence || ""} ${item.missingEvidence || ""}`).join(" ");
  assertChineseAnalysisText(noisyGapText, "English PDF research gaps should use Chinese analysis prose");
  await fetch(`${base}/api/doc/${encodeURIComponent(uploadedPdfId)}`, { method: "DELETE" });

  const guidePdfResponse = await postFile(
    base,
    await makeEnglishWritingGuidePdf(),
    "unc-literature-review-guide.pdf",
    "application/pdf"
  );
  const guideQueued = await guidePdfResponse.json();
  assert(guidePdfResponse.status === 202, `English writing guide PDF should enter the background queue: ${guideQueued.error || ""}`);
  const guideJob = await waitForUploadJob(base, guideQueued.jobs?.[0]?.id);
  assert(guideJob.status === "completed", `English writing guide PDF should complete: ${guideJob.error || ""}`);
  const guideData = await (await fetch(`${base}/api/library?docId=${encodeURIComponent(guideJob.docId)}`)).json();
  const guideDoc = (guideData.docs || []).find((doc) => doc.id === guideJob.docId) || {};
  assert(guideDoc.evidenceCard?.document_kind === "teaching_or_reference_material", "English writing guide PDFs should be classified as reference material, not research papers.");
  assertChineseAnalysisText(guideDoc.abstract || "", "English writing guide abstract should be a Chinese guide summary");
  assertChineseAnalysisText(guideDoc.fullSummary || "", "English writing guide full summary should match the guide, not another article");
  assert((guideData.matrix || []).every((row) => row.mode === "single-doc" && !/研究问题|方法\/流程|数据\/实验/.test(row.dimension || "")), "Reference material matrix should not force research-paper dimensions.");
  const guideMatrixText = (guideData.matrix || []).map((row) => `${row.dimension} ${row.claim} ${row.evidence} ${row.notes}`).join(" ");
  assertChineseAnalysisText(guideMatrixText, "English writing guide matrix should use Chinese reference-material prose");
  assert(!/Find models|Narrow your topic|Organizing the body|Be selective|Works consulted/i.test(`${guideDoc.abstract} ${guideDoc.fullSummary} ${guideMatrixText}`), "English writing guide UI fields should not expose English source sentences.");
  const guideFlowText = (guideData.docFlow?.nodes || []).map((node) => `${node.title} ${node.text} ${node.summary} ${node.evidence}`).join(" ");
  assert((guideData.docFlow?.nodes || []).length >= 7, "Reference material should render a source-grounded writing map, not a sparse four-node sketch.");
  assert(["资料定位", "写作目的", "寻找范例", "收窄主题", "组织正文", "选择重点", "参考来源", "使用边界"].every((title) => guideFlowText.includes(title)), "Reference material flow should mirror the actual guide sections.");
  assert(!/可用产物|生成综述大纲|写作检查清单|证据使用|原文证据、转述/.test(guideFlowText), "Reference material flow should not add product-output or generic evidence nodes that are not in the guide.");
  assert(guideData.docFlow?.title === "为什么要写文献综述", `Reference material center title should translate the actual article title: ${guideData.docFlow?.title || ""}`);
  assert(!/Why do we write|Find models|Narrow your topic|Organizing the body|Be selective|不适用论文|不适用.*字段|作用机制是：\s*不适用|当前资料未抽出足够文本/i.test(guideFlowText), "Single-document flow should not expose English guide fragments or inapplicable research-paper fields as graph nodes.");
  await fetch(`${base}/api/doc/${encodeURIComponent(guideJob.docId)}`, { method: "DELETE" });

  const answer = await (await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "这几篇文献对智能体或大模型在具体应用中的价值和风险有什么共识与分歧？",
      docId: "all"
    })
  })).json();
  assert((answer.sources || []).length >= 2, "Cross-document answer should include at least two sources.");
  assert((answer.sources || []).length < Math.max(5, library.docs.length), "Cross-document answer should filter irrelevant all-library sources.");
  const answerText = JSON.stringify(answer);
  assert(!answerText.includes("通过实验、数据、案例或指标对核心判断进行验证"), "Answer should not present generic placeholder evidence as original evidence.");
  assert(!/−1，其中 n 为统计年限|计算公式如式|图\d+\([a-z]\)可见|级区域模型预测结果如表1所示/.test(answerText), "Answer should not promote formula/table fragments as direct evidence.");
  assert(Array.isArray(answer.consensus) && answer.consensus.length >= 1, "Cross-document answer should include consensus lines.");
  assert(Array.isArray(answer.disagreements) && answer.disagreements.length >= 1, "Cross-document answer should include disagreement or difference lines.");
  assert(Array.isArray(answer.cannotInfer) && answer.cannotInfer.length >= 1, "Cross-document answer should include cannot-infer boundaries.");
  assert(!/(只看|不是|而是|通过|基于|围绕|对|从|将|与|和|及|但|因此|说明)$/.test(answer.directConclusion || ""), "Direct conclusion should not end with an incomplete connector.");
  const allowedClaimTypes = new Set(["原文事实", "指标证据", "图表证据", "综合推断", "不确定"]);
  assert((answer.claims || []).every((claim) => allowedClaimTypes.has(claim.type)), "Answer claims should use the research-judgment claim type set.");
  assert(!(answer.claims || []).some((claim) => claim.type === "原话证据"), "Answer claims should not use the old 原话证据 type.");
  assert(!(answer.claims || []).some((claim) => /%|发现率|假发现率|准确率|误差|指标/.test(claim.text || "") && claim.type === "原文事实"), "Metric-looking claims should not be labeled as plain source facts.");
  assert((answer.stanceMatrix || []).every((row) => (row.stance || "").length <= 125), "Stance matrix should use short research judgments.");
  assert(!(answer.stanceMatrix || []).some((row) => /智能体智能体|\b\d+[)）]/.test(row.stance || "")), "Stance matrix should not expose stitched numbering or duplicated terms.");
  const sourceMarkers = new Set((answer.sources || []).map((source) => source.marker));
  const citationMarkers = (answer.claims || []).flatMap((claim) => claim.citations || []);
  assert(citationMarkers.every((marker) => sourceMarkers.has(marker)), "Claim citations should all map to returned sources.");
  const matrixRows = (answer.sources || []).flatMap((source) => source.matrix || []);
  assert(matrixRows.length >= Math.min(2, answer.sources?.length || 0), "Answer sources should expose an evidence matrix.");
  assert(matrixRows.every((row) => "audit" in row && "confidence" in row), "Answer evidence matrix rows should expose audit and confidence.");
  assert((answer.claims || []).some((claim) => claim.type === "不确定") || (answer.sources || []).every((source) => !(source.weakFields || []).length), "Answer should surface weak fields as uncertainty when present.");

  const gapCandidates = [
    ...((library.researchGaps?.candidateTopics || [])),
    ...((library.researchGaps?.underEvaluatedMethods || [])),
    ...((library.researchGaps?.missingScenarios || []))
  ];
  assert(gapCandidates.some((item) => item.proposal?.researchQuestion && item.proposal?.independentVariable && item.proposal?.dependentVariable), "Research gaps should include proposal-level research question and variables.");
  assert(gapCandidates.every((item) => item.gapScope && typeof item.canBeThesisTopic === "boolean"), "Research gaps should expose scope and thesis-topic flags.");
  assert(gapCandidates.every((item) => item.gapScope !== "cross_domain_methodology" || item.canBeThesisTopic === false), "Cross-domain methodology gaps must not be marked as thesis topics.");
  assert(gapCandidates.every((item) => item.gapScope !== "single_source_boundary" || (item.canBeThesisTopic === false && item.canBeResearchLead === true)), "Single-source gaps should be research leads, not thesis topics.");
  assert(gapCandidates.every((item) => item.canBeThesisTopic !== true || (item.gapScope === "same_domain_topic" && (item.scopeReasons || []).some((reason) => /可核对证据/.test(reason)))), "Thesis-topic gaps should pass strict same-domain evidence gating.");
  assert(gapCandidates.every((item) => item.evidenceBuckets && Array.isArray(item.evidenceBuckets.commonSupport) && Array.isArray(item.evidenceBuckets.singleSupport) && Array.isArray(item.evidenceBuckets.cannotInfer)), "Research gaps should expose common/single/cannot-infer evidence buckets.");
  assert(gapCandidates.every((item) => item.canBeThesisTopic !== true || item.evidenceBuckets.commonSupport.length >= 1), "Writable thesis-topic gaps must have at least one shared conclusion supported by two usable evidence sources.");
  assert(gapCandidates.every((item) => !/\[\d+\]/.test((item.verificationSteps || []).map((step) => `${step.action} ${step.criterion}`).join(" "))), "Research gap verification steps should use readable source titles instead of numeric markers.");
  const gapDisplayText = gapCandidates.map((item) => [
    item.title,
    item.gapSentence,
    item.missingEvidence,
    item.whyItMatters,
    ...(item.scopeReasons || []),
    item.proposal?.researchQuestion,
    item.proposal?.independentVariable,
    item.proposal?.dependentVariable,
    item.proposal?.dataNeeded,
    item.proposal?.literatureGroup,
    ...(item.verificationSteps || []).flatMap((step) => [step.action, step.criterion]),
    ...(item.evidenceBuckets?.cannotInfer || []).flatMap((row) => [row.conclusion, row.reason])
  ].filter(Boolean).join(" ")).join("\n");
  assert(!/《\s*》|《\s*[A-Za-z]\s*》/.test(gapDisplayText), "Research gap display text should not show empty or one-letter source titles.");
  assert(!/\b(?:claim|quote|location|confidence|usable evidence)\b|gap 主句|domain\/method\/evidence|methodType|evidenceType/.test(gapDisplayText), "Research gap display text should not expose internal field names.");
  const metricText = gapCandidates.map((item) => item.proposal?.metrics || "").join(" ");
  assert(!/(^|、)(指标|对比|样本|基线|通过效率)(、|$)/.test(metricText), "Research gap metrics should not fall back to generic metric labels.");
  assert(/API discovery rate|false positive rate|平均延误|排队长度|MAPE|RMSE|发文量|关键词突现|任务完成率|引用命中率|误合并率|引用可追溯率/.test(metricText), "Research gap metrics should include domain-specific or audit-specific measures.");

  assert(typeof library.review === "string" && library.review.includes("原文事实层"), "Review draft should include a source-fact layer.");
  assert(library.review.includes("综合推断层"), "Review draft should include a synthesis layer.");
  assert(library.review.includes("待核对层"), "Review draft should include an audit layer.");
  const sourceFactSection = String(library.review || "").match(/原文事实层\n([\s\S]*?)\n\n(?:参考资料层\n[\s\S]*?\n\n)?综合推断层/)?.[1] || "";
  const sourceFactBullets = (sourceFactSection.match(/\n- (研究问题|方法路径|数据\/材料|主要结论|证据\d+|边界条件|核心事实)：/g) || []).length;
  assert(sourceFactBullets >= Math.min(12, Math.max(4, (library.scopedCount || 0) * 2)), "Review source-fact layer should expose multiple structured facts per selected research document.");

  const journalReview = await (await fetch(`${base}/api/review/journal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      docId: "all",
      topic: "人工智能智能体应用与证据链研究综述",
      structure: "topic",
      wordCount: 3000,
      citationFormat: "gbt",
      keepAuditMarkers: true
    })
  })).json();
  const journalTitle = String(journalReview.review || "").split("\n")[0] || "";
  assert(journalTitle === "人工智能智能体应用与证据链研究综述", "Journal review should use the user topic as the title without duplicating the suffix.");
  assert(/\n摘要\n/.test(journalReview.review || ""), "Journal review should include an abstract section.");
  assert(/关键词[:：]/.test(journalReview.review || ""), "Journal review should include keywords.");
  assert(/\n1 引言\n/.test(journalReview.review || "") && /\n6 结论与展望\n/.test(journalReview.review || "") && /\n参考文献\n/.test(journalReview.review || ""), "Journal review should follow a basic academic review structure.");
  assert(!/组织方式：|目标篇幅：|引用格式：/.test(journalReview.review || ""), "Journal review body should not expose generation settings.");
  assert(!/高水平期刊式文献综述草稿|研究综述研究综述/.test(journalReview.review || ""), "Journal review should not expose template titles or duplicated title suffixes.");
  assert(!/\[\d+\]/.test(journalReview.review || ""), "Journal review prose should not expose bracketed citation numbers.");
  assert(!/综述不宜|综述应|写作应|正式写作|本稿优先|不宜按文献顺序|写作的重点|应放在|能写到什么程度/.test(journalReview.review || ""), "Journal review should not expose meta writing instructions.");
  assert(!/未来综述写作的重点|继续增加文献数量|统一的论证坐标|资料汇总.*研究判断|构建可验证、可追溯、可部署的研究判断链/.test(journalReview.review || ""), "Journal review conclusion should not fall back to generic methodology claims.");
  assert(!/原文显示|当前字段没有找到|不能作为强结论使用|数据材料:|研究问题:/.test(journalReview.review || ""), "Journal review should not expose extraction labels or internal audit failure text.");
  assert(/6 结论与展望\n[\s\S]*《[^》]+》/.test(journalReview.review || ""), "Journal review conclusion should reference concrete source titles.");

  const autoJournalReview = await (await fetch(`${base}/api/review/journal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      docId: "all",
      topic: "",
      structure: "topic",
      wordCount: 3000,
      citationFormat: "gbt",
      keepAuditMarkers: false
    })
  })).json();
  const autoJournalTitle = String(autoJournalReview.review || "").split("\n")[0] || "";
  assert(/研究综述$|综述$/.test(autoJournalTitle), "Auto journal review should still produce a review-style title.");
  assert(!/^(高水平期刊式文献综述草稿|相关领域研究综述|当前资料研究综述|文献综述草稿)$/.test(autoJournalTitle), "Auto journal review title should not use generic template text.");
  assert(/智能系统|智能交通|知识图谱|接口|交通|智能体|生成式人工智能|证据验证|边界条件|跨主题|多主题/.test(autoJournalTitle), "Auto journal review title should be grounded in selected document themes.");
  assert(!/综述不宜|综述应|写作应|正式写作|本稿优先|不宜按文献顺序|写作的重点|应放在|能写到什么程度/.test(autoJournalReview.review || ""), "Auto journal review should not expose meta writing instructions.");
  assert(!/未来综述写作的重点|继续增加文献数量|统一的论证坐标|资料汇总.*研究判断|构建可验证、可追溯、可部署的研究判断链/.test(autoJournalReview.review || ""), "Auto journal review conclusion should not fall back to generic methodology claims.");
  assert(!/原文显示|当前字段没有找到|不能作为强结论使用|数据材料:|研究问题:/.test(autoJournalReview.review || ""), "Auto journal review should not expose extraction labels or internal audit failure text.");
  assert(!/浙江大学研究生学位论文编写规则|Why do we write literature reviews|写作指导资料/.test(autoJournalReview.review || ""), "Auto journal review body should exclude writing guides and formatting manuals from research synthesis.");
  assert(!/关注五、|结语本文|绪论本文|引言本文|不能只按文献标题罗列/.test(autoJournalReview.review || ""), "Auto journal review should not expose section-heading fragments or meta writing notes.");
  assert(!/《人工智能驱动下的营销变革》[^。；\n]*(接口安全检测|漏洞检测|组合建模与预测)/.test(autoJournalReview.review || ""), "Marketing transformation papers should not be misclassified as API security or traffic prediction research.");
  assert(!JSON.stringify(autoJournalReview.variants || []).includes("浙江大学研究生学位论文编写规则") && !JSON.stringify(autoJournalReview.variants || []).includes("Why do we write literature reviews"), "Journal review variants should exclude writing guides and formatting manuals.");

  const trafficDocIds = library.docs
    .filter((doc) => /交通运输|网约车|出行预测|交叉口|交通流/.test(`${doc.title || ""} ${doc.filename || ""}`))
    .map((doc) => doc.id)
    .slice(0, 2);
  if (trafficDocIds.length >= 2) {
    const relatedJournalReview = await (await fetch(`${base}/api/review/journal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docIds: trafficDocIds,
        topic: "",
        structure: "topic",
        wordCount: 2200,
        citationFormat: "gbt",
        keepAuditMarkers: false
      })
    })).json();
    const relatedJournalTitle = String(relatedJournalReview.review || "").split("\n")[0] || "";
    assert(/智能交通场景中预测、控制与效果验证研究综述/.test(relatedJournalTitle), "Related multi-document journal review should produce a strong thematic title.");
    assert(!/跨主题|高水平期刊式文献综述草稿|相关领域研究综述/.test(relatedJournalTitle), "Related multi-document journal title should not fall back to cross-topic or template text.");
  }

  const unrelatedDocIds = [
    library.docs.find((doc) => /域外汉籍|文献计量|知识图谱/.test(`${doc.title || ""} ${doc.filename || ""}`))?.id,
    library.docs.find((doc) => /网约车|交通运输|交通流|交叉口/.test(`${doc.title || ""} ${doc.filename || ""}`))?.id
  ].filter(Boolean);
  if (unrelatedDocIds.length >= 2) {
    const splitJournalReview = await (await fetch(`${base}/api/review/journal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docIds: unrelatedDocIds,
        topic: "",
        structure: "topic",
        wordCount: 2200,
        citationFormat: "gbt",
        keepAuditMarkers: false
      })
    })).json();
    assert(Array.isArray(splitJournalReview.variants) && splitJournalReview.variants.length >= 2, "Unrelated multi-document journal review should return switchable topic variants.");
    assert(splitJournalReview.variants.every((item) => /文献综述|研究综述|综述/.test(item.review || "") && Array.isArray(item.docIds) && item.docIds.length >= 1), "Each journal variant should include its own review and source ids.");
  }

  const firstDocId = library.docs[0]?.id;
  if (firstDocId) {
    const singleJournalReview = await (await fetch(`${base}/api/review/journal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId: firstDocId,
        topic: "",
        structure: "topic",
        wordCount: 1600,
        citationFormat: "gbt",
        keepAuditMarkers: false
      })
    })).json();
    const singleJournalTitle = String(singleJournalReview.review || "").split("\n")[0] || "";
    assert(/文献综述$/.test(singleJournalTitle), "Single-document journal review should use a document-review title.");
    assert(!/^(高水平期刊式文献综述草稿|相关领域研究综述|当前资料研究综述|文献综述草稿)$/.test(singleJournalTitle), "Single-document journal review title should not use generic template text.");
    assert(!/[\u4e00-\u9fa5]{2,3}\*?\d|[,，]\s*\d/.test(singleJournalTitle), `Single-document journal title should not expose author footnote numbers: ${singleJournalTitle}`);
  }

  console.log("API regression passed: search recall, source filtering, graph pruning, matrix audit fields, and review audit layers verified.");
} catch (error) {
  console.error(output.trim());
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
}
