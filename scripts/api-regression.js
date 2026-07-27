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
    server.listen(0, "0.0.0.0", () => {
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
      <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>方法路径：使用结构化证据卡记录 claim、quote、定位和 confidence，再生成矩阵与关系图。</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>`);
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
  env: { ...process.env, PORT: String(port), DATA_DIR: testDataDir },
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
  if (!library.docs.length) {
    assert(library.review === "", "Empty libraries should not generate a synthetic review draft.");
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
    assert(evidenceItems.every((item) => "quote_quality_score" in item && "quote_quality_issues" in item && "missing_reason" in item && "suggested_dimension" in item && "claim_atoms" in item), "Evidence items should expose quality score, missing reason, suggested dimension, and claim atoms.");
    assert(evidenceItems.every((item) => "evidence_type" in item && "evidence_role" in item && "direct_quote_eligible" in item), "Evidence items should expose evidence type, role, and direct quote eligibility.");
    assert(evidenceItems.every((item) => Number(item.quote_quality_score || 0) >= 0.5 || !item.is_usable), "Low-quality quotes should not be marked usable.");
    assert(evidenceItems.every((item) => item.dimension_audit !== "dimension_mismatch" || !item.is_usable), "Dimension-mismatched fields should not be marked usable.");
    assert(evidenceItems.every((item) => !/metric_evidence|figure_evidence|invalid_fragment|context_only/.test(item.evidence_type || "") || !item.is_usable), "Non-direct evidence types should not be marked usable as direct quotes.");
    assert(library.docs.every((doc) => Array.isArray(doc.evidenceCard?.evidence_candidates)), "Evidence cards should expose the document-level candidate pool.");
    assert(library.docs.every((doc) => Array.isArray(doc.evidenceCard?.metric_evidence)), "Evidence cards should expose separated metric/figure evidence.");
  }
  if (library.docs.length >= 5) {
    assert(library.graph.edges.length < library.docs.length * (library.docs.length - 1) / 2, "Graph should not keep every possible edge.");
    assert(library.matrix.every((row) => "audit" in row && "confidence" in row), "Multi-doc matrix should expose evidence audit fields.");
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
  await fetch(`${base}/api/doc/${encodeURIComponent(uploadedPdfId)}`, { method: "DELETE" });

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
  assert(gapCandidates.every((item) => item.canBeThesisTopic !== true || (item.gapScope === "same_domain_topic" && (item.scopeReasons || []).some((reason) => /usable evidence/.test(reason)))), "Thesis-topic gaps should pass strict same-domain evidence gating.");
  const metricText = gapCandidates.map((item) => item.proposal?.metrics || "").join(" ");
  assert(!/(^|、)(指标|对比|样本|基线|通过效率)(、|$)/.test(metricText), "Research gap metrics should not fall back to generic metric labels.");
  assert(/API discovery rate|false positive rate|平均延误|排队长度|MAPE|RMSE|发文量|关键词突现|任务完成率|引用命中率|误合并率|引用可追溯率/.test(metricText), "Research gap metrics should include domain-specific or audit-specific measures.");

  assert(typeof library.review === "string" && library.review.includes("原文事实层"), "Review draft should include a source-fact layer.");
  assert(library.review.includes("综合推断层"), "Review draft should include a synthesis layer.");
  assert(library.review.includes("待核对层"), "Review draft should include an audit layer.");

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
