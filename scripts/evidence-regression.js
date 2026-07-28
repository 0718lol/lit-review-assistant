import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { writeTestDataDir } from "./test-fixture.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

function fieldItems(card, field) {
  const value = card?.[field];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function matchingItem(card, field, expectedText) {
  return fieldItems(card, field).find((item) =>
    `${item.quote || ""} ${item.normalized_claim || item.claim || ""}`.toLowerCase().includes(expectedText.toLowerCase()));
}

function assertEvidenceField(doc, field, expectedText, expectedPage) {
  const item = matchingItem(doc.evidenceCard, field, expectedText);
  const actual = fieldItems(doc.evidenceCard, field).map((candidate) => candidate.quote || candidate.normalized_claim || candidate.claim || "");
  const pool = (doc.evidenceCard?.evidence_candidates || []).map((candidate) => ({
    quote: candidate.quote,
    types: candidate.candidateTypes,
    selected: candidate.selected,
    field: candidate.field,
    sourceSpanId: candidate.sourceSpanId
  }));
  assert(item, `${doc.title}: ${field} should contain ${expectedText}; actual=${JSON.stringify(actual)} pool=${JSON.stringify(pool)}`);
  assert(item.dimension_audit === "dimension_supported", `${doc.title}: ${field} should pass dimension validation.`);
  assert(item.direct_quote_eligible === true, `${doc.title}: ${field} should remain directly quotable.`);
  assert(item.is_usable === true, `${doc.title}: ${field} should be usable, got ${item.not_usable_reason || item.audit}.`);
  assert(item.page === expectedPage, `${doc.title}: ${field} should point to ${doc.sourceUnit} ${expectedPage}.`);
  assert(item.source_span_id, `${doc.title}: ${field} should expose a canonical source span ID.`);
  return item;
}

const port = await freePort();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lit-review-evidence-"));
await writeTestDataDir(dataDir);
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/`);
  const response = await fetch(`${base}/api/library`);
  const library = await response.json();
  assert(response.ok, `Evidence fixture library should load: ${library.error || ""}`);

  const english = library.docs.find((doc) => doc.id === "fixture-english-agent");
  assert(english?.sourceType === "pptx" && english?.sourceUnit === "slide", "English fixture should exercise PPTX slide evidence.");
  assertEvidenceField(english, "research_question", "intelligent agents learn reliable policies", 1);
  assertEvidenceField(english, "method", "compare decision trees", 2);
  assertEvidenceField(english, "data_or_materials", "three public benchmark datasets", 3);
  const englishEvidence = assertEvidenceField(english, "evidence", "8.2 percentage points", 4);
  assert(!/produce task labels/.test(englishEvidence.quote || ""), `English evidence extraction should select the result sentence instead of merging preceding context: ${englishEvidence.quote || ""}`);
  assertEvidenceField(english, "contribution", "reproducible evaluation workflow", 5);
  assertEvidenceField(english, "limitations", "supervised tasks only", 6);

  const traffic = library.docs.find((doc) => doc.id === "fixture-traffic-control");
  const trafficData = assertEvidenceField(traffic, "data_or_materials", "SUMO", 3);
  assert(trafficData.extraction_strategy === "data_source_phrase_extract", "SUMO data source should be selected from the unified candidate pool.");
  const selectedCandidate = (traffic.evidenceCard?.evidence_candidates || []).find((item) =>
    item.selected && item.sourceSpanId === trafficData.source_span_id);
  assert(selectedCandidate, "Selected data-source fallback should remain visible in the candidate audit pool.");
  const otherTrafficItems = [
    ...fieldItems(traffic.evidenceCard, "research_question"),
    ...fieldItems(traffic.evidenceCard, "method"),
    ...fieldItems(traffic.evidenceCard, "contribution"),
    ...fieldItems(traffic.evidenceCard, "evidence"),
    ...fieldItems(traffic.evidenceCard, "limitations")
  ].filter((item) => item.quote);
  assert(otherTrafficItems.every((item) => item.source_span_id !== trafficData.source_span_id), "A selected data-source span must not be reused by another evidence field.");

  const answerResponse = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "这些文献在方法、证据和局限方面有什么差异？",
      docIds: ["fixture-traffic-control", "fixture-english-agent"]
    })
  });
  const answer = await answerResponse.json();
  assert(answerResponse.ok, `Cross-document fixture answer should succeed: ${answer.error || ""}`);
  assert(Array.isArray(answer.sources) && answer.sources.length === 2, "Cross-document evidence regression should retain both requested sources.");
  assert(Array.isArray(answer.stanceMatrix) && answer.stanceMatrix.length === 2, "Cross-document evidence regression should produce one stance row per source.");

  console.log("Evidence regression passed: English PPT fields, canonical source spans, data-source audit, and cross-document scope verified.");
} catch (error) {
  console.error(output.trim());
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
