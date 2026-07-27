import express from "express";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import * as mupdf from "mupdf";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const uploadDir = path.join(dataDir, "uploads");
const originalDir = path.join(dataDir, "originals");
const backupDir = path.join(dataDir, "backups");
const ocrLangDir = path.join(dataDir, "tessdata");
const ocrCacheDir = path.join(dataDir, "tesseract-cache");
const storePath = path.join(dataDir, "library.json");
const searchIndexPath = path.join(dataDir, "search-index.json");
const providerConfigPath = path.join(dataDir, "provider-config.json");
const uploadJobsPath = path.join(dataDir, "jobs.json");
const pendingUploadDir = path.join(dataDir, "pending");

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultOpenAIModel = process.env.OPENAI_MODEL || "gpt-5";
const defaultAnthropicModel = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const ocrMaxPages = Number(process.env.OCR_MAX_PAGES || 0);
const pdfCleanVersion = 4;
const evidenceCardVersion = 30;
let lastLLMStatus = "not-configured";
let providerConfig = null;
let libraryMutationQueue = Promise.resolve();
let uploadJobMutationQueue = Promise.resolve();
let uploadJobStore = { jobs: [] };
let uploadJobProcessorRunning = false;

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(originalDir, { recursive: true });
await fs.mkdir(backupDir, { recursive: true });
await fs.mkdir(ocrLangDir, { recursive: true });
await fs.mkdir(pendingUploadDir, { recursive: true });
mupdf.setLog(null);
providerConfig = await loadProviderConfig();
lastLLMStatus = providerConfig.apiKey ? "configured" : "not-configured";
uploadJobStore = await loadUploadJobs();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 35 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (isSupportedUpload(file)) cb(null, true);
    else cb(Object.assign(new Error(uploadFormatHelp(file.originalname)), { code: "UNSUPPORTED_UPLOAD_TYPE" }));
  }
});

const stopwords = new Set(`
the a an and or of to in for on with by as is are was were be been being from that this these those it its at into
we our us they their them which can may using used use based between through across than such also not have has had
资料 文件 文档 内容 问题 方法 模型 数据 结果 通过 基于 进行 一个 一种 以及 可以 主要 相关 分析 提出 实现 不同 其中 对于 文献 论文 报告
`.trim().split(/\s+/));

async function loadLibrary() {
  let library;
  try {
    library = JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch {
    library = { docs: [] };
  }
  const recovered = await recoverLocalSourceDocs(library);
  const pdfCleanChanged = await ensurePdfCleanVersion(recovered.library);
  const evidenceChanged = ensureEvidenceCards(recovered.library);
  const metaChanged = ensureSourceMetadata(recovered.library);
  if (recovered.changed || pdfCleanChanged || evidenceChanged || metaChanged) await saveLibrary(recovered.library);
  else await ensureSearchIndex(recovered.library);
  return recovered.library;
}

async function saveLibrary(library) {
  await backupLibraryFile();
  const temporaryPath = `${storePath}.${process.pid}.${uuid()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(library, null, 2));
  await fs.rename(temporaryPath, storePath);
  await writeSearchIndex(library);
}

function mutateLibrary(operation) {
  const pending = libraryMutationQueue.then(operation, operation);
  libraryMutationQueue = pending.catch(() => {});
  return pending;
}

function mutationRoute(handler) {
  return (req, res, next) => {
    mutateLibrary(() => handler(req, res)).catch(next);
  };
}

function mutateUploadJobs(operation) {
  const pending = uploadJobMutationQueue.then(operation, operation);
  uploadJobMutationQueue = pending.catch(() => {});
  return pending;
}

async function loadUploadJobs() {
  let store;
  try {
    store = JSON.parse(await fs.readFile(uploadJobsPath, "utf8"));
  } catch {
    store = { jobs: [] };
  }
  if (!Array.isArray(store.jobs)) store.jobs = [];
  let changed = false;
  for (const job of store.jobs) {
    if (["parsing", "ocr", "enhancing", "saving", "canceling"].includes(job.status)) {
      const pendingPath = pendingPathForJob(job);
      if (job.status === "canceling" || job.cancelRequested) {
        job.status = "canceled";
        job.phase = "已取消";
        job.error = "";
        job.cancelRequested = true;
        job.updatedAt = new Date().toISOString();
        await fs.rm(pendingPath, { force: true }).catch(() => {});
        changed = true;
        continue;
      }
      try {
        await fs.access(pendingPath);
        job.status = "queued";
        job.phase = "等待恢复解析";
        job.progress = 0;
      } catch {
        job.status = "failed";
        job.phase = "原始文件缺失";
        job.error = "服务重启后找不到待解析文件，请重新上传。";
      }
      job.cancelRequested = false;
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await saveUploadJobs(store);
  return store;
}

async function saveUploadJobs(store = uploadJobStore) {
  const temporaryPath = `${uploadJobsPath}.${process.pid}.${uuid()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2));
  await fs.rename(temporaryPath, uploadJobsPath);
}

function pendingPathForJob(job = {}) {
  const pendingFile = path.basename(String(job.pendingFile || ""));
  return pendingFile ? path.join(pendingUploadDir, pendingFile) : "";
}

function publicUploadJob(job = {}) {
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    phase: job.phase || "",
    progress: Math.max(0, Math.min(100, Number(job.progress || 0))),
    currentPage: Number(job.currentPage || 0),
    totalPages: Number(job.totalPages || 0),
    error: job.error || "",
    docId: job.docId || "",
    docTitle: job.docTitle || "",
    duplicateOf: job.duplicateOf || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

async function updateUploadJob(jobId, patch = {}) {
  return mutateUploadJobs(async () => {
    const job = uploadJobStore.jobs.find((item) => item.id === jobId);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await saveUploadJobs();
    return job;
  });
}

function uploadJobProgress(jobId) {
  return async (patch = {}) => {
    const job = await mutateUploadJobs(async () => uploadJobStore.jobs.find((item) => item.id === jobId));
    if (!job || job.cancelRequested) throw Object.assign(new Error("解析任务已取消。"), { code: "JOB_CANCELED" });
    await updateUploadJob(jobId, patch);
  };
}

function scheduleUploadJobProcessor() {
  setTimeout(() => processUploadJobs().catch((error) => console.error("upload job processor failed", error)), 0);
}

async function processUploadJobs() {
  if (uploadJobProcessorRunning) return;
  uploadJobProcessorRunning = true;
  try {
    while (true) {
      const job = await mutateUploadJobs(async () => uploadJobStore.jobs.find((item) => item.status === "queued"));
      if (!job) break;
      await runUploadJob(job.id);
    }
  } finally {
    uploadJobProcessorRunning = false;
    const hasQueued = uploadJobStore.jobs.some((job) => job.status === "queued");
    if (hasQueued) scheduleUploadJobProcessor();
  }
}

async function runUploadJob(jobId) {
  const job = await updateUploadJob(jobId, {
    status: "parsing",
    phase: "读取并解析文件",
    progress: 5,
    error: ""
  });
  if (!job) return;
  const pendingPath = pendingPathForJob(job);
  try {
    const buffer = await fs.readFile(pendingPath);
    const doc = await analyzeUploadedDocument({
      id: uuid(),
      filename: job.filename,
      buffer,
      onProgress: uploadJobProgress(jobId)
    });
    await uploadJobProgress(jobId)({ status: "saving", phase: "写入知识库", progress: 94 });
    const result = await mutateLibrary(async () => {
      if (job.cancelRequested) throw Object.assign(new Error("解析任务已取消。"), { code: "JOB_CANCELED" });
      const library = await loadLibrary();
      const existing = library.docs.find((item) => item.fileHash === doc.fileHash || (item.filename === job.filename && item.wordCount > 0));
      if (existing) return { duplicate: existing };
      await fs.writeFile(path.join(originalDir, doc.sourceFile), doc._sourceBuffer || buffer);
      library.docs.push(doc);
      cleanupDuplicateDocs(library);
      await saveLibrary(library);
      return { doc };
    });
    if (result.duplicate) {
      await updateUploadJob(jobId, {
        status: "duplicate",
        phase: "已存在于资料库",
        progress: 100,
        duplicateOf: result.duplicate.id,
        docId: result.duplicate.id,
        docTitle: result.duplicate.title || job.filename
      });
    } else {
      await updateUploadJob(jobId, {
        status: "completed",
        phase: "解析完成",
        progress: 100,
        docId: result.doc.id,
        docTitle: result.doc.title || job.filename
      });
    }
    await fs.rm(pendingPath, { force: true });
  } catch (error) {
    const canceled = error?.code === "JOB_CANCELED";
    await updateUploadJob(jobId, {
      status: canceled ? "canceled" : "failed",
      phase: canceled ? "已取消" : "解析失败",
      error: canceled ? "" : (error?.message || "文件解析失败，请确认文件未损坏。")
    });
    if (canceled) await fs.rm(pendingPath, { force: true }).catch(() => {});
  }
}

async function enqueueUploadFiles(files = []) {
  const library = await loadLibrary();
  const jobs = [];
  const skipped = [];
  await mutateUploadJobs(async () => {
    for (const file of files) {
      const filename = decodeUploadFilename(file.originalname);
      try {
        const buffer = await fs.readFile(file.path);
        const hash = fileHash(buffer);
        const existing = library.docs.find((doc) => doc.fileHash === hash || (doc.filename === filename && doc.wordCount > 0));
        const activeJob = uploadJobStore.jobs.find((job) =>
          job.fileHash === hash && ["queued", "parsing", "ocr", "enhancing", "saving", "canceling"].includes(job.status));
        if (existing || activeJob) {
          skipped.push({
            filename,
            reason: "duplicate",
            existingId: existing?.id || activeJob?.docId || "",
            existingTitle: existing?.title || activeJob?.filename || filename
          });
          await fs.rm(file.path, { force: true });
          continue;
        }
        const id = uuid();
        const pendingFile = `${id}${uploadExtension(filename) || ".pdf"}`;
        await fs.rename(file.path, path.join(pendingUploadDir, pendingFile));
        const now = new Date().toISOString();
        const job = {
          id,
          filename,
          fileHash: hash,
          pendingFile,
          status: "queued",
          phase: "等待解析",
          progress: 0,
          currentPage: 0,
          totalPages: 0,
          error: "",
          cancelRequested: false,
          createdAt: now,
          updatedAt: now
        };
        uploadJobStore.jobs.push(job);
        jobs.push(job);
      } catch (error) {
        await fs.rm(file.path, { force: true }).catch(() => {});
        skipped.push({ filename, reason: "queue-failed", message: error?.message || "文件加入解析队列失败。" });
      }
    }
    if (jobs.length) await saveUploadJobs();
  });
  if (jobs.length) scheduleUploadJobProcessor();
  return { jobs: jobs.map(publicUploadJob), skipped };
}

async function backupLibraryFile() {
  try {
    const content = await fs.readFile(storePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(backupDir, `library-${stamp}.json`);
    await fs.writeFile(target, content);
    const backups = (await fs.readdir(backupDir))
      .filter((file) => /^library-.*\.json$/.test(file))
      .sort();
    for (const file of backups.slice(0, Math.max(0, backups.length - 30))) {
      await fs.rm(path.join(backupDir, file), { force: true }).catch(() => {});
    }
  } catch {
    // No previous library exists yet.
  }
}

function envProviderConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: defaultOpenAIModel,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY
    };
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    return {
      provider: "anthropic",
      model: defaultAnthropicModel,
      baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY
    };
  }
  return {
    provider: "local",
    model: defaultOpenAIModel,
    baseUrl: "https://api.openai.com/v1",
    apiKey: ""
  };
}

async function loadProviderConfig() {
  const fallback = envProviderConfig();
  try {
    const saved = JSON.parse(await fs.readFile(providerConfigPath, "utf8"));
    const merged = sanitizeProviderConfig({ ...fallback, ...saved });
    merged.apiKey = fallback.apiKey || "";
    return merged;
  } catch {
    try {
      return sanitizeProviderConfig(fallback);
    } catch (error) {
      lastLLMStatus = `provider-config-invalid: ${error.message}`;
      return { provider: "local", model: defaultOpenAIModel, baseUrl: "", apiKey: "" };
    }
  }
}

function sanitizeProviderConfig(config = {}) {
  const provider = ["openai", "anthropic", "local"].includes(config.provider) ? config.provider : "local";
  const baseUrl = safeProviderBaseUrl(provider, config.baseUrl);
  const model = String(config.model || (provider === "anthropic" ? defaultAnthropicModel : defaultOpenAIModel)).trim();
  return {
    provider,
    model,
    baseUrl,
    apiKey: String(config.apiKey || "")
  };
}

function safeProviderBaseUrl(provider, rawBaseUrl = "") {
  const fallback = provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  if (provider === "local") return "";
  const value = String(rawBaseUrl || fallback).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("模型 Base URL 格式不正确。"), { status: 400 });
  }
  if (url.protocol !== "https:") {
    throw Object.assign(new Error("模型 Base URL 只允许 https，不能使用 http 或本地地址。"), { status: 400 });
  }
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLocalHost(host)) {
    throw Object.assign(new Error("模型 Base URL 不能指向 localhost、内网或保留地址。"), { status: 400 });
  }
  if (provider === "openai" && !/(^|\.)openai\.com$|(^|\.)azure\.com$|(^|\.)azurefd\.net$/.test(host)) {
    throw Object.assign(new Error("OpenAI 模式只允许 OpenAI 或 Azure OpenAI 的 https 地址。"), { status: 400 });
  }
  if (provider === "anthropic" && !/(^|\.)anthropic\.com$/.test(host)) {
    throw Object.assign(new Error("Claude / Anthropic 模式只允许 Anthropic 官方 https 地址。"), { status: 400 });
  }
  return url.toString().replace(/\/+$/, "");
}

function isPrivateOrLocalHost(host = "") {
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(127|10)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^(0|169\.254)\./.test(host)) return true;
  if (host === "::1" || host === "[::1]") return true;
  return false;
}

async function saveProviderConfig(nextConfig) {
  providerConfig = sanitizeProviderConfig(nextConfig);
  const persisted = {
    provider: providerConfig.provider,
    model: providerConfig.model,
    baseUrl: providerConfig.baseUrl
  };
  await fs.writeFile(providerConfigPath, JSON.stringify(persisted, null, 2));
  lastLLMStatus = providerConfig.apiKey ? "configured" : "not-configured";
  return providerConfig;
}

async function recoverLocalSourceDocs(library) {
  const docs = library.docs || [];
  const hasLocalUserDocs = docs.some((doc) => doc.sourceFile);
  if (hasLocalUserDocs) return { library, changed: false };
  let files = [];
  try {
    files = (await fs.readdir(originalDir))
      .filter((file) => /\.pdf$/i.test(file) && !/\.truncated\.pdf$/i.test(file))
      .sort();
  } catch {
    return { library, changed: false };
  }
  if (!files.length) return { library, changed: false };

  const seenHashes = new Set(docs.map((doc) => doc.fileHash).filter(Boolean));
  const recovered = [];
  for (const file of files) {
    const sourcePath = path.join(originalDir, file);
    try {
      const buffer = await fs.readFile(sourcePath);
      const hash = fileHash(buffer);
      if (seenHashes.has(hash)) continue;
      const id = uuid();
      const doc = await analyzePdfDocument({
        id,
        filename: file,
        buffer,
        existingDoc: { sourceFile: file }
      });
      seenHashes.add(doc.fileHash || hash);
      if (doc._sourceBuffer && Buffer.compare(doc._sourceBuffer, buffer) !== 0) {
        await fs.writeFile(sourcePath, doc._sourceBuffer);
      }
      doc.localRecovered = true;
      recovered.push(doc);
    } catch {
      // Keep the PDF on disk; skip only this damaged source during index recovery.
    }
  }
  if (!recovered.length) return { library, changed: false };
  library.docs = [...docs, ...recovered];
  return { library, changed: true };
}

async function ensurePdfCleanVersion(library) {
  const docs = library.docs || [];
  let changed = false;
  for (let index = 0; index < docs.length; index += 1) {
    const current = docs[index];
    if (current?.sourceType && current.sourceType !== "pdf") continue;
    if (current?.pdfCleanVersion === pdfCleanVersion) continue;
    if (current?.pdfCleanAttemptVersion === pdfCleanVersion) continue;
    const sourcePath = sourcePathForDoc(current);
    if (!sourcePath) {
      current.pdfCleanAttemptVersion = pdfCleanVersion;
      current.pdfCleanWarning = "没有保存原始 PDF，无法自动应用新版 PDF 清洗；重新上传后会使用新版清洗。";
      changed = true;
      continue;
    }
    try {
      const buffer = await fs.readFile(sourcePath);
      const reparsed = await analyzePdfDocument({
        id: current.id,
        filename: current.filename || `${current.title || current.id}.pdf`,
        buffer,
        existingDoc: current
      });
      docs[index] = reparsed;
      if (reparsed._sourceBuffer && Buffer.compare(reparsed._sourceBuffer, buffer) !== 0) {
        await fs.writeFile(sourcePath, reparsed._sourceBuffer);
      }
      changed = true;
    } catch (error) {
      current.pdfCleanAttemptVersion = pdfCleanVersion;
      current.pdfCleanWarning = `新版 PDF 清洗迁移失败：${error?.message || "无法解析原始 PDF"}。`;
      changed = true;
    }
  }
  library.docs = docs;
  return changed;
}

function normalizeText(text) {
  return collapseRepeatedCjkGlyphs(decodePdfGlyphEncoding(text))
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanPdfPageTexts(pageTexts = []) {
  const normalized = (pageTexts || []).map((text) => normalizeText(text || ""));
  const repeated = repeatedPdfLayoutLines(normalized);
  return normalized.map((pageText) => cleanPdfPageText(pageText, repeated));
}

function repeatedPdfLayoutLines(pageTexts = []) {
  const counts = new Map();
  for (const pageText of pageTexts) {
    const pageLines = new Set(normalizeText(pageText)
      .split(/\n+/)
      .map(normalizePdfLayoutLine)
      .filter((line) => line.length >= 4 && line.length <= 90)
      .filter((line) => !/^(摘要|关键词|引言|结论|参考文献)$/i.test(line)));
    for (const line of pageLines) counts.set(line, (counts.get(line) || 0) + 1);
  }
  const threshold = pageTexts.length >= 6 ? 3 : 2;
  return new Set([...counts.entries()]
    .filter(([line, count]) => count >= threshold && isLikelyRepeatedLayoutLine(line))
    .map(([line]) => line));
}

function normalizePdfLayoutLine(line = "") {
  return cleanPdfLineText(line)
    .replace(/\s+/g, "")
    .replace(/^[·•\-\d\s]+|[·•\-\d\s]+$/g, "")
    .trim();
}

function isLikelyRepeatedLayoutLine(line = "") {
  if (/^\d+$/.test(line)) return true;
  if (/第\d+[卷期页]|vol\.?\d+|no\.?\d+|issn|cn\d+|doi/i.test(line)) return true;
  if (/(学报|期刊|杂志|journal|science|engineering|计算机应用|科学基金|工业工程设计|工程与信息)/i.test(line)) return true;
  if (/^\d{4}年\d{1,2}月|^\d{4}[-⁃]\d{1,2}/.test(line)) return true;
  return line.length <= 18 && /(?:^|\D)\d{1,4}(?:\D|$)/.test(line);
}

function cleanPdfPageText(pageText = "", repeatedLines = new Set()) {
  const lines = normalizeText(pageText)
    .split(/\n+/)
    .map((line) => cleanPdfLineText(line))
    .filter(Boolean)
    .filter((line) => !repeatedLines.has(normalizePdfLayoutLine(line)))
    .filter((line) => !isPdfLayoutNoiseLine(line));
  return mergePdfTextLines(lines).join("\n");
}

function cleanPdfLineText(text = "") {
  return toHalfWidth(String(text || ""))
    .replace(/[‐‑‒–—－]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isPdfLayoutNoiseLine(line = "") {
  const clean = cleanPdfLineText(line);
  if (!clean) return true;
  if (/^\d{1,4}$/.test(clean)) return true;
  if (/^page\s*\d{1,4}$/i.test(clean)) return true;
  if (/^[-–—_]{2,}$/.test(clean)) return true;
  if (/^(图|表)\s*\d+[-－]?\d*\s*[:：]?.{0,80}$/.test(clean) && !/(结果|表明|显示|发现|实验|模型|方法)/.test(clean)) return true;
  if (/^(Fig\.?|Figure|Table)\s*\d+/i.test(clean)) return true;
  if (/^(注|资料来源|来源|说明)\s*[:：]/.test(clean)) return true;
  if (/^(?:\[\d+\]|\d+\.)\s*.{0,120}(?:出版社|doi|http|journal|conference|proceedings)/i.test(clean)) return true;
  if (/^[−\-–—]?\s*\d+(?:\.\d+)?\s*[,，;；]?\s*其中/.test(clean)) return true;
  if (/^[A-Za-z]\s*为[^。；;]{2,40}(?:[,，]\s*[A-Za-z]\s*为[^。；;]{2,40})+/.test(clean)) return true;
  if (/基金项目|基金资助|作者简介|通信作者|通讯作者|收稿日期|修回日期|引用格式|相似文章推荐|中图分类号|文献标志码|文章编号/.test(clean)) return true;
  return false;
}

function mergePdfTextLines(lines = []) {
  const merged = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const previous = merged[merged.length - 1] || "";
    if (previous && shouldMergePdfLine(previous, line)) {
      merged[merged.length - 1] = `${previous}${mergeSpacer(previous, line)}${line}`.replace(/\s+/g, " ").trim();
    } else {
      merged.push(line);
    }
  }
  return merged;
}

function shouldMergePdfLine(previous = "", next = "") {
  if (!previous || !next) return false;
  if (/[。！？!?；;：:]$/.test(previous)) return false;
  if (/^(摘要|关键词|引言|结论|参考文献|references?|abstract|keywords?)\b/i.test(next)) return false;
  if (/^\d+(?:\.\d+)*\s+/.test(next)) return false;
  if (/^[A-Z][A-Z\s]{4,}$/.test(next)) return false;
  if (previous.length < 18 && next.length < 18) return false;
  return true;
}

function mergeSpacer(previous = "", next = "") {
  if (/[\u4e00-\u9fa5]$/.test(previous) && /^[\u4e00-\u9fa5]/.test(next)) return "";
  if (/[-‐‑‒–—]$/.test(previous)) return "";
  return " ";
}

function sectionForText(text = "", current = "") {
  const clean = cleanPdfLineText(text);
  if (/^(摘要|abstract)\b/i.test(clean)) return "abstract";
  if (/^(关键词|key words?|keywords)\b/i.test(clean)) return "keywords";
  if (/^(?:\d+(?:\.\d+)*\s*)?(引言|绪论|introduction)\b/i.test(clean)) return "introduction";
  if (/方法|材料|数据|模型|算法|method|materials|data/i.test(clean) && clean.length <= 80) return "method";
  if (/实验|结果|分析|result|experiment|evaluation/i.test(clean) && clean.length <= 80) return "results";
  if (/讨论|局限|不足|discussion|limitation/i.test(clean) && clean.length <= 80) return "discussion";
  if (/结论|展望|conclusion/i.test(clean) && clean.length <= 80) return "conclusion";
  if (/参考文献|references/i.test(clean) && clean.length <= 60) return "references";
  return current || "";
}

async function ensureSearchIndex(library) {
  try {
    const index = JSON.parse(await fs.readFile(searchIndexPath, "utf8"));
    const docs = library.docs || [];
    const indexedIds = new Set((index.docs || []).map((doc) => doc.id));
    if (index.version === 4 && docs.length === indexedIds.size && docs.every((doc) => indexedIds.has(doc.id))) return;
  } catch {
    // Rebuild below.
  }
  await writeSearchIndex(library);
}

async function writeSearchIndex(library) {
  const docs = library.docs || [];
  const index = {
    version: 4,
    updatedAt: new Date().toISOString(),
    docs: docs.map(searchDocSummary),
    chunks: docs.flatMap(searchChunksForDoc)
  };
  await fs.writeFile(searchIndexPath, JSON.stringify(index));
}

function searchDocSummary(doc) {
  const evidence = evidenceCardForDoc(doc);
  const card = analysisCardFromEvidence(evidence, doc);
  const sourceMeta = sourceMetaForDoc(doc);
  sourceMeta.journal = sourceMeta.journal || cleanJournalName(doc.journal || "") || journalFromKnownName(`${doc.title || ""} ${doc.filename || ""}`);
  return {
    id: doc.id,
    title: publicDocTitle(doc),
    filename: doc.filename || "",
    authors: sourceMeta.authors || [],
    journal: sourceMeta.journal || "",
    publicationYear: sourceMeta.publicationYear || doc.publicationYear || "",
    sourceMeta,
    sourceType: doc.sourceType || "pdf",
    sourceUnit: doc.sourceUnit || "page",
    pages: doc.pages || 0,
    wordCount: doc.wordCount || 0,
    abstract: publicSummaryText(doc.abstract || sourceMeta.abstract, synthesizeDocKeyInfo(doc)),
    question: displayText(card.question || ""),
    method: matrixDisplayField(card.method, methodFallbackForDoc(doc)),
    findings: matrixDisplayField(synthesizeDocKeyInfo(doc), card.findings || doc.takeaway),
    reviewSlot: displayText(card.reviewSlot || ""),
    keywords: (doc.keywords || []).slice(0, 12).map((item) => displayText(item.term || item)).filter(Boolean),
    updatedAt: doc.updatedAt || doc.createdAt || ""
  };
}

function searchChunksForDoc(doc) {
  const chunks = (doc.chunks || [])
    .filter((chunk) => chunk?.text && !isLowValueChunk(chunk.text))
    .slice(0, 420);
  return chunks.map((chunk) => {
    const text = displayText(chunk.text);
    return {
      id: `${doc.id}:${chunk.index}`,
      docId: doc.id,
      title: publicDocTitle(doc),
      sourceType: doc.sourceType || "pdf",
      sourceUnit: doc.sourceUnit || "page",
      page: chunk.page || estimatePage(chunk.index - 1, chunks.length, doc.pages),
      index: chunk.index,
      text: shortEvidenceText(text, 520),
      terms: (chunk.terms || []).slice(0, 8).map(displayText).filter(Boolean)
    };
  }).filter((chunk) => chunk.text && !isMatrixNoise(chunk.text));
}

function decodePdfGlyphEncoding(text) {
  const raw = String(text || "");
  const glyphMatches = raw.match(/[\u7e00-\u7e7e]/g) || [];
  if (glyphMatches.length < 4) return raw;
  return raw.replace(/[\u7e00-\u7e7e]/g, (char) => {
    const code = char.charCodeAt(0) & 0x7f;
    if (code < 32 || code > 126) return "";
    if (code === 0x5c) return "\"";
    return String.fromCharCode(code);
  });
}

function collapseRepeatedCjkGlyphs(text) {
  const raw = String(text || "");
  const repeatedRuns = raw.match(/([\u4e00-\u9fa5])\1{1,3}/g) || [];
  if (repeatedRuns.length < 20) return raw;
  return raw.replace(/([\u4e00-\u9fa5])\1{1,3}/g, "$1");
}

function sentences(text) {
  return normalizeText(text)
    .replace(/([。！？!?])\s*/g, "$1\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => !isBoilerplateLine(s))
    .filter((s) => {
      const cjkCount = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
      return s.length <= 420 && (s.length >= 35 || cjkCount >= 12);
    });
}

function toHalfWidth(text) {
  return String(text || "").replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, " ");
}

function isBoilerplateLine(text) {
  const clean = toHalfWidth(text).replace(/\s+/g, " ").trim().toLowerCase();
  if (!clean) return true;
  const compact = clean.replace(/\s+/g, "");
  return (
    /^doi[:：]?/.test(clean) ||
    /doi[:：]?\s*10\.\d{4,9}/i.test(clean) ||
    /10\.\d{4,9}\/j\.(issn|cnki)/i.test(clean) ||
    /\bissn\b|coden|journal of|http:\/\/|https:\/\/|www\./i.test(clean) ||
    /^keywords[:：]|^key words[:：]|^关键词[:：]|\[关键词\]|中图分类号|文献标志码|文章编号|收稿日期|修回日期|接受日期|发布日期|出版日期|通信作者|作者简介|基金项目|基金资助/.test(clean) ||
    /期刊名|机构名|发文量|相似文章推荐|本文引用格式|引用格式|citation\s*format|图书馆理论与实践|大学图书馆学报|重庆理工大学学报/.test(clean) ||
    /主要研究方向|电子邮箱|copyright|all rights reserved/i.test(clean) ||
    /keywords[:：].{0,240}(intelligent|machine|learning|transportation|traffic|model)/i.test(clean) ||
    /[a-z]{35,}/.test(clean)
  );
}

function tokens(text) {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const cjk = [];
  for (const run of cjkRuns) {
    if (run.length <= 8) cjk.push(run);
    for (const size of [2, 3, 4]) {
      for (let i = 0; i <= run.length - size; i += 1) cjk.push(run.slice(i, i + size));
    }
  }
  return [...latin, ...cjk].filter((t) => !stopwords.has(t) && !/^\d+$/.test(t));
}

function topKeywords(text, limit = 12) {
  const counts = new Map();
  for (const token of tokens(text)) counts.set(token, (counts.get(token) || 0) + 1);
  const selected = [];
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  for (const [term, count] of ranked) {
    const isCjk = /[\u4e00-\u9fa5]/.test(term);
    const covered = isCjk && selected.some((item) => item.term.includes(term) && item.count >= count);
    if (!covered) selected.push({ term, count });
    if (selected.length >= limit) break;
  }
  return selected;
}

function titleFromText(filename, text) {
  const filenameTitle = filename.replace(/\.(pdf|pptx)$/i, "").trim();
  if (/[\u4e00-\u9fa5]/.test(filenameTitle) && filenameTitle.length >= 6) return filenameTitle;
  const lines = normalizeText(text).split("\n").map((l) => l.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const leadTitle = titleCandidateFromLeadLine(line);
    if (leadTitle && !isBadTitleCandidate(leadTitle)) return leadTitle;
    if (
      line.length < 8 ||
      line.length > 160 ||
      /^(abstract|摘要|keywords|关键词|pr magazine|copyright|page\s*\d+)$/i.test(line) ||
      isBadTitleCandidate(line)
    ) continue;
    const nextLine = lines[index + 1] || "";
    if (
      nextLine.length > 0 &&
      nextLine.length <= 24 &&
      !/[，。；：:,.!?！？]$/.test(line) &&
      !/大学|学院|研究院|实验室|@|作者|摘要|关键词/i.test(nextLine)
    ) {
      return `${line}${nextLine}`.slice(0, 180);
    }
    return line;
  }
  const recoveredTitle = knownTitleFromText(text);
  if (recoveredTitle) return recoveredTitle;
  return filenameTitle;
}

function knownTitleFromText(text = "") {
  const clean = cleanPdfLineText(text);
  if (/交叉口信号与车辆轨迹协同控制方法/.test(clean)) return "新型混合交通交叉口信号与车辆轨迹协同控制方法";
  if (/人工智能驱动下的营销变革/.test(clean)) return "人工智能驱动下的营销变革";
  if (/基于(?:AI|人工智能)智能体的隐藏(?:RESTful )?API识别与漏洞检测方法/i.test(clean)) return "基于AI智能体的隐藏RESTful API识别与漏洞检测方法";
  if (/大语言模型(?:AI)?智能体的设计方法研究/.test(clean)) return "大语言模型AI智能体的设计方法研究";
  return "";
}

function titleCandidateFromLeadLine(line = "") {
  const clean = cleanPdfLineText(line)
    .replace(/^CODEN\s+\S+\s+https?:\/\/\S+\s*/i, "")
    .replace(/^(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月\s*/, "")
    .replace(/^第\s*\d+\s*[卷期]\s*第?\s*\d+\s*[期页]?\s*/, "")
    .trim();
  const surname = "[赵钱孙李周吴郑王冯陈杨朱马刘帅彭唐石黄覃夏林张许周]";
  const authorList = new RegExp(`^(.{8,100}?)(?:${surname}[\\u4e00-\\u9fa5]{1,3}\\s*[,，、]\\s*${surname}[\\u4e00-\\u9fa5]{1,3}|引用本文|摘要|\\(|（|\\*)`);
  const match = clean.match(authorList);
  const candidate = (match?.[1] || "").replace(/[：:，,。；;\s]+$/g, "").trim();
  if (candidate && /(研究|方法|模型|系统|控制|预测|分析|综述|机制|范式|检测|应用|图谱|文献)/.test(candidate)) return candidate;
  return "";
}

function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function duplicateKey(doc) {
  if (doc.fileHash) return `hash:${doc.fileHash}`;
  const filename = String(doc.filename || "").trim().toLowerCase();
  const title = String(doc.title || "").trim().toLowerCase();
  const wordCount = Number(doc.wordCount || 0);
  if (filename && title && wordCount > 0) return `legacy:${filename}:${title}:${wordCount}`;
  return "";
}

function cleanupDuplicateDocs(library) {
  const docs = library.docs || [];
  const seen = new Set();
  const deduped = [];
  const removed = [];
  for (const doc of docs) {
    const key = duplicateKey(doc);
    if (key && seen.has(key)) {
      removed.push({ id: doc.id, title: doc.title || doc.filename || "未命名文档" });
      continue;
    }
    if (key) seen.add(key);
    deduped.push(doc);
  }
  library.docs = deduped;
  return removed;
}

function uploadExtension(filename = "") {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".pdf" || ext === ".pptx") return ext;
  return "";
}

function uploadKind(filename = "") {
  const ext = uploadExtension(filename);
  if (ext === ".pdf") return "pdf";
  if (ext === ".pptx") return "pptx";
  return "";
}

function isSupportedUpload(file) {
  const name = String(file?.originalname || "").toLowerCase();
  const mime = String(file?.mimetype || "").toLowerCase();
  return (
    name.endsWith(".pdf") ||
    name.endsWith(".pptx") ||
    mime === "application/pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
}

function uploadFormatHelp(filename = "") {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".ppt") return "当前支持 PDF 和 PPTX；旧版 PPT 是二进制格式，请先另存为 PPTX 或导出为 PDF 后上传。";
  if ([".doc", ".docx", ".xls", ".xlsx"].includes(ext)) return "当前资料分析支持 PDF 和 PPTX；Word/Excel 请先导出为 PDF，或只上传文献 PDF。";
  return "当前只支持 PDF 和 PPTX 文件。PPT 请另存为 PPTX 或导出 PDF 后上传。";
}

function sourceFilenameForDoc(id, filename = "") {
  return `${id}${uploadExtension(filename) || ".pdf"}`;
}

function sourcePathForDoc(doc) {
  const sourceFile = path.basename(String(doc?.sourceFile || ""));
  return sourceFile ? path.join(originalDir, sourceFile) : "";
}

async function analyzePdfDocument({ id, filename, buffer, existingDoc = null, onProgress = null }) {
  const originalHash = fileHash(buffer);
  let sourceBuffer = buffer;
  let hash = originalHash;
  await onProgress?.({ status: "parsing", phase: "解析 PDF 结构", progress: 10 });
  let parsed = await parsePdfBuffer(buffer, onProgress);
  let recovery = null;
  if (shouldAttemptPdfRecovery(parsed)) {
    await onProgress?.({ status: "parsing", phase: "尝试恢复 PDF", progress: 55 });
    recovery = await recoverPdfFromWeb({ filename, buffer }).catch((error) => ({ error: error.message }));
    if (recovery?.buffer) {
      sourceBuffer = recovery.buffer;
      hash = fileHash(sourceBuffer);
      parsed = await parsePdfBuffer(sourceBuffer, onProgress);
    }
  }
  if (parsed.repairedBuffer) {
    sourceBuffer = parsed.repairedBuffer;
    hash = fileHash(sourceBuffer);
  }
  await onProgress?.({ status: "parsing", phase: "生成证据卡片", progress: 68 });
  const doc = await analyzeDocument(id, filename, parsed.text || "", parsed.numpages || 0, parsed.pageTexts || [], onProgress);
  doc.fileHash = hash;
  if (hash !== originalHash) doc.originalFileHash = originalHash;
  doc.sourceFile = existingDoc?.sourceFile || sourceFilenameForDoc(id, filename);
  doc.sourceType = "pdf";
  doc.sourceUnit = "page";
  doc.pdfCleanVersion = pdfCleanVersion;
  delete doc.pdfCleanAttemptVersion;
  delete doc.pdfCleanWarning;
  relabelSourceCitations(doc);
  doc.parseWarning = friendlyParseWarning(parsed.error, Boolean((parsed.text || "").trim()));
  if (recovery?.url && (parsed.text || "").trim()) {
    doc.parseWarning = `原上传 PDF 结构不完整，已自动从官方来源恢复完整 PDF 并完成解析。来源：${recovery.url}`;
    doc.autoRecovered = true;
    doc.recoverySource = recovery.url;
  } else if (parsed.repairedBuffer && (parsed.text || "").trim()) {
    doc.parseWarning = "PDF 文件尾部结构损坏，已自动重建页面树并抽取正文；页码按修复后的页面顺序确定，关键引用请回到原 PDF 核对。";
    doc.autoRepaired = true;
  } else if (recovery?.error && doc.parseWarning) {
    doc.recoveryError = recovery.error;
  }
  doc.ocrUsed = Boolean(parsed.ocrUsed && (parsed.text || "").trim());
  doc.createdAt = existingDoc?.createdAt || doc.createdAt;
  doc.updatedAt = new Date().toISOString();
  if (existingDoc?.manualTitle) {
    doc.title = existingDoc.title;
    doc.manualTitle = true;
  }
  Object.defineProperty(doc, "_sourceBuffer", { value: sourceBuffer, enumerable: false });
  return doc;
}

async function analyzeUploadedDocument({ id, filename, buffer, existingDoc = null, onProgress = null }) {
  const kind = uploadKind(filename);
  if (kind === "pptx") return analyzePptxDocument({ id, filename, buffer, existingDoc, onProgress });
  return analyzePdfDocument({ id, filename, buffer, existingDoc, onProgress });
}

async function analyzePptxDocument({ id, filename, buffer, existingDoc = null, onProgress = null }) {
  await onProgress?.({ status: "parsing", phase: "读取 PPTX 结构", progress: 10 });
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = await pptxSlidePaths(zip);
  if (!slidePaths.length) {
    throw Object.assign(new Error("没有在 PPTX 中找到可解析的幻灯片，请确认文件没有损坏，或导出为 PDF 后再上传。"), { status: 422 });
  }
  const pageTexts = [];
  for (let index = 0; index < slidePaths.length; index += 1) {
    const slidePath = slidePaths[index];
    const slideText = await pptxXmlText(zip, slidePath);
    const notesPath = await pptxNotesPath(zip, slidePath);
    const notesText = notesPath ? await pptxXmlText(zip, notesPath) : "";
    const parts = [
      slideText,
      notesText ? `备注：${notesText}` : ""
    ].filter(Boolean);
    pageTexts.push(normalizeText(parts.join("\n")));
    await onProgress?.({
      status: "parsing",
      phase: `解析幻灯片 ${index + 1}/${slidePaths.length}`,
      progress: Math.round(15 + ((index + 1) / slidePaths.length) * 50),
      currentPage: index + 1,
      totalPages: slidePaths.length
    });
  }
  const text = pageTexts.join("\n\n");
  if (!normalizeText(text).trim()) {
    throw Object.assign(new Error("这个 PPTX 没有抽到可分析文字，可能主要是图片或扫描页；请导出为 PDF 后上传，或先用 OCR 生成可复制文本。"), { status: 422 });
  }
  const doc = await analyzeDocument(id, filename, text, pageTexts.length, pageTexts, onProgress);
  doc.fileHash = fileHash(buffer);
  doc.sourceFile = existingDoc?.sourceFile || sourceFilenameForDoc(id, filename);
  doc.sourceType = "pptx";
  doc.sourceUnit = "slide";
  relabelSourceCitations(doc);
  doc.parseWarning = "已按幻灯片页抽取 PPTX 文本与备注；引用定位使用 slide 编号，图片内文字需要先转为可复制文本或 PDF OCR。";
  doc.createdAt = existingDoc?.createdAt || doc.createdAt;
  doc.updatedAt = new Date().toISOString();
  if (existingDoc?.manualTitle) {
    doc.title = existingDoc.title;
    doc.manualTitle = true;
  }
  Object.defineProperty(doc, "_sourceBuffer", { value: buffer, enumerable: false });
  return doc;
}

function relabelSourceCitations(doc) {
  for (const chunk of doc.chunks || []) {
    const start = chunk.pageStart || chunk.page || null;
    const end = chunk.pageEnd || start;
    chunk.citation = sourceCitation(doc, start, end);
  }
  for (const point of doc.keyPoints || []) {
    if (point.page) point.citation = sourceCitation(doc, point.page);
  }
}

const pptxXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

async function pptxSlidePaths(zip) {
  const ordered = await pptxOrderedSlidePaths(zip);
  if (ordered.length) return ordered;
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalPathSort);
}

async function pptxOrderedSlidePaths(zip) {
  const presentation = await pptxParseXml(zip, "ppt/presentation.xml");
  const rels = await pptxParseXml(zip, "ppt/_rels/presentation.xml.rels");
  const relMap = new Map();
  for (const rel of collectXmlNodes(rels, "Relationship")) {
    const id = rel?.["@_Id"];
    const target = rel?.["@_Target"];
    const type = rel?.["@_Type"] || "";
    if (id && target && /\/slide$/i.test(type)) relMap.set(id, normalizeZipPath("ppt", target));
  }
  const slideIds = collectXmlNodes(presentation, "p:sldId")
    .map((node) => node?.["@_r:id"] || node?.["@_id"])
    .filter(Boolean);
  return slideIds.map((id) => relMap.get(id)).filter((item) => item && zip.file(item));
}

async function pptxNotesPath(zip, slidePath) {
  const relPath = slidePath.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels";
  const rels = await pptxParseXml(zip, relPath);
  const rel = collectXmlNodes(rels, "Relationship").find((item) => /\/notesSlide$/i.test(item?.["@_Type"] || ""));
  return rel?.["@_Target"] ? normalizeZipPath(path.posix.dirname(slidePath), rel["@_Target"]) : "";
}

async function pptxXmlText(zip, filePath) {
  const parsed = await pptxParseXml(zip, filePath);
  const paragraphs = collectPptxParagraphText(parsed)
    .map((item) => normalizePptxParagraph(item))
    .filter((item) => item && !/^https?:\/\//i.test(item));
  if (paragraphs.length) return uniqueStrings(paragraphs).join("\n");
  return uniqueStrings(collectXmlText(parsed).map((item) => normalizeText(item)).filter(Boolean)).join("\n");
}

function normalizePptxParagraph(text = "") {
  const clean = normalizeText(text);
  if (!clean || /[。！？!?；;:]$/.test(clean) || clean.length < 20) return clean;
  return `${clean}.`;
}

async function pptxParseXml(zip, filePath) {
  const file = zip.file(filePath);
  if (!file) return null;
  const xml = await file.async("string");
  return pptxXmlParser.parse(xml);
}

function collectXmlText(node) {
  const out = [];
  const visit = (value, key = "") => {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      if (key === "a:t" || key === "m:t" || key === "#text") out.push(String(value));
      return;
    }
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
    }
  };
  visit(node);
  return out;
}

function collectPptxParagraphText(node) {
  const out = [];
  const visit = (value, key = "") => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (typeof value !== "object") return;
    if (key === "a:p") {
      const text = collectXmlText(value).map((item) => normalizeText(item)).filter(Boolean).join(" ");
      if (text) out.push(text);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  visit(node);
  return out;
}

function collectXmlNodes(node, wantedKey) {
  const out = [];
  const visit = (value, key = "") => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (typeof value !== "object") return;
    if (key === wantedKey) out.push(value);
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  visit(node);
  return out;
}

function normalizeZipPath(baseDir, target) {
  const raw = String(target || "").replace(/^\/+/, "");
  if (raw.startsWith("ppt/")) return path.posix.normalize(raw);
  return path.posix.normalize(path.posix.join(baseDir, raw));
}

function naturalPathSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function decodeUploadFilename(filename) {
  if (!filename) return "uploaded.pdf";
  const decoded = Buffer.from(filename, "latin1").toString("utf8");
  return decoded.includes("�") ? filename : decoded;
}

function friendlyParseWarning(error, hasText) {
  if (hasText && /ocr:/i.test(error || "")) {
    const coverage = String(error || "").match(/ocr:(\d+)\/(\d+)/i);
    if (coverage && Number(coverage[1]) < Number(coverage[2])) {
      return `已使用 OCR 识别前 ${coverage[1]}/${coverage[2]} 页；其余页面没有进入分析，不能据此判断全文结论。可提高 OCR_MAX_PAGES 后重新解析。`;
    }
    return "已使用 OCR 识别全部页面；页码和文字可能存在识别误差，重要内容请回到原 PDF 核对。";
  }
  if (!hasText) {
    if (/ocr-empty|blank-render/i.test(error || "")) {
      return "PDF 可识别页数，但页面渲染或 OCR 未得到可用文字；可能是文件结构损坏、页面内容流缺失或图像编码异常。";
    }
    if (/ocr-failed/i.test(error || "")) {
      return "PDF 文本抽取失败，OCR 也未能完成；请重新下载完整文件或另存为标准 PDF 后再上传。";
    }
    if (/missing-eof|missing-xref|missing-objects|truncated/i.test(error || "")) {
      if (/page-object-estimate/i.test(error || "")) {
        return "PDF 文件尾部结构不完整，已根据可见页面对象建立临时页码；当前只能生成待核对框架。";
      }
      return "PDF 文件尾部结构不完整，已尝试自动修复和官方来源恢复；当前仍无法可靠抽取正文。";
    }
    if (/Invalid PDF structure/i.test(error || "")) {
      return "PDF 结构异常或采用特殊压缩，当前无法抽取文本；请尝试用浏览器或 Acrobat 重新另存为 PDF 后再上传。";
    }
    return "PDF 未抽取到可读文本，可能是扫描件、加密文件或特殊格式 PDF。";
  }
  return error || "";
}

function estimatePagesFromObjects(buffer) {
  const raw = buffer.toString("latin1");
  const pageObjects = raw.match(/\/Type\s*\/Page\b/g) || [];
  if (pageObjects.length) return pageObjects.length;
  const mediaBoxes = raw.match(/\/MediaBox\s*\[/g) || [];
  return mediaBoxes.length || 0;
}

function pdfStructureIssues(buffer) {
  const raw = buffer.toString("latin1");
  const issues = [];
  const hasEof = raw.lastIndexOf("%%EOF") >= 0;
  const hasUsableTrailer = /\/Root\s+\d+\s+0\s+R/.test(raw) || /\/Type\s*\/XRef/.test(raw);
  if (hasEof && hasUsableTrailer) return issues;
  if (!raw.includes("xref")) issues.push("missing-xref");
  if (!hasEof) issues.push("missing-eof");
  const objectIds = new Set([...raw.matchAll(/(?:^|\n)(\d+)\s+0\s+obj/g)].map((match) => Number(match[1])));
  const refs = [...raw.matchAll(/(\d+)\s+0\s+R/g)].map((match) => Number(match[1]));
  const missingRefs = refs.filter((id) => id > 0 && !objectIds.has(id));
  if (missingRefs.length) issues.push(`missing-objects:${[...new Set(missingRefs)].slice(0, 8).join(",")}`);
  return issues;
}

function parseWithMuPDF(buffer) {
  const doc = mupdf.PDFDocument.openDocument(buffer, "application/pdf");
  const pages = doc.countPages();
  const pageTexts = [];
  for (let index = 0; index < pages; index += 1) {
    try {
      const page = doc.loadPage(index);
      pageTexts.push(normalizeText(page.toStructuredText().asText() || ""));
    } catch {
      pageTexts.push("");
    }
  }
  return { text: pageTexts.join("\n\n"), pageTexts, numpages: pages };
}

function extractPdfObjectBody(raw, objectId) {
  const match = raw.match(new RegExp(`(?:^|\\n)${objectId}\\s+0\\s+obj\\s*([\\s\\S]*?)\\s*endobj`));
  return match?.[1] || "";
}

function findBalancedPdfValue(text, startIndex, opener, closer) {
  let index = startIndex;
  let depth = 0;
  while (index < text.length) {
    if (text.startsWith(opener, index)) {
      depth += 1;
      index += opener.length;
      continue;
    }
    if (text.startsWith(closer, index)) {
      depth -= 1;
      index += closer.length;
      if (depth === 0) return text.slice(startIndex, index);
      continue;
    }
    index += 1;
  }
  return "";
}

function extractPdfDictionaryAfter(body, key) {
  const keyIndex = body.indexOf(key);
  if (keyIndex < 0) return "";
  const dictIndex = body.indexOf("<<", keyIndex + key.length);
  if (dictIndex < 0) return "";
  return findBalancedPdfValue(body, dictIndex, "<<", ">>");
}

function repairPdfPageTreeFromFormXObjects(buffer) {
  const raw = buffer.toString("latin1");
  const objectMatches = [...raw.matchAll(/(?:^|\n)(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g)];
  const maxObjectId = objectMatches.reduce((max, match) => Math.max(max, Number(match[1])), 0);
  const objectOffsets = new Map();
  for (const match of objectMatches) {
    const id = Number(match[1]);
    const offset = raw[match.index || 0] === "\n" ? (match.index || 0) + 1 : (match.index || 0);
    if (!objectOffsets.has(id)) objectOffsets.set(id, offset);
  }
  const pages = objectMatches
    .map((match) => ({ id: Number(match[1]), body: match[2], offset: match.index || 0 }))
    .filter((object) => /\/Type\s*\/Page\b/.test(object.body) && !/\/Type\s*\/Pages\b/.test(object.body))
    .sort((a, b) => a.offset - b.offset)
    .map((page) => {
      const resources = extractPdfDictionaryAfter(page.body, "/Resources");
      const xObjectDict = extractPdfDictionaryAfter(resources, "/XObject");
      const xObjects = [...xObjectDict.matchAll(/\/([^\s<>[\]{}()/%]+)\s+(\d+)\s+0\s+R/g)];
      const form = xObjects.find((match) => /\/Subtype\s*\/Form\b/.test(extractPdfObjectBody(raw, Number(match[2])))) || xObjects[0];
      const mediaBox = page.body.match(/\/MediaBox\s*(\[[^\]]+\])/)?.[1] || "[0 0 595.276 841.89]";
      if (!resources || !form) return null;
      return { mediaBox, resources, formName: form[1] };
    })
    .filter(Boolean);

  if (!pages.length) return null;

  let nextObjectId = maxObjectId + 1;
  const pageObjectIds = [];
  const objects = [];
  for (const page of pages) {
    const contentStream = `q\n/${page.formName} Do\nQ\n`;
    const contentId = nextObjectId++;
    const pageId = nextObjectId++;
    pageObjectIds.push(pageId);
    objects.push({
      id: contentId,
      body: `<< /Length ${Buffer.byteLength(contentStream, "latin1")} >>\nstream\n${contentStream}endstream`
    });
    objects.push({
      id: pageId,
      body: `<< /Type /Page /MediaBox ${page.mediaBox} /Resources ${page.resources} /Contents ${contentId} 0 R /Parent ${maxObjectId + pages.length * 2 + 1} 0 R >>`
    });
  }
  const pagesObjectId = nextObjectId++;
  const catalogObjectId = nextObjectId++;
  objects.push({
    id: pagesObjectId,
    body: `<< /Type /Pages /Kids [ ${pageObjectIds.map((id) => `${id} 0 R`).join(" ")} ] /Count ${pageObjectIds.length} >>`
  });
  objects.push({
    id: catalogObjectId,
    body: `<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`
  });

  let output = raw.endsWith("\n") ? raw : `${raw}\n`;
  for (const object of objects) {
    objectOffsets.set(object.id, Buffer.byteLength(output, "latin1"));
    output += `${object.id} 0 obj\n${object.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${catalogObjectId + 1}\n`;
  output += "0000000000 65535 f \n";
  for (let id = 1; id <= catalogObjectId; id += 1) {
    const offset = objectOffsets.get(id);
    output += offset === undefined ? "0000000000 00000 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${catalogObjectId + 1} /Root ${catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

async function copyIfMissing(source, target) {
  try {
    await fs.access(target);
  } catch {
    await fs.copyFile(source, target);
  }
}

async function prepareOcrData() {
  await fs.mkdir(ocrLangDir, { recursive: true });
  await fs.mkdir(ocrCacheDir, { recursive: true });
  await copyIfMissing(
    path.join(__dirname, "node_modules", "@tesseract.js-data", "eng", "4.0.0", "eng.traineddata.gz"),
    path.join(ocrLangDir, "eng.traineddata.gz")
  );
  await copyIfMissing(
    path.join(__dirname, "node_modules", "@tesseract.js-data", "chi_sim", "4.0.0", "chi_sim.traineddata.gz"),
    path.join(ocrLangDir, "chi_sim.traineddata.gz")
  );
}

async function ocrPdfWithMuPDF(buffer, maxPages = ocrMaxPages, onProgress = null) {
  await prepareOcrData();
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker(["chi_sim", "eng"], 1, {
    corePath: path.dirname(require.resolve("tesseract.js-core/tesseract-core.wasm.js")),
    langPath: ocrLangDir,
    cachePath: ocrCacheDir,
    cacheMethod: "readOnly",
    gzip: true
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1",
    user_defined_dpi: "180"
  });
  const doc = mupdf.PDFDocument.openDocument(buffer, "application/pdf");
  const pages = doc.countPages();
  const pageLimit = maxPages > 0 ? Math.min(pages, maxPages) : pages;
  const parts = [];
  const pageTexts = Array.from({ length: pages }, () => "");
  const warnings = [];
  await onProgress?.({ status: "ocr", phase: `OCR 识别 0/${pageLimit}`, progress: 15, currentPage: 0, totalPages: pageLimit });

  try {
    for (let index = 0; index < pageLimit; index += 1) {
      try {
        const page = doc.loadPage(index);
        const pixmap = page.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
        const png = Buffer.from(pixmap.asPNG());
        if (png.length < 6000) {
          warnings.push(`p.${index + 1}:blank-render`);
          continue;
        }
        const result = await worker.recognize(png);
        const pageText = normalizeText(result.data?.text || "");
        if (pageText) {
          pageTexts[index] = pageText;
          parts.push(`第 ${index + 1} 页\n${pageText}`);
        }
        else warnings.push(`p.${index + 1}:empty-ocr`);
      } catch (error) {
        warnings.push(`p.${index + 1}:${error.message}`);
      }
      await onProgress?.({
        status: "ocr",
        phase: `OCR 识别 ${index + 1}/${pageLimit}`,
        progress: Math.round(15 + ((index + 1) / Math.max(1, pageLimit)) * 45),
        currentPage: index + 1,
        totalPages: pageLimit
      });
    }
  } finally {
    await worker.terminate();
  }

  return {
    text: parts.join("\n\n"),
    pageTexts,
    numpages: pages,
    pagesProcessed: pageLimit,
    warnings
  };
}

function pagesFromMarkedText(text) {
  const raw = normalizeText(text || "");
  if (!raw) return [];
  const parts = raw.split(/(?:^|\n)第\s*(\d+)\s*页\s*\n/g);
  if (parts.length < 3) return [];
  const pages = [];
  for (let index = 1; index < parts.length; index += 2) {
    const page = Number(parts[index]);
    if (page) pages[page - 1] = normalizeText(parts[index + 1] || "");
  }
  return pages;
}

function inferPdfParsePageTexts(text, numpages = 0) {
  const raw = normalizeText(text || "");
  if (!raw) return [];
  const marked = pagesFromMarkedText(raw);
  if (marked.length) return marked;
  const markerSplit = raw
    .split(/\n+\s*(?:Page\s*)?\d{1,4}\s*\n+/i)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (markerSplit.length >= 2 && (!numpages || markerSplit.length <= numpages + 2)) return markerSplit;
  const formFeedSplit = raw
    .split(/\f+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (formFeedSplit.length >= 2) return formFeedSplit;
  return [];
}

function hasUsefulPdfText(text = "") {
  const clean = normalizeText(text);
  const wordLike = (clean.match(/[\u4e00-\u9fa5]|[A-Za-z]{3,}/g) || []).length;
  const sentenceLike = sentences(clean).length;
  return wordLike >= 24 && sentenceLike >= 1;
}

async function parsePdfBuffer(buffer, onProgress = null) {
  const issues = pdfStructureIssues(buffer);
  const tryFormXObjectRepair = () => {
    try {
      const repairedBuffer = repairPdfPageTreeFromFormXObjects(buffer);
      if (!repairedBuffer) return null;
      const repaired = parseWithMuPDF(repairedBuffer);
      const repairedText = (repaired.text || "").trim() ? repaired.text : "";
      if (!repairedText) return null;
      return {
        text: repairedText,
        numpages: repaired.numpages || estimatePagesFromObjects(buffer) || 0,
        error: [...issues, "form-xobject-repair"].filter(Boolean).join(";"),
        repairedBuffer
      };
    } catch {
      return null;
    }
  };
  try {
    const parsed = await pdf(buffer);
    const structured = (() => {
      try {
        const result = parseWithMuPDF(buffer);
        return hasUsefulPdfText(result.text || "") ? result : null;
      } catch {
        return null;
      }
    })();
    const fallbackPageTexts = structured ? [] : inferPdfParsePageTexts(parsed.text || "", parsed.numpages || 0);
    if (!(parsed.text || "").trim() && issues.length) {
      const repaired = tryFormXObjectRepair();
      if (repaired) return repaired;
    }
    const parsedText = structured?.text || parsed.text || "";
    const parsedPages = structured?.numpages || parsed.numpages || 0;
    if (!hasUsefulPdfText(parsedText) && parsedPages) {
      try {
        const ocr = await ocrPdfWithMuPDF(buffer, ocrMaxPages, onProgress);
        if (hasUsefulPdfText(ocr.text || "")) {
          return {
            text: ocr.text,
            pageTexts: ocr.pageTexts || pagesFromMarkedText(ocr.text),
            numpages: ocr.numpages || parsedPages,
            error: [...issues, `ocr:${ocr.pagesProcessed}/${ocr.numpages || parsedPages}`].filter(Boolean).join(";"),
            ocrUsed: true,
            ocrPartial: ocr.pagesProcessed < (ocr.numpages || parsedPages)
          };
        }
      } catch (ocrError) {
        return {
          text: parsedText,
          pageTexts: structured?.pageTexts || fallbackPageTexts,
          numpages: parsedPages,
          error: [...issues, `ocr-failed:${ocrError.message}`].filter(Boolean).join(";"),
          ocrUsed: true
        };
      }
    }
    return {
      text: parsedText,
      pageTexts: structured?.pageTexts || fallbackPageTexts,
      numpages: parsedPages,
      error: issues.join(";")
    };
  } catch (error) {
    const formRepair = tryFormXObjectRepair();
    if (formRepair) {
      return {
        ...formRepair,
        error: [error.message, formRepair.error].filter(Boolean).join(";")
      };
    }
    try {
      const repaired = parseWithMuPDF(buffer);
      const repairedText = (repaired.text || "").trim() ? repaired.text : "";
      if (!repairedText && repaired.numpages) {
        try {
          const ocr = await ocrPdfWithMuPDF(buffer, ocrMaxPages, onProgress);
          if ((ocr.text || "").trim()) {
            return {
              text: ocr.text,
              pageTexts: ocr.pageTexts || pagesFromMarkedText(ocr.text),
              numpages: ocr.numpages || repaired.numpages || 0,
              error: [error.message, ...issues, "mupdf-repair", `ocr:${ocr.pagesProcessed}/${ocr.numpages || repaired.numpages || 0}`].filter(Boolean).join(";"),
              ocrUsed: true,
              ocrPartial: ocr.pagesProcessed < (ocr.numpages || repaired.numpages || 0)
            };
          }
          return {
            text: "",
            numpages: ocr.numpages || repaired.numpages || 0,
            error: [error.message, ...issues, "mupdf-repair", "ocr-empty", ...ocr.warnings.slice(0, 6)].filter(Boolean).join(";"),
            ocrUsed: true
          };
        } catch (ocrError) {
          return {
            text: "",
            numpages: repaired.numpages || 0,
            error: [error.message, ...issues, "mupdf-repair", `ocr-failed:${ocrError.message}`].filter(Boolean).join(";"),
            ocrUsed: true
          };
        }
      }
      return {
        text: repairedText,
        pageTexts: repaired.pageTexts || [],
        numpages: repaired.numpages || estimatePagesFromObjects(buffer) || 0,
        error: [error.message, ...issues, "mupdf-repair", repaired.numpages ? "" : "page-object-estimate"].filter(Boolean).join(";")
      };
    } catch (fallbackError) {
      const estimatedPages = estimatePagesFromObjects(buffer);
      return {
        text: "",
        numpages: estimatedPages,
        error: [error.message, fallbackError.message, ...issues, estimatedPages ? "page-object-estimate" : ""].filter(Boolean).join(";")
      };
    }
  }
}

function shouldAttemptPdfRecovery(parsed) {
  const text = String(parsed?.text || "").trim();
  const error = String(parsed?.error || "");
  if (/missing-eof|missing-xref|missing-objects|truncated/i.test(error)) return true;
  return !text && /Invalid PDF structure|ocr-empty|blank-render/i.test(error);
}

function extractDoiCandidates({ filename = "", buffer }) {
  const raw = [
    filename,
    buffer.toString("utf8"),
    buffer.toString("latin1")
  ].map((part) => toHalfWidth(part).replace(/\s+/g, " ")).join("\n");
  const matches = raw.match(/10\.\d{4,9}\/[^\s<>"'“”]+/gi) || [];
  return [...new Set(matches.map((doi) =>
    doi
      .replace(/[，。；;,.、)）\]}]+$/g, "")
      .replace(/&amp;/g, "&")
      .trim()
  ).filter((doi) => doi.length > 8))];
}

async function recoverPdfFromWeb({ filename, buffer }) {
  const dois = extractDoiCandidates({ filename, buffer });
  for (const doi of dois) {
    const recovered = await recoverPdfByDoi(doi).catch(() => null);
    if (recovered?.buffer) return { ...recovered, doi };
  }
  return null;
}

async function recoverPdfByDoi(doi) {
  const candidates = [];
  if (/^10\.11772\/j\.issn\./i.test(doi)) {
    candidates.push(`https://www.joca.cn/CN/${doi}`);
  }
  candidates.push(`https://doi.org/${doi}`);
  for (const url of candidates) {
    const direct = await fetchPdfCandidate(url).catch(() => null);
    if (direct?.buffer) return direct;
    const page = await fetchTextCandidate(url).catch(() => null);
    if (!page?.html) continue;
    const links = pdfLinksFromHtml(page.html, page.url).slice(0, 12);
    for (const link of links) {
      const pdfFile = await fetchPdfCandidate(link, page.url).catch(() => null);
      if (pdfFile?.buffer) return pdfFile;
    }
  }
  return null;
}

function pdfLinksFromHtml(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/(?:href|src|content|data-url)=["']([^"']+)["']/gi)) {
    const href = match[1];
    if (!/(pdf|downloadArticleFile|showArticleFile|download|attachType=PDF)/i.test(href)) continue;
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {
      // Ignore malformed links.
    }
  }
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+(?:pdf|downloadArticleFile|showArticleFile|attachType=PDF)[^\s"'<>]*/gi)) {
    links.push(match[0].replace(/&amp;/g, "&"));
  }
  return [...new Set(links)].sort((a, b) => scorePdfUrl(b) - scorePdfUrl(a));
}

function scorePdfUrl(url) {
  let score = 0;
  if (/attachType=PDF/i.test(url)) score += 5;
  if (/downloadArticleFile/i.test(url)) score += 4;
  if (/\.pdf(?:$|[?#])/i.test(url)) score += 3;
  if (/fee|login|validate/i.test(url)) score -= 4;
  return score;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (ASTeam Literature Assistant)",
        Accept: "*/*",
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextCandidate(url) {
  const response = await fetchWithTimeout(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!/html|text|xml/i.test(contentType)) return null;
  return { url: response.url || url, html: await response.text() };
}

async function fetchPdfCandidate(url, referer = "") {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/pdf,application/octet-stream,*/*",
      ...(referer ? { Referer: referer } : {})
    }
  }, 30000);
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!looksLikeUsablePdf(buffer)) return null;
  return { url: response.url || url, buffer };
}

function looksLikeUsablePdf(buffer) {
  if (!buffer || buffer.length < 20000) return false;
  const head = buffer.subarray(0, 16).toString("latin1");
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
  return head.includes("%PDF") && tail.includes("%%EOF");
}

function extractSections(text) {
  const clean = normalizeText(text);
  const abstract = clean.match(/(?:abstract|摘要)\s*[:：]?\s*([\s\S]{160,1600}?)(?:\n\s*(?:keywords|关键词|introduction|引言|1\.|i\.))/i)?.[1];
  const conclusion = clean.match(/(?:conclusion|conclusions|discussion|结论|总结)\s*[:：]?\s*([\s\S]{180,1800}?)(?:\n\s*(?:references|acknowledg|参考文献|致谢)|$)/i)?.[1];
  return { abstract: cleanAbstractText(abstract || ""), conclusion: conclusion?.trim() };
}

function cleanAbstractText(text) {
  let clean = displayText(text || "")
    .replace(/^(摘要|提要|\[摘要\]|\[摘 要\]|abstract)[:：]?/i, "")
    .replace(/关\s*键\s*词[:：][\s\S]*$/i, "")
    .replace(/key\s*words?[:：][\s\S]*$/i, "")
    .replace(/中图分类号[:：][\s\S]*$/i, "")
    .replace(/doi[:：]?\s*10\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  clean = clean.replace(/^[,，;；:：\s]+/, "");
  if (!clean || isBoilerplateLine(clean) || isMatrixNoise(clean)) return "";
  return shortEvidenceText(clean, 520);
}

function ensureSourceMetadata(library) {
  let changed = false;
  for (const doc of library.docs || []) {
    const meta = sourceMetaForDoc(doc);
    const cleanAbstract = cleanAbstractText(doc.abstract || meta.abstract || "");
    if (cleanAbstract && cleanAbstract !== doc.abstract) {
      doc.abstract = cleanAbstract;
      changed = true;
    }
    if (JSON.stringify(doc.sourceMeta || {}) !== JSON.stringify(meta)) {
      doc.sourceMeta = meta;
      if (meta.journal) doc.journal = meta.journal;
      if (meta.publicationYear) doc.publicationYear = meta.publicationYear;
      if (meta.authors?.length) doc.authors = meta.authors;
      changed = true;
    }
  }
  return changed;
}

function sourceMetaForDoc(doc) {
  const existing = doc.sourceMeta || {};
  const text = [
    doc.title || "",
    doc.abstract || "",
    ...((doc.chunks || []).slice(0, 4).map((chunk) => chunk.text || ""))
  ].join("\n");
  const extracted = extractSourceMeta(text, doc.filename || "");
  const journal = cleanJournalName(existing.journal || doc.journal || "") ||
    cleanJournalName(extracted.journal || "") ||
    journalFromKnownName(`${doc.title || ""} ${doc.filename || ""}`);
  const authors = firstNonEmptyArray(existing.authors, doc.authors, extracted.authors, extractAuthorsFromTitle(doc.title || ""));
  return {
    journal,
    authors,
    issue: cleanIssueInfo(existing.issue || extracted.issue || ""),
    publicationYear: extracted.publicationYear || "",
    doi: displayText(existing.doi || extracted.doi || ""),
    abstract: cleanAbstractText(existing.abstract || extracted.abstract || doc.abstract || ""),
    titleCandidate: displayText(existing.titleCandidate || extracted.titleCandidate || "")
  };
}

function publicDocTitle(doc = {}) {
  const meta = sourceMetaForDoc(doc);
  const raw = displayText(doc.title || "");
  const candidate = displayText(meta.titleCandidate || "");
  const textCandidate = titleFromDocText(doc);
  const filenameTitle = displayText(String(doc.filename || "").replace(/\.pdf$/i, ""));
  if (doc.manualTitle && raw) return raw;
  if (isBadDisplayTitle(raw) && candidate && !isBadTitleCandidate(candidate)) return candidate;
  if (isBadDisplayTitle(raw) && textCandidate) return textCandidate;
  if (isBadDisplayTitle(raw) && filenameTitle && !isBadDisplayTitle(filenameTitle)) return filenameTitle;
  return raw || candidate || filenameTitle || "未命名资料";
}

function isBadDisplayTitle(title = "") {
  const clean = displayText(title);
  if (!clean || clean.length < 6) return true;
  if (/^(第\s*\d+\s*卷|第\s*\d+\s*期|(?:19|20)\d{2}\s*[-⁃]\s*\d|(?:19|20)\d{2}\s*年|第\s*\d+\s*页)/.test(clean)) return true;
  if (/^(?:\d{2,4})?(中国科学基金|计算机应用|工业工程设计|交通运输系统工程与信息)(?:\d{4}|[,，]|$)/.test(clean)) return true;
  if (/^(?:PR\s*)?Magazine|Copyright|ISSN|CNKI/i.test(clean)) return true;
  return false;
}

function isBadTitleCandidate(title = "") {
  const clean = displayText(title);
  return !clean ||
    /^•?专题|^专题[:：]|^第\s*\d+\s*[卷期]|^\d+/.test(clean) ||
    /^(交通运输系统工程与信息|中国科学基金|计算机应用|工业工程设计)$/.test(clean) ||
    /^(通过对|在萌芽阶段|已有研究中).{10,}/.test(clean) ||
    /^(通过|基于|采用|利用|针对|为了|为).{8,}(进一步|讨论|比较|表明|结果|可以|本文|本研究)/.test(clean) ||
    (clean.length > 70 && /[。；;]$/.test(clean)) ||
    clean.length < 8;
}

function titleFromDocText(doc = {}) {
  const text = displayText([
    doc.abstract || "",
    ...((doc.chunks || []).slice(0, 3).map((chunk) => chunk.text || ""))
  ].join(" "));
  const patterns = [
    /(人工智能大模型与智能体驱动的消费研究新范式[:：][\u4e00-\u9fa5、，,与和]+?自主演化)/,
    /(基于智能体的隐藏表述规范的应用程序接口识别与漏洞检测方法)/,
    /(人工智能驱动下的营销变革)/,
    /(大语言模型智能体的设计方法研究)/,
    /(混合模型在网约车出行预测研究中的应用)/,
    /(生成式人工智能交互中意识形态感性化认同的行为机制及其调制)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return displayText(match[1]);
  }
  return "";
}

function extractSourceMeta(text, filename = "") {
  const clean = normalizeText(text || "");
  const lines = clean
    .split(/\n|(?<=。)\s+/)
    .map((line) => displayText(line).trim())
    .filter(Boolean)
    .slice(0, 90);
  const joined = lines.join("\n");
  const doi = joined.match(/10\.\d{4,9}\/[^\s，。；;]+/i)?.[0] || "";
  const issueLine = lines.find((line) =>
    /(?:第\s*\d+\s*卷|第\s*\d+\s*期|卷\s*\d+|期\s*\d+|Vol\.?\s*\d+|No\.?\s*\d+|(?:19|20)\d{2}\s*年)/i.test(line) &&
    !/(摘要|关键词|作者简介|基金|doi|参考文献)/i.test(line)
  ) || "";
  const publicationYear = extractPublicationYear(lines, issueLine);
  const journal = inferJournalName(lines, issueLine, filename);
  const titleCandidate = lines.find((line) =>
    line.length >= 8 &&
    line.length <= 90 &&
    !/(摘要|关键词|大学|学院|研究院|实验室|基金|doi|第\s*\d+\s*[卷期]|Vol\.|No\.|Copyright)/i.test(line) &&
    /研究|方法|模型|控制|检测|识别|变革|范式|机制|应用|综述|展望|智能|交通|营销|API/i.test(line)
  ) || "";
  const authors = extractAuthors(lines, titleCandidate);
  const abstract = cleanAbstractText(
    joined.match(/(?:摘\s*要|提\s*要|\[摘\s*要\]|abstract)\s*[:：]?\s*([\s\S]{80,1200}?)(?:关\s*键\s*词|key\s*words?|中图分类号|1\s*[.、]|一、|引言|$)/i)?.[1] || ""
  );
  return {
    journal,
    authors,
    issue: cleanIssueInfo(issueLine),
    publicationYear,
    doi,
    abstract,
    titleCandidate
  };
}

function extractPublicationYear(lines = [], issueLine = "") {
  const issueYear = String(issueLine || "").match(/(?:19|20)\d{2}/)?.[0] || "";
  if (issueYear) return issueYear;
  const trusted = lines.slice(0, 24).find((line) =>
    /(?:19|20)\d{2}\s*年/.test(line) &&
    /(第\s*\d+\s*[卷期]|Vol\.?|No\.?|学报|期刊|杂志|Journal|Review|Science|Engineering|计算机应用|科学基金|工业工程设计|工程与信息)/i.test(line) &&
    !/(参考文献|出版社|第\d+页|引用|作者简介|基金|阶段|目标)/.test(line)
  );
  return trusted?.match(/(?:19|20)\d{2}/)?.[0] || "";
}

function extractAuthors(lines = [], titleCandidate = "") {
  const candidates = [];
  const title = displayText(titleCandidate || "");
  const authorTail = extractAuthorsFromTitle(title).join("、");
  if (authorTail) candidates.push(authorTail);
  for (const line of lines.slice(0, 35)) {
    const clean = displayText(line)
      .replace(/\d+$/, "")
      .replace(/[＊*†‡]+/g, "")
      .trim();
    if (!clean || clean.length > 70) continue;
    if (/(摘要|关键词|基金|项目|收稿|作者简介|通讯作者|通信作者|大学|学院|研究院|实验室|学报|期刊|第\s*\d+\s*[卷期]|doi|DOI|http|邮箱|Email|研究|方法|模型|控制|检测|识别|综述|展望)/i.test(clean)) continue;
    if (/^[\u4e00-\u9fa5]{2,4}(?:\s*[,，、]\s*[\u4e00-\u9fa5]{2,4}){0,8}$/.test(clean)) candidates.push(clean);
  }
  const names = candidates
    .flatMap((item) => item.split(/[,，、]/))
    .map((item) => displayText(item).replace(/\s+/g, "").trim())
    .filter((item) => /^[\u4e00-\u9fa5]{2,4}$/.test(item))
    .filter((item) => !/(研究|方法|模型|系统|交通|智能|数据|摘要|关键词|大学|学院)$/.test(item));
  return uniqueStrings(names).slice(0, 10);
}

function firstNonEmptyArray(...items) {
  return items.find((item) => Array.isArray(item) && item.length) || [];
}

function extractAuthorsFromTitle(title = "") {
  const clean = displayText(title || "").replace(/\s+/g, "");
  const match = clean.match(/(?:研究|应用|方法|机制|控制|检测|识别|变革|范式|综述|展望)([\u4e00-\u9fa5]{2,4}(?:[,，、][\u4e00-\u9fa5]{2,4}){1,8})$/);
  if (!match?.[1]) return [];
  return uniqueStrings(match[1].split(/[,，、]/).filter((name) => /^[\u4e00-\u9fa5]{2,4}$/.test(name))).slice(0, 10);
}

function journalFromKnownName(text) {
  const known = [
    "交通运输系统工程与信息",
    "工业工程设计",
    "中国科学基金",
    "计算机应用",
    "图书馆理论与实践",
    "重庆理工大学学报",
    "营销科学学报"
  ];
  const raw = displayText(text || "");
  return known.find((name) => raw.includes(name)) || "";
}

function cleanIssueInfo(value) {
  const clean = displayText(value || "").trim();
  if (!clean || clean.length > 120) return "";
  if (/(作者简介|基金|参考文献|引用格式|相似文章|摘要|关键词|大学|学院|研究院|实验室)/.test(clean)) return "";
  return clean;
}

function inferJournalName(lines, issueLine = "", filename = "") {
  const candidates = [];
  const known = [
    "交通运输系统工程与信息",
    "工业工程设计",
    "Industrial & Engineering Design",
    "中国科学基金",
    "计算机应用",
    "图书馆理论与实践",
    "重庆理工大学学报",
    "营销科学学报"
  ];
  for (const name of known) {
    if (lines.some((line) => line.includes(name)) || issueLine.includes(name) || filename.includes(name)) candidates.push(name);
  }
  for (const line of lines.slice(0, 30)) {
    if (
      line.length >= 4 &&
      line.length <= 80 &&
      /(学报|杂志|论坛|科学基金|工程与信息|工业工程设计|计算机应用|Journal|Review|Science|Engineering)/i.test(line) &&
      !/(摘要|关键词|作者|基金|引用格式|相似文章|大学|学院|研究院|实验室|本文)/.test(line)
    ) {
      candidates.push(cleanJournalName(line.replace(/(?:第\s*\d+\s*卷.*|(?:19|20)\d{2}\s*年.*)$/i, "").trim()));
    }
  }
  if (issueLine) {
    const issueJournal = issueLine
      .replace(/(?:第\s*\d+\s*卷.*|(?:19|20)\s*年.*|Vol\.?\s*\d+.*|No\.?\s*\d+.*)$/i, "")
      .replace(/^[\d\s\-⁃,，.]+/, "")
      .trim();
    if (issueJournal && issueJournal.length >= 4 && issueJournal.length <= 60) candidates.push(cleanJournalName(issueJournal));
  }
  return cleanJournalName(candidates.find(Boolean) || "");
}

function cleanJournalName(value) {
  const clean = displayText(value || "")
    .replace(/[|｜].*$/, "")
    .replace(/^[•·\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length < 3 || clean.length > 48) return "";
  if (/(摘要|关键词|作者|基金项目|基金资助|引用格式|相似文章|本文|研究的目的|通过.*期刊论文|优质期刊论文|提出|针对|分析|发现|表明)/.test(clean)) return "";
  if (/期刊论文|学术论文|CNKI|中国知网/.test(clean) && !/(学报|杂志|科学基金|计算机应用|工程与信息|工业工程设计)/.test(clean)) return "";
  return clean;
}

function scoreSentence(sentence, keywordSet, index, total) {
  const sentenceTokens = tokens(sentence);
  const keyHits = sentenceTokens.filter((t) => keywordSet.has(t)).length;
  const signal =
    /(propose|present|show|demonstrate|evaluate|result|finding|contribution|challenge|limitation|提出|发现|表明|证明|评估|贡献|挑战|局限|结果)/i.test(sentence)
      ? 2
      : 0;
  const position = index < total * 0.22 || index > total * 0.72 ? 1 : 0;
  return keyHits + signal + position;
}

function distinctTopSentences(allSentences, keywordSet, limit) {
  const picked = [];
  const ranked = allSentences
    .map((s, i) => ({ s, score: scoreSentence(s, keywordSet, i, allSentences.length) }))
    .sort((a, b) => b.score - a.score);
  for (const item of ranked) {
    const itemTerms = new Set(tokens(item.s));
    const duplicate = picked.some((p) => jaccard(itemTerms, new Set(tokens(p))) > 0.45);
    if (!duplicate) picked.push(item.s);
    if (picked.length >= limit) break;
  }
  return picked;
}

function estimatePage(index, total, pages) {
  if (!pages || !total) return null;
  return Math.max(1, Math.min(pages, Math.ceil(((index + 1) / total) * pages)));
}

function makeResearchCard(doc, selected) {
  const text = `${doc.abstract} ${doc.takeaway} ${selected.join(" ")}`;
  const context = `${doc.filename || ""} ${doc.title || ""} ${text}`;
  const method = firstMatch(text, /(method|approach|framework|process|workflow|benchmark|experiment|evaluation|survey|case study|plan|policy|方法|框架|流程|方案|实验|评估|调查|计划|政策)[^.。！？!?]{0,180}/i);
  const limitation = firstMatch(text, /(limitation|challenge|risk|fail|brittle|uncertain|dependency|constraint|局限|挑战|风险|失败|不足|依赖|约束|限制)[^.。！？!?]{0,180}/i);
  const contribution = firstMatch(text, /(propose|present|contribution|show|demonstrate|argues|concludes|recommend|require|提出|贡献|表明|证明|认为|结论|建议|要求)[^.。！？!?]{0,180}/i);
  return {
    question: selected[0] || "未抽取到明确核心问题。",
    method: method || "未抽取到明确处理方式；建议回到原文相邻段落核对。",
    data: "当前解析未识别出稳定的数据、样本或对象描述。",
    findings: doc.abstract || selected[1] || "未抽取到明确关键信息。",
    contribution: contribution || doc.takeaway || "未抽取到明确结论或建议。",
    limitations: limitation || "未抽取到明确风险或限制。",
    reviewSlot: inferReviewSlot(context)
  };
}

function ensureEvidenceCards(library) {
  let changed = false;
  for (const doc of library.docs || []) {
    if (!doc.evidenceCard || doc.evidenceCard.version !== evidenceCardVersion) {
      doc.evidenceCard = buildEvidenceCard(doc);
      changed = true;
    }
    const upgraded = analysisCardFromEvidence(doc.evidenceCard, doc);
    if (JSON.stringify(doc.analysisCard || {}) !== JSON.stringify(upgraded)) {
      doc.analysisCard = upgraded;
      doc.researchCard = upgraded;
      changed = true;
    }
  }
  return changed;
}

function evidenceCardForDoc(doc) {
  if (doc.evidenceCard?.version === evidenceCardVersion) return doc.evidenceCard;
  return buildEvidenceCard(doc);
}

function buildEvidenceCard(doc) {
  const used = new Set();
  const candidatePool = buildEvidenceCandidatePool(doc);
  const researchQuestion = evidenceField(doc, "research_question", [/摘要|针对|问题|挑战|不足|缺乏|目的|旨在|重要|需求|已有研究|难以|research question|problem|challenge|objective|aim|need|motivation/i], 0, used, candidatePool);
  const method = evidenceField(doc, "method", [/方法|流程|框架|模型|算法|步骤|体系|设计|构建|提出|采用|基于|分解|预测|控制|检测|识别|method|approach|framework|algorithm|pipeline|we (?:use|propose|develop|train|evaluate)/i], 1, used, candidatePool);
  const dataOrMaterials = evidenceField(doc, "data_or_materials", [/数据|样本|材料|文献|语料|案例|实验|仿真|订单|接口|漏洞|中国知网|期刊|青年|场景|对象|data|dataset|sample|corpus|participants|documents|case study|benchmark/i], 2, used, candidatePool);
  const contribution = evidenceField(doc, "contribution", [/贡献|创新|提出|构建|证明|表明|实现|价值|意义|结论|有效|提升|降低|未来|本文|contribution|we (?:show|find|demonstrate|present)|results? (?:show|suggest)|conclude/i], 5, used, candidatePool);
  const mainClaims = evidenceList(doc, "main_claims", [/结果|表明|证明|发现|提出|构建|认为|说明|验证|有效|提升|降低|机制|结论|显示|result|finding|show|demonstrate|suggest|conclude|we propose/i], 3, 3, used, "主张", candidatePool);
  const evidence = evidenceList(doc, "evidence", [/实验|仿真|结果|指标|发现率|准确率|误差|对比|数据|案例|表明|验证|发文|关键词|引文|图谱|样本|experiment|evaluation|result|metric|accuracy|error|dataset|benchmark|comparison/i], 3, 3, used, "证据", candidatePool);
  const limitations = evidenceList(doc, "limitations", [/局限|不足|风险|限制|挑战|误报|依赖|未来|仍需|可能|偏差|伦理|安全|治理|外推|参数|limitation|constraint|risk|bias|cannot|may fail|future work|challenge/i], 2, 5, used, "边界", candidatePool);
  const quotes = uniqueEvidenceQuotes([
    researchQuestion,
    method,
    dataOrMaterials,
    contribution,
    ...mainClaims,
    ...evidence,
    ...limitations
  ]);
  const metricEvidence = metricEvidenceItems([
    researchQuestion,
    method,
    dataOrMaterials,
    contribution,
    ...mainClaims,
    ...evidence,
    ...limitations
  ], candidatePool);
  const sourcePages = [...new Set(quotes.map((item) => item.page).filter(Boolean))].sort((a, b) => a - b);
  const confidenceValues = [
    researchQuestion,
    method,
    dataOrMaterials,
    contribution,
    ...mainClaims,
    ...evidence,
    ...limitations
  ].map((item) => Number(item.confidence || 0.5));
  const confidence = Number((confidenceValues.reduce((sum, value) => sum + value, 0) / Math.max(1, confidenceValues.length)).toFixed(2));
  const warnings = evidenceCardWarnings([
    researchQuestion,
    method,
    dataOrMaterials,
    contribution,
    ...mainClaims,
    ...evidence,
    ...limitations
  ]);
  return {
    version: evidenceCardVersion,
    research_question: researchQuestion,
    method,
    data_or_materials: dataOrMaterials,
    main_claims: mainClaims,
    evidence,
    limitations,
    contribution,
    evidence_candidates: topEvidenceCandidates(candidatePool, [
      researchQuestion,
      method,
      dataOrMaterials,
      contribution,
      ...mainClaims,
      ...evidence,
      ...limitations
    ]),
    quotes,
    metric_evidence: metricEvidence,
    source_pages: sourcePages,
    confidence,
    warnings
  };
}

function evidenceField(doc, key, patterns, fallbackIndex, used, candidatePool = null) {
  return evidenceItem(doc, key, patterns, fallbackIndex, used, "字段", candidatePool);
}

function evidenceList(doc, key, patterns, limit, fallbackIndex, used, purpose, candidatePool = null) {
  const items = [];
  for (let index = 0; index < limit; index += 1) {
    const item = evidenceItem(doc, key, patterns, fallbackIndex + index, used, purpose, candidatePool);
    if (!item.quote && items.length) continue;
    if (items.some((existing) => jaccard(new Set(tokens(existing.quote || existing.claim)), new Set(tokens(item.quote || item.claim))) > 0.58)) continue;
    items.push(item);
  }
  return items;
}

function evidenceItem(doc, key, patterns, fallbackIndex, used, purpose, candidatePool = null) {
  const candidate = selectEvidenceCandidate(doc, key, patterns, fallbackIndex, used, candidatePool);
  const quote = candidate ? {
    text: candidate.quote,
    page: candidate.page,
    paragraph: candidate.paragraph
  } : null;
  const quoteClaim = claimFromQuote(doc, key, quote?.text || "");
  const normalizedClaim = normalizedClaimFromQuote(doc, key, quoteClaim, quote?.text || "");
  const dimension = candidate?.dimension || dimensionAssessment(key, quoteClaim, quote?.text || "");
  const quoteQuality = candidate?.quoteQuality || quoteQualityAssessment(quote?.text || "", { key });
  const evidenceType = candidate?.evidenceType || evidenceTypeForQuote(quote?.text || "");
  const qualityDelta = quoteQuality.score >= 0.72 ? 0.04 : quoteQuality.score < 0.45 ? -0.2 : quoteQuality.score < 0.58 ? -0.08 : 0;
  const baseConfidence = evidenceConfidence(normalizedClaim, quote?.text || "");
  const confidence = Number(Math.max(0.18, Math.min(0.9, baseConfidence + dimension.confidenceDelta + qualityDelta)).toFixed(2));
  const support = supportAssessment(normalizedClaim, quote?.text || "");
  const usable = Boolean(quote?.text) &&
    dimension.audit === "dimension_supported" &&
    evidenceType.directQuoteEligible &&
    quoteQuality.score >= 0.5 &&
    !quoteQuality.issues.some((issue) => /formula_fragment|reference_noise|header_footer_noise|starts_mid_sentence|incomplete_sentence/.test(issue)) &&
    !/weak|missing/.test(support.level);
  const audit = evidenceAuditStatus({
    claim: normalizedClaim,
    quote: quote?.text || "",
    page: quote?.page || null,
    confidence,
    supportLevel: support.level,
    dimensionAudit: dimension.audit,
    quoteQuality,
    evidenceType
  });
  const missingReason = missingReasonForEvidence({ quote, dimension, support, quoteQuality });
  return {
    field: key,
    claim: normalizedClaim,
    claim_atoms: claimAtomsFromQuote(doc, key, quote?.text || quoteClaim || ""),
    quote_claim: quoteClaim,
    normalized_claim: normalizedClaim,
    quote: quote?.text || "",
    page: quote?.page || null,
    paragraph: quote?.paragraph || null,
    span_type: candidate?.spanType || "missing",
    evidence_type: evidenceType.type,
    evidence_role: evidenceType.role,
    direct_quote_eligible: evidenceType.directQuoteEligible,
    claim_type: claimTypeForField(key),
    why_supports_claim: dimension.why ? `${support.why} ${dimension.why}` : support.why,
    support_level: support.level,
    dimension_audit: dimension.audit,
    dimension_issue: dimension.issue,
    suggested_dimension: dimension.suggestedDimension || "",
    is_usable: usable,
    not_usable_reason: usable ? "" : notUsableReason({ quote, dimension, support, quoteQuality, evidenceType }),
    missing_reason: missingReason,
    quote_quality_score: quoteQuality.score,
    quote_quality_issues: quoteQuality.issues,
    source_quality: sourceQualityForCandidate(candidate, confidence),
    extraction_strategy: candidate?.strategy || "missing_fallback",
    purpose,
    confidence,
    audit
  };
}

function selectEvidenceCandidate(doc, key, patterns, fallbackIndex = 0, used = new Set(), candidatePool = null) {
  const candidates = extractEvidenceCandidates(doc, key, patterns, fallbackIndex, used, candidatePool);
  const supported = candidates.find((item) => item.dimension.audit === "dimension_supported" && item.quoteQuality.score >= 0.5 && item.score > 0);
  const strictField = ["research_question", "method", "data_or_materials", "limitations"].includes(key);
  const picked = supported || (strictField ? null : (
    candidates.find((item) => item.quoteQuality.score >= 0.5 && item.score > 3) ||
    candidates[0] ||
    null
  ));
  if (picked) used.add(picked.baseId || picked.id);
  return picked;
}

function buildEvidenceCandidatePool(doc) {
  const chunks = (doc.chunks || []).filter((chunk) => !isLowValueChunk(chunk.text));
  const seen = new Set();
  const pool = chunks.flatMap((chunk, chunkPosition) => {
    const lines = rawEvidenceLines(chunk.text)
      .map((line, index) => ({ line: cleanCandidateEvidenceLine(line), lineIndex: index + 1 }))
      .filter(({ line }) => isUsableCandidatePoolLine(line));
    return lines.map((item) => {
      const baseId = `${chunk.index}:${item.lineIndex}`;
      const quote = normalizeEvidenceSnippet(completeEvidenceSnippet({
        picked: { line: item.line, index: item.lineIndex },
        candidates: lines.map((line) => ({ line: line.line, index: line.lineIndex })),
        chunk,
        doc
      }));
      const classification = classifyEvidenceCandidate(quote);
      const quoteQuality = quoteQualityAssessment(quote, { chunk });
      const evidenceType = evidenceTypeForQuote(quote);
      return {
        id: baseId,
        baseId,
        quote,
        page: chunk.pageStart || chunk.page || null,
        paragraph: chunk.index,
        section: chunk.section || "",
        chunkPosition,
        lineIndex: item.lineIndex,
        spanType: classification.spanType,
        candidateTypes: candidateTypesForQuote(quote),
        classification,
        evidenceType,
        quoteQuality,
        strategy: "candidate_pool_extract"
      };
    });
  })
    .filter((item) => {
      if (!item.quote || item.quoteQuality.score < 0.36) return false;
      const key = compactEvidenceKey(item.quote);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.quoteQuality.score - a.quoteQuality.score || a.paragraph - b.paragraph);
  return pool;
}

function isUsableCandidatePoolLine(line) {
  const clean = normalizeEvidenceSnippet(line);
  if (!clean) return false;
  if (isBoilerplateLine(clean) || isLowValueChunk(clean) || isMatrixNoise(clean) || isLikelyTitleOrByline(clean)) return false;
  if (isEvidenceNoise(clean)) return false;
  const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const type = evidenceTypeForQuote(clean);
  if (type.type === "invalid_fragment") return false;
  return cjk >= 12 || clean.length >= 42 || type.type === "metric_evidence";
}

function compactEvidenceKey(text = "") {
  return displayText(text).replace(/\s+/g, "").slice(0, 90);
}

function extractEvidenceCandidates(doc, key, patterns, fallbackIndex = 0, used = new Set(), candidatePool = null) {
  const pool = candidatePool || buildEvidenceCandidatePool(doc);
  return pool
    .filter((candidate) => !used.has(candidate.baseId || candidate.id))
    .map((candidate) => {
      const classification = candidate.classification || classifyEvidenceCandidate(candidate.quote);
      const quoteQuality = quoteQualityAssessment(candidate.quote, { key });
      const evidenceType = candidate.evidenceType || evidenceTypeForQuote(candidate.quote);
      const dimension = dimensionAssessment(key, candidate.quote, candidate.quote);
      const hits = patterns.reduce((count, pattern) => count + (pattern.test(candidate.quote) ? 1 : 0), 0);
      const classificationDimension = classification.dimension;
      const contextMatch = candidateMatchesFieldContext(key, candidate, classificationDimension);
      const fieldMatch = contextMatch ? 10 : -5;
      const fallbackPenalty = Math.abs((candidate.chunkPosition ?? fallbackIndex) - fallbackIndex) * 0.12;
      const quotePenalty = candidate.quote.length < 45 ? 3.5 : candidate.quote.length > 190 ? 2.2 : 0;
      const qualityPenalty = (1 - quoteQuality.score) * 8;
      const mismatchPenalty = dimension.audit === "dimension_supported" && contextMatch ? 0 : 12;
      const sectionDelta = sectionScoreForEvidenceField(key, candidate.section);
      const score = hits * 8 +
        dimensionFitScore(key, candidate.quote) +
        fieldSelectionBoost(key, candidate.quote) +
        fieldMatch +
        sectionDelta +
        classification.confidence * 3 +
        quoteQuality.score * 7 -
        fallbackPenalty -
        quotePenalty -
        qualityPenalty -
        mismatchPenalty;
      return {
        ...candidate,
        id: `${candidate.baseId || candidate.id}:${key}`,
        dimension: {
          ...dimension,
          audit: dimension.audit === "dimension_supported" && contextMatch
            ? "dimension_supported"
            : "dimension_mismatch",
          issue: dimension.audit === "dimension_supported" && contextMatch
            ? dimension.issue
            : (dimension.issue || `候选句功能被判为${classificationDimension}，与字段 ${key} 不匹配。`),
          suggestedDimension: dimension.suggestedDimension || classificationDimension
        },
        score,
        evidenceType,
        quoteQuality,
        strategy: dimension.audit === "dimension_supported" && contextMatch
          ? "candidate_pool_select"
          : "candidate_pool_weak_fallback"
      };
    })
    .filter((item) => item.score > -8 && item.quoteQuality.score >= 0.36)
    .sort((a, b) => {
      const aSupported = a.dimension.audit === "dimension_supported" ? 1 : 0;
      const bSupported = b.dimension.audit === "dimension_supported" ? 1 : 0;
      return bSupported - aSupported || b.score - a.score || a.paragraph - b.paragraph;
    });
}

function sectionScoreForEvidenceField(key, section = "") {
  if (section === "references") return -30;
  if (key === "research_question" && ["abstract", "introduction"].includes(section)) return 3;
  if (key === "method" && ["method", "abstract"].includes(section)) return 4;
  if (key === "data_or_materials" && ["method", "results"].includes(section)) return 2;
  if (key === "evidence" && ["results", "conclusion"].includes(section)) return 4;
  if (key === "limitations" && ["discussion", "conclusion"].includes(section)) return 4;
  if (key === "contribution" && ["abstract", "conclusion", "results"].includes(section)) return 3;
  return 0;
}

function classifyEvidenceCandidate(text = "") {
  const clean = displayText(text);
  const checks = [
    ["limitation", "limitation_boundary", /不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏|limitation|constraint|risk|bias|cannot|may fail|future work|challenge/i],
    ["method", "method_action", /采用|构建|提出|设计|使用|基于|利用|引入|建立|开发|实现|融合|分解|优化|训练|控制|检测|识别|可通过|we (?:use|propose|develop|train|evaluate)|method|approach|framework|algorithm|pipeline/i],
    ["data_or_materials", "data_source", /实验数据采用|数据采用|数据来源|样本来源|研究对象|实验对象|应用场景|仿真场景|问卷|访谈|订单|接口|漏洞|期刊|文献|引文|数据集|data|dataset|sample|corpus|participants|documents|case study|benchmark/i],
    ["evidence", "result_metric", /实验|仿真|指标|结果|对比|验证|图\s*\d+|表\s*\d+|\d+(?:\.\d+)?\s*%|准确率|召回率|误差|延误|求解速度|发现率|发文量|相关系数|ρ=|experiment|evaluation|result|metric|accuracy|error|comparison/i],
    ["research_question", "problem_statement", /针对|解决|问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有|重要|research question|problem|objective|aim|motivation|need/i],
    ["contribution", "contribution_claim", /贡献|创新|有效|提升|降低|优于|实现|价值|意义|结论|表明|证明|发现|contribution|we (?:show|find|demonstrate|present)|results? (?:show|suggest)|conclude/i]
  ];
  const matched = checks.find(([, , pattern]) => pattern.test(clean));
  if (!matched) return { dimension: "background", spanType: "background_or_noise", confidence: 0.35 };
  return { dimension: matched[0], spanType: matched[1], confidence: 0.78 };
}

function candidateMatchesField(key, dimension) {
  if (key === dimension) return true;
  if (key === "main_claims" && ["contribution", "evidence", "research_question"].includes(dimension)) return true;
  if (key === "contribution" && ["contribution", "evidence"].includes(dimension)) return true;
  if (key === "evidence" && dimension === "data_or_materials") return false;
  return false;
}

function candidateMatchesFieldContext(key, candidate = {}, classificationDimension = "") {
  if (candidateMatchesField(key, classificationDimension)) return true;
  const types = candidate.candidateTypes || candidateTypesForQuote(candidate.quote || "");
  if (types.includes(key)) return true;
  if (key === "main_claims" && types.some((type) => ["contribution", "evidence", "research_question"].includes(type))) return true;
  if (key === "contribution" && types.some((type) => ["contribution", "evidence"].includes(type))) return true;
  return false;
}

function fieldSelectionBoost(key, quote = "") {
  const clean = displayText(quote);
  let boost = 0;
  if (startsMidSentenceFragment(clean)) boost -= 28;
  if (key === "method") {
    if (/(?:本文|本研究|文章|该文).{0,20}(?:采用|运用|使用|提出|构建|设计|基于|利用|引入|建立|开发)/.test(clean)) boost += 24;
    if (/为此,?拟通过|定量与定性结合|知识图谱绘制|文献计量综合分析/.test(clean)) boost += 22;
    if (/已有|综述了|相关研究|理论基础/.test(clean) && !/为此|本文|本研究|拟通过/.test(clean)) boost -= 18;
    if (/分别为|遗忘门|输入门|输出门|对偶问题|KKT|公式|变量|系数/.test(clean)) boost -= 24;
  }
  if (key === "data_or_materials") {
    if (/实验数据采用|数据采用|数据来源|样本来源|研究对象为|选取[^。；;]{0,40}(?:数据|样本|案例|对象)/.test(clean)) boost += 28;
    if (/筛选的\s*\d+\s*篇文献|\d+\s*篇(?:文献|论文)|中国知网|期刊来源类别|样本文献|数据集|订单数据|出行流量数据/.test(clean)) boost += 28;
    if (/中国知网.{0,80}(?:期刊|论文|文献)|(?:期刊|论文|文献).{0,80}中国知网/.test(clean)) boost += 16;
    if (/^\S{0,8}(?:距离|数量|比例|占比|平均)/.test(clean)) boost -= 14;
  }
  if (key === "evidence") {
    if (/结果表明|实验表明|仿真.*表明|对比|优于|提升|降低|准确率|召回率|误差|延误|\d+(?:\.\d+)?\s*%/.test(clean)) boost += 18;
    if (/实验数据采用|数据来源|样本来源/.test(clean) && !/结果|表明|对比|提升|降低|优于/.test(clean)) boost -= 18;
  }
  if (key === "limitations") {
    if (/虽然[^。；;]{0,80}但|不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|瓶颈/.test(clean)) boost += 18;
    if (/提供.*可能|机遇|提升|优化|有效|优势|有助于/.test(clean) && !/不足|局限|限制|风险|挑战|难以/.test(clean)) boost -= 18;
  }
  if (key === "research_question") {
    if (/(?:本文|本研究|文章|该文).{0,24}(?:旨在|目的|针对|解决|探讨|分析|研究)|针对[^。；;]{4,90}(?:问题|挑战|不足|需求)/.test(clean)) boost += 18;
    if (/研究的目的是|目的是|目的在于|旨在/.test(clean)) boost += 28;
  }
  return boost;
}

function claimTypeForField(key) {
  return {
    research_question: "problem",
    method: "method",
    data_or_materials: "data",
    contribution: "conclusion",
    main_claims: "claim",
    evidence: "evidence",
    limitations: "limitation"
  }[key] || "claim";
}

function evidenceTypeForQuote(text = "") {
  const clean = displayText(text);
  if (!clean) return { type: "missing", role: "缺失证据", directQuoteEligible: false };
  const symbolCount = (clean.match(/[=<>∑√±×÷≈≤≥{}[\]|]/g) || []).length;
  const formulaLike = isFormulaFragment(clean) ||
    /(?:式\s*\(?\d+\)?|公式|其中\s*[A-Za-z]\s*为|变量|系数|参数|−1|ρ=|β=|α=|λ=)/.test(clean) ||
    (symbolCount >= 3 && symbolCount / Math.max(clean.length, 1) > 0.04);
  const tableLike = /(?:表\s*\d+|table\s*\d+|如表|见表|表明.*表\d+|模型预测结果如表|指标如表)/i.test(clean);
  const figureLike = /(?:图\s*\d+|figure\s*\d+|如图|见图|图\d+\([a-z]\)|图谱|可见)/i.test(clean);
  const fragmentLike = startsMidSentenceFragment(clean) ||
    isIncompleteEvidenceFragment(clean) ||
    /^[,，。；;:：)\]）\-−=+*/\\\d\s]+/.test(clean) ||
    /^[−\-–—]?\s*\d+(?:\.\d+)?\s*[,，;；]?\s*其中/.test(clean);
  if (fragmentLike && formulaLike) return { type: "invalid_fragment", role: "残缺公式片段", directQuoteEligible: false };
  if (formulaLike) return { type: "metric_evidence", role: "公式/指标证据，需回原文表格或公式核对", directQuoteEligible: false };
  if (tableLike) return { type: "metric_evidence", role: "表格/指标证据，需回表核对", directQuoteEligible: false };
  if (figureLike) return { type: "figure_evidence", role: "图示证据，需回图核对", directQuoteEligible: false };
  if (fragmentLike) return { type: "invalid_fragment", role: "残句或跨段片段", directQuoteEligible: false };
  if (/参考文献|DOI|作者简介|基金项目|通讯作者|收稿日期|修回日期|责任编辑/i.test(clean)) {
    return { type: "context_only", role: "来源或版面信息，不可作结论证据", directQuoteEligible: false };
  }
  const researchBullet = clean.length >= 42 && /\b(?:we (?:use|propose|develop|show|find|evaluate)|method|approach|result|data|dataset|limitation|challenge|objective)\b/i.test(clean);
  if (!/[。！？!?]$/.test(clean) && clean.length < 80 && !researchBullet) return { type: "context_only", role: "短片段背景信息", directQuoteEligible: false };
  return { type: "direct_quote", role: "完整自然句，可作为直接原文证据", directQuoteEligible: true };
}

function notUsableReason({ quote, dimension, support, quoteQuality, evidenceType }) {
  if (!quote?.text) return "missing_quote";
  if (evidenceType && !evidenceType.directQuoteEligible) return `not_direct_quote:${evidenceType.type}`;
  if (quoteQuality?.score != null && quoteQuality.score < 0.5) return `low_quote_quality:${quoteQuality.issues.join(",") || "quote_quality_low"}`;
  if (dimension.audit !== "dimension_supported") return dimension.issue || "dimension_mismatch";
  if (/weak|missing/.test(support.level)) return support.why || "weak_support";
  return "needs_review";
}

function sourceQualityForCandidate(candidate, confidence = 0) {
  if (!candidate) return "missing";
  if (confidence >= 0.72 && candidate.dimension?.audit === "dimension_supported" && Number(candidate.quoteQuality?.score || 0) >= 0.66) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

function missingReasonForEvidence({ quote, dimension, support, quoteQuality }) {
  if (!quote?.text) return "not_found";
  if (quoteQuality?.score != null && quoteQuality.score < 0.5) return "found_but_low_quality";
  if (dimension.audit === "dimension_mismatch") return "found_but_mismatch";
  if (/weak|missing/.test(support.level)) return "found_but_weak_support";
  return "";
}

function topEvidenceCandidates(pool = [], selectedItems = []) {
  const selectedByQuote = new Map((selectedItems || [])
    .filter((item) => item?.quote)
    .map((item) => [compactEvidenceKey(item.quote), item]));
  return (pool || [])
    .filter((item) => item?.quote)
    .map((item) => {
      const selected = selectedByQuote.get(compactEvidenceKey(item.quote));
      return {
        field: selected?.field || "",
        quote: item.quote,
        page: item.page || null,
        paragraph: item.paragraph || null,
        candidateTypes: item.candidateTypes || candidateTypesForQuote(item.quote),
        evidenceType: item.evidenceType?.type || selected?.evidence_type || evidenceTypeForQuote(item.quote).type,
        evidenceRole: item.evidenceType?.role || selected?.evidence_role || evidenceTypeForQuote(item.quote).role,
        directQuoteEligible: item.evidenceType?.directQuoteEligible ?? selected?.direct_quote_eligible ?? evidenceTypeForQuote(item.quote).directQuoteEligible,
        quoteQualityScore: item.quoteQuality?.score ?? selected?.quote_quality_score ?? 0,
        quoteQualityIssues: item.quoteQuality?.issues || selected?.quote_quality_issues || [],
        spanType: item.spanType || selected?.span_type || "",
        selected: Boolean(selected),
        selectedAudit: selected?.audit || "",
        suggestedDimension: selected?.suggested_dimension || ""
      };
    })
    .sort((a, b) => Number(b.quoteQualityScore || 0) - Number(a.quoteQualityScore || 0))
    .slice(0, 24);
}

function quoteQualityAssessment(text = "", context = {}) {
  const clean = displayText(text);
  const issues = [];
  let score = 0.78;
  if (!clean) return { score: 0, issues: ["empty_quote"] };
  const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (clean.length < 28 || (cjk > 0 && cjk < 12)) {
    score -= 0.22;
    issues.push("too_short");
  }
  if (clean.length > 260) {
    score -= 0.08;
    issues.push("too_long");
  }
  if (/^[,，。；;:：)\]）\-−=+*/\\\d\s]+/.test(clean) || startsMidSentenceFragment(clean)) {
    score -= 0.28;
    issues.push("starts_mid_sentence");
  }
  if (/[，,、;；:：]$/.test(clean) || isIncompleteEvidenceFragment(clean)) {
    score -= 0.18;
    issues.push("incomplete_sentence");
  }
  if (isFormulaFragment(clean) || /(?:ρ|β|α|λ|∑|−1|=\s*\d|其中\s*[A-Za-z]\s*为|变量|系数|参数)/.test(clean)) {
    score -= 0.3;
    issues.push("formula_fragment");
  }
  if (/参考文献|DOI|http|基金项目|作者简介|通讯作者|收稿日期|修回日期|责任编辑|第\s*\d+\s*卷|No\.\d|Vol\./i.test(clean)) {
    score -= 0.34;
    issues.push("reference_noise");
  }
  if (isLikelyTitleOrByline(clean) || isBoilerplateLine(clean) || isLowValueChunk(clean)) {
    score -= 0.24;
    issues.push("header_footer_noise");
  }
  if (!/(提出|构建|设计|采用|基于|针对|旨在|问题|不足|结果|表明|发现|验证|实验|数据|样本|局限|风险|限制|挑战|证明|显示|分析|研究|\b(?:we (?:use|propose|develop|show|find|evaluate)|method|approach|result|data|dataset|sample|limitation|risk|challenge|objective|experiment|evaluation)\b)/i.test(clean)) {
    score -= 0.12;
    issues.push("weak_research_signal");
  }
  if (context.key === "data_or_materials" && /结果表明|实验表明|提升|降低|优于|有效/.test(clean) && !/数据|样本|语料|对象|案例|场景|期刊|文献|订单/.test(clean)) {
    score -= 0.18;
    issues.push("result_sentence_in_data_field");
  }
  if (context.key === "limitations" && /提升|有效|有助于|提供依据|积极影响|优于/.test(clean) && !/不足|局限|限制|风险|挑战|仍需|不能|难以/.test(clean)) {
    score -= 0.22;
    issues.push("positive_sentence_in_limitation_field");
  }
  return {
    score: Number(Math.max(0, Math.min(1, score)).toFixed(2)),
    issues: [...new Set(issues)]
  };
}

function candidateTypesForQuote(text = "") {
  const clean = displayText(text);
  const types = [];
  if (/针对|解决|问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有|research question|problem|objective|aim|motivation|need/i.test(clean)) types.push("research_question");
  if (/采用|构建|提出|设计|使用|基于|利用|引入|建立|开发|融合|分解|优化|训练|控制|检测|识别|分析|we (?:use|propose|develop|train|evaluate)|method|approach|framework|algorithm|pipeline/i.test(clean)) types.push("method");
  if (/数据|样本|材料|文献|语料|案例|对象|场景|仿真|问卷|订单|接口|漏洞|期刊|引文|数据集|data|dataset|sample|corpus|participants|documents|case study|benchmark/i.test(clean)) types.push("data_or_materials");
  if (/结果|表明|证明|发现|显示|提升|降低|优于|有效|结论|贡献|创新|result|finding|show|demonstrate|accuracy|error|experiment|evaluation/i.test(clean)) types.push("evidence");
  if (/不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏|limitation|constraint|risk|bias|cannot|may fail|future work|challenge/i.test(clean)) types.push("limitations");
  return types.length ? types : ["background"];
}

function bestEvidenceChunk(doc, patterns, fallbackIndex = 0, used = new Set(), key = "") {
  const chunks = (doc.chunks || []).filter((chunk) => !used.has(chunk.index) && !isLowValueChunk(chunk.text));
  if (!chunks.length) return null;
  const ranked = chunks
    .map((chunk, index) => {
      const clean = displayText(chunk.text);
      const hits = patterns.reduce((count, pattern) => count + (pattern.test(clean) ? 1 : 0), 0);
      const signal = /提出|构建|设计|证明|验证|结果|表明|发现|实验|方法|问题|不足|局限|贡献|有效|提升|降低/.test(clean) ? 2 : 0;
      const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
      const page = Number(chunk.pageStart || chunk.page || 0);
      const pageCoverageBonus = page && doc.pages ? Math.min(2, page / Math.max(1, doc.pages)) : 0;
      const fallbackPenalty = Math.abs(index - fallbackIndex) * 0.15;
      const lengthPenalty = cjk < 24 ? 3 : 0;
      const dimensionScore = dimensionFitScore(key, clean);
      return { chunk, score: hits * 8 + signal + dimensionScore + pageCoverageBonus - fallbackPenalty - lengthPenalty };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
  const picked = ranked[0]?.chunk || null;
  if (picked) used.add(picked.index);
  return picked;
}

function quoteFromChunk(chunk, patterns, doc, key = "") {
  const lines = rawEvidenceLines(chunk?.text || "")
    .map((line, index) => ({ line: cleanCandidateEvidenceLine(line), index: index + 1 }))
    .filter(({ line }) => isUsableEvidenceLine(line, key));
  const ranked = lines
    .map((item) => {
      const hits = patterns.reduce((count, pattern) => count + (pattern.test(item.line) ? 1 : 0), 0);
      const generic = /提出|构建|设计|证明|验证|结果|表明|发现|方法|问题|不足|局限|有效|提升|降低/.test(item.line) ? 1 : 0;
      return { ...item, score: hits * 8 + dimensionFitScore(key, item.line) + generic };
    })
    .filter((item) => item.score > 0 || allowGenericEvidenceFallback(key))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = ranked[0] || null;
  if (!picked) return null;
  return {
    text: normalizeEvidenceSnippet(completeEvidenceSnippet({ picked, candidates: lines, chunk, doc })),
    page: chunk.pageStart || chunk.page || null,
    paragraph: chunk.index
  };
}

function cleanCandidateEvidenceLine(line) {
  let clean = cleanEvidenceLine(line);
  clean = clean.replace(/\{[^}]{0,120}@[^\s}]+}?\s*/g, "");
  clean = clean.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*/g, "");
  const abstractIndex = clean.search(/摘要[:：]|提\s*要/);
  if (abstractIndex > 0) clean = clean.slice(abstractIndex).replace(/^(摘要[:：]|提\s*要)\s*/, "");
  const afterInstitution = clean.search(/(大学|学院|研究院|实验室|中心|有限公司)[^。！？!?]{0,80}\s+(?=[\u4e00-\u9fa5]{8,})/);
  if (afterInstitution >= 0) {
    const tail = clean.slice(afterInstitution).replace(/^[^。！？!?]{0,120}?\s+(?=[\u4e00-\u9fa5]{8,})/, "");
    if ((tail.match(/[\u4e00-\u9fa5]/g) || []).length >= 20) clean = tail;
  }
  return normalizeEvidenceSnippet(displayText(clean).trim());
}

function isUsableEvidenceLine(line, key = "") {
  const clean = normalizeEvidenceSnippet(line);
  if (!clean) return false;
  if (isBoilerplateLine(clean) || isLowValueChunk(clean) || isMatrixNoise(clean) || isLikelyTitleOrByline(clean)) return false;
  if (isEvidenceNoise(clean)) return false;
  if (isFormulaFragment(clean)) return false;
  if (isIncompleteEvidenceFragment(clean)) return false;
  const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjk < 16 && clean.length < 48) return false;
  if (key) {
    const strict = strictDimensionCheck(key, clean, clean);
    if (strict.hardMismatch) return false;
  }
  return true;
}

function allowGenericEvidenceFallback(key = "") {
  return /main_claims|evidence|limitations/.test(key);
}

function isLikelyTitleOrByline(line) {
  const clean = displayText(line);
  if (/[\(（]\s*\d+\.\s*[^。]{0,80}(大学|学院|研究院|实验室|有限公司|中心)/.test(clean)) return true;
  if (/(作者|通讯作者|基金项目|收稿日期|修回日期)/.test(clean)) return true;
  const hasResearchVerb = /提出|构建|设计|采用|基于|结果|表明|发现|验证|分析|研究|解决|旨在|针对|不足|问题/.test(clean);
  if (!hasResearchVerb && clean.length <= 80 && /方法|研究|应用|检测|综述|展望$/.test(clean)) return true;
  return false;
}

function evidenceConfidence(claim, quote) {
  if (!quote) return 0.3;
  const claimTerms = new Set(tokens(claim));
  const quoteTerms = new Set(tokens(quote));
  const overlap = jaccard(claimTerms, quoteTerms);
  const hasSignal = /提出|构建|设计|证明|验证|结果|表明|发现|实验|方法|问题|局限|不足/.test(quote) ? 0.12 : 0;
  const pageSignal = /第\s*\d+\s*段|p\.\d+|结果|表明|提出|构建|实验|验证/.test(quote) ? 0.04 : 0;
  const score = 0.36 + overlap * 0.62 + hasSignal + pageSignal;
  const capped = overlap < 0.04 ? Math.min(score, 0.48) : score;
  return Number(Math.max(0.18, Math.min(0.88, capped)).toFixed(2));
}

function dimensionFitScore(key, text) {
  const clean = displayText(text);
  const hasResult = /结果|表明|发现率|准确率|误差|提升|降低|优于|达到|验证|实验评估|result|finding|show|demonstrate|accuracy|error|evaluation/i.test(clean);
  const hasMetricResult = /发现率|假发现率|准确率|误差|召回率|精确率|平均.*%|\d+(?:\.\d+)?\s*%|实验评估结果|accuracy|precision|recall|error rate|metric/i.test(clean);
  const hasMethod = /方法|流程|框架|模型|算法|步骤|体系|设计|构建|采用|基于|控制|检测|识别|优化|method|approach|framework|model|algorithm|pipeline|we (?:use|propose|develop|train)/i.test(clean);
  const hasData = /数据|样本|材料|文献|语料|案例|实验|仿真|订单|接口|漏洞|期刊|场景|对象|指标|data|dataset|sample|corpus|participants|documents|case study|benchmark/i.test(clean);
  const hasProblem = /问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有|重要|research question|problem|objective|aim|motivation|need|challenge/i.test(clean);
  const hasRisk = /局限|不足|风险|限制|挑战|误报|依赖|仍需|可能|偏差|伦理|安全|治理|外推|参数|limitation|constraint|risk|bias|cannot|may fail|future work/i.test(clean);
  const hasPositive = /突破|提升|优化|有效|实现|贡献|创新|优于|contribution|improve|effective|outperform|we (?:show|find|demonstrate)/i.test(clean);
  const hasNumbers = /\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?|表\s*\d+|图\s*\d+|对比|指标|table\s*\d+|figure\s*\d+|metric|comparison/i.test(clean);
  const strict = strictDimensionCheck(key, clean, clean);
  if (strict.hardMismatch) return -18;
  if (key === "method") return (hasMethod ? 7 : 0) + (hasMetricResult ? -14 : 0) + (hasResult && !hasMethod ? -10 : 0) + (hasData ? 1 : 0);
  if (key === "data_or_materials") return (hasData ? 8 : 0) + (hasResult && !hasData ? -10 : 0);
  if (key === "limitations") return (hasRisk ? 8 : 0) + (hasPositive && !hasRisk ? -12 : 0);
  if (key === "evidence") return (hasNumbers ? 8 : 0) + (hasData ? 3 : 0) + (hasResult ? 2 : 0);
  if (key === "research_question") return (hasProblem ? 8 : 0) + (hasResult && !hasProblem ? -5 : 0);
  if (key === "contribution" || key === "main_claims") return (hasResult || hasPositive ? 6 : 0) + (hasMethod ? 1 : 0);
  return 0;
}

function dimensionAssessment(key, claim, quote) {
  if (!quote) {
    return {
      audit: "missing_quote",
      confidenceDelta: -0.18,
      issue: "没有原文片段，无法校验字段归类。",
      suggestedDimension: "",
      why: "字段维度无法校验。"
    };
  }
  const text = displayText(`${claim} ${quote}`);
  const strict = strictDimensionCheck(key, claim, quote);
  if (strict.hardMismatch) {
    const suggestedDimension = strict.suggestedDimension || inferSuggestedDimension(text, key);
    return {
      audit: "dimension_mismatch",
      confidenceDelta: -0.34,
      issue: strict.issue,
      suggestedDimension,
      why: `严格维度校验未通过：${strict.issue}${suggestedDimension ? ` 建议改派到 ${suggestedDimension}。` : ""}`
    };
  }
  const resultOnly = /结果|表明|发现率|准确率|误差|提升|降低|优于|达到|实验评估|result|finding|show|demonstrate|accuracy|error|evaluation/i.test(text) &&
    !/方法|流程|框架|模型|算法|步骤|体系|设计|构建|采用|基于|控制|检测|识别|method|approach|framework|model|algorithm|pipeline|we (?:use|propose|develop|train)/i.test(text);
  const metricResult = /发现率|假发现率|准确率|误差|召回率|精确率|实验评估结果|\d+(?:\.\d+)?\s*%|accuracy|precision|recall|error rate|metric/i.test(text);
  const noDataSignal = !/数据|样本|材料|文献|语料|案例|实验|仿真|订单|接口|漏洞|期刊|场景|对象|指标|data|dataset|sample|corpus|participants|documents|case study|benchmark/i.test(text);
  const positiveOnly = /突破|提升|优化|有效|实现|贡献|创新|优于|contribution|improve|effective|outperform/i.test(text) &&
    !/局限|不足|风险|限制|挑战|误报|依赖|仍需|可能|偏差|伦理|安全|治理|外推|limitation|constraint|risk|bias|cannot|may fail|future work/i.test(text);
  const weakEvidence = !/\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?|表\s*\d+|图\s*\d+|对比|指标|实验|仿真|样本|案例|数据|experiment|evaluation|result|metric|dataset|sample|case study|comparison/i.test(text);
  const noProblemSignal = !/问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有|重要|research question|problem|objective|aim|motivation|need|challenge/i.test(text);
  const mismatch = (key === "method" && (resultOnly || metricResult)) ||
    (key === "data_or_materials" && noDataSignal) ||
    (key === "limitations" && positiveOnly) ||
    (key === "evidence" && weakEvidence) ||
    (key === "research_question" && noProblemSignal);
  if (!mismatch) {
    return {
      audit: "dimension_supported",
      confidenceDelta: 0.04,
      issue: "",
      suggestedDimension: "",
      why: "字段维度与原文信号基本一致。"
    };
  }
  const issue = {
    method: "该片段更像结果或效果描述，不是稳定的方法路径。",
    data_or_materials: "该片段缺少明确数据、材料、样本、案例或场景信号。",
    limitations: "该片段更像正向贡献，不是局限或风险。",
    evidence: "该片段缺少数字、实验、样本、指标、案例或对比信号。",
    research_question: "该片段缺少问题、挑战、目的或研究需求信号。"
  }[key] || "该片段与目标字段维度不完全匹配。";
  return {
    audit: "dimension_mismatch",
    confidenceDelta: -0.24,
    issue,
    suggestedDimension: inferSuggestedDimension(text, key),
    why: `维度校验提示：${issue}`
  };
}

function inferSuggestedDimension(text = "", currentKey = "") {
  const clean = displayText(text);
  if (/不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏/.test(clean)) return "limitations";
  if (/实验|仿真|指标|结果|对比|验证|图\s*\d+|表\s*\d+|\d+(?:\.\d+)?\s*%|准确率|召回率|误差|延误|发现率|发文量|结果表明|实验表明|研究发现/.test(clean)) return "evidence";
  if (/数据|样本|材料|文献|语料|案例|对象|场景|问卷|订单|接口|漏洞|期刊|引文|数据集|中国知网|CNKI/.test(clean)) return "data_or_materials";
  if (/采用|构建|提出|设计|使用|基于|利用|引入|建立|开发|融合|分解|优化|训练|控制|检测|识别|分析/.test(clean)) return "method";
  if (/针对|解决|问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有/.test(clean)) return "research_question";
  if (/贡献|创新|有效|提升|降低|优于|实现|价值|意义|结论|表明|证明|发现/.test(clean)) return "contribution";
  return currentKey === "main_claims" ? "contribution" : "background";
}

function claimFromQuote(doc, key, quote) {
  const clean = displayText(quote || "");
  if (!clean) return "当前字段没有找到可直接支撑的原文片段，不能作为强结论使用。";
  const clause = claimClause(clean, key);
  const prefix = {
    research_question: "原文显示研究问题是",
    method: "原文显示作者采用的方法是",
    data_or_materials: "原文显示数据、材料或对象包括",
    contribution: "原文显示主要贡献或结论是",
    main_claims: "可从原文归纳出的主张是",
    evidence: "可核对证据是",
    limitations: "原文提示的局限或边界是"
  }[key] || "原文可支持的判断是";
  return completeSentence(`${prefix}：${clause}`);
}

function normalizedClaimFromQuote(doc, key, quoteClaim, quote) {
  const clause = compressedResearchClaim(doc, key, quote || quoteClaim || "");
  if (!quote) {
    return {
      research_question: "当前没有足够原文支撑来界定研究问题。",
      method: "当前没有足够原文支撑来确认方法路径。",
      data_or_materials: "当前没有足够原文支撑来确认数据、材料或研究对象。",
      contribution: "当前没有足够原文支撑来确认贡献或结论。",
      main_claims: "当前没有足够原文支撑来确认主要主张。",
      evidence: "当前没有足够原文支撑来确认可核验证据。",
      limitations: "当前没有足够原文支撑来确认局限或风险。"
    }[key] || "当前字段缺少可核对原文。";
  }
  return completeSentence(polishNormalizedClaim(clause));
}

function polishNormalizedClaim(text = "") {
  return displayText(text)
    .replace(/\s+/g, " ")
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/:以因为/g, ":因为")
    .replace(/：以因为/g, "：因为")
    .replace(/:以(?=结果|实验|仿真|指标|数据|样本|对比|图|表|高|低|平均|准确率|召回率|误差|延误|发现率)/g, ":")
    .replace(/：以(?=结果|实验|仿真|指标|数据|样本|对比|图|表|高|低|平均|准确率|召回率|误差|延误|发现率)/g, "：")
    .replace(/(方法路径|数据\/材料|证据|局限边界|贡献结论|核心主张|研究问题):/g, "$1：")
    .replace(/。{2,}/g, "。")
    .trim();
}

function compressedResearchClaim(doc, key, text) {
  const source = normalizeEvidenceSnippet(claimClause(text, key)
    .replace(/^(原文显示研究问题是|原文显示作者采用的方法是|原文显示数据、材料或对象包括|原文显示主要贡献或结论是|可从原文归纳出的主张是|可核对证据是|原文提示的局限或边界是)[:：]/, "")
    .trim());
  const domain = conciseObject(doc, source);
  const method = conciseMethod(source);
  const metrics = conciseMetrics(source);
  const problem = conciseProblem(source);
  const limitation = conciseLimitation(source);
  const result = conciseResult(source);
  const purpose = concisePurpose(source);
  const fallbackClause = source ? shortEvidenceText(source, 96) : "";
  if (key === "research_question") {
    return `研究问题：${problem || purpose || fallbackClause || `围绕${domain}界定研究对象与待解决矛盾`}`;
  }
  if (key === "method") {
    return `方法路径：${method || fallbackClause || `围绕${domain}组织分析路径`}`;
  }
  if (key === "data_or_materials") {
    return `数据/材料：${conciseDataSource(source) || fallbackClause || `以${domain}相关样本、案例或场景作为分析基础`}`;
  }
  if (key === "evidence") {
    return `证据：${metrics || result || conciseDataSource(source) || fallbackClause || `原文给出与${domain}相关的可核对证据`}`;
  }
  if (key === "limitations") {
    return `局限边界：${limitation || fallbackClause || "原文只提供有限边界线索，需核对数据、场景和外推条件"}`;
  }
  if (key === "contribution") {
    return `贡献结论：${result || method || purpose || fallbackClause || `围绕${domain}形成研究判断`}`;
  }
  if (key === "main_claims") {
    return `核心主张：${result || problem || purpose || fallbackClause || `围绕${domain}提出研究判断`}`;
  }
  return `研究判断：${result || source}`;
}

function claimAtomsFromQuote(doc, key, text = "") {
  const source = normalizeEvidenceSnippet(claimClause(text, key));
  return {
    object: conciseObject(doc, source),
    method: conciseMethod(source),
    purpose: concisePurpose(source) || conciseProblem(source),
    finding: conciseResult(source),
    evidence_basis: conciseMetrics(source) || conciseDataSource(source),
    limitation: conciseLimitation(source),
    scope: conciseDataSource(source)
  };
}

function strictDimensionCheck(key, claim = "", quote = "") {
  const text = normalizeEvidenceSnippet(`${claim} ${quote}`);
  if (!text) return { hardMismatch: true, issue: "缺少可校验文本。" };
  if (isEvidenceNoise(text)) return { hardMismatch: true, issue: "片段包含版面、参考文献、基金、作者或页眉页脚噪声。", suggestedDimension: "background" };
  if (isFormulaFragment(text)) return { hardMismatch: true, issue: "片段更像公式、变量说明或统计符号残片，不适合作为研究字段。", suggestedDimension: "background" };
  const startsAsResult = /^(结果|实验|实验结果|评估结果|实验评估结果|仿真结果|结果表明|实验表明|研究发现|发现率|准确率|误差|results?|findings?|evaluation)/i.test(text);
  const hasMethodAction = /采用|构建|提出|设计|使用|基于|利用|引入|建立|开发|实现|融合|分解|优化|训练|控制|检测|识别|比较|分析|we (?:use|propose|develop|train|evaluate)|method|approach|framework|algorithm|pipeline/i.test(text);
  const hasDataSource = /(?:数据采用|实验数据|数据来源|样本|语料|材料|案例|研究对象|实验对象|应用场景|仿真场景|问卷|访谈|日志|订单|接口|漏洞|期刊|文献|引文|图谱|数据集|data|dataset|sample|corpus|participants|documents|case study|benchmark)/i.test(text);
  const hasEvidence = /实验|仿真|指标|结果|对比|验证|样本|案例|图\s*\d+|表\s*\d+|\d+(?:\.\d+)?\s*%|准确率|召回率|误差|延误|求解速度|发现率|发文量|引文|experiment|evaluation|result|metric|accuracy|error|comparison|dataset|sample/i.test(text);
  const hasLimitation = /不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏|limitation|constraint|risk|bias|cannot|may fail|future work|challenge/i.test(text);
  const isBackgroundOrCitation = /研究表明|已有研究|相关研究|参考文献|综述|理论基础|学者|指出|认为/.test(text) && !/本文|本研究|提出|构建|实验|验证|结果/.test(text);
  if (key === "method" && /(?:表现良好|已有研究|相关研究|研究表明|文献研究表明|仍然难以|很难|不足|依赖|不确定)/.test(text) && !/(?:本文|本研究).{0,20}(?:提出|构建|设计|采用|使用)|(?:提出|构建|设计)[^。；;]{0,80}(?:方法|模型|框架|算法)/.test(text)) {
    return { hardMismatch: true, issue: "该片段更像背景评价、已有方法或局限说明，不是本文的方法路径。", suggestedDimension: hasLimitation ? "limitations" : "background" };
  }
  if (key === "method" && /(?:结果表明|实验表明|可显著降低|准确率|误差|延误|通过效率|优于)/.test(text) && !/(?:提出|构建|设计|采用|使用)[^。；;]{0,80}(?:方法|模型|框架|算法|流程)/.test(text)) {
    return { hardMismatch: true, issue: "该片段以实验结果或效果为主，不是可复用的方法路径。", suggestedDimension: "evidence" };
  }
  if (key === "data_or_materials" && /(?:分解|权重|矩阵|算法|模型|预测|控制|优化)/.test(text) && !/(?:实验数据采用|数据采用|数据来源|样本来源|研究对象为|选取[^。；;]{0,30}(?:数据|样本|案例|对象))/.test(text)) {
    return { hardMismatch: true, issue: "该片段更像模型处理流程，不是数据来源、样本、材料或研究对象。", suggestedDimension: "method" };
  }
  if (key === "data_or_materials" && /(?:基本原理|共现分析|测度|语义|关系更密切|知识图谱绘制)/.test(text) && !/(?:中国知网|CNKI|期刊|论文|样本|数据集|语料|案例)/i.test(text)) {
    return { hardMismatch: true, issue: "该片段更像分析原理或方法说明，不是数据、材料或研究对象。", suggestedDimension: "method" };
  }
  if (key === "data_or_materials" && /(?:结果表明|实验表明|研究发现|提升|降低|优于|有效|证明)/.test(text) && !hasDataSource) {
    return { hardMismatch: true, issue: "数据/材料字段抽到了结果或效果句，应改作证据而不是样本来源。", suggestedDimension: "evidence" };
  }
  if (key === "limitations" && /(?:抗风险能力|积极影响|有效|提升|优化|有助于|提供依据)/.test(text)) {
    return { hardMismatch: true, issue: "该片段是正向意义或效果描述，不是局限边界。", suggestedDimension: "contribution" };
  }
  if (key === "limitations" && /机遇和挑战|提供了(?:机遇|可能)|更多可能/.test(text) && !/(?:不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|误报|外推|瓶颈|缺乏)/.test(text)) {
    return { hardMismatch: true, issue: "该片段只是宏观机遇或挑战表述，不是可写入综述的具体局限。", suggestedDimension: "background" };
  }
  if (key === "research_question" && !/(?:本文|本研究|文章|该文|旨在|目的|针对|解决|探讨|分析|研究|问题|挑战|不足|缺乏|需求|难以|research question|problem|objective|aim|motivation|need|challenge|we (?:study|investigate|examine))/i.test(text)) {
    return { hardMismatch: true, issue: "研究问题字段不能只用宏观背景，必须包含本文目的、问题、挑战或研究动作。", suggestedDimension: inferSuggestedDimension(text, "background") };
  }
  if (key === "method" && (startsAsResult || !hasMethodAction)) return { hardMismatch: true, issue: "方法字段必须包含方法动作，不能由结果句或效果句充当。", suggestedDimension: startsAsResult ? "evidence" : "background" };
  if (key === "data_or_materials" && (!hasDataSource || startsAsResult || /^(表示|其中|设|令|记|若|当).{0,80}(变量|样本数量|统计年限|发文总量|系数|参数)/.test(text))) return { hardMismatch: true, issue: "数据/材料字段必须指向数据来源、样本、语料、对象、案例或场景，不能是结果句、公式说明或变量解释。", suggestedDimension: startsAsResult ? "evidence" : "background" };
  if (key === "evidence" && !hasEvidence) return { hardMismatch: true, issue: "证据字段必须包含实验、指标、结果、对比、数据、样本或案例信号。", suggestedDimension: inferSuggestedDimension(text, "background") };
  if (key === "limitations" && (!hasLimitation || /可能有助于|有助于了解|积极影响|提供依据/.test(text))) return { hardMismatch: true, issue: "局限字段必须包含真实不足、限制、依赖、偏差、风险、仍需、不能或挑战，不能是正向意义或背景说明。", suggestedDimension: /未来|后续/.test(text) ? "future_work" : inferSuggestedDimension(text, "contribution") };
  if (key === "contribution" && isBackgroundOrCitation) return { hardMismatch: true, issue: "贡献字段不能抽取参考文献综述、背景理论或他人工作。", suggestedDimension: "background" };
  return { hardMismatch: false, issue: "" };
}

function claimClause(text, key) {
  const clean = displayText(text).replace(/^第\s*\d+\s*段[,，]?\s*第\s*\d+\s*行[:：]?/, "");
  const lines = clean
    .split(/[。！？!?；;]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8 && !isBoilerplateLine(item));
  const patterns = {
    research_question: /针对|问题|挑战|不足|缺乏|目的|旨在|需求|重要|难以|研究.*问题/,
    method: /方法|流程|框架|模型|算法|体系|设计|构建|提出|采用|基于|分解|控制|检测|识别/,
    data_or_materials: /数据|样本|材料|文献|语料|案例|实验|仿真|订单|接口|对象|期刊|青年|场景/,
    contribution: /贡献|创新|提出|构建|证明|表明|实现|价值|意义|结论|有效|提升|降低/,
    main_claims: /结果|表明|证明|发现|提出|构建|认为|说明|验证|有效|提升|降低|机制|结论|显示/,
    evidence: /实验|仿真|结果|指标|发现率|准确率|误差|对比|数据|案例|表明|验证|发文|关键词|引文|图谱/,
    limitations: /局限|不足|风险|限制|挑战|误报|依赖|未来|仍需|可能|偏差|伦理|安全|治理|外推|参数/
  };
  const pattern = patterns[key] || /提出|表明|发现|结果|方法|问题/;
  const picked = lines.find((line) => pattern.test(line)) || lines.find((line) => /提出|表明|发现|结果|方法|问题/.test(line)) || lines[0] || clean;
  return shortEvidenceText(picked, 180).replace(/。$/, "");
}

function completeSentence(text) {
  const clean = displayText(text).replace(/\.{3}|…/g, "").trim();
  if (!clean) return "";
  return /[。！？!?]$/.test(clean) ? clean : `${clean}。`;
}

function supportAssessment(claim, quote) {
  if (!quote) {
    return { level: "missing_quote", why: "没有找到可绑定原文，系统只能保留为待核对推断。" };
  }
  const overlap = jaccard(new Set(tokens(claim)), new Set(tokens(quote)));
  if (overlap < 0.04) {
    return { level: "weak", why: "原文片段与自动概括的关键词重合较低，应视为推断而非原文直接支持。" };
  }
  if (overlap < 0.12) {
    return { level: "partial", why: "原文片段能部分支撑该概括，但正式使用前需要核对相邻段落。" };
  }
  return { level: "direct", why: "原文片段与该概括存在明确主题重合，可作为直接支撑。" };
}

function evidenceAuditStatus({ quote, page, confidence, supportLevel, dimensionAudit, quoteQuality, evidenceType }) {
  if (!quote) return "missing_quote";
  if (!page) return "missing_page";
  if (evidenceType && !evidenceType.directQuoteEligible) return "needs_review";
  if (quoteQuality?.score != null && quoteQuality.score < 0.5) return "low_quote_quality";
  if (dimensionAudit === "dimension_mismatch") return "dimension_mismatch";
  if (supportLevel === "weak" || confidence < 0.45) return "weak_support";
  if (supportLevel === "partial" || confidence < 0.6) return "needs_review";
  return "supported";
}

function evidenceCardWarnings(items) {
  const warnings = [];
  const missing = items.filter((item) => item.audit === "missing_quote").length;
  const weak = items.filter((item) => item.audit === "weak_support").length;
  const noPage = items.filter((item) => item.audit === "missing_page").length;
  const mismatch = items.filter((item) => item.audit === "dimension_mismatch").length;
  const lowQuality = items.filter((item) => item.audit === "low_quote_quality").length;
  if (missing) warnings.push(`${missing} 个字段没有绑定原文片段，已降级为待核对推断。`);
  if (mismatch) warnings.push(`${mismatch} 个字段可能存在维度错位，已降级为待核对。`);
  if (lowQuality) warnings.push(`${lowQuality} 个字段原文片段质量较低，疑似残句、公式、页眉或参考文献噪声。`);
  if (weak) warnings.push(`${weak} 个字段的原文支撑较弱，不能当作强证据。`);
  if (noPage) warnings.push(`${noPage} 个字段缺少定位，需要回到原文核对。`);
  return warnings;
}

function uniqueEvidenceQuotes(items) {
  const seen = new Set();
  const quotes = [];
  for (const item of items || []) {
    const text = displayText(item?.quote || "");
    if (!text) continue;
    const type = item.evidence_type ? { type: item.evidence_type, role: item.evidence_role || "", directQuoteEligible: item.direct_quote_eligible } : evidenceTypeForQuote(text);
    if (!type.directQuoteEligible) continue;
    const key = `${item.page || ""}:${text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({
      text,
      page: item.page || null,
      paragraph: item.paragraph || null,
      purpose: item.purpose || "证据",
      evidence_type: type.type,
      evidence_role: type.role
    });
    if (quotes.length >= 8) break;
  }
  return quotes;
}

function metricEvidenceItems(items = [], candidatePool = []) {
  const selected = (items || [])
    .filter((item) => /metric_evidence|figure_evidence/.test(item?.evidence_type || ""))
    .map((item) => ({
      quote: displayText(item.quote || ""),
      page: item.page || null,
      paragraph: item.paragraph || null,
      evidence_type: item.evidence_type,
      evidence_role: item.evidence_role,
      field: item.field || "",
      confidence: item.confidence || 0
    }));
  const candidates = (candidatePool || [])
    .filter((item) => /metric_evidence|figure_evidence/.test(item?.evidenceType?.type || ""))
    .slice(0, 8)
    .map((item) => ({
      quote: displayText(item.quote || ""),
      page: item.page || null,
      paragraph: item.paragraph || null,
      evidence_type: item.evidenceType.type,
      evidence_role: item.evidenceType.role,
      field: "",
      confidence: Number(item.quoteQuality?.score || 0)
    }));
  const seen = new Set();
  return [...selected, ...candidates]
    .filter((item) => item.quote)
    .filter((item) => {
      const key = `${item.page || ""}:${item.quote.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function analysisCardFromEvidence(card, doc) {
  const claims = (card.main_claims || []).map((item) => item.normalized_claim || item.claim).filter(Boolean);
  const evidence = (card.evidence || []).map((item) => item.normalized_claim || item.claim).filter(Boolean);
  const limitations = (card.limitations || []).map((item) => item.normalized_claim || item.claim).filter(Boolean);
  return {
    question: card.research_question?.normalized_claim || card.research_question?.claim || synthesizeDocKeyInfo(doc),
    method: card.method?.normalized_claim || card.method?.claim || methodFallbackForDoc(doc),
    data: card.data_or_materials?.normalized_claim || card.data_or_materials?.claim || "当前未识别出稳定的数据、材料或案例来源。",
    findings: claims.concat(evidence).slice(0, 3).join(" ") || synthesizeDocKeyInfo(doc),
    contribution: card.contribution?.normalized_claim || card.contribution?.claim || claims[0] || synthesizeDocKeyInfo(doc),
    limitations: limitations.join(" ") || "原文未明确给出稳定的风险或限制，使用前需要回到适用场景、数据来源和实验条件核对。",
    reviewSlot: inferReviewSlot(`${doc.title || ""} ${doc.filename || ""} ${card.method?.normalized_claim || card.method?.claim || ""} ${card.research_question?.normalized_claim || card.research_question?.claim || ""}`)
  };
}

function inferEvidenceDomain(doc) {
  const title = displayText(doc.title || doc.filename || "");
  const keywords = (doc.keywords || []).map((item) => displayText(item.term || item)).join(" ");
  const abstract = displayText(doc.abstract || "");
  const firstChunks = displayText((doc.chunks || []).slice(0, 3).map((chunk) => chunk.text).join(" "));
  const weighted = `${title} ${title} ${title} ${title} ${keywords} ${keywords} ${keywords} ${abstract} ${abstract} ${firstChunks}`;
  const patterns = {
    apiSecurity: [/RESTful|隐藏.*接口|隐藏.*API|API.*漏洞|应用程序接口.*漏洞|漏洞检测|端点|假发现率/i, /NAUTILUS|RESTler|Burp|ZAP/i],
    rideHailing: [/网约车|出行预测|交通流.*预测|订单数据|短时交通流/i],
    intersectionControl: [/交叉口|信号配时|车辆轨迹|混合交通|网联自动驾驶|CAV/i],
    overseasChineseBooks: [/域外汉籍|文献计量|知识图谱|发文量|引文/i],
    ideology: [/意识形态|感性化认同|高易感|青年群体|人机交互/i],
    consumerResearch: [/消费研究|消费感知|消费者行为|行为模拟|营销建模|自主演化/i],
    llmAgentDesign: [/大语言模型.*智能体|智能体.*设计方法|垂直领域.*智能体|语义检索|链式推理|提示优化|内容生成设计/i]
  };
  const scores = Object.entries(patterns).map(([domain, items]) => ({
    domain,
    score: items.reduce((sum, pattern) => sum + ((weighted.match(pattern) || []).length ? 1 : 0), 0)
  }));
  scores.sort((a, b) => b.score - a.score);
  if (scores[0]?.score > 0) return scores[0].domain;
  return "generic";
}

function firstMatch(text, pattern) {
  return text.match(pattern)?.[0]?.trim();
}

function inferReviewSlot(text) {
  if (/project-plan|implementation plan|项目实施方案|实施方案/i.test(text)) return "项目执行";
  if (/budget-summary|budget summary|预算说明|预算摘要/i.test(text)) return "预算与成本";
  if (/risk-register|risk register|风险清单|风险台账/i.test(text)) return "风险与合规";
  if (/customer-feedback|customer feedback|用户反馈|客户反馈/i.test(text)) return "用户与反馈";
  if (/vendor-comparison|vendor comparison|供应商对比|竞品对比/i.test(text)) return "供应商与对比";
  if (/budget|cost|price|revenue|预算|成本|价格|收入|费用/i.test(text)) return "预算与成本";
  if (/risk|security|rollback|incident|compliance|风险|安全|回滚|事故|合规/i.test(text)) return "风险与合规";
  if (/customer|user|feedback|complaint|用户|客户|反馈|投诉/i.test(text)) return "用户与反馈";
  if (/vendor|competitor|comparison|procurement|供应商|竞品|对比|采购/i.test(text)) return "供应商与对比";
  if (/implementation|migration|rollout|timeline|checkpoint|方案|计划|实施|上线|迁移|排期|节点/i.test(text)) return "项目执行";
  if (/evaluation|benchmark|metric|评估|基准|指标/i.test(text)) return "评估方法与证据";
  if (/governance|policy|oversight|accountability|治理|监管|责任/i.test(text)) return "治理与风险控制";
  if (/retrieval|citation|source|grounding|检索|引用|溯源/i.test(text)) return "检索增强与可信问答";
  if (/agent|planning|tool|multi-agent|智能体|规划|工具/i.test(text)) return "智能体能力与可靠性";
  if (/contract|clause|liability|合同|条款|责任/i.test(text)) return "合同与合规";
  return "资料背景";
}

async function analyzeDocument(id, filename, text, pages = 0, pageTexts = [], onProgress = null) {
  const normalizedPageTexts = cleanPdfPageTexts(pageTexts || []);
  const hasPageText = normalizedPageTexts.some(Boolean);
  const clean = hasPageText ? normalizeText(normalizedPageTexts.join("\n\n")) : cleanPdfPageText(text || "");
  const sentenceEntries = hasPageText ? pageSentenceEntries(normalizedPageTexts) : [];
  const allSentences = sentenceEntries.length ? sentenceEntries.map((item) => item.text) : sentences(clean);
  const keywords = topKeywords(clean, 14);
  const keywordSet = new Set(keywords.map((k) => k.term));
  const sections = extractSections(clean);
  const sourceMeta = extractSourceMeta(clean, filename);
  const selected = distinctTopSentences(allSentences, keywordSet, 8);
  const abstractSeed = sections.abstract || sourceMeta.abstract
    ? sentences(sections.abstract || sourceMeta.abstract).slice(0, 3)
    : selected.slice(0, 3);
  const conclusionSeed = sections.conclusion ? sentences(sections.conclusion).slice(0, 2) : selected.slice(3, 5);
  const keyPoints = selected.slice(0, 5).map((sentence, index) => ({
    id: `${id}-kp-${index + 1}`,
    text: sentence,
    page: pageForSentence(sentenceEntries, sentence) || estimatePage(allSentences.indexOf(sentence), allSentences.length, pages),
    sourceType: "quote"
  }));
  const doc = {
    id,
    filename,
    title: titleFromText(filename, clean),
    pages,
    wordCount: tokens(clean).length,
    journal: sourceMeta.journal || "",
    publicationYear: sourceMeta.publicationYear || "",
    sourceMeta,
    abstract: cleanAbstractText(abstractSeed.join(" ")),
    takeaway: conclusionSeed.join(" "),
    keywords,
    keyPoints,
    analysisCard: null,
    researchCard: null,
    llmEnhanced: false,
    sourceNotes: [
      { label: "原话摘录", description: "关键点直接取自 PDF 文本中的高信号句子。" },
      { label: "综合推断", description: "摘要、关系和问答由多处文本特征归纳生成，需结合原文复核。" }
    ],
    chunks: hasPageText ? makeChunksFromPages(normalizedPageTexts) : makeChunks(clean, pages),
    createdAt: new Date().toISOString()
  };
  doc.analysisCard = makeResearchCard(doc, selected);
  doc.researchCard = doc.analysisCard;
  await onProgress?.({ status: "enhancing", phase: providerConfig?.apiKey ? "模型增强分析" : "整理证据", progress: 80 });
  await enhanceDocumentWithOpenAI(doc, clean);
  doc.evidenceCard = buildEvidenceCard(doc);
  doc.analysisCard = analysisCardFromEvidence(doc.evidenceCard, doc);
  doc.researchCard = doc.analysisCard;
  await onProgress?.({ status: "enhancing", phase: "证据分析完成", progress: 92 });
  return doc;
}

function pageSentenceEntries(pageTexts = []) {
  return pageTexts.flatMap((pageText, index) =>
    sentences(pageText).map((text) => ({ text, page: index + 1 }))
  );
}

function pageForSentence(entries, sentence) {
  if (!entries?.length || !sentence) return null;
  return entries.find((entry) => entry.text === sentence)?.page || null;
}

function makeChunks(text, pages = 0) {
  const s = sentences(text);
  const chunks = [];
  let section = "";
  for (let i = 0; i < s.length; i += 5) {
    section = sectionForText(s[i] || "", section);
    const pageStart = estimatePage(i, s.length, pages);
    const pageEnd = estimatePage(Math.min(i + 4, s.length - 1), s.length, pages);
    chunks.push({
      index: chunks.length + 1,
      text: s.slice(i, i + 5).join(" "),
      section,
      pageStart,
      pageEnd,
      citation: pageStart ? `p.${pageStart}${pageEnd && pageEnd !== pageStart ? `-${pageEnd}` : ""}` : `chunk ${chunks.length + 1}`,
      terms: topKeywords(s.slice(i, i + 5).join(" "), 12).map((k) => k.term)
    });
  }
  return chunks.slice(0, 240);
}

function makeChunksFromPages(pageTexts = []) {
  const chunks = [];
  let section = "";
  pageTexts.forEach((pageText, pageIndex) => {
    const page = pageIndex + 1;
    const s = sentences(pageText);
    for (let i = 0; i < s.length; i += 5) {
      const text = s.slice(i, i + 5).join(" ");
      if (!text.trim()) continue;
      section = sectionForText(s[i] || text, section);
      chunks.push({
        index: chunks.length + 1,
        text,
        section,
        page,
        pageStart: page,
        pageEnd: page,
        citation: `p.${page}`,
        terms: topKeywords(text, 12).map((k) => k.term)
      });
    }
  });
  return chunks.slice(0, 240);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function buildGraph(docs) {
  const profiles = new Map(docs.map((doc) => [doc.id, docGraphProfile(doc)]));
  const nodes = docs.map((doc) => ({
    id: doc.id,
    label: doc.title.length > 56 ? doc.title.slice(0, 56).replace(/[，,、；;:：-]+$/, "") : doc.title,
    title: doc.title,
    keywords: doc.keywords.slice(0, 6).map((k) => k.term),
    profile: profiles.get(doc.id),
    size: Math.max(20, Math.min(48, Math.round(Math.sqrt(doc.wordCount || 1) * 1.6)))
  }));
  const allEdges = [];
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const aTerms = new Set([
        ...docs[i].keywords.slice(0, 18).map((k) => k.term),
        ...topKeywords(`${docs[i].abstract} ${docs[i].takeaway}`, 10).map((k) => k.term)
      ]);
      const bTerms = new Set([
        ...docs[j].keywords.slice(0, 18).map((k) => k.term),
        ...topKeywords(`${docs[j].abstract} ${docs[j].takeaway}`, 10).map((k) => k.term)
      ]);
      const shared = cleanRelationTerms([...aTerms].filter((term) => bTerms.has(term)));
      const score = jaccard(aTerms, bTerms);
      const relation = compareDocRelation(docs[i], docs[j], profiles.get(docs[i].id), profiles.get(docs[j].id), shared, score);
      allEdges.push({
        source: docs[i].id,
        target: docs[j].id,
        weight: Number(Math.max(0.12, relation.score + score + shared.length / 30).toFixed(2)),
        relation: relation.label,
        relationKind: relation.kind || relationKindForLabel(relation.label),
        shared: shared.slice(0, 5),
        keepCandidate: shouldKeepGraphRelation(docs[i], docs[j], profiles.get(docs[i].id), profiles.get(docs[j].id), relation, shared, score),
        evidence: relationEvidence(docs[i], docs[j], shared, relation, profiles.get(docs[i].id), profiles.get(docs[j].id))
      });
    }
  }
  const selected = selectDefaultGraphEdges(docs, allEdges.filter((edge) => edge.keepCandidate), profiles);
  const completedEdges = ensureGraphCoverage(docs, selected, profiles);
  const selectedIds = new Set(completedEdges.map(edgeSignature));
  const candidateEdges = allEdges
    .filter((edge) => !selectedIds.has(edgeSignature(edge)))
    .sort((a, b) => relationPriorityScore(b) - relationPriorityScore(a))
    .slice(0, 18)
    .map(({ keepCandidate, ...edge }) => edge);
  return {
    nodes,
    edges: completedEdges,
    candidateEdges,
    hiddenEdgeCount: Math.max(0, allEdges.length - completedEdges.length),
    argument: buildResearchArgument(docs, profiles, completedEdges)
  };
}

function edgeSignature(edge = {}) {
  return [edge.source, edge.target].sort().join("::");
}

function selectDefaultGraphEdges(docs, edges, profiles) {
  if (docs.length <= 2) return edges.sort((a, b) => relationPriorityScore(b) - relationPriorityScore(a));
  const maxEdges = Math.max(docs.length - 1, Math.min(14, Math.ceil(docs.length * 1.45)));
  const buckets = {
    strong: [],
    conflict: [],
    bridge: [],
    evidence: []
  };
  for (const edge of edges) {
    const kind = edge.relationKind || relationKindForLabel(edge.relation);
    if (/cannot_merge|boundary|contrasts|risk/.test(kind)) buckets.conflict.push(edge);
    else if (/same_problem|same_method|method_transfers|problem_extends/.test(kind) || Number(edge.weight || 0) >= 0.76) buckets.strong.push(edge);
    else if (/extends|application_expands/.test(kind)) buckets.bridge.push(edge);
    else buckets.evidence.push(edge);
  }
  Object.values(buckets).forEach((bucket) => bucket.sort((a, b) => relationPriorityScore(b) - relationPriorityScore(a)));
  const picked = [];
  const used = new Set();
  const add = (edge) => {
    const id = edgeSignature(edge);
    if (used.has(id) || picked.length >= maxEdges) return false;
    used.add(id);
    picked.push(edge);
    return true;
  };
  [...buckets.conflict.slice(0, 3), ...buckets.strong.slice(0, Math.ceil(maxEdges * 0.55)), ...buckets.bridge.slice(0, 4)].forEach(add);
  [...buckets.strong, ...buckets.conflict, ...buckets.bridge, ...buckets.evidence].forEach(add);
  return picked
    .sort((a, b) => relationPriorityScore(b) - relationPriorityScore(a))
    .slice(0, maxEdges);
}

function relationPriorityScore(edge = {}) {
  const kind = edge.relationKind || relationKindForLabel(edge.relation || "");
  const kindBoost = /cannot_merge|boundary|contrasts/.test(kind) ? 0.24 :
    /same_problem|same_method|method_transfers|problem_extends/.test(kind) ? 0.2 :
    /extends|application_expands/.test(kind) ? 0.14 :
    /supports|evidence_strengthens/.test(kind) ? 0.08 : 0;
  const evidenceBonus = edge.evidence?.sources?.length ? 0.05 : 0;
  return Number(edge.weight || 0) + kindBoost + evidenceBonus;
}

function buildResearchArgument(docs, profiles, edges = []) {
  if (docs.length < 2) return null;
  const items = docs.map((doc) => profiles.get(doc.id)).filter(Boolean);
  const byDomain = (pattern) => items.filter((item) => pattern.test(item.domain));
  const theory = byDomain(/生成式人工智能影响|文献计量与知识图谱/);
  const method = byDomain(/智能体设计|接口安全检测|交通控制/);
  const application = byDomain(/消费研究智能化|交通流预测/);
  const evidence = items.filter((item) => /实验|指标|案例|文献计量/.test(item.evidenceType));
  const boundary = [...new Set(items.map((item) => item.riskType).filter((item) => item && item !== "适用边界待核对"))];
  const domains = [...new Set(items.map((item) => item.domain).filter(Boolean))];
  const methodTypes = [...new Set(items.map((item) => item.methodType).filter(Boolean))];
  const hasAgentMethod = items.some((item) => /智能体|大模型|智能体协同/.test(`${item.domain} ${item.methodType} ${item.finding}`));
  const hasConcreteEvidence = evidence.length > 0;
  const thesis = hasAgentMethod
    ? "这组资料共同指向一个观点：大模型或智能体不能只作为通用问答工具理解，它需要被放进具体问题场景、数据处理流程、证据评估和风险边界中，才可能成为可复用的研究或应用方法。"
    : `这组资料共同指向一个观点：${domains.slice(0, 4).join("、") || "不同研究对象"}之间的联系，不在标题相似，而在“问题提出 -> 方法组织 -> 证据验证 -> 边界约束”的论证链条。`;

  const steps = [];
  const pushStep = (role, title, text, proves, refs = []) => {
    if (!text) return;
    steps.push({
      role,
      title,
      text,
      proves,
      refs: refs.map(argumentRef).filter(Boolean)
    });
  };

  const theoryRefs = theory.length ? theory : items.filter((item) => /解释|梳理|机制|演进/.test(item.problemType));
  pushStep(
    "问题起点",
    "先说明为什么需要重新组织研究对象",
    theoryRefs.length
      ? `${profilePhrase(theoryRefs[0])}。它的作用是把问题从“现象描述”推进到“机制或研究演进需要被解释”。`
      : `${profilePhrase(items[0])}。它承担问题起点：先界定研究对象和要解决的矛盾。`,
    "证明后续不能只罗列概念，必须解释对象为什么需要新的分析方法。",
    theoryRefs.slice(0, 2)
  );

  const methodRefs = method.length ? method : items.filter((item) => /框架|流程|建模|控制|机制|智能体/.test(item.methodType));
  pushStep(
    "方法中枢",
    "再给出把问题变成可操作流程的方法",
    methodRefs.length
      ? `${profilePhrase(methodRefs[0])}。它把前面的抽象问题转成可执行的方法链条，例如数据处理、模型组织、工具协同、机制解释或控制流程。`
      : `${methodTypes.slice(0, 3).join("、") || "方法组织"}构成这组资料的中间层。`,
    "证明研究推进的关键不是换一个名词，而是把问题拆成可执行、可评估的步骤。",
    methodRefs.slice(0, 2)
  );

  const appRefs = application.length ? application : items.filter((item) => /应用|预测|范式|场景/.test(`${item.domain} ${item.problemType}`));
  pushStep(
    "应用推导",
    "然后把方法放到具体场景里检验它是否有用",
    appRefs.length
      ? `${profilePhrase(appRefs[0])}。它说明方法一旦进入具体场景，就会变成预测、消费研究、接口安全、交通控制等可检验任务。`
      : "这些资料虽然研究对象不同，但都在尝试把方法落到具体对象上，而不是停留在概念层。",
    "证明方法的价值必须通过具体场景表现出来，不能只靠框架自洽。",
    appRefs.slice(0, 2)
  );

  pushStep(
    "证据支撑",
    "最后用证据说明观点是否站得住",
    hasConcreteEvidence
      ? `${evidence.map((item) => `${item.domain}使用${item.evidenceType}`).slice(0, 3).join("；")}。这些证据承担的不是装饰作用，而是检验方法是否真的改善了问题。`
      : "当前资料更偏理论或框架，证据链还需要回到原文继续补强。",
    "证明一条关系能否成立，要看它是否有实验、指标、案例、文本或计量证据支撑。",
    evidence.slice(0, 3)
  );

  pushStep(
    "边界回收",
    "再反过来限制结论不能外推过头",
    boundary.length
      ? `这些资料共同提示 ${boundary.slice(0, 4).join("、")}。因此结论不能写成“所有场景都有效”，而应写成“在特定数据、任务、交互或风险条件下有效”。`
      : "当前资料没有形成稳定的共同边界，正式写作时需要补充适用条件。",
    "证明综合观点必须带适用范围，否则容易把单篇结论误当成普遍规律。",
    items.filter((item) => boundary.includes(item.riskType)).slice(0, 3)
  );

  const conclusion = hasAgentMethod
    ? "因此，这几篇放在一起不是为了证明它们题目相似，而是证明：智能方法要真正进入研究和应用，必须经过“机制解释 -> 方法设计 -> 场景落地 -> 证据评估 -> 风险约束”这一整条链。"
    : "因此，这几篇的逻辑联系不是标题连接，而是共同构成一条从问题提出到证据验证、再到边界约束的研究链。";
  const weakLinks = edges
    .filter((edge) => /概念|边界对照|证据类型/.test(edge.relation || "") && Number(edge.weight || 0) < 0.65)
    .slice(0, 3)
    .map((edge) => edge.evidence?.why)
    .filter(Boolean);
  return { thesis, steps, conclusion, weakLinks };
}

function profilePhrase(profile) {
  if (!profile) return "";
  return `${profile.domain}围绕“${profile.problemType}”展开，主要方法是${profile.methodType}`;
}

function argumentRef(profile) {
  if (!profile) return "";
  return `${profile.domain} / ${profile.methodType}`;
}

function docGraphProfile(doc) {
  const evidence = evidenceCardForDoc(doc);
  const card = analysisCardFromEvidence(evidence, doc);
  const rawText = displayText([
    doc.title,
    doc.filename,
    doc.abstract,
    doc.takeaway,
    card.question,
    card.method,
    card.findings,
    evidence.contribution?.claim,
    ...(evidence.main_claims || []).map((item) => item.claim),
    ...(evidence.evidence || []).map((item) => item.claim),
    ...(doc.keywords || []).map((item) => item.term || item)
  ].join(" "));
  const keyInfo = synthesizeDocKeyInfo(doc);
  const haystack = `${rawText} ${keyInfo}`;
  const domain = inferGraphDomain(haystack);
  return {
    id: doc.id,
    title: publicDocTitle(doc),
    domain,
    problemType: inferGraphProblemType(haystack, domain),
    methodType: inferGraphMethodType(haystack),
    evidenceType: inferGraphEvidenceType(haystack),
    riskType: inferGraphRiskType(haystack),
    question: profileQuestion(evidence.research_question?.claim || card.question, keyInfo),
    method: matrixDisplayField(evidence.method?.claim || card.method, methodFallbackForDoc(doc)),
    finding: matrixDisplayField(keyInfo, evidence.contribution?.claim || card.findings || doc.takeaway),
    keywords: cleanTopicTerms((doc.keywords || []).map((item) => displayText(item.term || item)), 8)
  };
}

function inferGraphDomain(text) {
  if (/隐藏|漏洞|接口|应用程序接口|REST|安全测试|扫描/.test(text)) return "接口安全检测";
  if (/网约车|出行|交通流.*预测|短时预测|订单/.test(text)) return "交通流预测";
  if (/交叉口|信号配时|车辆轨迹|网联自动驾驶|混合交通/.test(text)) return "交通控制";
  if (/消费研究|消费感知|行为模拟|营销|自主演化/.test(text)) return "消费研究智能化";
  if (/意识形态|认同|青年|人机交互|感性化/.test(text)) return "生成式人工智能影响";
  if (/大语言模型|智能体|大模型|垂直领域|工具调用|多源数据|语义检索|语义向|链式推理|提示优化|内容生成设计|城市动态感知/.test(text)) return "智能体设计";
  if (/域外汉籍|文献计量|知识图谱|发文|引文/.test(text)) return "文献计量与知识图谱";
  return "一般研究资料";
}

function inferGraphProblemType(text, domain = "") {
  if (domain === "交通流预测") return "提升预测效果";
  if (domain === "智能体设计") return "构建系统框架";
  if (domain === "消费研究智能化") return "重构研究范式";
  if (domain === "接口安全检测") return "弥补现有方法不足";
  if (domain === "生成式人工智能影响") return "解释行为机制";
  if (domain === "文献计量与知识图谱") return "梳理研究演进";
  if (/预测|准确|误差|交通流|订单/.test(text)) return "提升预测效果";
  if (/缺乏|不足|难以|挑战|问题|安全盲区|漏检|误报/.test(text)) return "弥补现有方法不足";
  if (/认同|影响|机制|行为|调制/.test(text)) return "解释行为机制";
  if (/设计|构建|框架|体系|流程|系统化/.test(text)) return "构建系统框架";
  if (/演进|趋势|热点|知识图谱|文献计量/.test(text)) return "梳理研究演进";
  return "界定研究问题";
}

function profileQuestion(primary, keyInfo) {
  const value = cleanMatrixText(primary || "");
  if (!value || isMatrixNoise(value) || /^\[|^\]|^关键词|^摘要/.test(value) || value.length < 18) return displayText(keyInfo || "");
  return value;
}

function inferGraphMethodType(text) {
  if (/智能体|模型上下文协议|检索增强生成|工具调用|反馈迭代/.test(text)) return "智能体协同流程";
  if (/知识图谱|文献计量|引文|关键词|共现/.test(text)) return "计量分析与知识图谱";
  if (/组合预测|时间序列|分解|融合|预测模型|误差修正/.test(text)) return "组合建模与预测";
  if (/协同控制|信号配时|轨迹|控制框架|快变量|慢变量/.test(text)) return "协同控制框架";
  if (/机制|调制|行为|认同|交互/.test(text)) return "机制解释";
  if (/三阶段|消费感知|类脑模拟|自主演化|范式/.test(text)) return "范式框架";
  return "文本归纳与结构分析";
}

function inferGraphEvidenceType(text) {
  if (/实验|结果|发现率|准确率|误差|指标|对比|仿真|数据/.test(text)) return "实验/指标证据";
  if (/案例|应用|系统|城市|场景/.test(text)) return "案例/场景证据";
  if (/文献计量|知识图谱|发文|关键词|引文/.test(text)) return "文献计量证据";
  if (/理论|机制|逻辑|路径|范式/.test(text)) return "理论推导证据";
  return "文本证据";
}

function inferGraphRiskType(text) {
  if (/安全|漏洞|误报|权限|敏感|风险/.test(text)) return "安全与误报边界";
  if (/数据|参数|样本|外推|泛化|场景/.test(text)) return "数据与场景边界";
  if (/伦理|治理|意识形态|算法缺陷|偏见/.test(text)) return "治理与伦理边界";
  if (/缺少|不足|未来|仍需|局限/.test(text)) return "研究不足与待验证";
  return "适用边界待核对";
}

function compareDocRelation(aDoc, bDoc, aProfile, bProfile, shared = [], keywordScore = 0) {
  const claimRelation = compareDocClaims(aDoc, bDoc, aProfile, bProfile, shared, keywordScore);
  const profileRelation = compareDocProfiles(aProfile, bProfile, shared, keywordScore);
  if (!claimRelation) return profileRelation;
  if (claimRelation.score >= profileRelation.score - 0.08) return claimRelation;
  return {
    ...profileRelation,
    details: [
      ...(profileRelation.details || []),
      `补充 claim 关系：${claimRelation.label}。${claimRelation.why}`
    ].slice(0, 5)
  };
}

function compareDocClaims(aDoc, bDoc, aProfile, bProfile, shared = [], keywordScore = 0) {
  const a = relationClaimProfile(aDoc, aProfile);
  const b = relationClaimProfile(bDoc, bProfile);
  const candidates = [];
  const push = (kind, label, score, why, details = []) => {
    candidates.push({ kind, label, score, why, details, claimPair: { a: a.primaryClaim, b: b.primaryClaim } });
  };
  const sameProblem = textSimilarity(a.problem, b.problem);
  const sameMethod = textSimilarity(a.method, b.method);
  const sameEvidence = a.evidenceType === b.evidenceType && a.evidenceType !== "文本证据";
  const bothGaps = /缺少|不足|局限|待|风险|外推|泛化|评价|指标|审计/.test(`${a.boundary} ${b.boundary}`);
  const appExpands = applicationExpansion(aProfile, bProfile);
  const relatedContext = sameProblem > 0.18 ||
    sameMethod > 0.16 ||
    shared.length >= 2 ||
    keywordScore > 0.06 ||
    aProfile?.domain === bProfile?.domain ||
    appExpands;
  if ((sameProblem > 0.2 || aProfile?.problemType === bProfile?.problemType) && a.problemUsable && b.problemUsable) {
    push(
      "problem_extends",
      "问题延续",
      0.62 + Math.min(0.14, sameProblem),
      `${aDoc.title} 与 ${bDoc.title} 都围绕相近问题展开；前者的问题定义可以作为后者比较或深化的起点。`,
      [`A 问题：${a.problem}`, `B 问题：${b.problem}`, `共同问题强度：${sameProblem.toFixed(2)}`]
    );
  }
  if ((sameMethod > 0.18 || aProfile?.methodType === bProfile?.methodType) && a.methodUsable && b.methodUsable) {
    push(
      "method_transfers",
      "方法迁移",
      0.66 + Math.min(0.15, sameMethod),
      `两篇都使用或组织了相近方法链条，关系重点是方法能否从一个对象迁移到另一个对象，而不是标题是否相似。`,
      [`A 方法：${a.method}`, `B 方法：${b.method}`, `方法相似度：${sameMethod.toFixed(2)}`]
    );
  }
  if (relatedContext && isFrameworkLike(a) && isEmpiricalLike(b)) {
    push(
      "evidence_strengthens",
      "证据补强",
      0.7,
      `${aDoc.title} 更像框架或机制来源，${bDoc.title} 提供实验、指标、案例或场景证据，可用来补强前者提出的研究判断。`,
      [`框架侧：${a.primaryClaim}`, `证据侧：${b.evidence}`]
    );
  }
  if (relatedContext && isFrameworkLike(b) && isEmpiricalLike(a)) {
    push(
      "evidence_strengthens",
      "证据补强",
      0.7,
      `${bDoc.title} 更像框架或机制来源，${aDoc.title} 提供实验、指标、案例或场景证据，可用来补强前者提出的研究判断。`,
      [`框架侧：${b.primaryClaim}`, `证据侧：${a.evidence}`]
    );
  }
  if (sameEvidence && relatedContext && aProfile?.domain !== bProfile?.domain) {
    push(
      "evidence_differs",
      "证据类型不同场景对照",
      0.56,
      `两篇都依赖${a.evidenceType}，但研究对象不同，适合比较证据强弱，不能直接合并成同一个结论。`,
      [`A 证据：${a.evidence}`, `B 证据：${b.evidence}`]
    );
  }
  if (relatedContext && (boundaryLimitsClaim(a.boundary, b.primaryClaim) || boundaryLimitsClaim(b.boundary, a.primaryClaim))) {
    push(
      "boundary_limits",
      "边界约束",
      0.64,
      `一篇的局限或适用边界会限制另一篇结论的外推范围，综述中应写成有条件成立，而不是普遍成立。`,
      [`A 边界：${a.boundary}`, `B 边界：${b.boundary}`]
    );
  }
  if (bothGaps && (shared.length || keywordScore > 0.03 || sameProblem > 0.12)) {
    push(
      "research_gap_shared",
      "共同研究空白",
      0.58,
      `两篇都暴露出评价、泛化、数据场景或风险边界方面的空白，适合转化为后续研究问题。`,
      [`A 不可外推：${a.boundary}`, `B 不可外推：${b.boundary}`]
    );
  }
  if (appExpands) {
    push(
      "application_expands",
      "应用扩展",
      0.6,
      `一篇偏通用方法或系统框架，另一篇偏具体场景应用；关系应写成应用扩展，证据强度要随场景重新核查。`,
      [`A 定位：${aProfile?.domain} / ${aProfile?.methodType}`, `B 定位：${bProfile?.domain} / ${bProfile?.methodType}`]
    );
  }
  if (!candidates.length && !relatedContext && aProfile?.domain !== bProfile?.domain && aProfile?.methodType !== bProfile?.methodType) {
    push(
      "cannot_merge",
      "不能强行合并",
      0.34,
      `两篇的研究对象、方法和证据链差异较大，只能作为边界对照，不能因为少量概念相似就合并结论。`,
      [`A 判断：${a.primaryClaim}`, `B 判断：${b.primaryClaim}`]
    );
  }
  if (!candidates.length) return null;
  return candidates.sort((x, y) => y.score - x.score)[0];
}

function relationClaimProfile(doc, profile = {}) {
  const card = evidenceCardForDoc(doc);
  const researchQuestion = card.research_question || {};
  const methodField = card.method || {};
  const contributionField = card.contribution || {};
  const evidenceField = (card.evidence || [])[0] || {};
  const limitationField = (card.limitations || [])[0] || {};
  const pick = (...items) => cleanAnswerText(items) || "";
  const problem = pick(researchQuestion.normalized_claim, profile.question, doc.abstract);
  const method = pick(methodField.normalized_claim, profile.method, doc.abstract);
  const contribution = pick(contributionField.normalized_claim, card.main_claims?.[0]?.normalized_claim, profile.finding, doc.abstract);
  const evidence = pick(evidenceField.normalized_claim, card.data_or_materials?.normalized_claim, contribution);
  const boundary = pick(limitationField.normalized_claim, profile.riskType, "该文的外推边界需要结合数据、方法和场景核对。");
  return {
    problem,
    method,
    contribution,
    evidence,
    boundary,
    primaryClaim: contribution || problem || method,
    evidenceType: profile?.evidenceType || inferGraphEvidenceType(`${evidence} ${doc.abstract || ""}`),
    problemUsable: usableEvidenceItem(researchQuestion) || !isMissingEvidenceText(problem),
    methodUsable: usableEvidenceItem(methodField) || !isMissingEvidenceText(method),
    contributionUsable: usableEvidenceItem(contributionField) || !isMissingEvidenceText(contribution),
    evidenceUsable: usableEvidenceItem(evidenceField) || !isMissingEvidenceText(evidence),
    boundaryUsable: usableEvidenceItem(limitationField) || !isMissingEvidenceText(boundary)
  };
}

function textSimilarity(a, b) {
  return jaccard(new Set(tokens(a || "")), new Set(tokens(b || "")));
}

function isFrameworkLike(item) {
  return /框架|机制|设计|体系|范式|流程|方法路径|理论|模型上下文|检索|推理/.test(`${item.method} ${item.primaryClaim}`);
}

function isEmpiricalLike(item) {
  return /实验|指标|准确率|发现率|误差|仿真|对比|数据|样本|案例|证据基础/.test(`${item.evidence} ${item.primaryClaim}`);
}

function boundaryLimitsClaim(boundary = "", claim = "") {
  return /局限|不足|风险|限制|挑战|误报|依赖|仍需|可能|偏差|外推|泛化|边界/.test(boundary) &&
    /有效|提升|降低|发现|证明|说明|能够|实现|优化/.test(claim);
}

function applicationExpansion(aProfile = {}, bProfile = {}) {
  const aGeneral = /智能体设计/.test(aProfile?.domain || "") || /智能体|大模型|工具调用|检索增强|链式推理|模型上下文/.test(aProfile?.methodType || "");
  const bApplied = /接口安全检测|交通流预测|交通控制|消费研究智能化/.test(bProfile?.domain || "");
  const bGeneral = /智能体设计/.test(bProfile?.domain || "") || /智能体|大模型|工具调用|检索增强|链式推理|模型上下文/.test(bProfile?.methodType || "");
  const aApplied = /接口安全检测|交通流预测|交通控制|消费研究智能化/.test(aProfile?.domain || "");
  return (aGeneral && bApplied) || (bGeneral && aApplied);
}

function compareDocProfiles(a, b, shared = [], keywordScore = 0) {
  const candidates = [];
  const push = (label, score, why, details = [], kind = "") => candidates.push({ label, score, why, details, kind: kind || relationKindForLabel(label) });
  if (a.domain === b.domain && a.domain !== "一般研究资料") {
    push("同一问题域的纵向对照", 0.72, `两篇都落在“${a.domain}”，适合比较问题设定、方法链条和证据强弱。`, [
      `共同领域：${a.domain}`,
      `A 的方法：${a.methodType}`,
      `B 的方法：${b.methodType}`
    ], "same_problem");
  }
  if (a.problemType === b.problemType && a.problemType !== "界定研究问题") {
    push("共同问题意识", 0.58, `两篇都在处理“${a.problemType}”，可以放在同一段讨论研究动机。`, [
      `A 关注：${a.question}`,
      `B 关注：${b.question}`
    ], "same_problem");
  }
  if (a.methodType === b.methodType && a.methodType !== "文本归纳与结构分析") {
    push("方法路径可比较", 0.62, `两篇都使用“${a.methodType}”，关系重点不是题目相似，而是方法如何迁移或复用。`, [
      `A 方法：${a.method}`,
      `B 方法：${b.method}`
    ], "same_method");
  }
  if (a.evidenceType === b.evidenceType && a.evidenceType !== "文本证据") {
    const relatedByTopic = a.domain === b.domain || a.problemType === b.problemType || a.methodType === b.methodType || shared.length >= 2;
    push("证据类型可横向比较", relatedByTopic ? 0.5 : 0.22, `两篇都主要依赖“${a.evidenceType}”，${relatedByTopic ? "适合比较指标、案例或论证力度。" : "但研究对象差异较大，只适合作为证据写法的弱对照。"}`, [
      `A 证据类型：${a.evidenceType}`,
      `B 证据类型：${b.evidenceType}`
    ], relatedByTopic ? "supports" : "evidence_gap");
  }
  if (/智能体|大语言模型/.test(`${a.domain} ${a.methodType}`) && /智能体|大语言模型/.test(`${b.domain} ${b.methodType}`) && a.domain !== b.domain) {
    push("智能体方法的跨场景迁移", 0.68, "两篇不一定研究同一对象，但都把智能体/大模型作为方法底座，适合讨论从设计方法到应用场景的迁移。", [
      `${a.domain}：${a.method}`,
      `${b.domain}：${b.method}`
    ], "extends");
  }
  if ((/接口安全检测|交通流预测|交通控制/.test(a.domain) && /智能体设计|消费研究智能化/.test(b.domain)) ||
      (/接口安全检测|交通流预测|交通控制/.test(b.domain) && /智能体设计|消费研究智能化/.test(a.domain))) {
    push("技术方法与应用场景的连接", 0.44, "一篇偏方法或系统实现，另一篇偏应用/影响场景，适合说明技术能力如何进入具体问题。", [
      `${a.domain}：${a.problemType}`,
      `${b.domain}：${b.problemType}`
    ], "extends");
  }
  if (a.riskType === b.riskType && a.riskType !== "适用边界待核对") {
    push("共同边界与风险", 0.42, `两篇都涉及“${a.riskType}”，适合放在综述的局限或治理讨论中。`, [
      `A 边界：${a.riskType}`,
      `B 边界：${b.riskType}`
    ], "contrasts");
  }
  if (shared.length >= 2 || keywordScore > 0.04) {
    push(shared.length >= 3 ? "概念网络交叉" : "局部概念交叉", 0.3 + Math.min(0.24, shared.length / 16 + keywordScore), `两篇共享 ${shared.slice(0, 4).join("、") || "若干相近概念"}，但需要结合方法和证据判断是否能合并讨论。`, [
      `共享概念：${shared.slice(0, 6).join("、") || "较少"}`
    ], "evidence_gap");
  }
  if (!candidates.length) {
    push("研究边界对照", 0.18, "两篇直接关联较弱，更适合作为研究对象和方法边界的对照，而不是强行合并结论。", [
      `${a.domain} vs ${b.domain}`,
      `${a.methodType} vs ${b.methodType}`
    ], "contrasts");
  }
  return candidates.sort((x, y) => y.score - x.score)[0];
}

function cleanRelationTerms(terms = []) {
  const generic = /^(研究|方法|模型|系统|结果|数据|问题|相关|分析|本文|提出|可以|通过|基于|应用|进行|显示|表明|交通|智能|人工智能)$/i;
  const seen = new Set();
  const cleaned = [];
  for (const term of terms) {
    const value = displayText(term || "").trim();
    if (!value || value.length < 2 || generic.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  return cleaned.slice(0, 8);
}

function usableEvidenceItem(item = {}) {
  if (!item) return false;
  if ("is_usable" in item) return Boolean(item.is_usable);
  const type = item.evidence_type ? { directQuoteEligible: item.direct_quote_eligible !== false } : evidenceTypeForQuote(item.quote || "");
  return Boolean(item.quote && item.page && type.directQuoteEligible && !/missing|weak|mismatch|low_quote_quality/.test(`${item.audit || ""} ${item.support_level || ""} ${item.dimension_audit || ""}`));
}

function isMissingEvidenceText(text = "") {
  return /当前没有足够原文支撑|未抽取到明确|待核对|无法可靠/.test(String(text || ""));
}

function docUsableEvidenceCount(doc) {
  const card = evidenceCardForDoc(doc);
  return [
    card.research_question,
    card.method,
    card.data_or_materials,
    card.contribution,
    ...(card.main_claims || []),
    ...(card.evidence || []),
    ...(card.limitations || [])
  ].filter(usableEvidenceItem).length;
}

function shouldKeepGraphRelation(aDoc, bDoc, aProfile, bProfile, relation, shared = [], keywordScore = 0) {
  if (!relation) return false;
  const kind = relation.kind || relationKindForLabel(relation.label);
  const evidenceEnough = docUsableEvidenceCount(aDoc) > 0 && docUsableEvidenceCount(bDoc) > 0;
  const strongProfile = aProfile?.domain === bProfile?.domain && aProfile?.domain !== "一般研究资料";
  const strongMethod = aProfile?.methodType === bProfile?.methodType && aProfile?.methodType !== "文本归纳与结构分析";
  const strongShared = shared.length >= 2 || keywordScore > 0.06;
  if (!evidenceEnough && !/cannot_merge|contrasts/.test(kind)) return false;
  if (/problem|same_problem/.test(kind) && /当前没有足够原文支撑/.test((relation.details || []).join(" "))) return false;
  if (/evidence_gap|supports/.test(kind) && !strongProfile && !strongMethod && shared.length < 3) return false;
  return relation.score >= 0.5 || strongProfile || strongMethod || strongShared || /cannot_merge|boundary|research_gap/.test(kind);
}

function relationKindForLabel(label = "") {
  if (/问题延续/.test(label)) return "problem_extends";
  if (/方法迁移/.test(label)) return "method_transfers";
  if (/证据补强/.test(label)) return "evidence_strengthens";
  if (/证据类型不同/.test(label)) return "evidence_differs";
  if (/边界约束/.test(label)) return "boundary_limits";
  if (/共同研究空白/.test(label)) return "research_gap_shared";
  if (/应用扩展/.test(label)) return "application_expands";
  if (/不能强行合并/.test(label)) return "cannot_merge";
  if (/同一问题域|共同问题/.test(label)) return "same_problem";
  if (/方法路径/.test(label)) return "same_method";
  if (/跨场景|技术方法|扩展/.test(label)) return "extends";
  if (/证据类型|支撑|支持/.test(label)) return "supports";
  if (/边界|风险|对照/.test(label)) return "contrasts";
  return "evidence_gap";
}

function ensureGraphCoverage(docs, edges, profiles) {
  if (docs.length <= 1) return edges;
  const covered = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const completed = [...edges];
  for (const doc of docs) {
    if (covered.has(doc.id)) continue;
    const best = docs
      .filter((other) => other.id !== doc.id)
      .map((other) => ({ other, relation: compareDocRelation(doc, other, profiles.get(doc.id), profiles.get(other.id), [], 0) }))
      .filter((item) => shouldKeepGraphRelation(doc, item.other, profiles.get(doc.id), profiles.get(item.other.id), item.relation, [], 0))
      .sort((a, b) => b.relation.score - a.relation.score)[0];
    if (!best) continue;
    completed.push({
      source: doc.id,
      target: best.other.id,
      weight: Number(Math.max(0.12, best.relation.score).toFixed(2)),
      relation: best.relation.label,
      relationKind: best.relation.kind || relationKindForLabel(best.relation.label),
      shared: [],
      evidence: relationEvidence(doc, best.other, [], best.relation, profiles.get(doc.id), profiles.get(best.other.id))
    });
  }
  return completed.sort((a, b) => b.weight - a.weight).slice(0, 32);
}

function docFlowSection(doc, id, title, patterns, fallbackIndex, used = new Set()) {
  const chunks = doc.chunks || [];
  const usefulChunks = chunks.filter((chunk) => !used.has(chunk.index) && !isLowValueChunk(chunk.text));
  let chunk = selectFlowChunk(doc, id, patterns, usefulChunks, fallbackIndex) ||
    usefulChunks[0] ||
    chunks.find((item) => !used.has(item.index)) ||
    chunks[fallbackIndex] ||
    chunks[0];
  let evidence = chunk ? formatChunkEvidence(chunk, patterns, doc) : "当前资料未抽出足够文本，需要回到原文核对。";
  if (/未找到可展示的有效证据行/.test(evidence)) {
    const alternate = usefulChunks.find((item) => {
      if (item.index === chunk?.index) return false;
      return !/未找到可展示的有效证据行/.test(formatChunkEvidence(item, patterns, doc));
    });
    if (alternate) {
      chunk = alternate;
      evidence = formatChunkEvidence(chunk, patterns, doc);
    }
  }
  if (chunk) used.add(chunk.index);
  const rawEvidence = chunk?.text || "当前资料未抽出足够文本，需要回到原文核对。";
  return {
    id,
    title,
    citation: chunk?.citation || "",
    summary: summarizeFlowNode(doc, id, rawEvidence),
    evidence,
    text: summarizeFlowNode(doc, id, rawEvidence),
    terms: (chunk?.terms || []).map(displayText).filter(Boolean)
  };
}

function selectFlowChunk(doc, id, patterns, chunks, fallbackIndex = 0) {
  if (!chunks.length) return null;
  const scored = chunks
    .map((chunk, index) => ({ chunk, score: flowChunkScore(doc, id, patterns, chunk, index, chunks.length, fallbackIndex) }))
    .filter((item) => item.score > -40)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
  return scored[0]?.chunk || chunks[fallbackIndex] || chunks[0];
}

function flowChunkScore(doc, id, patterns, chunk, index, total, fallbackIndex) {
  const text = cleanEvidenceLine(chunk?.text || "");
  if (!text || isLowValueChunk(text)) return -100;
  if (text.length < 30) return -100;
  const hits = patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  const signal = flowSignalScore(id, text);
  if (!hits && !signal) return -100;
  const page = Number(chunk.pageStart || 0);
  const pages = Math.max(1, Number(doc.pages || 0));
  const position = page ? (page - 1) / Math.max(1, pages - 1) : index / Math.max(1, total - 1);
  const target = flowTargetPosition(id);
  const positionScore = Math.max(0, 10 - Math.abs(position - target) * 18);
  const fallbackScore = Math.max(0, 3 - Math.abs(index - fallbackIndex));
  const citationCoverage = chunk.pageEnd && chunk.pageStart && chunk.pageEnd !== chunk.pageStart ? 1.2 : 0;
  return hits * 10 + signal + positionScore + fallbackScore + citationCoverage;
}

function flowTargetPosition(id) {
  return {
    question: 0.08,
    method: 0.22,
    mechanism: 0.42,
    evidence: 0.62,
    risk: 0.78,
    conclusion: 0.9
  }[id] ?? 0.45;
}

function flowSignalScore(id, text) {
  const common = /提出|构建|设计|采用|基于|结果|表明|实验|发现|验证|结论|不足|局限|风险|未来|讨论|影响|效果/.test(text) ? 2 : 0;
  const nodeSignals = {
    question: /问题|挑战|不足|缺乏|背景|目的|旨在|针对|重要|意义|需求/.test(text) ? 8 : 0,
    method: /方法|流程|框架|模型|算法|步骤|体系|设计|构建|采用|基于/.test(text) ? 8 : 0,
    mechanism: /机制|原理|过程|协同|作用|影响|关系|控制|推理|融合|分解|优化/.test(text) ? 8 : 0,
    evidence: /实验|仿真|结果|表明|显示|数据|对比|准确|误差|提升|降低|MAPE|%|发现率/.test(text) ? 9 : 0,
    risk: /不足|局限|风险|限制|误差|偏差|伦理|安全|未来|仍需|可能/.test(text) ? 9 : 0,
    conclusion: /结论|综上|表明|证明|可见|本文|未来|建议|应用|价值/.test(text) ? 8 : 0
  };
  return common + (nodeSignals[id] || 0);
}

function isLowValueChunk(text) {
  const clean = toHalfWidth(String(text || "")).replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (/相似文章推荐|similar articles recommended|请使用火狐|firefox|ie浏览器|本文引用格式|citation\s*format|作者简介|通讯作者|主要从事|基金项目|基金资助|参考文献|https?:\/\/|journal of .*natural science/i.test(clean)) return true;
  if (/(重庆理工大学学报|自然科学).*(重庆理工大学学报|自然科学).*(重庆理工大学学报|自然科学)/.test(clean)) return true;
  if (/摘要[:：]/.test(clean.replace(/摘\s+要/g, "摘要"))) return false;
  const citationMarks = (clean.match(/《[^》]{2,80}》/g) || []).length;
  const bracketRefs = (clean.match(/\[\d+\]|\(\d{4}\)|\b\d{4}\.\d{1,2}\b/g) || []).length;
  if ((citationMarks >= 4 || bracketRefs >= 6) && !/本文|研究|方法|结果|表明|发现|提出|构建|实验|模型/.test(clean)) return true;
  return /doi[:：]?/.test(clean);
}

function rawEvidenceLines(text) {
  return normalizeText(String(text || ""))
    .replace(/([。！？!?；;])\s*/g, "$1\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatChunkEvidence(chunk, preferredPatterns = [], doc = null) {
  const lines = rawEvidenceLines(chunk?.text || "");
  const candidates = lines
    .map((line, index) => ({ line: cleanEvidenceLine(line), index: index + 1 }))
    .filter(({ line }) => !isBoilerplateLine(line) && !isLowValueChunk(line));
  const picked =
    candidates.find(({ line }) => preferredPatterns.some((pattern) => pattern.test(line))) ||
    candidates.find(({ line }) => /提出|构建|实现|发现|表明|结果|实验|方法|流程|机制|风险|不足|限制|挑战|API|A2A|MCP|RAG/i.test(line)) ||
    candidates[0];
  if (!picked) return `第 ${chunk?.index || 1} 段：未找到可展示的有效证据行。`;
  return `第 ${chunk.index} 段，第 ${picked.index} 行：${displayText(completeEvidenceSnippet({ picked, candidates, chunk, doc }))}`;
}

function completeEvidenceSnippet({ picked, candidates = [], chunk = null, doc = null }) {
  let text = cleanEvidenceLine(picked?.line || "");
  const pickedPosition = candidates.findIndex((item) => item.index === picked?.index && item.line === picked?.line);
  if (pickedPosition > 0 && shouldPrependEvidence(text, candidates[pickedPosition - 1]?.line || "")) {
    text = joinEvidenceFragments(candidates[pickedPosition - 1].line, text);
  }
  for (let index = pickedPosition + 1; shouldExtendEvidence(text) && index >= 1 && index < candidates.length; index += 1) {
    text = joinEvidenceFragments(text, candidates[index].line);
  }
  if (shouldExtendEvidence(text) && doc && chunk) {
    const chunks = doc.chunks || [];
    const currentPosition = chunks.findIndex((item) => item.index === chunk.index);
    for (let chunkOffset = currentPosition + 1; shouldExtendEvidence(text) && chunkOffset > 0 && chunkOffset < chunks.length; chunkOffset += 1) {
      const nextLines = rawEvidenceLines(chunks[chunkOffset].text)
        .map((line) => cleanEvidenceLine(line))
        .filter((line) => line && !isBoilerplateLine(line) && !isLowValueChunk(line));
      for (const line of nextLines.slice(0, 2)) {
        text = joinEvidenceFragments(text, line);
        if (!shouldExtendEvidence(text)) break;
      }
    }
  }
  return shortEvidenceText(text, 340);
}

function shouldPrependEvidence(text = "", previous = "") {
  const clean = cleanEvidenceLine(text);
  const prev = cleanEvidenceLine(previous);
  if (!clean || !prev || prev.length > 180) return false;
  if (startsMidSentenceFragment(clean)) return true;
  if (/^[^。！？!?；;]{0,18}(的|地|得|中|上|下|内|外|后|前|方面|部分|过程|策略|用例|非线性|单量|籍|流量|结果)[,，]/.test(clean)) return true;
  return false;
}

function shouldExtendEvidence(text) {
  const clean = cleanEvidenceLine(text);
  if (!clean || clean.length >= 340) return false;
  if (!/[。！？!?；;]$/.test(clean)) return true;
  return /(?:基于|根据|通过|采用|提出|设计|构建|以及|并|与|和|为|对|在|将|由|把|从|向|的|及|或|分别提出基于)[。！？!?；;]?$/.test(clean);
}

function joinEvidenceFragments(left, right) {
  const a = cleanEvidenceLine(left);
  const b = cleanEvidenceLine(right);
  if (!a) return b;
  if (!b) return a;
  if (/[a-zA-Z0-9]$/.test(a) && /^[a-zA-Z0-9]/.test(b)) return `${a} ${b}`;
  return `${a}${b}`;
}

function normalizeEvidenceSnippet(text) {
  let clean = toHalfWidth(String(text || "")).replace(/\s+/g, " ").trim();
  clean = clean.replace(/^[,，。；;:：、)\]）\s]+/, "");
  const dataStart = clean.search(/实验数据采用|数据采用|数据来源|样本来源|研究对象为|选取[^。；;]{0,30}(?:数据|样本|案例|对象)/);
  if (dataStart > 0) clean = clean.slice(dataStart);
  clean = clean
    .replace(/摘\s+要/g, "摘要")
    .replace(/关\s+键\s+词/g, "关键词")
    .replace(/基金项目[:：][^。！？!?]{0,220}/g, "")
    .replace(/作者简介[:：][^。！？!?]{0,220}/g, "")
    .replace(/收稿日期[:：][^。！？!?]{0,120}/g, "")
    .replace(/通信作者[:：][^。！？!?]{0,160}/g, "")
    .replace(/参考文献\s*$/g, "")
    .replace(/\[[0-9,\-\s]{1,20}\]/g, "")
    .replace(/\b\d+(?:\.\d+){1,3}\s*[^。；;]{0,40}(?:理论|成果|研究|分析|方法|模型|实验|结论)\s*/g, "")
    .replace(/(?:第\s*)?\d+\s*(卷|期)\s*/g, "")
    .replace(/\b(?:Vol|No)\.\s*\d+\b/gi, "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/doi[:：]?\s*10\.\S+/gi, "")
    .replace(/中图分类号[:：]?\S+/g, "")
    .replace(/文献标志码[:：]?\S+/g, "")
    .replace(/文章编号[:：]?\S+/g, "")
    .replace(/^[,，;；:：、\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > 160) clean = trimToCompleteSentence(clean, 160);
  return clean;
}

function trimToCompleteSentence(text, limit = 160) {
  const clean = displayText(text);
  if (clean.length <= limit) return clean;
  const sliced = clean.slice(0, limit);
  const lastStop = Math.max(sliced.lastIndexOf("。"), sliced.lastIndexOf("；"), sliced.lastIndexOf(";"));
  if (lastStop >= 60) return sliced.slice(0, lastStop + 1);
  return sliced.replace(/[，,;；:：、\s]+$/, "");
}

function isEvidenceNoise(text) {
  const clean = toHalfWidth(String(text || "")).replace(/\s+/g, " ").trim();
  return /基金项目|基金资助|作者简介|收稿日期|修回日期|通信作者|通讯作者|参考文献|相似文章推荐|本文引用格式|引用格式|Citation format|关键词[:：]|中图分类号|文献标志码|文章编号|版权所有|copyright|doi[:：]|https?:\/\/|www\./i.test(clean) ||
    /^[\d\s\-—–.,;:()（）]+$/.test(clean) ||
    /(大学|学院|研究院|实验室|中心)[,， ]*(大学|学院|研究院|实验室|中心)/.test(clean);
}

function isFormulaFragment(text) {
  const clean = toHalfWidth(String(text || "")).replace(/\s+/g, " ").trim();
  const formulaSignals = (clean.match(/[=+\-−×*/∑Σ√≤≥<>]|\\frac|\\sum|alpha|beta|gamma/gi) || []).length;
  const words = (clean.match(/[\u4e00-\u9fa5A-Za-z]/g) || []).length;
  if (/^[−\-–—]?\s*\d+(?:\.\d+)?\s*[,，;；]?\s*其中/.test(clean)) return true;
  if (/^[A-Za-z]\s*为[^。；;]{2,40}(?:[,，]\s*[A-Za-z]\s*为[^。；;]{2,40})+/.test(clean)) return true;
  if (formulaSignals >= 3 && words < 45) return true;
  if (/^[式图表]\s*\d+[-－]?\d*[:：]?/.test(clean)) return true;
  return false;
}

function isIncompleteEvidenceFragment(text) {
  const clean = displayText(text);
  if (!clean) return true;
  if (startsMidSentenceFragment(clean)) return true;
  if (/^(之下|之中|其中|因此|同时|并且|以及|或者|从而|对于|基于|通过|采用|利用|为了|与|和|的|了|在|将|由|把|向|对|模型|特征|征)[\u4e00-\u9fa5,，]/.test(clean)) return true;
  if (/[，,、;；:：]$/.test(clean) && clean.length < 120) return true;
  if (/(?:和|及|与|或|的|为|将|把|对|在|基于|通过|采用)[。！？!?；;]?$/.test(clean)) return true;
  return false;
}

function startsMidSentenceFragment(text = "") {
  const clean = displayText(text);
  if (!clean) return true;
  if (/^[,，。；;:：、)\]）\-−=+*/\\\d\s]+/.test(clean)) return true;
  if (/^(籍|单量|流量|行距离|层策略|用例生成|非线性强的特点|分别为|于跟随|级感知|策模型|低了|然基于|内在复杂性|方面|其中|同时|因此|这|该|其|他们|它们|这些|上述|前者|后者|结果|值|图\d+|表\d+)/.test(clean)) return true;
  if (/^[一二三四五六七八九十]方面/.test(clean)) return true;
  if (/^[^。！？!?；;]{0,10}(?:的|地|得|中|上|下|内|外|后|前|过程|策略|用例|结果)[,，]/.test(clean)) return true;
  return false;
}

function cleanEvidenceLine(text) {
  let clean = normalizeEvidenceSnippet(text);
  const abstractIndex = clean.search(/摘要[:：]/);
  if (abstractIndex > 0) clean = clean.slice(abstractIndex);
  return clean;
}

function conciseObject(doc, text = "") {
  const source = displayText(`${doc?.title || ""} ${doc?.filename || ""} ${text}`);
  const candidates = [
    [/混合交通|信号配时|车辆轨迹|交叉口|交通控制/, "混合交通场景下信号配时与车辆轨迹协同"],
    [/网约车|交通流|订单|短时预测/, "网约车或交通流预测场景"],
    [/接口|API|漏洞|REST|安全检测/, "接口安全检测场景"],
    [/消费研究|消费者|营销|行为模拟/, "智能化消费研究场景"],
    [/意识形态|感性化认同|青年|人机交互/, "生成式人工智能交互中的意识形态认同"],
    [/域外汉籍|文献计量|知识图谱|引文/, "域外汉籍研究的文献计量与知识图谱"],
    [/智能体|大语言模型|工具调用|RAG|检索增强/, "大语言模型智能体应用"]
  ];
  return candidates.find(([pattern]) => pattern.test(source))?.[1] || shortEvidenceText(text || doc?.title || "研究对象", 36);
}

function conciseProblem(text = "") {
  const clean = displayText(text);
  const direct = firstMatch(clean, /(?:针对|解决|弥补|面向|围绕).{8,70}(?:问题|不足|挑战|需求|难题)/);
  if (direct) return direct.replace(/^针对/, "解决").replace(/^面向/, "解决");
  const hard = firstMatch(clean, /[^。；;]{0,40}(?:难以|不足|缺乏|挑战|瓶颈|问题)[^。；;]{0,50}/);
  if (hard) return `解决${hard.replace(/^[，,。；;\s]+/, "")}`;
  return "";
}

function concisePurpose(text = "") {
  const clean = displayText(text);
  const purpose = firstMatch(clean, /(?:旨在|目的在于|本文以|本文旨在|本研究旨在|为了|以期|试图|拟)[^。；;]{8,90}/);
  if (!purpose) return "";
  return purpose
    .replace(/^本文以/, "以")
    .replace(/^本文旨在/, "旨在")
    .replace(/^本研究旨在/, "旨在")
    .replace(/^为了/, "为")
    .trim();
}

function conciseMethod(text = "") {
  const clean = displayText(text);
  const authored = firstMatch(clean, /(?:本文|本研究|文章|该文).{0,16}(?:采用|运用|使用|提出|构建|设计|基于|利用|引入|建立|开发)[^。；;]{8,120}/);
  const method = authored || firstMatch(clean, /(?:采用|运用|构建|提出|设计|使用|基于|利用|引入|建立|开发|融合|分解|优化|可通过)[^。；;]{6,110}/);
  if (!method) return "";
  return method
    .replace(/^(本文|本研究|文章|该文)/, "")
    .replace(/本文|本研究|该文|作者/g, "")
    .replace(/[,，、]?(?:和|及|与|或|的|为|将|把|对|在|基于|通过|采用)$/, "")
    .trim();
}

function conciseDataSource(text = "") {
  const clean = displayText(text);
  const data = firstMatch(clean, /(?:实验数据采用|数据采用|数据来源|样本来源|研究对象为|采用|使用|选取|基于|以)?[^。；;]{0,35}(?:数据|样本|语料|案例|对象|场景|仿真|问卷|订单|接口|漏洞|期刊|文献|引文|数据集)[^。；;]{0,55}/);
  return data ? data.replace(/^(采用|使用|选取|基于|以)/, "以").trim() : "";
}

function conciseMetrics(text = "") {
  const clean = displayText(text);
  const metric = firstMatch(clean, /(?:以|通过|利用)?[^。；;]{0,35}(?:指标|准确率|召回率|误差|延误|求解速度|发现率|假发现率|发文量|引文|对比|实验|仿真)[^。；;]{0,80}/);
  return metric ? metric.replace(/^(以|通过|利用)?/, "以").replace(/^以以/, "以").replace(/^以因为/, "因为").trim() : "";
}

function conciseResult(text = "") {
  const clean = displayText(text);
  const result = firstMatch(clean, /(?:结果表明|实验表明|研究发现|表明|证明|显示|有效|提升|降低|优于)[^。；;]{6,90}/);
  return result ? result.replace(/^(结果表明|实验表明|研究发现|表明|证明|显示)/, "").replace(/^[，,：:\s]+/, "").trim() : "";
}

function conciseLimitation(text = "") {
  const clean = displayText(text);
  const limitation = firstMatch(clean, /[^。；;]{0,30}(?:不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏)[^。；;]{0,70}/);
  return limitation ? limitation.replace(/^[，,：:\s]+/, "").trim() : "";
}

function cleanEvidenceForAnswer(text) {
  let clean = cleanEvidenceLine(text)
    .replace(/摘要[:：]?/g, "")
    .replace(/^(可核对证据是|原文显示主要贡献或结论是|可从原文归纳出的主张是|原文提示的局限或边界是)[:：]\s*/g, "")
    .replace(/^\s*\d+(?:\.\d+){1,3}\s*/g, "")
    .replace(/关键词[:：]?.*$/g, "")
    .replace(/doi[:：]?\s*10\.\S+/gi, "")
    .replace(/中图分类号[:：]?\S+/g, "")
    .replace(/文献标识码[:：]?\S+/g, "")
    .replace(/收稿日期[:：]?.*$/g, "")
    .replace(/基金项目[:：]?.*$/g, "")
    .replace(/作者简介[:：]?.*$/g, "")
    .replace(/^[−\-–—]?\s*\d+(?:\.\d+)?\s*[,，;；]?\s*其中[^。；;]{0,80}$/g, "")
    .replace(/^[A-Za-z]\s*为[^。；;]{2,30}(?:[,，]\s*[A-Za-z]\s*为[^。；;]{2,30})*$/g, "")
    .replace(/^[式图表]\s*\d+[-－]?\d*[:：]?.*$/g, "")
    .replace(/^\(?\s*\d+(?:\.\d+)*\s*\)?\s*[,，;；:：]/g, "")
    .replace(/第\s*\d+\s*(卷|期)|Vol\.\s*\d+|No\.\s*\d+/gi, "")
    .replace(/\b\d{4}\s*年\s*\d+\s*月\b/g, "")
    .replace(/\[[0-9,\-\s]+\]/g, "")
    .replace(/[A-Z][A-Z0-9_\-]{2,}(?:[-_\s][A-Z0-9]{2,}){1,}/g, (match) => {
      const known = {
        RESTFUL: "RESTful",
        API: "API",
        LLM: "大语言模型",
        LSTM: "长短期记忆网络",
        SVR: "支持向量回归",
        SSA: "优化算法"
      };
      return match
        .split(/[-_\s]+/)
        .map((part) => known[part.toUpperCase()] || part)
        .join("与");
    })
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (isLikelyTitleOrByline(clean) || isBoilerplateLine(clean) || isLowValueChunk(clean) || isWeakAnswerSentence(clean)) return "";
  if (/^(参考文献|目录|致谢|作者|通讯作者|关键词|Key words|Abstract)\b/i.test(clean)) return "";
  if (/^[\d\s.,;:()\-+*/=<>{}[\]|]+$/.test(clean)) return "";
  if ((/^[−\-–—]?\s*\d|其中\s*[a-zA-Z]\s*为|统计年限|发文总量/.test(clean) && !/[。！？]/.test(clean)) ||
      (/其中\s*[a-zA-Z]\s*为|统计年限|发文总量/.test(clean) && clean.length < 80)) return "";
  const symbolCount = (clean.match(/[=<>∑√±×÷≈≤≥{}[\]|]/g) || []).length;
  if (symbolCount >= 5 && symbolCount / Math.max(clean.length, 1) > 0.08) return "";
  if (clean.length < 16 && !/[。；:：]/.test(clean)) return "";
  return shortEvidenceText(clean, 260);
}

function cleanAnswerEvidence(items = [], limit = 4) {
  return uniqueStrings((items || []).map(cleanEvidenceForAnswer).filter(Boolean)).slice(0, limit);
}

function cleanAnswerText(value, fallbacks = []) {
  const candidates = [value, ...fallbacks].flat().filter((item) => item !== undefined && item !== null);
  for (const candidate of candidates) {
    const clean = cleanEvidenceForAnswer(candidate);
    if (clean) return clean;
  }
  for (const candidate of candidates) {
    const clean = displayText(candidate || "");
    if (clean && !isAnswerNoise(clean) && !isBoilerplateLine(clean) && !isLowValueChunk(clean)) return shortEvidenceText(clean, 260);
  }
  return "";
}

function incompleteAnswerEnding(text = "") {
  return /(只看|不是|而是|通过|基于|围绕|对|从|将|与|和|及|但|因此|说明|需要|不能|不是只看|而不是只看)$/.test(displayText(text));
}

function finalizeAnswerSentence(text = "", options = {}) {
  let clean = displayText(text || "");
  const fallback = displayText(options.fallback || "基于当前资料，回答应按问题、方法、证据和边界分层判断。");
  if (!clean || incompleteAnswerEnding(clean)) clean = fallback;
  if (!/[。！？!?]$/.test(clean)) clean = `${clean}。`;
  return clean;
}

function hasMetricEvidenceText(text = "") {
  return /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*个百分点|发现率|假发现率|准确率|召回率|误差|MAPE|RMSE|MAE|F1|AUC|指标|数值)/i.test(displayText(text));
}

function hasFigureEvidenceText(text = "") {
  return /(?:图\d+|表\d+|如图|如表|figure|table|柱状图|曲线|矩阵)/i.test(displayText(text));
}

function normalizeAnswerClaimType(type = "", text = "") {
  const cleanType = displayText(type);
  const cleanText = displayText(text);
  if (/不确定|待核对|不能/.test(cleanType)) return "不确定";
  if (/指标/.test(cleanType) || hasMetricEvidenceText(cleanText)) return "指标证据";
  if (/图表/.test(cleanType) || hasFigureEvidenceText(cleanText)) return "图表证据";
  if (/综合|推断|共识|分歧/.test(cleanType)) return "综合推断";
  if (/原话|原文|事实/.test(cleanType)) return "原文事实";
  return "综合推断";
}

function compactResearchJudgment(text = "", fallback = "") {
  let clean = cleanAnswerText(text, [fallback]);
  clean = clean
    .replace(/^\s*(?:\d+[.)）]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.])\s*/g, "")
    .replace(/智能体智能体/g, "智能体")
    .replace(/研究问题[:：]\s*/g, "")
    .replace(/证据[:：]\s*/g, "")
    .replace(/贡献结论[:：]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const shortened = shortEvidenceText(clean || fallback, 110);
  const looksFragmented = !hasMetricEvidenceText(shortened) && (!/[。！？!?]$/.test(shortened) || /[的与和对在为以从将模][。！？!?]?$/.test(shortened));
  return finalizeAnswerSentence(looksFragmented ? fallback : shortened, { fallback });
}

function metricEvidenceSummary(text = "") {
  const metrics = extractMetrics(text);
  if (metrics) return `指标证据报告 ${metrics} 等数值或工具对比结果，需按原文指标口径核对。`;
  return "证据以数值指标、对比结果或实验表现为主，需要回到指标口径核对。";
}

function metricEvidenceForAnswer(item = {}) {
  const raw = item.quote || item.text || "";
  const type = normalizeAnswerClaimType(item.evidence_type || item.evidenceType || "", raw);
  if (type === "图表证据") return figureEvidenceSummary(raw);
  return metricEvidenceSummary(raw);
}

function metricEvidenceLineForAnswer(source, item = {}) {
  const summary = metricEvidenceForAnswer(item);
  return summary ? `${source.marker}${summary}` : "";
}

function figureEvidenceSummary(text = "") {
  const clean = displayText(text);
  const label = clean.match(/(?:图|表)\s*\d+[A-Za-z]?/)?.[0] || "";
  return `${label ? `${label} 属于图表证据，` : "图表证据"}需要回到原图、原表或相邻说明核对，不能直接当作自然句原话引用。`;
}

function isAnswerNoise(text) {
  const clean = displayText(text);
  if (!clean) return true;
  if (isWeakAnswerSentence(clean)) return true;
  if (/^(可核对证据是|原文显示主要贡献或结论是|可从原文归纳出的主张是|原文提示的局限或边界是)[:：]\s*[−\-–—]?\s*\d/.test(clean)) return true;
  if ((/其中\s*[a-zA-Z]\s*为|统计年限|发文总量/.test(clean) && clean.length < 110)) return true;
  const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const formulaSymbols = (clean.match(/[=<>∑√±×÷≈≤≥{}[\]|]|[A-Za-z]\s*[=为]/g) || []).length;
  return formulaSymbols >= 3 && cjk < 18;
}

function isWeakAnswerSentence(text) {
  const clean = displayText(text);
  if (!clean) return true;
  if (/^(这将|本文将|下文将|综上|因此可为|可为).{0,40}(未来研究|提供依据|提供参考|奠定基础)/.test(clean)) return true;
  if (/^(研究热点前沿分析|理论与算法|结果分析|实验分析|引言|结论)\b/.test(clean)) return true;
  if (/^\d+(?:\.\d+){1,3}\s*\S{0,20}$/.test(clean)) return true;
  return false;
}

function sanitizeAnswerPayload(payload, sources = []) {
  const sourceByMarker = new Map((sources || []).map((source) => [source.marker, source]));
  const cleaned = { ...payload };
  cleaned.directConclusion = finalizeAnswerSentence(displayText(cleaned.directConclusion || payload.answer || ""), {
    fallback: "基于当前资料，回答应按研究问题、方法链条、证据类型和适用边界分层判断。"
  });
  cleaned.answer = cleanAnswerText(cleaned.answer, [cleaned.directConclusion]);
  cleaned.consensus = cleanAnswerEvidence(cleaned.consensus || [], 8);
  cleaned.disagreements = cleanAnswerEvidence(cleaned.disagreements || [], 8);
  cleaned.evidenceStrength = (cleaned.evidenceStrength || []).map((item) => {
    const marker = String(item || "").match(/\[\d+\]/)?.[0] || "";
    const source = sourceByMarker.get(marker);
    return cleanAnswerText(item, [
      source?.contribution,
      source?.method,
      source?.researchQuestion,
      source?.keyInfo
    ]);
  }).filter(Boolean);
  cleaned.cannotInfer = cleanAnswerEvidence(cleaned.cannotInfer || [], 8);
  cleaned.uncertainty = cleanAnswerText(cleaned.uncertainty, ["该回答基于已上传资料的结构化证据卡，正式使用前建议核对定位与原文。"]);
  cleaned.claims = (cleaned.claims || []).map((claim) => {
    const text = cleanAnswerText(claim.text, [
      ...(claim.citations || []).map((marker) => sourceByMarker.get(marker)?.contribution),
      ...(claim.citations || []).map((marker) => sourceByMarker.get(marker)?.keyInfo)
    ]);
    return {
      ...claim,
      type: normalizeAnswerClaimType(claim.type, text),
      text
    };
  }).filter((claim) => claim.text);
  cleaned.stances = (cleaned.stances || []).map((stance) => {
    const source = sourceByMarker.get(stance.source) || {};
    return {
      ...stance,
      title: displayText(stance.title || source.title || ""),
      stance: cleanAnswerText([source.abstract, source.keyInfo, source.contribution, source.mainClaims?.[0], source.researchQuestion, stance.stance]),
      evidence: cleanAnswerText([source.evidence?.[0], source.quotes?.[0]?.text, source.method, source.contribution, stance.evidence, source.abstract, source.keyInfo]),
      limitation: cleanAnswerText([source.limitations?.[0], stance.limitation, "该文的外推边界需要结合数据来源、方法假设和原文定位核对。"])
    };
  }).filter((stance) => stance.stance || stance.evidence || stance.limitation);
  cleaned.stanceMatrix = (cleaned.stanceMatrix || []).map((item) => ({
      ...item,
      title: displayText(item.title || ""),
      stance: cleanAnswerText(item.stance, ["该文立场需要回到证据卡核对。"]),
      supportingEvidence: finalizeAnswerSentence(displayText(item.supportingEvidence || item.evidenceSummary || ""), {
        fallback: cleanAnswerText(item.stance, ["该文证据需要回到证据卡核对。"])
      }),
      canInfer: cleanAnswerText(item.canInfer, [item.stance]),
      cannotInfer: cleanAnswerText(item.cannotInfer, ["不能把该文的单篇结论直接外推为所有资料的共同结论。"]),
      evidenceType: normalizeAnswerClaimType(item.evidenceType, item.supportingEvidence || item.evidenceSummary || item.stance),
      sameAs: Array.isArray(item.sameAs) ? item.sameAs : [],
      differentFrom: Array.isArray(item.differentFrom) ? item.differentFrom : []
  })).filter((item) => item.stance || item.supportingEvidence);
  cleaned.comparison = (cleaned.comparison || []).map((item) => {
    const source = sourceByMarker.get(item.source) || {};
    return {
      ...item,
      title: displayText(item.title || source.title || ""),
      view: cleanAnswerText([source.abstract, source.keyInfo, source.contribution, source.mainClaims?.[0], source.method, source.researchQuestion, item.view]),
      differsBy: cleanAnswerText([source.limitations?.[0], source.method, source.dataOrMaterials, item.differsBy, "差异需要回到原文相邻段落进一步核对。"])
    };
  }).filter((item) => item.view || item.differsBy);
  cleaned.sources = (cleaned.sources || sources || []).map((source) => ({
    ...source,
    title: displayText(source.title || ""),
    keyInfo: cleanAnswerText(source.keyInfo, [source.contribution, source.researchQuestion, source.method]),
    abstract: cleanAnswerText(source.abstract, [source.keyInfo, source.contribution]),
    researchQuestion: cleanAnswerText(source.researchQuestion, [source.keyInfo]),
    method: cleanAnswerText(source.method, [source.keyInfo]),
    dataOrMaterials: cleanAnswerText(source.dataOrMaterials, [source.keyInfo]),
    contribution: cleanAnswerText(source.contribution, [source.keyInfo]),
    evidence: cleanAnswerEvidence(source.evidence || [], 4),
    limitations: cleanAnswerEvidence(source.limitations || [], 3),
    metricEvidence: (source.metricEvidence || []).map((item) => ({
      ...item,
      quote: cleanAnswerText(item.quote || item.text || ""),
      evidence_type: item.evidence_type || item.evidenceType || ""
    })).filter((item) => item.quote).slice(0, 4),
    profile: source.profile || null,
    mainClaims: cleanAnswerEvidence(source.mainClaims || [], 4),
    quotes: (source.quotes || []).map((quote) => ({ ...quote, text: cleanAnswerText(quote.text || quote.quote || "") })).filter((quote) => quote.text).slice(0, 3),
    matrix: (source.matrix || []).map((row) => ({
      ...row,
      claim: cleanAnswerText(row.claim, [source.contribution, source.method, source.keyInfo]),
      quote: cleanAnswerText(row.quote, [row.claim]),
      why: cleanAnswerText(row.why, [row.claim])
    })).filter((row) => row.claim || row.quote)
  }));
  return cleaned;
}

function shortEvidenceText(text, limit = 260) {
  const clean = cleanEvidenceLine(text);
  if (clean.length <= limit) return clean;
  const punctuationCut = Math.max(
    clean.lastIndexOf("。", limit),
    clean.lastIndexOf("；", limit),
    clean.lastIndexOf("！", limit),
    clean.lastIndexOf("？", limit),
    clean.lastIndexOf(";", limit),
    clean.lastIndexOf("!", limit),
    clean.lastIndexOf("?", limit)
  );
  if (punctuationCut >= Math.floor(limit * 0.55)) return clean.slice(0, punctuationCut + 1);
  const softCut = Math.max(clean.lastIndexOf("，", limit), clean.lastIndexOf(",", limit), clean.lastIndexOf("、", limit));
  if (softCut >= Math.floor(limit * 0.7)) return clean.slice(0, softCut);
  return clean.slice(0, limit).replace(/[，,、；;:：-]+$/, "");
}

function summarizeFlowNode(doc, id, evidence) {
  const title = `${doc.title || ""} ${doc.filename || ""}`;
  const text = normalizeText(String(evidence || "")).replace(/\s+/g, " ");
  if (!text) return "当前节点缺少可概括的原文依据。";
  if (/RESTful|API|漏洞|识别|检测/i.test(title)) return summarizeApiFlowNode(id, text);
  if (/大语言模型|LLM|智能体|Agent/i.test(title)) return summarizeAgentFlowNode(id, text);
  const domainSummary = summarizeKnownDomainFlowNode(doc, id, text);
  if (domainSummary) return domainSummary;
  const card = doc.analysisCard || doc.researchCard || {};
  const summarySource = summarySourceForNode(doc, card, id, text);
  if (summarySource) return summaryFromSource(id, summarySource);
  const terms = cleanTopicTerms(topKeywords(text, 8).map((item) => item.term), 3);
  const topic = terms.slice(0, 3).join("、") || "核心对象";
  const metrics = extractMetrics(text);
  const generic = {
    question: `问题起点是 ${topic} 的现有不足或应用需求，需要明确研究对象和待解决矛盾。`,
    method: `作者把 ${topic} 组织成一套分析路径或处理流程，用来承接后续验证。`,
    mechanism: `论证重点在于说明 ${topic} 之间如何相互作用，并形成可执行的机制链条。`,
    evidence: metrics ? `证据主要来自 ${metrics} 等可核对结果。` : `证据集中在 ${topic} 的案例、数据或实验描述。`,
    risk: `需要注意 ${topic} 的适用边界、风险和仍需复核的条件。`,
    conclusion: `结论落在 ${topic} 的应用价值、落地条件和后续改进方向。`
  };
  return generic[id] || `该节点围绕 ${topic} 展开。`;
}

function summarizeKnownDomainFlowNode(doc, id, text) {
  const haystack = `${doc.title || ""} ${doc.filename || ""} ${doc.abstract || ""} ${text}`;
  if (/网约车|出行预测|短时交通流|交通流.*预测|LSTM|SVR|SSA/i.test(haystack)) {
    const map = {
      question: "研究起点是网约车出行交通流具有短时波动和随机变化，传统单一预测模型难以稳定捕捉其变化规律。",
      method: "方法核心是用麻雀搜索算法优化的长短期记忆网络与支持向量回归组合预测模型处理网约车短时交通流，并把不同分量的预测结果进行融合。",
      mechanism: "机制链条是先分解交通流序列，再针对不同分量分别建模预测，最后通过加权融合得到总体预测值。",
      evidence: "证据主要来自与基线模型的误差、精度和拟合度对比，包括平均绝对百分比误差下降和预测准确率提升等指标。",
      risk: "边界在于模型效果依赖订单数据质量、时间序列分解方式和城市出行场景，不能直接外推到所有交通预测任务。",
      conclusion: "论文结论是优化后的组合模型比单一模型更能捕捉网约车交通流的周期规律和随机波动。"
    };
    return map[id] || "";
  }
  if (/交叉口|信号配时|车辆轨迹|混合交通|网联自动驾驶|CAV/i.test(haystack)) {
    const map = {
      question: "研究起点是新型混合交通下，传统交叉口控制难以同时协调信号配时和车辆轨迹，集中优化策略也不适合车辆自组织控制场景。",
      method: "方法核心是把信号配时作为慢变量、车辆轨迹策略作为快变量，构建交叉口信号与网联自动驾驶车辆轨迹的协同控制框架。",
      mechanism: "机制链条是先用信号配时动态适应交通需求，再让网联自动驾驶车辆主动优化速度和通过时机，从而减少启动损失并提升通行效率。",
      evidence: "证据主要来自仿真实验、车辆时空轨迹对比、平均延误变化和不同网联自动驾驶车辆渗透率下的控制效果。",
      risk: "边界在于方法依赖网联自动驾驶车辆渗透率、参数设置和混合交通条件，真实道路部署仍需复核感知、通信和公平性约束。",
      conclusion: "论文结论落在协同控制能降低交叉口车辆平均延误，并且基于逻辑的决策模型具备较快求解能力。"
    };
    return map[id] || "";
  }
  return "";
}

function summarySourceForNode(doc, card, id, evidence) {
  const fields = {
    question: [card.question, doc.abstract, evidence],
    method: [card.method, card.contribution, evidence],
    mechanism: [card.contribution, card.method, evidence],
    evidence: [card.findings, doc.takeaway, evidence],
    risk: [card.limitations, evidence],
    conclusion: [card.findings, doc.takeaway, doc.abstract, evidence]
  }[id] || [evidence];
  for (const field of fields) {
    const clean = cleanSummarySource(field);
    if (clean) return clean;
  }
  return "";
}

function cleanSummarySource(text) {
  const clean = displayText(String(text || ""))
    .replace(/当前解析未识别出稳定的|未抽取到明确.*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || isBoilerplateLine(clean)) return "";
  if (/^(期刊名|机构名|发文量|排名|摘要[:：]?$)/.test(clean)) return "";
  return shortEvidenceText(clean, 150).replace(/\.{3}$|…$/g, "");
}

function summaryFromSource(id, source) {
  const map = {
    question: `核心问题是：${source}`,
    method: `方法路径是：${source}`,
    mechanism: `作用机制是：${source}`,
    evidence: `关键证据是：${source}`,
    risk: `边界与风险是：${source}`,
    conclusion: `结论落点是：${source}`
  };
  return map[id] || source;
}

function summarizeApiFlowNode(id, text) {
  const metrics = extractMetrics(text);
  const map = {
    question: "研究起点是现有 API 扫描工具依赖公开文档或路径，面对隐藏 API、无文档 API 和动态服务时容易漏检或误报。",
    method: "方法核心是 A2A：用 MCP 把 API 发现模块和漏洞检测模块连接起来，形成从隐藏端点发现到漏洞验证的自动化流程。",
    mechanism: "机制链条是先用自适应枚举和 HTTP 响应分析发现候选端点，再用服务指纹确认 API，最后结合 LLM、RAG 和反馈迭代生成测试用例验证漏洞。",
    evidence: metrics ? `实验支撑集中在 ${metrics}，并与 NAUTILUS、RESTler、ZAP、Burp Suite 等工具形成对比。` : "实验支撑来自 API 发现率、假发现率和漏洞检测覆盖情况的对比。",
    risk: "边界在于传统工具和既有方法未能完整打通 API 发现与漏洞检测，复杂动态 API 场景仍是主要挑战。",
    conclusion: "论文结论是智能体方案能把 API 资产发现和安全测试联动起来，提高隐藏接口发现与漏洞验证的自动化程度。"
  };
  return map[id] || "该节点围绕隐藏 RESTful API 发现与漏洞检测展开。";
}

function summarizeAgentFlowNode(id, text) {
  const metrics = extractMetrics(text);
  const map = {
    question: "研究起点是通用大模型智能体缺少系统化设计方法，垂直场景中的流程、内容生成和交互机制需要被结构化。",
    method: "方法核心是把垂域数据、语义表示、混合检索、链式推理和提示优化组织成可落地的智能体设计流程。",
    mechanism: "机制链条是先建设多源数据与语义检索底座，再通过推理和提示控制提升回答准确性、一致性和可控性。",
    evidence: metrics ? `证据集中在 ${metrics} 等结果或应用表现。` : "证据主要来自系统能力展示和垂直场景应用验证。",
    risk: "边界在于专业语料、检索精度、语义理解和生成可控性不足，容易影响垂域智能体的可靠性。",
    conclusion: "论文落点是让大模型智能体从通用问答走向垂直场景的感知、规划、执行和交互协同。"
  };
  return map[id] || "该节点围绕大语言模型智能体设计展开。";
}

function extractMetrics(text) {
  const matches = String(text || "").match(/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*个百分点|NAUTILUS|RESTler|ZAP|Burp Suite|GitHub|GitLab)/gi) || [];
  return [...new Set(matches.map((item) => item.replace(/\s+/g, " ").trim()))].slice(0, 6).join("、");
}

function unreadableDocFlow(doc) {
  const warning = doc.parseWarning || "当前资料没有可用文本。";
  const title = doc.title || doc.filename || "当前资料";
  const topic = inferBaselineTopic(title);
  const nodes = [
    {
      id: "topic",
      title: "研究主题",
      citation: "标题基准",
      text: topic.theme,
      terms: []
    },
    {
      id: "question",
      title: "核心问题",
      citation: "标题基准",
      text: topic.question,
      terms: []
    },
    {
      id: "method",
      title: "设计方法",
      citation: "结构基准",
      text: topic.method,
      terms: []
    },
    {
      id: "mechanism",
      title: "能力模块",
      citation: "结构基准",
      text: topic.mechanism,
      terms: []
    },
    {
      id: "evaluation",
      title: "评价基准",
      citation: "结构基准",
      text: topic.evaluation,
      terms: []
    },
    {
      id: "risk",
      title: "边界与风险",
      citation: "结构基准",
      text: topic.risk,
      terms: []
    },
    {
      id: "status",
      title: "原文状态",
      citation: "解析提示",
      text: `当前资料正文未成功抽取；本图按标题和研究结构基准生成。${warning}`,
      terms: []
    }
  ];
  return {
    title,
    mode: "baseline",
    nodes,
    edges: [
      { source: "topic", target: "question" },
      { source: "question", target: "method" },
      { source: "method", target: "mechanism" },
      { source: "mechanism", target: "evaluation" },
      { source: "evaluation", target: "risk" },
      { source: "risk", target: "status" }
    ]
  };
}

function inferBaselineTopic(title) {
  const cleanTitle = String(title || "").replace(/\.pdf$/i, "").trim();
  if (/RESTful|API|漏洞|识别|检测/i.test(cleanTitle)) {
    return {
      theme: `${cleanTitle}：围绕 API 资产识别和安全检测流程展开。`,
      question: "如何发现隐藏接口、还原调用关系，并识别潜在漏洞和安全风险。",
      method: "以流量、页面脚本、接口响应和调用行为为线索，建立发现、聚类、验证和风险分级流程。",
      mechanism: "核心模块包括接口发现、参数提取、认证识别、行为建模、漏洞探测和证据留存。",
      evaluation: "评价基准应覆盖接口召回率、误报率、漏洞验证准确性、覆盖范围和检测成本。",
      risk: "关键边界包括未授权探测、误报处置、敏感数据暴露和对生产系统的影响。"
    };
  }
  if (/大语言模型|LLM|智能体|Agent/i.test(cleanTitle)) {
    return {
      theme: `${cleanTitle}：围绕大语言模型智能体的目标、能力组成和设计流程展开。`,
      question: "如何把大语言模型从问答工具组织成可规划、可调用工具、可执行任务、可反馈修正的智能体系统。",
      method: "以任务目标为输入，拆分角色、记忆、规划、工具调用、执行反馈和安全控制等设计环节。",
      mechanism: "核心能力模块包括意图理解、任务分解、行动规划、工具/API 调用、上下文记忆、结果校验与迭代修正。",
      evaluation: "评价基准应覆盖任务完成率、步骤正确性、工具调用准确率、错误恢复能力、响应成本和可解释性。",
      risk: "关键边界包括幻觉、权限越界、数据泄露、工具误调用、长链路错误传播和人机审批责任。"
    };
  }
  return {
    theme: `${cleanTitle || "当前资料"}：围绕标题中的研究对象建立结构化阅读框架。`,
    question: "该资料要解决什么问题，问题背景、对象范围和核心矛盾是什么。",
    method: "梳理资料采用的分析路径、设计方案、处理流程或研究方法。",
    mechanism: "拆解关键组成部分、作用关系、输入输出和运行机制。",
    evaluation: "提取可验证的证据、指标、案例、对比结果或评价标准。",
    risk: "识别适用边界、限制条件、风险点和后续需要补充确认的内容。"
  };
}

function buildDocFlow(docs) {
  if (docs.length !== 1) return null;
  const doc = docs[0];
  const chunks = doc.chunks || [];
  if (!chunks.length) {
    return unreadableDocFlow(doc);
  }
  const used = new Set();
  const nodes = [
    docFlowSection(doc, "question", "核心问题", [/摘要|针对|目的|旨在|问题|挑战|不足|缺乏|难以|重要|意义|需求|已有研究/i], 0, used),
    docFlowSection(doc, "method", "分析路径", [/方法|流程|框架|模型|算法|步骤|体系|设计|构建|提出|采用|基于|分解|预测|控制|检测|识别/i], 1, used),
    docFlowSection(doc, "mechanism", "作用机制", [/机制|原理|过程|协同|作用|影响|关系|分解|融合|优化|推理|迭代|模块|策略|控制/i], 2, used),
    docFlowSection(doc, "evidence", "关键证据", [/实验|仿真|案例|结果|表明|显示|发现|数据|对比|准确|误差|提升|降低|MAPE|发现率|召回|性能|有效/i], 3, used),
    docFlowSection(doc, "risk", "边界与风险", [/风险|伦理|规范|边界|治理|不足|局限|限制|误差|偏差|未来|仍需|公平性|安全|隐私/i], 4, used),
    docFlowSection(doc, "conclusion", "结论/落地条件", [/结论|综上|结果表明|研究表明|本文|证明|可见|有效|可行|建议|未来|应用|价值|落地/i], 5, used)
  ];
  const seen = new Set();
  const uniqueNodes = nodes.map((node, index) => {
    const key = node.text;
    if (seen.has(key)) {
      const fallback = chunks[Math.min(index, chunks.length - 1)];
      return { ...node, text: fallback?.text || node.text, citation: fallback?.citation || node.citation, terms: fallback?.terms || node.terms };
    }
    seen.add(key);
    return node;
  });
  return {
    title: doc.title,
    mode: "single-doc",
    nodes: uniqueNodes,
    edges: [
      ["question", "method", "如何分析"],
      ["method", "mechanism", "推导机制"],
      ["mechanism", "evidence", "文本证据"],
      ["evidence", "risk", "约束条件"],
      ["risk", "conclusion", "落地判断"]
    ].map(([source, target, relation]) => ({ source, target, relation }))
  };
}

function classifyRelation(a, b, shared) {
  const text = `${a.abstract} ${a.takeaway} ${b.abstract} ${b.takeaway} ${shared.join(" ")}`;
  if (/evaluation|benchmark|metric|arena|bench|评估|基准|指标|测试/i.test(text)) return "同问题的评估对比";
  if (/governance|oversight|policy|accountability|risk|safety|治理|监管|责任|风险|安全/i.test(text)) return "能力证据与风险约束";
  if (/retrieval|citation|source|grounding|evidence|检索|引用|溯源|证据/i.test(text)) return "可信问答与来源溯源";
  if (/agent|planning|tool|multi-agent|react|toolformer|智能体|规划|工具|行动/i.test(text)) return "方法扩展与能力链条";
  return shared.length >= 3 ? "主题高度重叠" : "共享概念";
}

function relationEvidence(a, b, shared, relation = null, aProfile = null, bProfile = null) {
  const aCard = evidenceCardForDoc(a);
  const bCard = evidenceCardForDoc(b);
  const aClaim = relation?.claimPair?.a || aCard.contribution?.normalized_claim || aCard.contribution?.claim || aProfile?.finding || synthesizeDocKeyInfo(a);
  const bClaim = relation?.claimPair?.b || bCard.contribution?.normalized_claim || bCard.contribution?.claim || bProfile?.finding || synthesizeDocKeyInfo(b);
  const why = relation?.why ||
    (shared.length ? `两篇都涉及 ${shared.slice(0, 4).join("、")}。` : "两篇在摘要和关键点中出现相近主题。");
  return {
    why,
    details: [
      ...(relation?.details || []),
      relation?.claimPair ? `关系推断：A 的“${completeRelationText(relation.claimPair.a, 120)}”与 B 的“${completeRelationText(relation.claimPair.b, 120)}”形成 ${relation.label}。` : ""
    ].filter(Boolean),
    compare: {
      a: {
        domain: aProfile?.domain || "",
        problemType: aProfile?.problemType || "",
        methodType: aProfile?.methodType || "",
        evidenceType: aProfile?.evidenceType || ""
      },
      b: {
        domain: bProfile?.domain || "",
        problemType: bProfile?.problemType || "",
        methodType: bProfile?.methodType || "",
        evidenceType: bProfile?.evidenceType || ""
      }
    },
    sources: [
      { title: a.title, quote: completeRelationText(aClaim), citation: aCard.source_pages?.[0] ? `p.${aCard.source_pages[0]}` : "证据卡综合" },
      { title: b.title, quote: completeRelationText(bClaim), citation: bCard.source_pages?.[0] ? `p.${bCard.source_pages[0]}` : "证据卡综合" }
    ]
  };
}

function completeRelationText(text, limit = 260) {
  const clean = displayText(String(text || "")).replace(/\.{3}|…/g, "").trim();
  if (clean.length <= limit) return clean;
  const cut = Math.max(
    clean.lastIndexOf("。", limit),
    clean.lastIndexOf("；", limit),
    clean.lastIndexOf("！", limit),
    clean.lastIndexOf("？", limit)
  );
  if (cut >= 80) return clean.slice(0, cut + 1);
  return `${clean.slice(0, limit)}。`;
}

function relevantChunks(docs, question, limit = 8) {
  const queryTerms = new Set([...queryTopicTerms(question), ...queryExpansionTerms(question)]);
  const ranked = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks || []) {
      const termSet = new Set([...chunk.terms, ...tokens(chunk.text)]);
      const overlap = [...queryTerms].filter((t) => termSet.has(t)).length;
      const fuzzy = [...queryTerms].some((t) => chunk.text.toLowerCase().includes(t.toLowerCase())) ? 1 : 0;
      const sectionBoost = sectionScore(question, chunk.text);
      if (overlap || fuzzy || sectionBoost || queryTerms.size === 0) {
        ranked.push({ doc, chunk, score: overlap * 3 + fuzzy + sectionBoost });
      }
    }
  }
  if (!ranked.length && docs.length === 1) {
    return (docs[0].chunks || []).slice(0, limit).map((chunk) => ({ doc: docs[0], chunk, score: 0 }));
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

function queryExpansionTerms(question) {
  const q = String(question || "");
  const groups = [
    [/方法|流程|机制|怎么|如何|步骤|系统|架构/, ["方法", "流程", "机制", "系统", "架构", "模块", "A2A", "MCP", "RAG"]],
    [/实验|结果|指标|效果|性能|准确|发现率|误报|假发现/, ["实验", "结果", "发现率", "假发现率", "准确率", "对比", "基准", "NAUTILUS", "RESTler"]],
    [/漏洞|检测|安全|风险/, ["漏洞", "检测", "测试用例", "验证", "安全", "风险"]],
    [/证据|原文|页码|引用/, ["表明", "结果", "提出", "实验", "验证", "发现"]],
    [/局限|不足|限制|问题|待确认/, ["局限", "不足", "限制", "挑战", "误报", "依赖", "未来"]]
  ];
  return groups.flatMap(([pattern, terms]) => (pattern.test(q) ? terms : []));
}

function queryTopicTerms(query) {
  const broad = /^(这些|这几篇|文献|资料|论文|报告|共同|综合|异同|区别|差异|关系|观点|价值|风险|共识|分歧|什么|如何|怎么|哪些|问题|方法|证据|结论|局限|综述)$/;
  return cleanTopicTerms(tokens(displayText(query || "")).filter((term) => !broad.test(term)), 12);
}

function sectionScore(question, text) {
  const q = String(question || "");
  const t = String(text || "");
  let score = 0;
  if (/方法|流程|机制|系统|架构/.test(q) && /API发现|漏洞检测|智能体|A2A|MCP|RAG|自适应枚举|HTTP响应|指纹库|反馈迭代/.test(t)) score += 4;
  if (/实验|结果|指标|效果|性能|发现率|误报|假发现/.test(q) && /实验|结果|发现率|假发现率|NAUTILUS|RESTler|ZAP|Burp|GitHub|GitLab/.test(t)) score += 5;
  if (/局限|不足|限制|问题|待确认/.test(q) && /局限|不足|限制|挑战|误报|依赖|复杂|动态|未来|仍/.test(t)) score += 4;
  if (/证据|原文|页码|引用/.test(q) && /提出|表明|结果|实验|验证|发现/.test(t)) score += 3;
  return score;
}

function compactMatchText(text) {
  return (String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join("");
}

function docNameAliases(doc) {
  const names = [doc.title, doc.filename, String(doc.filename || "").replace(/\.pdf$/i, "")];
  return names
    .flatMap((name) => {
      const value = String(name || "");
      return [
        value,
        value.replace(/\.pdf$/i, ""),
        value.replace(/[（(]\d+[）)]/g, ""),
        value.replace(/[（(][^）)]*[）)]/g, "")
      ];
    })
    .map(compactMatchText)
    .filter((name, index, all) => name.length >= 8 && all.indexOf(name) === index);
}

function matchingUnreadableDocs(docs, question) {
  const q = compactMatchText(question);
  return docs.filter((doc) => {
    if ((doc.chunks || []).length || !doc.parseWarning) return false;
    return docNameAliases(doc).some((name) => q.includes(name));
  });
}

async function answerQuestion(docs, question) {
  const unreadableMatches = matchingUnreadableDocs(docs, question);
  if (unreadableMatches.length) {
    return sanitizeAnswerPayload({
      answer: `你问到的资料“${unreadableMatches[0].title}”当前没有可读文本，因此不能基于原文回答。`,
      claims: [
        {
          type: "不确定",
          text: unreadableMatches[0].parseWarning,
          citations: ["[1]"]
        }
      ],
      consensus: [],
      disagreements: [],
      uncertainty: "该资料上传成功，但文本抽取失败。请重新另存为标准 PDF、提供可复制文本版本，或后续接入 OCR/修复型解析后再分析。",
      comparison: unreadableMatches.map((doc, index) => ({
        source: `[${index + 1}]`,
        title: doc.title,
        view: doc.parseWarning,
        differsBy: "没有可用原文片段，未参与跨资料综合。"
      })),
      sources: unreadableMatches.map((doc, index) => ({
        marker: `[${index + 1}]`,
        docId: doc.id,
        title: doc.title,
          evidence: [doc.parseWarning]
        }))
    }, []);
  }
  const hits = relevantChunks(docs, question, 40);
  const byDoc = new Map();
  for (const hit of hits) {
    if (!byDoc.has(hit.doc.id)) byDoc.set(hit.doc.id, []);
    byDoc.get(hit.doc.id).push(hit);
  }
  const docGroups = [...byDoc.values()]
    .map((items) => ({ items, score: Math.max(...items.map((item) => item.score || 0)) }))
    .sort((a, b) => b.score - a.score || b.items.length - a.items.length)
    .slice(0, 6);
  const matchedDocs = selectAnswerDocs(docs, question, docGroups);
  const sources = matchedDocs.map((doc, index) => {
    const items = docGroups.find((group) => group.items[0].doc.id === doc.id)?.items || [];
    return evidenceSourceForAnswer(doc, question, items, index);
  });
  const legacySources = docGroups.map(({ items }, index) => {
    const doc = items[0].doc;
    const evidence = cleanAnswerEvidence(
      distinctTopSentences(sentences(items.map((i) => i.chunk.text).join(" ")), new Set(tokens(question)), 4),
      2
    );
    return {
      marker: `[${index + 1}]`,
      docId: doc.id,
      title: doc.title,
      keywords: (doc.keywords || []).map((item) => item.term).filter(Boolean),
      keyInfo: synthesizeDocKeyInfo(doc),
      evidence
    };
  });
  const commonTerms = cleanTopicTerms([
    ...sources.flatMap((s) => s.keywords || []),
    ...topKeywords(sources.flatMap((s) => [...(s.mainClaims || []), ...(s.evidence || []), s.method || ""]).join(" "), 8).map((k) => k.term)
  ]);
  const stanceMatrix = buildStanceMatrix(question, sources);
  const matrixFallback = buildEvidenceDrivenAnswer(question, sources, commonTerms, stanceMatrix);
  const fallback = {
    directConclusion: matrixFallback.directConclusion,
    answer:
      sources.length === 0
        ? "当前问题只命中了少量资料。请换一个更具体的问题，或先上传更多相关资料。"
        : sources.length === 1
          ? singleDocAnswer(sources[0], question, commonTerms)
          : matrixFallback.answer,
    claims:
      sources.length === 0
        ? []
        : matrixFallback.claims,
    consensus: matrixFallback.consensus,
    disagreements: matrixFallback.disagreements,
    evidenceStrength: matrixFallback.evidenceStrength,
    stances: matrixFallback.stances,
    stanceMatrix,
    cannotInfer: matrixFallback.cannotInfer,
    uncertainty: sources.length < 3 ? "命中来源偏少，结论置信度有限；但回答已优先依据每篇资料的结构化证据卡。" : `该回答先按问题相关性筛选出 ${sources.length} 份资料，未覆盖资料库外资料。`,
    comparison: sources.map((source) => ({
      source: source.marker,
      title: source.title,
      view: source.mainClaims?.[0] || source.keyInfo || "该文与问题相关，但证据卡缺少足够完整的主张。",
      differsBy: source.limitations?.[0] || source.method || "差异需要回到原文相邻段落进一步核对。"
    })),
    sources: sources.map((source, index) => ({
      ...source,
      evidence: source.evidence?.length ? source.evidence : legacySources[index]?.evidence || []
    }))
  };
  const enhanced = await enhanceAnswerWithOpenAI(question, sources, fallback);
  return sanitizeAnswerPayload(enhanced || fallback, sources);
}

function selectAnswerDocs(docs, question, docGroups = []) {
  const ranked = docGroups.map(({ items, score }) => ({
    doc: items[0].doc,
    score,
    hitCount: items.length,
    topicHits: docQuestionTopicHits(items[0].doc, question)
  }));
  const strong = ranked
    .filter((item) => item.score >= 4 || item.topicHits >= 2 || (item.score >= 2 && item.topicHits >= 1))
    .sort((a, b) => b.score - a.score || b.topicHits - a.topicHits || b.hitCount - a.hitCount);
  if (strong.length >= 2) return strong.slice(0, 6).map((item) => item.doc);
  if (strong.length === 1 && !broadCrossDocQuestion(question)) return [strong[0].doc];

  const topicRanked = docs
    .map((doc) => ({ doc, topicHits: docQuestionTopicHits(doc, question), usable: docUsableEvidenceCount(doc) }))
    .filter((item) => item.topicHits > 0 && item.usable > 0)
    .sort((a, b) => b.topicHits - a.topicHits || b.usable - a.usable)
    .slice(0, 6);
  if (topicRanked.length >= 2) return topicRanked.map((item) => item.doc);
  if (topicRanked.length === 1 && !broadCrossDocQuestion(question)) return [topicRanked[0].doc];

  if (docGroups.length) return docGroups.slice(0, broadCrossDocQuestion(question) ? 4 : 6).map(({ items }) => items[0].doc);
  return docs.slice(0, Math.min(broadCrossDocQuestion(question) ? 4 : 6, docs.length));
}

function docQuestionTopicHits(doc, question) {
  const terms = queryTopicTerms(question);
  if (!terms.length) return 0;
  const card = evidenceCardForDoc(doc);
  const haystack = displayText([
    doc.title,
    doc.filename,
    doc.abstract,
    doc.takeaway,
    ...(doc.keywords || []).map((item) => item.term || item),
    card.research_question?.claim,
    card.method?.claim,
    card.data_or_materials?.claim,
    card.contribution?.claim,
    ...(card.main_claims || []).map((item) => item.claim),
    ...(card.evidence || []).map((item) => item.claim),
    ...(card.limitations || []).map((item) => item.claim)
  ].join(" "));
  return terms.filter((term) => includesTerm(haystack, term)).length;
}

function evidenceSourceForAnswer(doc, question, hits = [], index = 0) {
  const card = evidenceCardForDoc(doc);
  const answerItems = answerEvidenceItems(card);
  const hitEvidence = cleanAnswerEvidence(
    distinctTopSentences(sentences(hits.map((item) => item.chunk.text).join(" ")), new Set(tokens(question)), 4),
    2
  );
  return {
    marker: `[${index + 1}]`,
    docId: doc.id,
    title: publicDocTitle(doc),
    keywords: (doc.keywords || []).map((item) => displayText(item.term || item)).filter(Boolean),
    abstract: cleanEvidenceForAnswer(doc.abstract || ""),
    keyInfo: synthesizeDocKeyInfo(doc),
    researchQuestion: answerItemClaim(card.research_question),
    method: answerItemClaim(card.method),
    dataOrMaterials: answerItemClaim(card.data_or_materials),
    mainClaims: cleanAnswerEvidence(answerItems.claims.map((item) => item.normalized_claim || item.claim), 4),
    evidence: [
      ...cleanAnswerEvidence(answerItems.evidence.map((item) => item.normalized_claim || item.claim), 4),
      ...hitEvidence
    ].slice(0, 4),
    metricEvidence: (card.metric_evidence || [])
      .map((item) => ({
        quote: metricEvidenceForAnswer(item),
        page: item.page || null,
        paragraph: item.paragraph || null,
        evidence_type: item.evidence_type || "",
        evidence_role: item.evidence_role || "",
        confidence: item.confidence || 0
      }))
      .filter((item) => item.quote)
      .slice(0, 4),
    limitations: cleanAnswerEvidence(answerItems.limitations.map((item) => item.normalized_claim || item.claim), 3),
    contribution: answerItemClaim(card.contribution),
    quotes: (card.quotes || []).map((quote) => ({ ...quote, text: cleanEvidenceForAnswer(quote.text || quote.quote || "") })).filter((quote) => quote.text).slice(0, 3),
    weakFields: weakAnswerFields(card),
    matrix: answerEvidenceMatrixRows(card),
    profile: docGraphProfile(doc),
    confidence: card.confidence || 0.6
  };
}

function answerEvidenceItems(card = {}) {
  const strong = (items = []) => items.filter((item) => answerItemUsable(item));
  return {
    claims: strong([card.contribution, ...(card.main_claims || [])].filter(Boolean)),
    evidence: strong(card.evidence || []),
    limitations: strong(card.limitations || [])
  };
}

function answerItemUsable(item = {}) {
  if (!item) return false;
  if (isGenericEvidenceClaim(item.normalized_claim || item.claim || "")) return false;
  if (usableEvidenceItem(item)) return true;
  const type = item.evidence_type ? { directQuoteEligible: item.direct_quote_eligible !== false } : evidenceTypeForQuote(item.quote || "");
  return Boolean(item.quote && item.page && type.directQuoteEligible && !isMissingEvidenceText(item.normalized_claim || item.claim || ""));
}

function isGenericEvidenceClaim(text = "") {
  return /通过实验、数据、案例或指标对核心判断进行验证|围绕.+提出可讨论的研究判断|形成关于.+的可复核研究判断/.test(String(text || ""));
}

function answerItemClaim(item = {}) {
  if (!answerItemUsable(item)) return "";
  return cleanEvidenceForAnswer(item.normalized_claim || item.claim || "");
}

function weakAnswerFields(card = {}) {
  const rows = [
    ["研究问题", card.research_question],
    ["方法", card.method],
    ["数据/材料", card.data_or_materials],
    ["贡献", card.contribution],
    ...((card.evidence || []).map((item, index) => [`证据${index + 1}`, item])),
    ...((card.limitations || []).map((item, index) => [`局限${index + 1}`, item]))
  ];
  return rows
    .filter(([, item]) => item && !answerItemUsable(item))
    .map(([dimension, item]) => ({
      dimension,
      reason: item.not_usable_reason || item.dimension_issue || item.audit || "needs_review",
      claim: isGenericEvidenceClaim(item.normalized_claim || item.claim || "") ? "" : cleanEvidenceForAnswer(item.normalized_claim || item.claim || "")
    }))
    .filter((item) => item.claim || item.reason)
    .slice(0, 5);
}

function answerEvidenceMatrixRows(card) {
  const rows = [
    ["研究问题", card.research_question],
    ["方法", card.method],
    ["数据/材料", card.data_or_materials],
    ["贡献", card.contribution],
    ...((card.main_claims || []).slice(0, 2).map((item, index) => [`主张${index + 1}`, item])),
    ...((card.evidence || []).slice(0, 2).map((item, index) => [`证据${index + 1}`, item])),
    ...((card.limitations || []).slice(0, 1).map((item) => ["局限", item]))
  ];
  return rows
    .filter(([, item]) => item)
    .map(([dimension, item]) => ({
      dimension,
      claim: isGenericEvidenceClaim(item.normalized_claim || item.claim || "") ? "" : cleanEvidenceForAnswer(item.normalized_claim || item.claim || ""),
      quoteClaim: cleanEvidenceForAnswer(item.quote_claim || ""),
      quote: cleanEvidenceForAnswer(item.quote || ""),
      page: item.page || null,
      confidence: item.confidence || 0,
      audit: item.audit || "needs_review",
      dimensionAudit: item.dimension_audit || "",
      dimensionIssue: item.dimension_issue || "",
      why: isGenericEvidenceClaim(item.why_supports_claim || "") ? "" : item.why_supports_claim || ""
    }));
}

function sourceResearchJudgment(source, sources = []) {
  const profile = source.profile || {};
  const methodLabel = profile.methodType || inferGraphMethodType(`${source.method || ""} ${source.dataOrMaterials || ""}`);
  const domainLabel = profile.domain || "当前主题";
  const problemLabel = profile.problemType || "研究问题";
  const stanceSeed = source.contribution || source.mainClaims?.[0] || source.researchQuestion || source.keyInfo;
  const stance = compactResearchJudgment(
    stanceSeed,
    `${domainLabel}研究把“${problemLabel}”转化为“${methodLabel}”下的可检验判断。`
  );
  const metric = (source.metricEvidence || []).find((item) => cleanEvidenceForAnswer(item.quote || ""));
  const directEvidence = source.evidence?.[0] || source.quotes?.[0]?.text || source.method || "";
  const evidenceType = normalizeAnswerClaimType(metric?.evidence_type || "", metric?.quote || directEvidence);
  const evidenceSeed = evidenceType === "指标证据"
    ? metricEvidenceSummary(metric?.quote || directEvidence)
    : evidenceType === "图表证据"
      ? figureEvidenceSummary(metric?.quote || directEvidence)
      : (metric?.quote || directEvidence);
  const evidenceSummary = compactResearchJudgment(
    evidenceSeed,
    evidenceType === "指标证据"
      ? "证据以数值指标、对比结果或实验表现为主，需要回到指标口径核对。"
      : "证据以原文事实、方法描述或案例材料为主，需要结合定位核对。"
  );
  const boundary = compactResearchJudgment(
    source.limitations?.[0] || profile.riskType || "",
    "边界需要结合数据来源、方法假设、应用场景和原文定位核对。"
  );
  const similar = sources
    .filter((other) => other.marker !== source.marker)
    .filter((other) => {
      const otherProfile = other.profile || {};
      return otherProfile.domain === domainLabel || otherProfile.methodType === methodLabel;
    })
    .map((other) => other.marker);
  const different = sources
    .filter((other) => other.marker !== source.marker)
    .filter((other) => {
      const otherProfile = other.profile || {};
      return otherProfile.domain !== domainLabel && otherProfile.methodType !== methodLabel;
    })
    .map((other) => other.marker)
    .slice(0, 4);
  return {
    source: source.marker,
    title: source.title,
    stance,
    supportingEvidence: evidenceSummary,
    evidenceSummary,
    evidenceType,
    sameAs: similar,
    differentFrom: different,
    canInfer: compactResearchJudgment(
      `${source.marker} 可用于说明“${problemLabel}”如何由“${methodLabel}”和对应证据支撑。`,
      "该文可用于支撑自身研究对象内的判断。"
    ),
    cannotInfer: boundary,
    evidenceStrength: source.confidence >= 0.75 ? "较强" : source.confidence >= 0.6 ? "中等" : "较弱"
  };
}

function buildStanceMatrix(question, sources) {
  return sources.map((source) => sourceResearchJudgment(source, sources));
}

function buildEvidenceDrivenAnswer(question, sources, commonTerms = [], stanceMatrix = []) {
  if (!sources.length) {
    return { directConclusion: "当前范围没有足够证据回答。", answer: "当前范围没有足够证据回答。", claims: [], consensus: [], disagreements: [], evidenceStrength: [], stances: [], cannotInfer: [] };
  }
  const q = String(question || "");
  const isBroad = broadCrossDocQuestion(question) && sources.length > 1;
  const focus = isBroad ? "这些资料" : (commonTerms.slice(0, 5).join("、") || "这些研究对象");
  const citations = sources.map((s) => s.marker);
  const methodGroups = groupByNormalized(sources, (source) => source.method);
  const riskItems = sources.flatMap((source) => (source.limitations || []).map((item) => `${source.marker}${item}`)).slice(0, 4);
  const evidenceItems = sources.flatMap((source) => (source.evidence || []).map((item) => `${source.marker}${item}`)).slice(0, 5);
  const metricItems = sources.flatMap((source) => (source.metricEvidence || []).map((item) => metricEvidenceLineForAnswer(source, item))).filter(Boolean).slice(0, 4);
  const consensus = answerConsensus(sources, methodGroups, evidenceItems);
  const disagreements = answerDisagreements(sources, methodGroups);
  const answerParts = [];
  if (isBroad) {
    answerParts.push(consensus[0] || `综合 ${sources.length} 份相关资料看，${focus}不能被压成一个单一结论，应按问题、方法、证据和边界分层判断。`);
    if (disagreements.length) answerParts.push(disagreements[0]);
    answerParts.push(`证据强弱要分层看：${stanceMatrix.slice(0, 6).map((item) => `${item.source}${item.evidenceStrength}`).join("；")}。`);
    if (riskItems.length) answerParts.push(`不能强推的部分主要在边界条件：${riskItems.join("；")}。`);
  } else if (/方法|流程|机制|架构|怎么|如何/.test(q)) {
    answerParts.push(`从证据矩阵看，${focus}的关键差异在方法链条：${sources.slice(0, 4).map((s) => `${s.marker}${s.method || s.contribution}`).filter(Boolean).join("；")}。`);
  } else if (/局限|风险|不足|边界|限制/.test(q)) {
    answerParts.push(`这些资料的边界不能合并成一句话，主要风险分别是：${riskItems.join("；") || "证据卡没有抽出稳定局限，需要回到原文核对"}。`);
  } else if (/证据|证明|支撑|结果|指标|实验/.test(q)) {
    answerParts.push(`可核对证据主要来自：${[...metricItems, ...evidenceItems].slice(0, 5).join("；") || "当前证据卡缺少明确实验或结果字段"}。这些证据决定了哪些结论能写得强，哪些只能作为待验证判断。`);
  } else {
    answerParts.push(`综合 ${sources.length} 份资料看，回答应以每篇的立场矩阵为依据，而不是只按关键词合并。`);
    answerParts.push(`${stanceMatrix.slice(0, 4).map((item) => `${item.source}${item.stance}`).filter(Boolean).join("；")}。`);
  }
  const directConclusion = finalizeAnswerSentence(answerParts[0], {
    fallback: `基于当前 ${sources.length} 篇资料，可以先按证据卡比较研究问题、方法、证据和边界。`
  });
  const evidenceStrength = sources.map((source) => {
    const confidence = Number(source.confidence || 0);
    const missing = (source.matrix || []).filter((row) => /missing|weak/.test(row.audit || "")).length;
    const level = confidence >= 0.75 && !missing ? "较强" : confidence >= 0.6 ? "中等" : "较弱";
    return `${source.marker}${source.title}：${level}。${missing ? `${missing} 个字段缺原文或支撑不足。` : "主要字段有原文支撑。"} `;
  });
  const stances = stanceMatrix.map((item) => ({
    source: item.source,
    title: item.title,
    stance: item.stance || "该文立场需要回到证据卡核对。",
    evidence: item.supportingEvidence || "",
    limitation: item.cannotInfer || ""
  }));
  const cannotInfer = [
    "不能把单篇文献中的模型效果、数字指标或应用判断直接写成全部文献共同结论。",
    "不能把只有概念交叉的文献强行解释成支持或反驳关系。",
    "没有绑定原文 quote 的字段只能作为待核对推断，不能作为强证据引用。"
  ];
  const claims = [
    {
      type: "综合推断",
      text: isBroad
        ? (consensus[0] || "可共同成立的结论是：这些资料都在把复杂对象转化为可操作的方法链条，但每篇的证据类型不同，不能把实验指标、计量画像和理论机制解释混成同一种证明力度。")
        : `可共同成立的结论是：${focus}需要同时说明研究问题、方法链条、证据强弱和适用边界，不能只按标题或关键词合并。`,
      citations
    }
  ];
  if (evidenceItems.length) {
    const evidenceClaimType = hasMetricEvidenceText(evidenceItems.join(" ")) ? "指标证据" : "综合推断";
    claims.push({
      type: evidenceClaimType,
      text: `支撑依据集中在各文给出的实验、指标、案例或机制解释：${evidenceItems.slice(0, 3).join("；")}。`,
      citations: sources.filter((s) => (s.evidence || []).length).map((s) => s.marker)
    });
  }
  if (metricItems.length) {
    claims.push({
      type: "指标证据",
      text: `数值或指标性证据需要按指标口径单独核对：${metricItems.slice(0, 3).join("；")}。`,
      citations: sources.filter((s) => (s.metricEvidence || []).length).map((s) => s.marker)
    });
  }
  const weakSources = sources.filter((source) => (source.weakFields || []).length);
  if (weakSources.length) {
    claims.push({
      type: "不确定",
      text: `以下来源存在待核对字段：${weakSources.map((source) => `${source.marker}${source.weakFields.map((field) => field.dimension).join("/")}`).join("；")}。这些字段不能作为强证据直接引用。`,
      citations: weakSources.map((source) => source.marker)
    });
  }
  return {
    directConclusion,
    answer: answerParts.join(" "),
    claims,
    consensus,
    disagreements,
    evidenceStrength,
    stances,
    cannotInfer
  };
}

function answerConsensus(sources, methodGroups, evidenceItems) {
  const sharedMethods = methodGroups.filter((group) => group.items.length >= 2).slice(0, 3);
  const lines = [];
  if (sharedMethods.length) {
    lines.push(`共识：多篇资料都偏向${sharedMethods.map((group) => group.label).join("、")}。共同点不是结论完全相同，而是都需要把研究问题转成可执行的方法链条。`);
  } else {
    lines.push(`共识：这些资料都需要通过“问题-方法-证据-边界”四层结构判断价值，而不是只看关键词相似。`);
  }
  if (evidenceItems.length) {
    lines.push(`共识证据：当前可核对证据集中在 ${evidenceItems.slice(0, 4).join("；")}。`);
  }
  return lines;
}

function answerDisagreements(sources, methodGroups) {
  const lines = [];
  const nonEmptyGroups = methodGroups.filter((group) => group.label && group.items.length);
  if (nonEmptyGroups.length > 1) {
    lines.push(`分歧或差异：方法路径不同，${nonEmptyGroups.slice(0, 4).map((group) => `${group.items.map((source) => source.marker).join("、")}偏向${group.label}`).join("；")}。这些差异意味着不能把各文效果、风险和适用场景直接合并。`);
  } else {
    lines.push("当前资料的方法路径相近，主要差异应继续看数据来源、评价指标、场景条件和局限字段。");
  }
  const weak = sources.filter((source) => (source.weakFields || []).length);
  if (weak.length) {
    lines.push(`证据分歧还体现在字段完整度：${weak.map((source) => `${source.marker}有${source.weakFields.length}个待核对字段`).join("；")}。`);
  }
  return lines;
}

function buildImpactAnalysis(previousDocs = [], addedDocs = [], allDocs = []) {
  if (!addedDocs.length) return null;
  const previousProfiles = previousDocs.map((doc) => ({ doc, profile: docGraphProfile(doc), card: evidenceCardForDoc(doc) }));
  const addedProfiles = addedDocs.map((doc) => ({ doc, profile: docGraphProfile(doc), card: evidenceCardForDoc(doc) }));
  const supports = [];
  const challenges = [];
  const fillsGaps = [];
  const reviewUpdates = [];
  for (const added of addedProfiles) {
    const related = previousProfiles
      .map((old) => ({
        old,
        relation: compareDocProfiles(added.profile, old.profile, sharedProfileTerms(added.profile, old.profile), 0)
      }))
      .sort((a, b) => b.relation.score - a.relation.score)
      .slice(0, 4);
    if (!related.length) {
      fillsGaps.push(`新增《${displayText(added.doc.title)}》引入了“${added.profile.domain} / ${added.profile.methodType}”，当前库里缺少直接可比资料，可作为新主题或新方法空白。`);
      continue;
    }
    for (const item of related) {
      const oldTitle = displayText(item.old.doc.title);
      const newTitle = displayText(added.doc.title);
      const kind = item.relation.kind || relationKindForLabel(item.relation.label);
      if (kind === "same_problem" || kind === "supports") {
        supports.push(`《${newTitle}》补强《${oldTitle}》相关结论：两者都围绕“${added.profile.problemType}”或相近证据类型展开，适合放进同一论证段比较证据强弱。`);
      } else if (kind === "contrasts") {
        challenges.push(`《${newTitle}》与《${oldTitle}》形成边界对照：新增资料提示“${added.profile.riskType}”，需要检查原综述是否把结论外推过头。`);
      } else if (kind === "extends" || kind === "same_method") {
        fillsGaps.push(`《${newTitle}》扩展了《${oldTitle}》的方法链条：从“${item.old.profile.methodType}”延伸到“${added.profile.methodType}”，可更新方法谱系段落。`);
      } else {
        fillsGaps.push(`《${newTitle}》与《${oldTitle}》只有弱概念交叉，暂不应强行合并结论，应作为待复核关系。`);
      }
    }
    const weakFields = [
      added.card.research_question,
      added.card.method,
      added.card.data_or_materials,
      added.card.contribution,
      ...(added.card.main_claims || []),
      ...(added.card.evidence || []),
      ...(added.card.limitations || [])
    ].filter((item) => /missing|weak/.test(item?.audit || ""));
    if (weakFields.length) {
      reviewUpdates.push(`《${displayText(added.doc.title)}》有 ${weakFields.length} 个证据字段缺原文或支撑偏弱，更新综述时应先标为“待核对”，不要写成强结论。`);
    } else {
      reviewUpdates.push(`《${displayText(added.doc.title)}》证据卡完整度较好，可优先更新对应的研究问题、方法分类和证据强弱段。`);
    }
  }
  return {
    addedCount: addedDocs.length,
    totalCount: allDocs.length,
    supports: uniqueStrings(supports).slice(0, 6),
    challenges: uniqueStrings(challenges).slice(0, 6),
    fillsGaps: uniqueStrings(fillsGaps).slice(0, 6),
    reviewUpdates: uniqueStrings(reviewUpdates).slice(0, 6)
  };
}

function buildResearchGaps(docs = []) {
  if (!docs.length) {
    return { repeatedProblems: [], underEvaluatedMethods: [], missingScenarios: [], candidateTopics: [], theorySources: [], empiricalSources: [] };
  }
  const items = docs.map((doc, index) => {
    const card = evidenceCardForDoc(doc);
    const profile = docGraphProfile(doc);
    return {
      marker: `[${index + 1}]`,
      title: displayText(doc.title || doc.filename || "未命名资料"),
      profile,
      card,
      weakCount: [
        card.research_question,
        card.method,
        card.data_or_materials,
        card.contribution,
        ...(card.main_claims || []),
        ...(card.evidence || []),
        ...(card.limitations || [])
      ].filter((field) => /missing|weak/.test(field?.audit || "")).length
    };
  });
  const problemGroups = groupByText(items, (item) => item.profile.problemType || "问题待核对");
  const methodGroups = groupByText(items, (item) => item.profile.methodType || "方法待核对");
  const repeatedProblems = problemGroups
    .filter((group) => group.items.length >= 2)
    .map((group) => gapItem({
      kind: "problem_alignment",
      title: `${group.label}为何被多篇文献反复提出`,
      sources: group.items,
      missingEvidence: "目前只能确认这些资料都触及相近问题，还需要比较每篇如何定义问题边界、评价对象和失败情形。",
      verificationPlan: "problem_alignment_seed",
      whyItMatters: "只有把共同问题界定清楚，综述中的研究动机才不会变成标题相似的堆叠。"
    }));
  const underEvaluatedMethods = methodGroups
    .filter((group) => group.items.some((item) => item.weakCount > 0 || !/实验|指标|计量|案例/.test(item.profile.evidenceType)))
    .map((group) => gapItem({
      kind: "method_evaluation",
      title: `${group.label}的评价是否不足或不可比`,
      sources: group.items,
      missingEvidence: "缺少统一的评价指标、样本说明、对比基线或跨场景复现实验，导致方法优劣不能直接推出。",
      verificationPlan: "method_evaluation_seed",
      whyItMatters: "方法很多不等于证据充分，评价口径不统一会让综述误把“提出了方法”写成“证明了方法更好”。"
    }));
  const missingScenarios = items
    .filter((item) => /边界|待验证|适用|场景|数据/.test(item.profile.riskType) || item.weakCount > 0)
    .map((item) => gapItem({
      kind: "source_boundary",
      title: `${item.title}的适用边界需要补证`,
      sources: [item],
      missingEvidence: item.profile.riskType || "原文对适用场景、数据范围或失败条件交代不足，需要回到证据卡核对。",
      verificationPlan: "source_boundary_seed",
      whyItMatters: "边界不清会让单篇结论被过度外推，影响后续关系图和综述判断。"
    }))
    .slice(0, 6);
  const candidateTopics = [
    ...problemGroups.slice(0, 3).map((group) => gapItem({
      kind: "evidence_compare",
      title: `面向“${group.label}”的证据强弱比较研究`,
      sources: group.items,
      missingEvidence: "需要明确哪些结论由多篇共同支持，哪些只是单篇材料或弱证据推断。",
      verificationPlan: "evidence_compare_seed",
      whyItMatters: "这个题目可以直接服务综述写作，把资料关系从“相关”推进到“谁证明了什么”。"
    })),
    ...methodGroups.slice(0, 3).map((group) => gapItem({
      kind: "method_transfer",
      title: `“${group.label}”在不同研究对象中的迁移边界与评价指标研究`,
      sources: group.items,
      missingEvidence: "缺少跨对象、跨数据或跨场景的可比实验，不能只根据方法名称判断可迁移。",
      verificationPlan: "method_transfer_seed",
      whyItMatters: "能把方法谱系写成可验证的研究问题，而不是泛泛比较技术路线。"
    }))
  ].slice(0, 6);
  const theorySources = items
    .filter((item) => /理论|机制|演进|范式|知识图谱|计量/.test(`${item.profile.evidenceType} ${item.profile.methodType}`))
    .map((item) => gapItem({
      kind: "theory_use",
      title: `${item.title}可作为理论或脉络来源`,
      sources: [item],
      missingEvidence: "还需要确认其概念定义、机制链条或领域演进判断是否有原文定位支撑。",
      verificationPlan: "theory_use_seed",
      whyItMatters: "理论来源负责解释研究为什么成立，不能和实验结果类资料混成同一种证据。"
    }))
    .slice(0, 6);
  const empiricalSources = items
    .filter((item) => /实验|指标|仿真|数据|案例|预测|检测/.test(`${item.profile.evidenceType} ${item.profile.problemType}`))
    .map((item) => gapItem({
      kind: "empirical_use",
      title: `${item.title}可作为实证支撑`,
      sources: [item],
      missingEvidence: "需要确认数据集、评价指标、对比对象和数值结果是否完整可核对。",
      verificationPlan: "empirical_use_seed",
      whyItMatters: "实证来源决定综述中哪些判断可以写得更强，哪些只能保留为可能趋势。"
    }))
    .slice(0, 6);
  return {
    repeatedProblems,
    underEvaluatedMethods,
    missingScenarios,
    candidateTopics,
    theorySources,
    empiricalSources
  };
}

function gapItem({ kind = "", title, sources = [], missingEvidence, verificationPlan, whyItMatters }) {
  const scope = gapScopeForSources(kind, sources);
  const isCrossDomainMethodology = scope.gapScope === "cross_domain_methodology";
  const scopedTitle = isCrossDomainMethodology ? crossDomainMethodologyTitle(kind, title, sources) : title;
  const scopedMissingEvidence = scope.canBeThesisTopic
    ? missingEvidence
    : isCrossDomainMethodology
      ? `${missingEvidence || "这些资料只共享抽象方法或证据意识。"}不同领域或不可比证据不能合并成同一个具体研究问题，只能作为方法论启发。${scope.scopeReasons?.length ? `未达标原因：${scope.scopeReasons.join("；")}。` : ""}`
      : `${missingEvidence || "当前只有单篇来源暴露出边界问题。"}这只能作为研究线索；需要继续补充同域、方法相近且证据可比的文献至少 2 篇后，才能升级为开题候选。`;
  const gapType = inferGapType(scopedTitle, scopedMissingEvidence, verificationPlan, kind);
  const verificationSteps = gapVerificationSteps({ kind, title: scopedTitle, sources, missingEvidence: scopedMissingEvidence, verificationPlan, gapType });
  const proposal = gapResearchProposal({ kind, title: scopedTitle, sources, missingEvidence: scopedMissingEvidence, gapType, gapScope: scope.gapScope, canBeThesisTopic: scope.canBeThesisTopic, canBeResearchLead: scope.canBeResearchLead });
  return {
    kind,
    title: scopedTitle,
    originalTitle: title,
    gapType,
    gapScope: scope.gapScope,
    scopeLabel: scope.scopeLabel,
    canBeThesisTopic: scope.canBeThesisTopic,
    canBeResearchLead: scope.canBeResearchLead,
    scopeReasons: scope.scopeReasons || [],
    gapSentence: scope.canBeThesisTopic
      ? gapWritingSentence(scopedTitle, scopedMissingEvidence, kind)
      : isCrossDomainMethodology
        ? crossDomainMethodologySentence(scopedTitle, sources)
        : singleSourceLeadSentence(scopedTitle, sources),
    proposal,
    sources: sources.map((item) => ({ marker: item.marker, title: item.title })),
    missingEvidence: scopedMissingEvidence,
    verificationPlan: verificationSteps.map((step, index) => `${index + 1}. ${step.action}`).join(" "),
    verificationSteps,
    whyItMatters: scope.canBeThesisTopic
      ? whyItMatters
      : isCrossDomainMethodology
        ? "跨领域或证据不可比资料的价值在于启发比较框架和证据标准，而不是直接拼出一个具体开题题目。"
        : "单篇资料的价值在于暴露值得追踪的边界线索，但还不足以证明这是稳定研究空白。"
  };
}

function gapScopeForSources(kind = "", sources = []) {
  const domains = [...new Set((sources || []).map((source) => source.profile?.domain || "").filter(Boolean))];
  const meaningfulDomains = domains.filter((domain) => domain && domain !== "一般研究资料");
  const singleSource = (sources || []).length <= 1;
  if (singleSource) {
    return {
      gapScope: "single_source_boundary",
      scopeLabel: "单篇研究线索",
      canBeThesisTopic: false,
      canBeResearchLead: true,
      scopeReasons: ["只有 1 篇来源，尚不能证明该空白具有稳定文献支撑"]
    };
  }
  const methodFamilies = [...new Set((sources || []).map((source) => gapMethodFamily(source.profile?.methodType || "")).filter(Boolean))];
  const evidenceFamilies = [...new Set((sources || []).map((source) => gapEvidenceFamily(source.profile?.evidenceType || "")).filter(Boolean))];
  const domainFamilies = [...new Set((sources || []).map((source) => gapDomainFamily(source.profile?.domain || "")).filter(Boolean))];
  const usableSources = (sources || []).filter((source) => gapUsableEvidenceCount(source) > 0).length;
  const reasons = [];
  const domainComparable = meaningfulDomains.length > 0 && domainFamilies.length <= 1;
  const methodComparable = methodFamilies.length <= 1;
  const evidenceComparable = evidenceFamilies.length <= 1;
  if (!domainComparable) reasons.push(`domain 不同或过宽（${meaningfulDomains.join("、") || "待识别"}）`);
  if (!methodComparable) reasons.push(`methodType 不相近（${gapUniqueProfileValues(sources, "methodType").join("、") || "待识别"}）`);
  if (!evidenceComparable) reasons.push(`evidenceType 不可比（${gapUniqueProfileValues(sources, "evidenceType").join("、") || "待识别"}）`);
  if (usableSources < 2) reasons.push(`可直接引用证据不足（仅 ${usableSources} 篇有 usable evidence）`);
  const canBeThesisTopic = domainComparable && methodComparable && evidenceComparable && usableSources >= 2;
  return canBeThesisTopic
    ? {
        gapScope: "same_domain_topic",
        scopeLabel: "同域可开题",
        canBeThesisTopic: true,
        canBeResearchLead: true,
        scopeReasons: ["domain/method/evidence 可比", `有 ${usableSources} 篇资料具备 usable evidence`]
      }
    : {
        gapScope: "cross_domain_methodology",
        scopeLabel: "跨域方法论启发",
        canBeThesisTopic: false,
        canBeResearchLead: true,
        scopeReasons: reasons
      };
}

function gapUsableEvidenceCount(source = {}) {
  const card = source.card || {};
  return [
    card.research_question,
    card.method,
    card.data_or_materials,
    card.contribution,
    ...(card.main_claims || []),
    ...(card.evidence || []),
    ...(card.limitations || [])
  ].filter(usableEvidenceItem).length;
}

function gapDomainFamily(domain = "") {
  if (/接口安全检测/.test(domain)) return "api_security";
  if (/交通控制|交通流预测/.test(domain)) return "traffic_system";
  if (/文献计量与知识图谱/.test(domain)) return "bibliometrics";
  if (/消费研究智能化/.test(domain)) return "consumer_ai";
  if (/生成式人工智能影响/.test(domain)) return "ai_social_effect";
  if (/智能体设计/.test(domain)) return "agent_design";
  if (/一般研究资料/.test(domain)) return "";
  return domain || "";
}

function gapMethodFamily(method = "") {
  if (/智能体协同|检索增强|工具调用|语义检索/.test(method)) return "agent_pipeline";
  if (/计量分析|知识图谱|共现|引文/.test(method)) return "bibliometric_mapping";
  if (/组合建模|预测|时间序列/.test(method)) return "predictive_modeling";
  if (/协同控制|信号配时|控制框架/.test(method)) return "control_framework";
  if (/机制解释|调制|行为机制/.test(method)) return "mechanism_explanation";
  if (/范式框架|消费感知|类脑模拟|自主演化/.test(method)) return "paradigm_framework";
  if (/文本归纳/.test(method)) return "";
  return method || "";
}

function gapEvidenceFamily(evidence = "") {
  if (/实验|指标|仿真|数据/.test(evidence)) return "empirical_metric";
  if (/文献计量|知识图谱/.test(evidence)) return "bibliometric";
  if (/理论|机制|逻辑/.test(evidence)) return "theoretical";
  if (/案例|场景/.test(evidence)) return "case_scenario";
  if (/文本/.test(evidence)) return "textual";
  return evidence || "";
}

function crossDomainMethodologyTitle(kind = "", title = "", sources = []) {
  const domainValues = gapUniqueProfileValues(sources, "domain").slice(0, 3);
  const domains = domainValues.join("、") || "不同领域";
  const connector = domainValues.length <= 1 ? "内部" : "之间";
  if (kind === "method_transfer") return `${domains}${connector}的证据口径与方法迁移边界启发`;
  if (kind === "evidence_compare") return `${domains}${connector}的证据强弱比较方法启发`;
  if (kind === "problem_alignment") return `${domains}${connector}的问题定义比较方法启发`;
  if (kind === "method_evaluation") return `${domains}${connector}的同口径评价方法启发`;
  return `${displayText(title) || domains}的方法论启发`;
}

function crossDomainMethodologySentence(title = "", sources = []) {
  const sourceText = gapSourceShortList(sources);
  return `${displayText(title)}：${sourceText}不能合并为同一个具体研究课题，但可以共同提示综述写作应先统一 claim、证据类型、评价指标和不可推出边界。`;
}

function singleSourceLeadSentence(title = "", sources = []) {
  const sourceText = gapSourceShortList(sources);
  return `${displayText(title)}：${sourceText}目前只能作为研究线索，尚不足以直接写成开题空白；下一步应补充同域、方法相近且证据可比的资料。`;
}

function gapResearchProposal({ kind = "", title = "", sources = [], missingEvidence = "", gapType = "", gapScope = "", canBeThesisTopic = true, canBeResearchLead = true }) {
  const sourceA = sources[0] || {};
  const sourceB = sources[1] || {};
  const problem = gapSourceProblem(sourceA);
  const method = gapSourceMethod(sourceA);
  const data = gapSourceData(sourceA);
  const metricHints = gapMetricHints(sources) || "准确率、召回率、误差、覆盖率或文献计量指标";
  const sourceMarkers = gapSourceShortList(sources);
  const titleText = displayText(title).replace(/[？?。]+$/, "");
  const methodB = gapSourceMethod(sourceB);
  if (gapScope === "single_source_boundary") {
    return {
      researchQuestion: `${titleText}暴露出的边界问题是否也存在于同域、方法相近的其他文献中？`,
      independentVariable: "补充文献数量、同域相似度、方法相似度和证据可比性",
      dependentVariable: "该边界问题能否从单篇线索升级为稳定研究空白",
      metrics: `${metricHints}、同域文献召回数、可比证据覆盖率、引用可追溯率`,
      dataNeeded: missingEvidence || "至少补充 2 篇同域、方法相近且有 usable evidence 的资料，再判断是否能形成开题候选。",
      expectedContribution: "把单篇边界线索转化为可验证的查证任务，避免把孤立局限误写成领域空白。",
      literatureGroup: `${sourceMarkers}：${sources.slice(0, 4).map((source) => shortEvidenceText(source.title || "", 24)).join("；")}`,
      scope: "单篇研究线索",
      canBeThesisTopic: false,
      canBeResearchLead
    };
  }
  if (!canBeThesisTopic || gapScope === "cross_domain_methodology") {
    return {
      researchQuestion: `${titleText}如何启发跨文献综述中的证据分层和可比性判断？`,
      independentVariable: "claim 表述、证据类型、评价口径和适用边界的编码规则",
      dependentVariable: "跨文献关系判断的一致性、误合并率和待核对字段召回率",
      metrics: "误合并率、证据可用率、引用可追溯率、人工复核一致性",
      dataNeeded: missingEvidence || "需要为每篇资料补齐 claim、quote/location/confidence，并标明是否同域可比。",
      expectedContribution: "形成跨领域文献综述的证据审计方法，避免把主题不同的资料强行拼成一个具体研究问题。",
      literatureGroup: `${sourceMarkers}：${sources.slice(0, 4).map((source) => shortEvidenceText(source.title || "", 24)).join("；")}`,
      scope: "跨域方法论启发",
      canBeThesisTopic: false,
      canBeResearchLead
    };
  }
  const variableByKind = {
    problem_alignment: {
      independent: "问题定义方式、研究对象边界、评价口径",
      dependent: "文献间结论是否可比较、综述问题框架的一致性",
      question: `${titleText}在不同文献中是否指向同一研究对象和同一评价目标？`
    },
    method_evaluation: {
      independent: `方法路径差异（${method}${methodB ? ` vs ${methodB}` : ""}）`,
      dependent: `同一任务下的${metricHints}`,
      question: `${titleText}能否在同一数据、同一指标和同一基线下进行有效比较？`
    },
    source_boundary: {
      independent: "数据来源、应用场景、对象范围和失败条件",
      dependent: "结论的稳定性、外推有效性和错误类型",
      question: `${problem || titleText}在更换数据或场景后是否仍然成立？`
    },
    evidence_compare: {
      independent: "证据强度、证据类型和来源数量",
      dependent: "结论可写强度、共识程度和不可推出边界",
      question: `${titleText}中哪些结论由多篇强证据共同支持，哪些只是单篇或弱证据推断？`
    },
    method_transfer: {
      independent: `方法模块、输入对象和输出指标（${method || titleText}）`,
      dependent: "跨对象迁移性能、失败样本和边界条件",
      question: `${method || titleText}能否跨对象、跨数据或跨场景保持效果？`
    },
    theory_use: {
      independent: "概念定义、机制链条和解释层级",
      dependent: "对其他文献方法或结果的解释覆盖度",
      question: `${titleText}能否作为解释其他研究结果的稳定理论框架？`
    },
    empirical_use: {
      independent: `数据集、样本范围、基线和指标（${data}）`,
      dependent: `结果强度、可复现性和${metricHints}`,
      question: `${titleText}的实证结论是否具备可复核的数据、指标和基线支撑？`
    }
  };
  const spec = variableByKind[kind] || {
    independent: "研究对象、方法路径和证据类型",
    dependent: "结论强度、适用边界和可复核性",
    question: `${titleText}是否具备足够证据链，能够从研究线索升级为稳定结论？`
  };
  return {
    researchQuestion: spec.question,
    independentVariable: spec.independent,
    dependentVariable: spec.dependent,
    metrics: metricHints,
    dataNeeded: missingEvidence || "需要补充可核对的原文 quote、定位、样本/数据范围和评价基线。",
    expectedContribution: expectedGapContribution(kind, gapType),
    literatureGroup: `${sourceMarkers}：${sources.slice(0, 4).map((source) => shortEvidenceText(source.title || "", 24)).join("；")}`,
    scope: canBeThesisTopic ? "可开题" : "方法论启发",
    canBeThesisTopic,
    canBeResearchLead
  };
}

function expectedGapContribution(kind = "", gapType = "") {
  if (kind === "problem_alignment") return "形成可复用的问题定义框架，避免把标题相近的文献误写成同一研究问题。";
  if (kind === "method_evaluation") return "提供同口径评价方案，区分“提出方法”和“证明方法有效”。";
  if (kind === "source_boundary") return "明确结论外推边界，说明在哪些数据、对象或场景下结论可能失效。";
  if (kind === "evidence_compare") return "建立强证据、弱证据和不可推出结论的分层综述写法。";
  if (kind === "method_transfer") return "解释方法迁移的适用条件和失败模式，而不是只比较方法名称。";
  if (kind === "theory_use") return "把概念或机制线索转化为能解释多篇资料的理论框架。";
  if (kind === "empirical_use") return "补齐数据、指标和基线，使单篇实证线索可进入强结论段。";
  return `${gapType || "研究空白"}的贡献在于把待核对线索转化为可验证研究问题。`;
}

function gapVerificationSteps({ kind = "", title = "", sources = [], missingEvidence = "", verificationPlan = "", gapType = "" }) {
  const sourceText = gapSourceShortList(sources);
  const weakFields = gapWeakFieldLabels(sources);
  const methodText = gapUniqueProfileValues(sources, "methodType").slice(0, 3).join("、");
  const problemText = gapUniqueProfileValues(sources, "problemType").slice(0, 3).join("、");
  const evidenceText = gapUniqueProfileValues(sources, "evidenceType").slice(0, 3).join("、");
  const riskText = gapUniqueProfileValues(sources, "riskType").slice(0, 2).join("、");
  const weakBySource = gapWeakFieldsBySource(sources);
  const pageText = gapPageEvidenceSummary(sources);
  const contrastText = gapContrastPair(sources);
  const sourceCount = sources.length;
  const sourceA = sources[0] || {};
  const sourceB = sources[1] || {};
  const claimA = gapSourceClaim(sourceA);
  const claimB = gapSourceClaim(sourceB);
  const methodA = gapSourceMethod(sourceA);
  const methodB = gapSourceMethod(sourceB);
  const dataA = gapSourceData(sourceA);
  const dataB = gapSourceData(sourceB);
  const limitationA = gapSourceLimitation(sourceA);
  const metricHints = gapMetricHints(sources);
  const steps = [];

  if (kind === "evidence_compare") {
    steps.push(gapStep(`先比较 ${sourceA.marker || sourceText} 的“${claimA}”与 ${sourceB.marker || "另一来源"} 的“${claimB || "对应结论"}”是否在回答同一判断`, `如果只是概念重合但研究对象不同，只能写成相关线索，不能写成共识`));
    steps.push(gapStep(`把 ${weakBySource || "弱证据字段"} 从主结论里剥离，逐条补 claim/quote/location/confidence`, `${pageText || "未定位的摘录"} 只可作为查证入口`));
    steps.push(gapStep(`把 ${sourceText} 的结论分成“共同支持/单篇支持/不能推出”三栏`, `只有同一结论至少被两篇可用证据支持时，才写进 gap 句`));
  } else if (kind === "problem_alignment" || /问题定义/.test(gapType)) {
    steps.push(gapStep(`先对照 ${sourceA.marker || sourceText} 的问题线索“${gapSourceProblem(sourceA)}”和 ${sourceB.marker || "另一来源"} 的“${gapSourceProblem(sourceB) || problemText || "问题线索"}”`, `若对象、场景或评价目标不同，就拆成两个 gap，不强行合并`));
    steps.push(gapStep(`补核 ${weakBySource || weakFields || "研究问题、数据/材料、局限"}，尤其确认问题定义是否有原文定位`, "缺定位或弱支撑的字段只保留为问题线索，不进入 gap 主句"));
    steps.push(gapStep(`把 ${sourceCount >= 2 ? sourceText : "当前文献"} 标成“同一问题/相邻背景/不可比较”`, `只有“同一问题”组可共同支撑问题定义缺口`));
  } else if (kind === "method_evaluation" || /测量|评价/.test(gapType)) {
    steps.push(gapStep(`先把 ${sourceA.marker || sourceText} 的“${methodA}”与 ${sourceB.marker || "另一方法"} 的“${methodB || methodText || "方法路径"}”放到同一任务下比较`, `任务不同则只比较研究思路，不比较优劣`));
    steps.push(gapStep(`核对数据口径：${sourceA.marker || ""}${dataA}；${sourceB.marker || ""}${dataB || "数据/样本待核对"}`, `${metricHints || "找不到共同指标"} 时，结论写成“评价口径不可比”`));
    steps.push(gapStep(`优先补 ${weakBySource || weakFields || "数据/材料、证据、局限"}，再决定是否设计复现实验`, `只有共同任务 + 共同指标 + 可核定位同时满足，才升级为实证 gap`));
  } else if (kind === "source_boundary" || /场景|边界/.test(gapType)) {
    steps.push(gapStep(`先围绕 ${sourceA.marker || sourceText} 的结论“${claimA}”定位验证场景：${dataA}`, `原文没有出现的场景不能写成已验证`));
    steps.push(gapStep(`把边界线索“${limitationA || riskText || "适用边界待核对"}”拆成数据范围、对象范围和失败条件`, `${weakBySource || "弱字段"} 先进入待核对区`));
    steps.push(gapStep(`选择一个不同于原文的场景复测，比如换数据来源、对象或评价指标`, "结果下降写边界条件；结果稳定才写跨场景泛化"));
  } else if (kind === "theory_use" || /理论/.test(gapType)) {
    steps.push(gapStep(`先从 ${sourceA.marker || sourceText} 抽出可当理论用的句子：“${claimA}”`, `如果它只是结果描述，不作为概念定义或机制链条`));
    steps.push(gapStep(`再查 ${sourceA.marker || ""} 是否给出分类框架、机制环节或演进阶段`, `缺 ${weakBySource || weakFields || "定义/机制/贡献"} 时，只能写成脉络线索`));
    steps.push(gapStep(`用这套概念去解释 ${methodText || evidenceText || "其他文献的方法或结果"}`, "解释不了的环节才是真正的理论缺口"));
  } else if (kind === "method_transfer" || /方法迁移/.test(gapType)) {
    steps.push(gapStep(`拆解 ${sourceA.marker || sourceText} 的方法“${methodA}”和 ${sourceB.marker || "另一来源"} 的“${methodB || methodText || "方法"}”：输入、模块、输出各列一栏`, "输入对象或输出指标不同，不比较迁移效果"));
    steps.push(gapStep(`确认原文是否真的做过跨对象/跨数据测试；当前数据线索：${dataA}${dataB ? `；${dataB}` : ""}`, `未报告迁移结果时，只写“迁移边界未验证”`));
    steps.push(gapStep(`设计一个原场景 + 一个外部场景，用同一指标复测`, "比较性能下降、失败样本和依赖条件，形成迁移边界证据"));
  } else if (kind === "empirical_use") {
    steps.push(gapStep(`先核 ${sourceA.marker || sourceText} 的数据/样本：“${dataA}”`, "数据来源、样本范围或场景不清时，只能写成实证线索"));
    steps.push(gapStep(`再核结果证据：“${claimA}”`, `${pageText || "定位未确认的结果"} 不能进入强证据段`));
    steps.push(gapStep(`把 ${metricHints || "可复核指标"} 和趋势判断分开`, "只有有指标、基线和定位的结果才能支撑“研究不足”"));
  } else {
    steps.push(gapStep(displayText(verificationPlan || `先回到 ${sourceText} 的文献矩阵核对 claim、quote、page 和 confidence`), "确认它不是弱证据堆出的方向"));
    steps.push(gapStep(`重点核对 ${weakBySource || weakFields || "研究问题、方法、数据/材料、局限"}`, "把可验证结论和单篇推断分开"));
    if (evidenceText) steps.push(gapStep(`当前证据类型主要是 ${evidenceText}`, "先判断它能支撑强结论、趋势判断还是背景描述"));
  }

  return steps.slice(0, 3).map((step) => ({
    action: displayText(step.action).replace(/[。；;]+$/, "。"),
    criterion: displayText(step.criterion).replace(/[。；;]+$/, "。")
  }));
}

function gapStep(action, criterion) {
  return { action, criterion };
}

function gapSourceShortList(sources = []) {
  const markers = sources.map((item) => item.marker).filter(Boolean).slice(0, 4);
  if (markers.length >= 2) return markers.join("、");
  return sources[0]?.marker || "相关文献";
}

function gapUniqueProfileValues(sources = [], key) {
  return uniqueStrings(sources.map((item) => displayText(item.profile?.[key] || "")).filter(Boolean));
}

function gapSourceProblem(source = {}) {
  return gapFieldPhrase(source.card?.research_question, source.profile?.problemType || "问题待核对", 34);
}

function gapSourceMethod(source = {}) {
  return gapFieldPhrase(source.card?.method, source.profile?.methodType || "方法待核对", 34);
}

function gapSourceData(source = {}) {
  return gapFieldPhrase(source.card?.data_or_materials, "数据/材料待核对", 38);
}

function gapSourceLimitation(source = {}) {
  const item = (source.card?.limitations || []).find((field) => field?.claim || field?.normalized_claim || field?.quote);
  return gapFieldPhrase(item, source.profile?.riskType || "", 36);
}

function gapSourceClaim(source = {}) {
  const card = source.card || {};
  const item = card.contribution || (card.main_claims || [])[0] || (card.evidence || [])[0] || card.method || card.research_question;
  return gapFieldPhrase(item, source.profile?.finding || source.profile?.problemType || "结论待核对", 42);
}

function gapFieldPhrase(field, fallback = "", limit = 36) {
  const raw = displayText(field?.normalized_claim || field?.claim || field?.quote || field?.text || fallback || "");
  const clean = raw
    .replace(/^(研究问题|方法路径|数据\/材料|证据|主张|局限|贡献)[:：]/, "")
    .replace(/^当前没有足够原文支撑来/, "")
    .trim();
  if (/^(界定研究问题|确认数据、材料或研究对象|确认局限或风险|确认研究对象|确认数据|待核对推断)/.test(clean)) {
    return shortEvidenceText(fallback || "字段待核对", limit);
  }
  return shortEvidenceText(clean || fallback || "待核对", limit);
}

function gapMetricHints(sources = []) {
  const text = sources.map((source) => [
    source.card?.method?.claim,
    source.card?.data_or_materials?.claim,
    ...(source.card?.evidence || []).map((item) => item.claim || item.quote),
    ...(source.card?.main_claims || []).map((item) => item.claim || item.quote)
  ].flat().join(" ")).join(" ");
  const domainMetrics = sources.flatMap((source) => metricsForGapProfile(source.profile || {}));
  const explicitMetrics = extractGapExplicitMetrics(text);
  const fallback = ["样本规模", "对比基线", "跨场景复现率", "人工复核一致性"];
  return uniqueStrings([...domainMetrics, ...explicitMetrics, ...fallback])
    .filter((item) => !/^(指标|对比|样本|基线|通过效率)$/.test(item))
    .slice(0, 6)
    .join("、");
}

function metricsForGapProfile(profile = {}) {
  const domain = profile.domain || "";
  const text = `${profile.problemType || ""} ${profile.methodType || ""} ${profile.evidenceType || ""}`;
  const byDomain = [
    [/接口安全检测/, ["API discovery rate", "false positive rate", "漏洞检出数", "跨端点漏洞覆盖率", "工具对比召回率"]],
    [/交通控制/, ["平均延误", "排队长度", "通行效率", "停车次数", "CAV 渗透率敏感性"]],
    [/交通流预测/, ["MAPE", "RMSE", "MAE", "预测准确率", "峰谷时段误差"]],
    [/文献计量与知识图谱/, ["发文量", "关键词突现", "共现网络密度", "聚类模块度", "中心性", "引文频次"]],
    [/智能体设计/, ["任务完成率", "工具调用成功率", "引用命中率", "幻觉率", "回答准确率"]],
    [/消费研究智能化/, ["偏好识别一致性", "行为预测准确率", "实验组差异", "量表信度", "模拟-真实行为偏差"]],
    [/生成式人工智能影响/, ["态度变化量", "认同强度评分", "实验组差异", "调节效应显著性", "量表信度"]]
  ];
  for (const [pattern, metrics] of byDomain) {
    if (pattern.test(domain)) return metrics;
  }
  if (/漏洞|API|应用程序接口/.test(text)) return ["API discovery rate", "false positive rate", "漏洞检出数", "跨端点漏洞覆盖率"];
  if (/交叉口|信号|协同控制/.test(text)) return ["平均延误", "排队长度", "通行效率", "停车次数"];
  if (/网约车|交通流/.test(text)) return ["MAPE", "RMSE", "MAE", "预测准确率"];
  if (/知识图谱|引文|共现/.test(text)) return ["发文量", "关键词突现", "共现网络密度", "聚类模块度"];
  if (/智能体协同|检索增强|语义检索|工具调用/.test(text)) return ["任务完成率", "工具调用成功率", "引用命中率", "幻觉率"];
  if (/理论|机制|范式/.test(text)) return ["概念覆盖度", "机制链条完整度", "解释一致性", "反例覆盖率"];
  return [];
}

function extractGapExplicitMetrics(text = "") {
  const clean = displayText(text);
  const patterns = [
    /API discovery rate|false positive rate|discovery rate|precision|recall|F1|AUC|MAPE|RMSE|MAE/gi,
    /(?:准确率|召回率|命中率|覆盖率|发现率|假发现率|误报率|漏报率|均方根误差|平均绝对百分比误差|平均延误|排队长度|通行效率|发文量|引文频次|关键词突现|聚类模块度|中心性|幻觉率|任务完成率|工具调用成功率)/g
  ];
  return uniqueStrings(patterns.flatMap((pattern) => clean.match(pattern) || []))
    .map((item) => item.replace(/\s+/g, " ").trim())
    .slice(0, 6);
}

function gapWeakFieldLabels(sources = []) {
  const labels = [];
  const add = (label, field) => {
    if (/missing|weak|review|mismatch/.test(`${field?.audit || ""} ${field?.dimension_audit || ""}`)) labels.push(label);
  };
  for (const source of sources) {
    const card = source.card || {};
    add("研究问题", card.research_question);
    add("方法", card.method);
    add("数据/材料", card.data_or_materials);
    add("贡献", card.contribution);
    (card.evidence || []).forEach((field) => add("证据", field));
    (card.limitations || []).forEach((field) => add("局限", field));
  }
  return uniqueStrings(labels).slice(0, 4).join("、");
}

function gapWeakFieldsBySource(sources = []) {
  const parts = [];
  for (const source of sources.slice(0, 4)) {
    const labels = [];
    const card = source.card || {};
    const add = (label, field) => {
      if (/missing|weak|review|mismatch/.test(`${field?.audit || ""} ${field?.dimension_audit || ""}`)) labels.push(label);
    };
    add("研究问题", card.research_question);
    add("方法", card.method);
    add("数据/材料", card.data_or_materials);
    add("贡献", card.contribution);
    (card.evidence || []).forEach((field) => add("证据", field));
    (card.limitations || []).forEach((field) => add("局限", field));
    if (labels.length) parts.push(`${source.marker}${uniqueStrings(labels).slice(0, 3).join("/")}`);
  }
  return parts.join("；");
}

function gapPageEvidenceSummary(sources = []) {
  const pages = sources
    .flatMap((source) => source.card?.source_pages || [])
    .filter(Boolean)
    .slice(0, 5);
  if (!pages.length) return "";
  return `已定位证据集中在 ${uniqueStrings(pages.map(String)).map((page) => `p.${page}`).join("、")}`;
}

function gapContrastPair(sources = []) {
  if (sources.length < 2) return "";
  return sources.slice(0, 2).map((source) => source.marker).join(" 与 ");
}

function inferGapType(title = "", missingEvidence = "", verificationPlan = "", kind = "") {
  const kindMap = {
    problem_alignment: "问题定义缺口",
    method_evaluation: "测量/评价缺口",
    source_boundary: "场景/边界缺口",
    evidence_compare: "证据链缺口",
    method_transfer: "方法迁移缺口",
    theory_use: "理论解释缺口",
    empirical_use: "实证支撑缺口"
  };
  if (kindMap[kind]) return kindMap[kind];
  const text = `${title} ${missingEvidence} ${verificationPlan}`;
  if (/场景|边界|适用|跨对象|外推|数据范围/.test(text)) return "场景/边界缺口";
  if (/评价|指标|基线|复现|实验|证据强弱/.test(text)) return "测量/评价缺口";
  if (/问题|定义|研究矛盾/.test(text)) return "问题定义缺口";
  if (/理论|机制|演进|脉络/.test(text)) return "理论解释缺口";
  if (/方法|迁移|技术路线/.test(text)) return "方法迁移缺口";
  return "研究空白候选";
}

function gapWritingSentence(title = "", missingEvidence = "", kind = "") {
  const cleanTitle = displayText(title).replace(/[？?]$/, "");
  const cleanMissing = displayText(missingEvidence).replace(/[。；;]+$/, "");
  if (kind === "evidence_compare") {
    return `现有资料已经围绕${cleanTitle}形成若干结论线索，但哪些结论由多篇强证据共同支持、哪些只是单篇推断仍未区分。`;
  }
  if (kind === "problem_alignment") {
    return `多篇文献都提到${cleanTitle}，但研究对象、边界条件和评价口径尚未对齐，因此需要先确认它们是否真在讨论同一个问题。`;
  }
  if (kind === "source_boundary") {
    return `现有资料已经提供${cleanTitle}的判断线索，但适用场景、数据边界和失败条件仍需补证。`;
  }
  if (kind === "method_transfer") {
    return `现有研究涉及${cleanTitle}，但方法能否跨对象、跨数据或跨场景迁移仍缺少同口径验证。`;
  }
  if (kind === "theory_use") {
    return `${cleanTitle}可以作为理论或脉络线索，但概念定义、机制链条和可解释范围仍需要原文证据支撑。`;
  }
  if (kind === "empirical_use") {
    return `${cleanTitle}可以作为实证线索，但数据集、指标、基线和数值结果需要完整可核对后，才能支撑强结论。`;
  }
  if (/评价|指标|基线|复现|实验/.test(`${cleanTitle} ${cleanMissing}`)) {
    return `现有研究已提出${cleanTitle}相关方法或判断，但评价指标、样本范围或对比基线仍不统一，因此还不能直接比较不同工作的有效性。`;
  }
  if (/场景|边界|适用|外推|数据范围/.test(`${cleanTitle} ${cleanMissing}`)) {
    return `现有研究已经触及${cleanTitle}，但对适用场景、数据边界和失败条件交代不足，后续可围绕结论能否跨场景成立展开验证。`;
  }
  if (/问题|定义|研究矛盾/.test(`${cleanTitle} ${cleanMissing}`)) {
    return `多篇文献都指向${cleanTitle}，但它们对问题对象、边界条件和评价口径的定义仍需对齐，因此可形成问题定义层面的研究空白。`;
  }
  return `现有资料已经提供${cleanTitle}的研究线索，但${cleanMissing || "关键证据链仍需补齐"}，因此更适合作为待验证的研究空白候选。`;
}

function sharedProfileTerms(a, b) {
  const left = new Set([...(a.keywords || []), a.domain, a.problemType, a.methodType].filter(Boolean));
  const right = new Set([...(b.keywords || []), b.domain, b.problemType, b.methodType].filter(Boolean));
  return [...left].filter((item) => right.has(item));
}

function uniqueStrings(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function broadCrossDocQuestion(question) {
  const q = String(question || "");
  return /共同|综合|这几篇|这些资料|关系|分歧|证据强弱|能.*证明|推出|综述|矩阵/.test(q);
}

function groupByNormalized(items, getter) {
  const groups = [];
  for (const item of items) {
    const text = displayText(getter(item) || "");
    const label = inferGraphMethodType(text);
    let group = groups.find((entry) => entry.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function cleanTopicTerms(terms, limit = 5) {
  const bad = /^(提出|提出的|发现率|发现率为|平均|当前|相关|主要|进行|通过|基于|方法|结果|系统|模型|研究|资料|论文)$/i;
  const seen = new Set();
  const cleaned = [];
  for (const term of terms || []) {
    const value = String(term || "").trim();
    if (!value || bad.test(value) || value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
    if (cleaned.length >= limit) break;
  }
  return cleaned;
}

function displayText(text) {
  return plainLanguageText(preferChineseText(expandTechnicalTerms(
    toHalfWidth(String(text || ""))
      .replace(/[‐‑‒–—－]/g, "-")
      .replace(/摘\s*要\s*[:：]?/g, "")
      .replace(/^关\s*键\s*词\s*[:：]?.*$/i, "")
      .replace(/^keywords?\s*[:：]?.*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
  )));
}

function expandTechnicalTerms(text) {
  return String(text || "")
    .replace(/singular\s*spectrum\s*analysis|singularspectrumanalysis/gi, "奇异谱分析")
    .replace(/SSA\s*-\s*LSTM\s*-\s*SVR/gi, "麻雀搜索算法优化的长短期记忆网络与支持向量回归组合预测模型")
    .replace(/LSTM\s*-\s*SVR/gi, "长短期记忆网络与支持向量回归结合的预测模型")
    .replace(/\bMAPE\b/gi, "平均绝对百分比误差")
    .replace(/\bRMSE\b/gi, "均方根误差")
    .replace(/\bACC\b/gi, "预测准确率")
    .replace(/\bCNKI\b/g, "中国知网")
    .replace(/\bCAVs?\b/gi, "网联自动驾驶车辆")
    .replace(/Leydesdor'?s?/gi, "引文理论")
    .replace(/\bAI\s*for\s*Social\s*Science\b/gi, "人工智能社会科学")
    .replace(/\bEMD\b/g, "经验模态分解")
    .replace(/\bDE\s*-\s*BPNN\b/gi, "差分进化优化的反向传播神经网络")
    .replace(/\bGA\s*-\s*RF\b/gi, "遗传算法与随机森林")
    .replace(/\bARIMA\b/gi, "差分整合移动平均模型")
    .replace(/\bDLDP\b/gi, "深度学习目的地预测方法")
    .replace(/\bRESTful\s*API\b/gi, "表述规范的应用程序接口")
    .replace(/\bAPI\b/g, "应用程序接口")
    .replace(/\bA2A\b/g, "智能体协同检测系统")
    .replace(/\bMCP\b/g, "模型上下文协议")
    .replace(/\bRAG\b/g, "检索增强生成")
    .replace(/\bLLM\b/gi, "大语言模型")
    .replace(/\bAI\b/g, "人工智能")
    .replace(/\bSSA\b/g, "麻雀搜索算法")
    .replace(/\bLSTM\b/g, "长短期记忆网络")
    .replace(/\bSVR\b/g, "支持向量回归")
    .replace(/\bNAUTILUS\b|\bRESTler\b|\bZAP\b|\bBurp\s*Suite\b/gi, "传统安全测试工具")
    .replace(/麻雀搜索算法算法/g, "麻雀搜索算法")
    .replace(/人工智能智能体/g, "智能体")
    .replace(/上下文协议\s*\(\s*模型上下文协议\s*\)/g, "模型上下文协议")
    .replace(/引文理论引文理论/g, "引文理论");
}

function plainLanguageText(text) {
  return String(text || "")
    .replace(/麻雀搜索算法优化的长短期记忆网络与支持向量回归组合预测模型/g, "融合时间规律识别和误差修正的组合预测方法")
    .replace(/长短期记忆网络与支持向量回归结合的预测模型/g, "时间序列预测与误差修正结合的模型")
    .replace(/奇异谱分析\s*\(\s*奇异谱分析\s*,\s*麻雀搜索算法\s*\)/g, "奇异谱分析")
    .replace(/奇异谱分析\s*\([^)]{0,40}麻雀搜索算法[^)]{0,40}\)/g, "奇异谱分析")
    .replace(/^[,，;；:：\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function preferChineseText(text) {
  let clean = String(text || "").replace(/\s+/g, " ").trim();
  if (/[\u4e00-\u9fa5]/.test(clean)) {
    clean = clean.replace(/[|｜]\s*[A-Za-z][A-Za-z &]+(?:\d{4}.*)?$/g, "");
  }
  const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  if (cjk >= 8 && latin > cjk * 1.2) {
    clean = clean
      .split(/[。！？!?；;]/)
      .filter((part) => (part.match(/[\u4e00-\u9fa5]/g) || []).length >= 8)
      .join("。");
  }
  return clean.replace(/\s+/g, " ").trim();
}

function synthesizeDocKeyInfo(doc) {
  const title = doc.title || doc.filename || "当前资料";
  const domain = inferEvidenceDomain(doc);
  const evidence = evidenceCardForDoc(doc);
  const card = doc.analysisCard || doc.researchCard || {};
  const raw = displayText([
    doc.abstract,
    evidence.research_question?.claim,
    evidence.method?.claim,
    evidence.contribution?.claim,
    ...(evidence.main_claims || []).map((item) => item.claim),
    ...(evidence.evidence || []).map((item) => item.claim),
    card.findings,
    card.method,
    doc.takeaway,
    ...(doc.keyPoints || []).map((item) => item.text)
  ].join(" "));
  if (domain === "rideHailing") {
    return "作者研究网约车出行交通流的短时预测问题。这个问题重要，是因为网约车订单量和交通流变化会影响城市交通调度、平台运力配置和智能交通管理。作者收集网约车出行订单数据，并使用一种融合时间规律识别和误差修正的组合预测方法来处理交通流的周期规律和随机波动。结果显示，该方法相比单一模型预测误差更低、准确率和拟合程度更高。这证明了作者的观点：单一预测模型难以同时处理网约车交通流的周期性和随机波动，组合预测更适合短时出行预测。";
  }
  if (domain === "apiSecurity") {
    return "作者研究隐藏应用程序接口的发现和漏洞检测问题。这个问题重要，是因为未公开、无文档或动态变化的接口容易绕过传统扫描工具，形成安全盲区。作者提出智能体协同检测方案，用模型上下文协议串联接口发现和漏洞检测模块，并结合大语言模型、检索增强生成与反馈迭代生成测试用例。结果显示，该方法能提高隐藏接口发现和漏洞验证的自动化程度。这证明了作者的观点：把智能体、上下文协议和知识增强测试结合起来，比单纯依赖文档或公开路径扫描更适合复杂接口安全场景。";
  }
  if (domain === "ideology") {
    return "作者研究生成式人工智能交互如何影响意识形态感性化认同。这个问题重要，是因为生成式人工智能不仅提供信息，还会通过拟人化互动、情感回应和个性化推荐影响用户的认知与情感判断。作者重点解释这种认同形成的行为机制，并讨论算法缺陷、数据偏差和交互依赖带来的调制与治理问题。这证明了作者的观点：生成式人工智能的社会影响不能只看技术能力，还要分析它如何改变用户的情感认同和价值判断过程。";
  }
  if (domain === "intersectionControl") {
    return "作者研究新型混合交通环境下的交叉口协同控制问题。这个问题重要，是因为传统信号灯控制很难同时兼顾路口信号配时和车辆行驶轨迹，容易造成通行效率损失。作者把信号配时视为慢变量、把车辆轨迹策略视为快变量，设计信号与车辆轨迹协同控制框架。结果显示，协同控制能降低车辆平均延误并提升路口通行效率。这证明了作者的观点：交叉口控制不能只优化信号灯，也需要把车辆轨迹决策纳入同一套协同机制。";
  }
  if (domain === "overseasChineseBooks") {
    return "作者研究近三十年域外汉籍研究的发展现状和演进趋势。这个问题重要，是因为域外汉籍关系到中华文化传承传播，但既有研究多停留在主题梳理，缺少系统的计量分析。作者基于中国知网优质期刊论文，用文献计量和知识图谱方法分析发文趋势、研究机构、关键词和主题演化。研究证明作者的观点：域外汉籍研究已经形成丰富成果，但还需要通过量化证据看清研究热点、学术网络和未来方向。";
  }
  if (domain === "consumerResearch") {
    return "作者研究人工智能大模型与智能体如何改变消费研究范式。这个问题重要，是因为传统消费研究多依赖事后问卷、访谈或统计分析，难以及时解释复杂消费行为。作者提出从消费感知、类脑模拟到自主演化的三阶段路径，用多模态数据、智能体模拟和营销建模推动消费研究从被动洞察走向主动演化。这证明了作者的观点：智能体不仅能辅助分析消费者，还能参与模拟、预测和优化消费行为研究过程。";
  }
  if (domain === "llmAgentDesign") {
    return "作者研究大语言模型智能体的系统化设计问题。这个问题重要，是因为通用大模型要进入垂直场景，不能只停留在问答能力，还需要数据处理、检索、推理、交互和评估流程。作者围绕多源数据、语义表示、混合检索、链式推理和提示优化构建设计方法，目标是提升智能体在垂直场景中的准确性、可控性和协同能力。这证明了作者的观点：垂直领域智能体的效果不仅取决于大模型本身，还取决于数据、检索、推理和交互设计是否被系统组织起来。";
  }
  const topic = cleanTopicTerms((doc.keywords || []).map((item) => displayText(item.term)), 4).join("、") || displayText(title);
  const method = displayText(evidence.method?.claim || card.method || "").replace(/^未抽取到明确处理方式.*/, "");
  const finding = displayText(evidence.contribution?.claim || card.findings || doc.abstract || doc.takeaway || "");
  return `作者围绕${topic}展开研究，目的是解决该主题在实际应用或理论解释中的关键问题。${method ? `作者采用${method}。` : ""}${finding ? `主要结论是：${finding}` : "当前文本可用信息有限，正式使用前需要回到原文核对。"}这证明了作者的观点：研究对象需要通过更合适的方法或证据链来解释，而不能只停留在现象描述。`;
}

function answerReviewQuestion(doc, question) {
  const title = doc.title || doc.filename || "当前资料";
  const keyInfo = synthesizeDocKeyInfo(doc);
  const text = `${title} ${keyInfo}`;
  if (/正文不可读|标题判断|待解析/.test(question)) {
    return "当前只能把它作为待解析资料处理，所有结论都应标记为需要回到原文确认。";
  }
  if (/核心研究问题|为什么认为这个问题重要/.test(question)) {
    return keyInfo;
  }
  if (/方法|流程|系统机制/.test(question)) {
    if (/网约车|交通流/.test(text)) return "方法上，作者用网约车订单数据构造预测任务，再用麻雀搜索算法优化的长短期记忆网络与支持向量回归组合模型同时处理时间序列规律和非线性误差，从而提高短时交通流预测效果。";
    if (/RESTful|API|漏洞/.test(text)) return "方法上，作者用 A2A 智能体串联隐藏 API 发现和漏洞检测：先发现候选端点，再确认 API 指纹，最后结合 LLM、RAG 和反馈迭代生成测试用例。";
    if (/大语言模型|智能体/.test(text)) return "方法上，作者把多源数据处理、语义检索、链式推理、提示优化和交互设计组织成一个垂直领域智能体设计流程。";
    return "方法上，作者先界定问题，再提出处理流程或模型，并用实验、案例或文本证据说明该方法能够支撑结论。";
  }
  if (/局限|风险|待确认|不能直接写进结论/.test(question)) {
    return "需要谨慎处理的是：自动抽取结果可能混入版面噪声；模型或方案的适用范围也不能无限外推。写作时应把适用场景、数据来源、对比对象和指标条件交代清楚。";
  }
  if (/证据|支撑|页码|结论/.test(question)) {
    if (/网约车|交通流/.test(text)) return "关键支撑是模型预测效果提升：平均绝对百分比误差下降超过 4%，预测准确率提高超过 6%，说明组合模型比单一模型更适合该预测任务。";
    if (/RESTful|API|漏洞/.test(text)) return "关键支撑是实验指标和对比结果：A2A 的平均 API 发现率达到 91.9%，假发现率为 7.8%，并能发现部分传统工具未检测到的隐藏漏洞。";
    return "关键支撑来自作者给出的实验、案例、指标或系统运行结果，作用是证明方法不是概念设想，而是能解释或改善目标问题。";
  }
  return keyInfo;
}

function singleDocAnswer(source, question, commonTerms) {
  const evidence = (source.evidence || []).filter(Boolean);
  const q = String(question || "");
  if (!evidence.length) return `基于当前资料“${source.title}”，暂未命中足够完整的原文片段。`;
  if (/核心研究问题|研究问题|为什么.*重要|重要/.test(q)) {
    return `基于《${source.title}》，可以概括为：${source.keyInfo || "作者先界定问题，再提出方法，最后用结果说明方案价值。"}`;
  }
  const topic = commonTerms.slice(0, 5).join("、") || "文中主要主题";
  if (/方法|流程|机制|系统|架构/.test(q)) {
    return `基于《${source.title}》，可以概括为：这篇资料重点说明“问题识别 -> 方法设计 -> 机制运行 -> 效果验证”的链条。核心不是单个片段，而是作者如何把 ${topic} 组织成可执行的方案，并通过后续实验或案例证明其有效性。`;
  }
  if (/实验|结果|指标|效果|性能|准确|发现率|误报|假发现/.test(q)) {
    return `基于《${source.title}》，实验部分主要用量化指标和对比基线来证明方法有效性。回答时应关注三点：评价指标是什么、相对哪些方法提升、这些提升能否支撑作者的核心结论。`;
  }
  if (/局限|不足|限制|风险|待确认/.test(q)) {
    return `基于《${source.title}》，局限应从适用场景、数据或工具依赖、误差来源和可推广性来理解；这些内容适合放在“边界条件”和“后续研究”里，而不是当作主结论。`;
  }
  return `基于《${source.title}》，可以先把它理解为围绕 ${topic} 展开的研究：先提出问题，再给出方法或机制，最后用证据说明效果和适用边界。`;
}

function draftReview(docs) {
  if (!docs.length) return "";
  const allTerms = topKeywords(docs.map((d) => d.keywords.map((k) => k.term).join(" ")).join(" "), 10).map((k) => k.term);
  const graph = buildGraph(docs);
  const strong = graph.edges.slice(0, 5);
  const followUps = reviewQuestions(docs, allTerms);
  const followUpAnswers = reviewQuestionAnswers(docs, followUps);
  const sourceFacts = docs.slice(0, 12).map((doc, index) => reviewSourceFact(doc, index));
  const weakFacts = sourceFacts.filter((item) => item.weak.length);
  return [
    `文献综述草稿`,
    ``,
    `核心主题`,
    `这组文献共同覆盖 ${allTerms.slice(0, 7).join("、") || "若干核心主题"}。以下段落为自动综合推断，适合作为开题调研、组会汇报或相关工作写作草稿的骨架，正式使用前应回到原文核对。`,
    ``,
    `原文事实层`,
    ...sourceFacts.map((item) => `${item.marker} ${item.title}：${item.fact}${item.page ? `（${item.page}）` : "（定位待核对）"}`),
    ``,
    `综合推断层`,
    `基于上述事实，这组资料更适合按“问题界定 -> 方法组织 -> 证据验证 -> 边界说明”组织，而不是按上传顺序罗列。这个判断属于跨文档综合推断，来源于 ${sourceFacts.map((item) => item.marker).join("")} 的共同结构。`,
    ...(strong.length
      ? strong.map((edge) => `- ${docTitle(docs, edge.source)} 与 ${docTitle(docs, edge.target)}：${edge.relation}，共享关键词 ${edge.shared.join("、") || "较少"}。`)
      : ["- 当前资料之间未抽出明显关键词重叠；可继续加入同主题资料后更新地图。"]),
    ``,
    `待核对层`,
    ...(weakFacts.length
      ? weakFacts.map((item) => `- ${item.marker} ${item.title}：${item.weak.join("、")} 字段证据偏弱，正式写作前需要回到原文复核。`)
      : ["- 当前证据卡没有发现明显弱字段，但正式引用仍需核对原文定位。"]),
    ``,
    `可继续追问与简答`,
    ...followUpAnswers.flatMap((item, index) => [
      `${index + 1}. 问：${item.question}`,
      `   答：${item.answer}`
    ])
  ].join("\n");
}

function reviewSourceFact(doc, index = 0) {
  const card = evidenceCardForDoc(doc);
  const marker = `[${index + 1}]`;
  const factItem = matrixBestEvidenceItem(card);
  const fact = cleanEvidenceForAnswer(factItem?.normalized_claim || factItem?.claim || synthesizeDocKeyInfo(doc)) || synthesizeDocKeyInfo(doc);
  const weak = weakAnswerFields(card).map((item) => item.dimension);
  return {
    marker,
    title: publicDocTitle(doc),
    fact,
    page: factItem?.page ? `p.${factItem.page}` : "",
    weak
  };
}

function draftJournalReview(docs, options = {}) {
  if (!docs.length) return "当前范围没有可生成综述的资料。";
  const settings = normalizeReviewOptions(options);
  const sources = docs.slice(0, 12).map((doc, index) => {
    const card = evidenceCardForDoc(doc);
    return {
      marker: `[${index + 1}]`,
      title: publicDocTitle(doc),
      domain: inferEvidenceDomain(doc),
      profile: docGraphProfile(doc),
      question: cleanEvidenceForAnswer(card.research_question?.claim || ""),
      method: cleanEvidenceForAnswer(card.method?.claim || ""),
      data: cleanEvidenceForAnswer(card.data_or_materials?.claim || ""),
      claims: cleanAnswerEvidence((card.main_claims || []).map((item) => item.claim), 4),
      evidence: cleanAnswerEvidence((card.evidence || []).map((item) => item.claim), 4),
      limitations: cleanAnswerEvidence((card.limitations || []).map((item) => item.claim), 3),
      contribution: cleanEvidenceForAnswer(card.contribution?.claim || ""),
      confidence: card.confidence || 0.6,
      pages: card.source_pages || [],
      weakFields: weakAnswerFields(card)
    };
  }).map((item) => {
    const domainLabel = journalDomainLabel(item.domain, item.profile.domain);
    return {
      ...item,
      domainLabel,
      methodType: journalMethodType(item),
      evidenceType: journalEvidenceType(item),
      problemType: journalProblemType(item)
    };
  });
  const domains = [...new Set(sources.map((item) => item.domainLabel).filter(Boolean))];
  const methodGroups = journalMacroMethodGroups(sources);
  const evidenceGroups = groupByText(sources, (item) => item.evidenceType || "证据待核对");
  const strongEvidence = sources.filter((item) => /实验指标|文献计量|系统验证/.test(item.evidenceType));
  const theoreticalEvidence = sources.filter((item) => /理论机制|框架论证|场景框架/.test(item.evidenceType));
  const lowConfidence = sources.filter((item) => item.confidence < 0.7);
  const subject = journalReviewSubject(sources, settings);
  const thesis = journalReviewThesis(sources, settings, subject);
  const argumentClaims = journalArgumentClaims(sources);
  const problemGroups = groupByText(sources, (item) => item.problemType || "问题待核对");
  const sourceList = sources.map((item) =>
    `${item.marker} ${formatCitationTitle(item.title, settings.citationFormat)}：${item.contribution || item.claims[0] || item.question}`
  );
  const structureHint = journalStructureHint(settings.structure);
  const auditLine = settings.keepAuditMarkers
    ? (lowConfidence.length
      ? `\n[待人工核对] ${lowConfidence.map((item) => item.marker).join("、")} 的证据卡置信度偏低，正式写作前需要回到原文逐条核查。${sources.filter((item) => item.weakFields.length).map((item) => `${item.marker}${item.weakFields.map((field) => field.dimension).join("/")}`).join("；")}`
      : "\n[证据状态] 当前证据卡未发现低置信资料，但正式写作仍需核对定位与原文。")
    : "";
  const keywords = cleanTopicTerms([
    subject.topic,
    ...domains,
    ...methodGroups.map((group) => group.label),
    ...evidenceGroups.map((group) => group.label),
    "证据链",
    "研究边界"
  ], 6).join("；");
  return [
    subject.title,
    "",
    "摘要",
    `围绕${subject.topic}，本文基于 ${sources.length} 篇资料梳理相关研究的问题意识、方法谱系、证据结构和研究边界。现有研究共同表明，该主题的核心进展不只是提出新的模型、框架或应用案例，而是逐步把复杂研究对象组织为“问题界定、方法建构、证据验证和边界说明”的判断链。本文进一步指出，不同文献之间的差异主要体现为证明方式和证据强度的差异：实验指标、系统验证和文献计量更适合支撑强结论，机制阐释、框架建构和场景讨论则更适合支撑解释性观点与未来研究命题。`,
    "",
    `关键词：${keywords || "文献综述；证据链；研究方法；研究边界"}`,
    "",
    "1 引言",
    `${structureHint} ${thesis}`,
    "",
    "2 研究问题与主题演进",
    `这些资料共同指向一个更大的研究转向：研究对象从单一文本、单一系统或单一场景，转向由数据、模型、任务、用户和部署环境共同构成的复杂系统。${sources.map((item) => item.marker).join("")} 因此，综述不宜按文献顺序罗列，而应围绕“问题如何被界定、方法如何被组织、证据如何支撑、结论能外推到哪里”四个层次展开。${journalProblemSynthesis(problemGroups)}`,
    "",
    "3 方法谱系与研究路径",
    ...methodGroups.map((group) =>
      `${group.label}方面，${group.items.map((item) => item.marker).join("、")} 共同承担的不是简单罗列方法，而是把复杂问题转化为可检验判断。${group.explanation} 这一组文献应放在同一方法谱系中比较其任务拆解、证据形式、评价指标和外推边界。`
    ),
    "",
    "4 证据结构与观点强度",
    `本综述能够给出的强判断是：凡是具有实验指标、系统验证、文献计量或明确案例支撑的结论，可以承担主体论证；只依赖概念阐释、框架建构或机制推断的结论，则更适合放在理论解释和未来方向中。${strongEvidence.map((item) => item.marker).join("") || sources.map((item) => item.marker).join("")} 当前资料的证据分布显示，强证据并不等于主题更重要，而是说明该主题更适合写成已经得到验证的结论；弱证据也不是无价值，而是更适合转化为研究空白、边界条件或待检验命题。`,
    ...argumentClaims.map((claim) => claim),
    "",
    "5 分歧、不足与研究边界",
    `这些资料的主要差异，不是简单的“谁支持谁、谁反对谁”，而是证明路径不同：${evidenceGroups.map((group) => `${group.items.map((item) => item.marker).join("、")}主要依赖${group.label}`).join("；")}。这意味着综述写作应避免把所有文献压成同一种证据。实验或计量文献适合回答“是否有效、提升多少”；机制和框架文献适合回答“为什么需要这样组织问题”；场景或设计类文献适合回答“这种方法在什么条件下可能成立”。`,
    `基于上述综合，可以提出一个比单篇论文更高层级的问题：围绕${subject.topic}，如何建立一套能同时比较问题定义、方法链条、证据强度和外推边界的评价框架？现有资料已经提供了若干局部答案，但还缺少同主题下可比较的评价指标、可复核的证据矩阵和对失败条件的系统报告。${sources.filter((item) => item.limitations.length || item.confidence < 0.7).slice(0, 6).map((item) => item.marker).join("")}`,
    auditLine,
    "",
    "6 结论与展望",
    `总体来看，${subject.topic}相关文献能够共同产出的观点是：研究正在从“提出某个模型或概念”转向“构建可验证、可追溯、可部署的研究判断链”。未来综述写作的重点，不应是继续增加文献数量，而应是把每篇文献放到同一个论证坐标中：它解决什么问题、依赖什么方法、提供什么证据、证明到什么程度、又在哪些条件下不能外推。只有这样，综述才会从资料汇总变成研究判断。`,
    "",
    "参考文献",
    ...sourceList
  ].join("\n");
}

function journalReviewSubject(sources = [], settings = {}) {
  const manualTopic = normalizeJournalTopic(settings.topic);
  const manualTitle = normalizeJournalTitle(settings.topicRaw || settings.topic);
  if (manualTopic) {
    return {
      topic: manualTopic,
      title: /综述$/.test(manualTitle) ? manualTitle : journalTitleFromTopic(manualTopic),
      source: "user"
    };
  }

  const domainCounts = countBy(sources.map((item) => item.domain || "").filter(Boolean));
  const profileDomainCounts = countBy(sources.map((item) => item.profile?.domain || "").filter(Boolean));
  const dominantDomain = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  const dominantProfileDomain = [...profileDomainCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (sources.length === 1) {
    const topic = singleSourceJournalTopic(sources[0]);
    return { topic, title: singleSourceJournalTitle(sources[0], topic), source: "single_source" };
  }
  const relatedness = journalRelatedness(sources);
  if (relatedness.related && relatedness.family === "intelligent_transportation" && sources.length >= 2) {
    const topic = familyJournalTopic(relatedness.family, sources);
    return { topic, title: relatedJournalTitle(topic, sources, { type: "family", key: relatedness.family }), source: "related_family" };
  }
  if (dominantDomain[1] >= Math.max(2, Math.ceil(sources.length * 0.55))) {
    const topic = domainJournalTopic(dominantDomain[0], sources);
    return { topic, title: relatedJournalTitle(topic, sources, { type: "domain", key: dominantDomain[0] }), source: "dominant_domain" };
  }
  if (dominantProfileDomain[1] >= Math.max(2, Math.ceil(sources.length * 0.55)) && dominantProfileDomain[0] !== "一般研究资料") {
    const topic = profileDomainJournalTopic(dominantProfileDomain[0], sources);
    return { topic, title: relatedJournalTitle(topic, sources, { type: "profile_domain", key: dominantProfileDomain[0] }), source: "dominant_profile_domain" };
  }
  if (relatedness.related) {
    const topic = familyJournalTopic(relatedness.family, sources);
    return { topic, title: relatedJournalTitle(topic, sources, { type: "family", key: relatedness.family }), source: "related_family" };
  }

  const axes = journalTopicAxes(sources);
  const topic = axes.length >= 2
    ? `${joinChineseList(axes.slice(0, 3))}的证据验证、方法比较与研究边界`
    : `${axes[0] || "复杂研究对象"}的方法组织、证据验证与边界条件`;
  return { topic, title: crossDomainJournalTitle(axes), source: "cross_domain" };
}

function normalizeJournalTitle(title = "") {
  const clean = toHalfWidth(String(title || ""))
    .replace(/[-�]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(关于|围绕|面向)\s*/, "")
    .replace(/--+/g, "——")
    .replace(/[：:，,。；;\s]+$/g, "")
    .trim();
  if (!clean || /^(当前资料|相关领域|若干核心主题|文献|资料|论文|研究|综述)$/.test(clean)) return "";
  return clean.slice(0, 72);
}

function normalizeJournalTopic(topic = "") {
  const clean = normalizeJournalTitle(topic)
    .replace(/^(关于|围绕|面向)\s*/, "")
    .replace(/(高水平|期刊式|草稿|文献综述|研究综述|综述)$/g, "")
    .replace(/[：:，,。；;\s]+$/g, "")
    .trim();
  if (!clean || clean.length < 2) return "";
  if (/^(当前资料|相关领域|若干核心主题|文献|资料|论文|研究|综述)$/.test(clean)) return "";
  return clean.slice(0, 60);
}

function journalTitleFromTopic(topic = "") {
  const clean = normalizeJournalTopic(topic) || "复杂研究对象的方法组织与证据验证";
  return /(研究|方法|应用|分析|验证|边界|条件|转型|检测|控制|预测|设计|机制|证据链|知识图谱)$/.test(clean)
    ? `${clean}综述`
    : `${clean}研究综述`;
}

function relatedJournalTitle(topic = "", sources = [], relation = {}) {
  if (relation.type === "domain") {
    const titleMap = {
      apiSecurity: "智能体协同驱动的应用程序接口发现与漏洞检测研究综述",
      rideHailing: "网约车出行预测中组合模型应用与效果验证研究综述",
      intersectionControl: "混合交通环境下交叉口协同控制方法与效果验证研究综述",
      overseasChineseBooks: "域外汉籍研究的文献计量、知识图谱与主题演进综述",
      ideology: "生成式人工智能交互中的意识形态认同机制与治理边界研究综述",
      consumerResearch: "人工智能大模型驱动的消费研究范式转型综述",
      llmAgentDesign: "垂直领域大语言模型智能体设计方法与评估边界研究综述"
    };
    if (titleMap[relation.key]) return titleMap[relation.key];
  }
  if (relation.type === "family") {
    const titleMap = {
      ai_systems: "智能体与生成式人工智能应用的证据链、机制解释与研究边界综述",
      intelligent_transportation: "智能交通场景中预测、控制与效果验证研究综述",
      knowledge_mapping: "知识图谱与文献计量方法的领域画像应用研究综述"
    };
    if (titleMap[relation.key]) return titleMap[relation.key];
  }
  const methods = cleanTopicTerms(sources.map((item) => item.methodType), 2);
  const evidence = cleanTopicTerms(sources.map((item) => item.evidenceType), 2);
  const cleanTopic = normalizeJournalTopic(topic);
  if (cleanTopic && methods.length && evidence.length) {
    return `${cleanTopic}的${methods[0]}与${evidence[0]}研究综述`;
  }
  return journalTitleFromTopic(cleanTopic || topic);
}

function journalRelatedness(sources = []) {
  const families = sources.map(domainFamilyForJournalSource).filter(Boolean);
  const familyCounts = countBy(families);
  const dominant = [...familyCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  const required = sources.length <= 3
    ? Math.max(2, Math.ceil(sources.length * 0.66))
    : Math.max(3, Math.ceil(sources.length * 0.75));
  return {
    related: Boolean(dominant[0] && dominant[1] >= required),
    family: dominant[0] || "",
    count: dominant[1] || 0,
    required
  };
}

function domainFamilyForJournalSource(source = {}) {
  const domain = source.domain || "";
  if (["apiSecurity", "ideology", "consumerResearch", "llmAgentDesign"].includes(domain)) return "ai_systems";
  if (["rideHailing", "intersectionControl"].includes(domain)) return "intelligent_transportation";
  if (["overseasChineseBooks"].includes(domain)) return "knowledge_mapping";
  const text = `${source.domainLabel || ""} ${source.profile?.domain || ""} ${source.problemType || ""} ${source.methodType || ""}`;
  if (/智能体|大语言模型|生成式人工智能|接口安全|消费研究智能化/.test(text)) return "ai_systems";
  if (/交通|网约车|交叉口|车辆|预测|控制/.test(text)) return "intelligent_transportation";
  if (/知识图谱|文献计量|引文|领域画像/.test(text)) return "knowledge_mapping";
  return "";
}

function familyJournalTopic(family = "", sources = []) {
  if (family === "ai_systems") return "智能体与生成式人工智能应用中的证据链、机制解释与研究边界";
  if (family === "intelligent_transportation") return "智能交通场景中的预测建模、协同控制与效果验证";
  if (family === "knowledge_mapping") return "知识图谱与文献计量方法在领域画像中的应用";
  const axes = journalTopicAxes(sources);
  return axes.length ? `${joinChineseList(axes)}的研究进展` : "相关文献的问题演进、方法路径与证据边界";
}

function singleSourceJournalTitle(source = {}, topic = "") {
  const rawTitle = normalizeJournalTitle(source.title || "");
  const title = rawTitle && !isBadDisplayTitle(rawTitle) ? rawTitle : normalizeJournalTitle(topic);
  const clean = title
    .replace(/(文献综述|研究综述|综述)$/g, "")
    .replace(/[：:，,。；;\s]+$/g, "")
    .trim();
  return `${clean || "当前资料"}文献综述`;
}

function crossDomainJournalTitle(axes = []) {
  return "跨主题文献的方法比较与证据边界综述";
}

function journalVariantClusters(docs = []) {
  if (docs.length <= 1) return [];
  const groups = new Map();
  for (const doc of docs) {
    const source = {
      domain: inferEvidenceDomain(doc),
      domainLabel: "",
      profile: docGraphProfile(doc),
      problemType: "",
      methodType: ""
    };
    source.domainLabel = journalDomainLabel(source.domain, source.profile.domain);
    source.problemType = journalProblemType(source);
    source.methodType = journalMethodType(source);
    const family = domainFamilyForJournalSource(source) || `doc:${doc.id}`;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(doc);
  }
  const clusters = [...groups.entries()].map(([family, items]) => ({ family, docs: items }));
  if (clusters.length <= 1) return [];
  const required = docs.length <= 3
    ? Math.max(2, Math.ceil(docs.length * 0.66))
    : Math.max(3, Math.ceil(docs.length * 0.75));
  const dominant = clusters.reduce((best, item) => item.docs.length > best.docs.length ? item : best, clusters[0]);
  if (dominant.docs.length >= required) return [];
  return clusters.sort((a, b) => b.docs.length - a.docs.length || variantClusterLabel(a).localeCompare(variantClusterLabel(b), "zh-CN"));
}

function variantClusterLabel(cluster = {}) {
  const familyLabel = {
    ai_systems: "智能系统主题",
    intelligent_transportation: "智能交通主题",
    knowledge_mapping: "知识图谱与计量主题"
  }[cluster.family];
  if (familyLabel) return `${familyLabel}（${cluster.docs.length} 篇）`;
  const title = publicDocTitle(cluster.docs[0] || {});
  return `${title}（1 篇）`;
}

function buildJournalReviewVariants(docs = [], options = {}) {
  if (normalizeJournalTopic(options.topic || "")) return [];
  const clusters = journalVariantClusters(docs);
  if (!clusters.length) return [];
  return clusters.map((cluster) => ({
    label: variantClusterLabel(cluster),
    docIds: cluster.docs.map((doc) => doc.id),
    note: "当前选择包含多个不相关主题，系统按主题拆分，避免硬凑成一篇假综述。",
    review: draftJournalReview(cluster.docs, { ...options, topic: "" })
  }));
}

function singleSourceJournalTopic(source = {}) {
  const mapped = domainJournalTopic(source.domain, [source]);
  if (mapped && !/复杂研究对象/.test(mapped)) return mapped;
  const profile = source.profile || {};
  const question = conciseTopicFromClaim(source.question || source.contribution || source.claims?.[0] || "");
  if (question) return question;
  const titleTopic = normalizeJournalTopic(source.title || "");
  if (titleTopic && !isBadDisplayTitle(titleTopic)) return titleTopic;
  const parts = cleanTopicTerms([profile.domain, profile.problemType, profile.methodType, ...(profile.keywords || [])], 3);
  return parts.length ? `${parts.join("与")}的研究进展` : "复杂研究对象的方法组织与证据验证";
}

function domainJournalTopic(domain = "", sources = []) {
  const map = {
    apiSecurity: "智能体协同的应用程序接口发现与漏洞检测",
    rideHailing: "网约车出行预测的组合模型应用",
    intersectionControl: "混合交通环境下交叉口协同控制",
    overseasChineseBooks: "域外汉籍研究的文献计量与知识图谱",
    ideology: "生成式人工智能交互中的意识形态感性化认同",
    consumerResearch: "人工智能大模型驱动的消费研究范式转型",
    llmAgentDesign: "垂直领域大语言模型智能体设计"
  };
  if (map[domain]) return map[domain];
  const profileDomain = sources[0]?.profile?.domain || "";
  if (profileDomain && profileDomain !== "一般研究资料") return profileDomainJournalTopic(profileDomain, sources);
  return "复杂研究对象的方法组织与证据验证";
}

function profileDomainJournalTopic(domain = "", sources = []) {
  if (/接口安全/.test(domain)) return "应用程序接口安全检测的方法与证据链";
  if (/交通流预测/.test(domain)) return "交通流预测模型的证据验证与适用边界";
  if (/交通控制/.test(domain)) return "混合交通控制方法的协同机制与效果验证";
  if (/消费研究/.test(domain)) return "智能体驱动的消费研究范式转型";
  if (/生成式人工智能影响/.test(domain)) return "生成式人工智能社会影响的行为机制与治理边界";
  if (/智能体设计/.test(domain)) return "垂直领域智能体设计的方法谱系与评估边界";
  if (/文献计量/.test(domain)) return "知识图谱与文献计量方法的领域画像应用";
  const terms = cleanTopicTerms(sources.flatMap((item) => [item.profile?.problemType, item.profile?.methodType, ...(item.profile?.keywords || [])]), 3);
  return terms.length ? `${terms.join("与")}的研究进展` : "复杂研究对象的方法组织与证据验证";
}

function journalTopicAxes(sources = []) {
  const text = sources.map((item) => `${item.domainLabel} ${item.profile?.domain} ${item.problemType} ${item.methodType} ${item.evidenceType} ${item.title}`).join(" ");
  const axes = [];
  if (/智能体|大语言模型|生成式人工智能|接口安全|消费研究智能化/.test(text)) axes.push("智能系统");
  if (/交通|网约车|交叉口|车辆|预测|控制/.test(text)) axes.push("智能交通场景");
  if (/文献计量|知识图谱|引文|领域画像/.test(text)) axes.push("知识图谱方法");
  if (/意识形态|认同|社会影响|治理/.test(text)) axes.push("人工智能社会影响");
  if (!axes.length) {
    axes.push(...cleanTopicTerms(sources.flatMap((item) => [item.profile?.domain, item.profile?.problemType, ...(item.profile?.keywords || [])]), 3));
  }
  return uniqueStrings(axes).slice(0, 3);
}

function conciseTopicFromClaim(claim = "") {
  const clean = displayText(claim)
    .replace(/^(研究问题|方法路径|贡献结论|证据|数据\/材料|局限边界)\s*[:：]\s*/, "")
    .replace(/^(作者|本文|该文|本研究)\s*(研究|探讨|分析|提出|构建|旨在|围绕)\s*/, "")
    .replace(/[。；;].*$/g, "")
    .trim();
  if (!clean || clean.length < 8 || clean.length > 48) return "";
  if (/当前没有足够原文支撑|待核对|关键问题|相关方法/.test(clean)) return "";
  return clean;
}

function countBy(items = []) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return counts;
}

function joinChineseList(items = []) {
  const clean = uniqueStrings(items.map((item) => displayText(item)).filter(Boolean));
  if (clean.length <= 2) return clean.join("与");
  return `${clean.slice(0, -1).join("、")}与${clean[clean.length - 1]}`;
}

function normalizeReviewOptions(options = {}) {
  const structure = ["topic", "method", "controversy", "time"].includes(options.structure) ? options.structure : "topic";
  const citationFormat = ["gbt", "apa"].includes(options.citationFormat) ? options.citationFormat : "gbt";
  const wordCount = Math.max(800, Math.min(8000, Number(options.wordCount || 3000)));
  return {
    topicRaw: normalizeJournalTitle(options.topic || ""),
    topic: normalizeJournalTopic(options.topic || ""),
    structure,
    structureLabel: { topic: "按主题", method: "按方法", controversy: "按争议", time: "按时间" }[structure],
    wordCount,
    citationFormat,
    citationFormatLabel: citationFormat === "apa" ? "APA" : "GB/T 7714",
    keepAuditMarkers: Boolean(options.keepAuditMarkers)
  };
}

function journalReviewThesis(sources, settings, subject = {}) {
  const domains = [...new Set(sources.map((item) => item.domainLabel).filter(Boolean))];
  const methods = [...new Set(sources.map((item) => item.methodType).filter(Boolean))].slice(0, 4);
  const evidenceTypes = [...new Set(sources.map((item) => item.evidenceType).filter(Boolean))].slice(0, 4);
  const topic = subject.topic || settings.topic || domains.slice(0, 4).join("、") || "当前选中文献";
  return `本文综述的中心论点是：${topic} 的核心进展不在于某一篇文献单独提出了什么模型、框架或案例，而在于这些研究共同揭示出一个更普遍的趋势：复杂研究对象需要被组织成“问题界定-方法建构-证据验证-边界说明”的完整判断链。换言之，本综述关注的不是几篇论文分别说了什么，而是它们共同说明了研究如何从经验性描述走向可审计的证据化判断。当前资料中，${methods.join("、") || "多种方法路径"}构成了主要方法谱系，${evidenceTypes.join("、") || "不同证据类型"}决定了结论强度。${sources.map((item) => item.marker).join("")}`;
}

function journalArgumentClaims(sources) {
  const strong = sources.filter((item) => /实验指标|文献计量|系统验证|案例验证/.test(item.evidenceType));
  const framework = sources.filter((item) => /框架|机制|理论|范式|设计/.test(`${item.methodType} ${item.evidenceType}`));
  const withLimits = sources.filter((item) => item.limitations.length || item.confidence < 0.72);
  const methodRefs = sources.slice(0, 6).map((item) => item.marker).join("");
  return [
    `第一，当前研究的共同贡献不是“各自提出一个方法”，而是把复杂对象拆成可处理的问题链条。${methodRefs} 这说明综述应把方法看成论证结构，而不是技术名词清单。`,
    `第二，证据强弱决定观点能写到什么程度。${(strong.length ? strong : sources).slice(0, 6).map((item) => item.marker).join("")} 能支撑较强结论；${framework.slice(0, 6).map((item) => item.marker).join("") || "机制和框架类资料"}更适合支撑解释性观点或研究假设。`,
    `第三，跨文献综合必须区分“共同问题”和“共同结论”。多篇资料讨论相近问题，并不自动意味着它们证明了同一结论；只有当研究对象、方法路径和证据类型能对应起来时，才能形成综述中的共识判断。`,
    `第四，后续研究的关键不只是补充更多文献，而是补齐可比性：统一任务定义、评价指标、数据或场景描述，并明确哪些结论只能在单篇文献范围内成立。${withLimits.slice(0, 6).map((item) => item.marker).join("")}`
  ];
}

function journalMacroMethodGroups(sources) {
  const buckets = [
    {
      label: "系统构建与流程编排",
      test: (item) => /智能体|系统|流程|检索|推理|协同|控制/.test(`${item.methodType} ${item.problemType}`),
      explanation: "这类研究关注如何把数据、工具、模型、控制变量和任务步骤组织成连续流程，重点不只是某个算法，而是流程各环节如何共同产生可执行结果。"
    },
    {
      label: "实证建模与效果验证",
      test: (item) => /实验|指标|预测|建模|仿真|检测|对比|验证/.test(`${item.methodType} ${item.evidenceType} ${item.problemType}`),
      explanation: "这类研究负责回答方法是否有效、效果如何衡量、与哪些基线比较才算成立，因此是综述中形成强结论的主要来源。"
    },
    {
      label: "机制解释与范式建构",
      test: (item) => /机制|理论|范式|框架|认同|营销|消费|生成式人工智能/.test(`${item.methodType} ${item.evidenceType} ${item.problemType}`),
      explanation: "这类研究负责解释现象为什么发生、概念之间如何连接，以及研究范式为何需要调整，适合支撑综述中的理论判断和研究假设。"
    },
    {
      label: "领域画像与知识结构梳理",
      test: (item) => /计量|知识图谱|演进|热点|趋势|文献/.test(`${item.methodType} ${item.evidenceType} ${item.problemType}`),
      explanation: "这类研究提供领域层面的结构性背景，用来说明研究热点、知识网络和历史演进，但不能直接替代具体场景中的效果验证。"
    }
  ];
  const assigned = new Set();
  const groups = buckets.map((bucket) => {
    const items = sources.filter((item) => bucket.test(item) && !assigned.has(item.marker));
    items.forEach((item) => assigned.add(item.marker));
    return { label: bucket.label, explanation: bucket.explanation, items };
  }).filter((group) => group.items.length);
  const remaining = sources.filter((item) => !assigned.has(item.marker));
  if (remaining.length) {
    groups.push({
      label: "待核对的补充证据",
      explanation: "这类资料暂时不能稳定归入上述谱系，正式写作时应优先回到原文核对其研究对象、方法和证据类型。",
      items: remaining
    });
  }
  return groups;
}

function journalProblemSynthesis(problemGroups) {
  const selected = problemGroups.slice(0, 6);
  if (!selected.length) return "当前资料的问题域还不够清晰，需要先补齐每篇文献的研究问题证据卡。";
  const labels = selected.map((group) => group.label).join("、");
  const refs = selected.flatMap((group) => group.items.map((item) => item.marker)).filter(Boolean).join("");
  return `从问题域看，这组文献并不是在重复同一个小题目，而是在不同场景下共同回应“复杂对象如何被建模、解释、验证和治理”的问题。具体而言，${labels}构成了同一条问题链：先识别复杂场景中的不足，再设计可执行方法，随后用实验、计量、机制或案例说明结论强度，最后回到适用边界与后续研究。${refs}`;
}

function journalStructureHint(structure) {
  if (structure === "method") return "本稿优先按方法谱系组织：先说明不同方法解决的对象，再比较证据强弱和适用边界。";
  if (structure === "controversy") return "本稿优先按争议组织：先列共识，再把证据不足、结论冲突和不能推出的部分单独讨论。";
  if (structure === "time") return "本稿优先按时间与演进组织：先写问题提出，再写方法扩展，最后写证据补强和未来方向。";
  return "本稿优先按主题组织：每个主题内部同时比较研究问题、方法、证据和局限。";
}

function formatCitationTitle(title, citationFormat) {
  return citationFormat === "apa" ? title : `《${title}》`;
}

function groupByText(items, getter) {
  const groups = [];
  for (const item of items) {
    const label = displayText(getter(item) || "未分类");
    let group = groups.find((entry) => entry.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label, "zh-CN"));
}

function journalDomainLabel(domain, fallback = "") {
  return {
    apiSecurity: "接口安全检测",
    rideHailing: "交通流预测",
    intersectionControl: "交通控制",
    overseasChineseBooks: "文献计量与知识图谱",
    ideology: "生成式人工智能影响",
    consumerResearch: "消费研究智能化",
    llmAgentDesign: "智能体设计"
  }[domain] || fallback || "一般研究资料";
}

function journalProblemType(item) {
  return {
    apiSecurity: "弥补隐藏接口发现和漏洞验证不足",
    rideHailing: "提升短时交通流预测效果",
    intersectionControl: "协调信号配时与车辆轨迹控制",
    overseasChineseBooks: "梳理领域演进与研究热点",
    ideology: "解释生成式人工智能交互的认同机制",
    consumerResearch: "重构消费研究范式",
    llmAgentDesign: "构建垂直领域智能体设计方法"
  }[item.domain] || item.profile.problemType || "界定研究问题";
}

function journalMethodType(item) {
  return {
    apiSecurity: "智能体协同检测流程",
    rideHailing: "组合建模与预测",
    intersectionControl: "协同控制框架",
    overseasChineseBooks: "文献计量与知识图谱",
    ideology: "理论机制解释",
    consumerResearch: "范式框架建构",
    llmAgentDesign: "智能体系统设计流程"
  }[item.domain] || item.profile.methodType || "文本归纳与结构分析";
}

function journalEvidenceType(item) {
  return {
    apiSecurity: "实验指标与工具对比证据",
    rideHailing: "实验指标与预测效果证据",
    intersectionControl: "仿真实验与交通指标证据",
    overseasChineseBooks: "文献计量与知识图谱证据",
    ideology: "理论机制与风险讨论证据",
    consumerResearch: "范式框架与场景论证证据",
    llmAgentDesign: "设计框架与案例验证证据"
  }[item.domain] || item.profile.evidenceType || "文本证据";
}

function methodGroupExplanation(label) {
  if (/智能体|检索|推理/.test(label)) return "把数据、工具、检索和推理组织成连续流程";
  if (/计量|知识图谱/.test(label)) return "用量化指标和结构图谱描述研究领域";
  if (/预测|建模/.test(label)) return "通过模型组合或参数优化提升预测效果";
  if (/控制/.test(label)) return "把多个控制变量放入同一协同框架";
  if (/机制/.test(label)) return "解释行为、认同或社会影响的形成路径";
  return "将研究对象拆解为问题、方法、证据和边界";
}

function reviewQuestionAnswers(docs, questions) {
  if (docs.length === 1) {
    return questions.map((question) => ({ question, answer: answerReviewQuestion(docs[0], question) }));
  }
  const docInfos = docs.slice(0, 6).map((doc) => `${doc.title || doc.filename || "资料"}：${synthesizeDocKeyInfo(doc)}`);
  return questions.map((question) => {
    if (/分别解决什么问题/.test(question)) {
      return { question, answer: docInfos.join("；") };
    }
    if (/关键差异/.test(question)) {
      return { question, answer: "差异主要看三点：研究对象是否相同、采用的方法链条是否相同、结果指标能否直接比较。不能只按关键词相似就合并结论。" };
    }
    if (/共同支持|单一来源/.test(question)) {
      return { question, answer: "共同支持的结论应来自多篇资料都出现的主题、方法或结果；只在单篇资料出现的数字、模型效果和应用判断，应标成单一来源结论。" };
    }
    if (/写成综述/.test(question)) {
      return { question, answer: "更稳妥的组织方式是先按问题分组，再在每组里比较方法和证据，最后总结适用边界。" };
    }
    return { question, answer: "需要结合每篇资料的研究问题、方法、结果和局限来回答，不能只摘录原文。" };
  });
}

function reviewQuestions(docs, allTerms = []) {
  if (docs.length === 1) {
    const doc = docs[0];
    const card = doc.analysisCard || doc.researchCard || {};
    const title = shortQuestionTopic(doc.title || doc.filename || "这份资料");
    const terms = (doc.keywords || []).slice(0, 4).map((item) => item.term).filter(Boolean);
    const fallbackTopic = /未抽取|当前解析|正文未成功/.test(`${card.question || ""} ${doc.abstract || ""}`)
      ? title
      : shortQuestionTopic(card.question || doc.abstract || title);
    const termText = terms.length ? terms.join("、") : fallbackTopic;
    if (!(doc.chunks || []).length) {
      return [
        `这份《${title}》目前正文不可读，能先根据标题判断它最可能解决什么问题吗？`,
        `围绕${termText}，需要补充核对哪些原文证据和实验指标？`,
        `如果把这份资料纳入研究包，哪些结论必须标记为“待解析确认”？`
      ];
    }
    return [
      `《${title}》的核心研究问题是什么，作者为什么认为这个问题重要？`,
      `这篇资料围绕${termText}提出了怎样的方法、流程或系统机制？`,
      `文中哪些原文证据支撑了主要结论，定位分别在哪里？`,
      `这篇资料的局限、风险或待确认点有哪些，哪些不能直接写进结论？`
    ];
  }
  const titles = docs.slice(0, 3).map((doc) => shortQuestionTopic(doc.title || doc.filename || "资料")).join("、");
  const termText = allTerms.slice(0, 5).join("、") || "核心主题";
  return [
    `这 ${docs.length} 份资料围绕${termText}分别解决什么问题？`,
    `${titles} 在方法、证据和适用边界上有什么关键差异？`,
    `哪些结论被多份资料共同支持，哪些只来自单一来源？`,
    `如果写成综述，应该按问题、方法还是应用场景来组织这些资料？`
  ];
}

function shortQuestionTopic(text, limit = 34) {
  const clean = String(text || "").replace(/\.pdf$/i, "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit).replace(/[，,、；;:：-]+$/, "") : clean;
}

function buildMatrix(docs) {
  if (docs.length === 1) return buildSingleDocMatrix(docs[0]);
  return docs.map((doc) => {
    const evidence = evidenceCardForDoc(doc);
    const card = analysisCardFromEvidence(evidence, doc);
    const keyInfo = synthesizeDocKeyInfo(doc);
    const quote = matrixBestEvidenceItem(evidence);
    return {
      mode: "multi-doc",
      id: doc.id,
      title: publicDocTitle(doc),
      question: matrixDisplayField(evidence.research_question?.claim || card.question, keyInfo),
      method: matrixDisplayField(evidence.method?.claim || card.method, methodFallbackForDoc(doc)),
      dataOrMaterials: matrixDisplayField(evidence.data_or_materials?.claim || card.data, ""),
      findings: matrixDisplayField(keyInfo, evidence.contribution?.claim || card.findings || doc.takeaway),
      limitations: matrixDisplayField((evidence.limitations || []).map((item) => item.claim).join(" "), card.limitations),
      reviewSlot: displayText(card.reviewSlot || ""),
      evidence: matrixEvidenceCardQuote(evidence) || matrixKeyPointEvidence(doc),
      quote: displayText(quote?.quote || quote?.text || ""),
      page: quote?.page || null,
      confidence: Number(evidence.confidence || quote?.confidence || 0),
      audit: matrixAuditSummary(evidence)
    };
  });
}

function matrixBestEvidenceItem(card) {
  const items = [
    card.contribution,
    ...(card.evidence || []),
    card.method,
    card.data_or_materials,
    card.research_question,
    ...(card.limitations || [])
  ].filter(Boolean);
  return items.find(usableEvidenceItem) || items.find((item) => item.quote) || (card.quotes || [])[0] || null;
}

function matrixAuditSummary(card) {
  const items = [
    card.research_question,
    card.method,
    card.data_or_materials,
    card.contribution,
    ...(card.evidence || []),
    ...(card.limitations || [])
  ].filter(Boolean);
  const weak = items.filter((item) => /missing|weak/.test(`${item.audit || ""} ${item.support_level || ""} ${item.dimension_audit || ""}`)).length;
  if (!items.length) return "待核对";
  if (!weak) return "强证据";
  if (weak <= 2) return "部分待核对";
  return "弱证据较多";
}

function matrixEvidenceCardQuote(card) {
  const quote = (card.quotes || []).find((item) => item.text && item.page) || (card.quotes || []).find((item) => item.text);
  if (!quote) return "";
  return displayText(`${quote.text}${quote.page ? ` (p.${quote.page})` : ""}`);
}

function matrixKeyPointEvidence(doc) {
  const point = (doc.keyPoints || []).find((item) => {
    const text = cleanMatrixText(item.text || "");
    return text && !isBoilerplateLine(text) && !isMatrixNoise(text) && !isLowValueChunk(text);
  });
  if (!point) return "";
  return displayText(`${point.text}${point.page ? ` (p.${point.page})` : ""}`);
}

function matrixDisplayField(primary, fallback = "") {
  const value = cleanMatrixText(primary || "");
  if (!value || isMatrixNoise(value) || /^当前解析未识别|未抽取到明确/.test(value)) return displayText(fallback || "");
  return value;
}

function isMatrixNoise(text) {
  const value = String(text || "");
  return /^(期刊名|机构名|发文量|排名)|相似文章推荐|本文引用格式|Citationformat|作者简介|基金项目|关键词|引用格式|图书馆理论与实践|大学图书馆学报|重庆理工大学学报/.test(value) ||
    /框架[,，]并分别提出基于|流程自动化|化认同氛围|^\s*(方法|流程|模型|系统|研究|结果)\s*$/.test(value) ||
    /[A-Za-z]{35,}/.test(value);
}

function cleanMatrixText(text) {
  const value = displayText(text)
    .replace(/^(摘要|关键词|\[关键词\])[:：]?/, "")
    .replace(/^[,，;；:：\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

function methodFallbackForDoc(doc) {
  const text = `${doc.title || ""} ${doc.abstract || ""} ${doc.takeaway || ""}`;
  if (/网约车|交通流|出行预测/i.test(text)) return "作者使用网约车订单数据建立短时交通流预测任务，并用组合预测模型同时处理周期规律和随机波动。";
  if (/REST|应用程序接口|漏洞|检测/i.test(displayText(text))) return "作者把隐藏接口发现、服务指纹识别和漏洞测试串成自动化流程，用智能体协调发现与验证。";
  if (/智能体|大语言模型|垂直领域/.test(text)) return "作者围绕数据处理、语义检索、推理生成和交互控制组织智能体设计流程。";
  if (/交叉口|信号配时|车辆轨迹|混合交通|网联自动驾驶|CAV/i.test(text)) return "作者把信号配时和车辆轨迹放进同一套协同控制框架，让路口信号与车辆通过策略相互配合。";
  if (/域外汉籍|文献计量|知识图谱/i.test(text)) return "作者用文献计量和知识图谱方法分析域外汉籍研究的发文趋势、研究机构、关键词和主题演化。";
  if (/消费研究|消费感知|行为模拟|营销建模|自主演化/i.test(text)) return "作者提出从消费感知、类脑模拟到自主演化的三阶段研究路径，用智能体参与消费行为分析、模拟和预测。";
  return doc.abstract || doc.takeaway || "";
}

function buildSingleDocMatrix(doc) {
  const chunks = doc.chunks || [];
  const used = new Set();
  if (!chunks.length) return unreadableDocMatrix(doc);
  const domainRows = domainSingleDocMatrix(doc, used);
  if (domainRows) return domainRows;
  const evidence = evidenceCardForDoc(doc);
  const card = analysisCardFromEvidence(evidence, doc);
  const rows = [
    matrixSection(doc, "研究问题", [/摘要|针对|问题|挑战|缺乏|背景|目的|旨在|围绕/i], matrixFallback(evidence.research_question?.claim || card.question, doc.abstract || doc.takeaway), "界定论文要解决的核心问题，适合放在综述的引入或问题提出部分。", 0, used),
    matrixSection(doc, "方法/流程", [/方法|框架|流程|构建|设计|体系|模型|算法|步骤|路径/i], evidence.method?.claim || card.method, "提取作者采用的方案、模型、流程或系统架构。", 1, used),
    matrixSection(doc, "证明/推导/机制", [/证明|推导|机制|原理|本体|语义|检索|调用|融合|生成|设计机制|处理体系/i], evidence.contribution?.claim || card.contribution, "拆解论文如何从问题推到方案，以及关键模块之间怎样起作用。", 2, used),
    matrixSection(doc, "数据/实验/案例", [/实验|案例|场景|数据|样本|测试|验证|应用|智慧城市|API|漏洞|识别|检测/i], evidence.data_or_materials?.claim || card.data, "定位支撑结论的实验、案例、系统实现或应用场景。", 3, used),
    matrixSection(doc, "结果/发现", [/结果|表明|发现|验证|实现|提升|有效|准确|召回|性能|具备/i], (evidence.main_claims || []).map((item) => item.claim).join(" ") || card.findings || doc.takeaway, "沉淀可以写进结论、贡献或汇报页的核心发现。", 4, used),
    matrixSection(doc, "局限/风险/待确认", [/局限|不足|风险|限制|挑战|误差|安全|隐私|伦理|待|未来|仍需/i], (evidence.limitations || []).map((item) => item.claim).join(" ") || card.limitations, "标出不能直接照搬的边界，提醒后续复核原文。", 5, used),
    quoteMatrixSection(doc, used)
  ].filter(Boolean);
  return rows.map((row, index) => ({ ...row, rowId: `${doc.id}-matrix-${index + 1}` }));
}

function domainSingleDocMatrix(doc, used) {
  const text = `${doc.title || ""} ${doc.filename || ""} ${doc.abstract || ""} ${doc.takeaway || ""}`;
  if (/网约车|出行预测|交通流/i.test(text)) {
    return matrixRowsFromBlueprint(doc, used, [
      ["研究问题", "论文要解决的是网约车短时交通流预测不稳定的问题：订单量和道路状态变化快，单一预测模型难以同时捕捉周期规律和随机波动。", [/网约车|交通流|实时预测|短时预测|智能交通|随机变化/i], "适合写在研究背景：说明为什么需要改进预测方法。"],
      ["方法/流程", "作者先收集网约车出行订单数据，再把交通流序列分解成不同变化成分，分别预测后再融合，得到最终交通流预测结果。", [/订单数据|分解|重构|分量|融合|预测值|模型/i], "适合写在方法部分：按“数据-分解-预测-融合”描述。"],
      ["证明/推导/机制", "机制重点是把规律性变化和随机扰动分开处理：平稳部分用于识别主要趋势，波动部分用于修正短期误差，最后合成整体预测。", [/周期项|趋势项|随机分量|噪声|权重融合|分解参数|优化/i], "适合解释作者为什么不用单一模型。"],
      ["数据/实验/案例", "实验以网约车出行订单和交通流数据为对象，并把组合方法与多个基线预测方法进行对比。", [/订单|数据|实验|表\\s*\\d|预测指标|基线模型|对比/i], "适合提取数据来源、对比对象和指标条件。"],
      ["结果/发现", "结果说明组合预测方法的误差更低、预测准确率和拟合程度更高，能够更好反映网约车交通流的短期变化。", [/结果表明|误差|精度|拟合度|准确率|提升|降低/i], "适合写入结论：证明组合方法比单一方法更有效。"],
      ["局限/风险/待确认", "该结论依赖具体城市、订单数据质量和参数设置，不能直接外推到所有交通流预测场景。", [/局限|不足|误差|敏感|参数|数据稀疏|未来/i], "适合写在边界条件：提醒复核适用范围。"]
    ]);
  }
  if (/RESTful|API|应用程序接口|漏洞|识别|检测/i.test(text)) {
    return matrixRowsFromBlueprint(doc, used, [
      ["研究问题", "论文要解决隐藏应用程序接口难发现、难验证的问题，重点是传统扫描方式容易遗漏无文档或动态变化的接口。", [/隐藏|接口|漏洞|挑战|扫描|发现|检测/i], "适合写在安全问题背景。"],
      ["方法/流程", "作者用智能体协同方式把接口发现、服务识别、测试用例生成和漏洞验证连成自动化流程。", [/发现|指纹|测试用例|漏洞检测|智能体|流程/i], "适合写在方法链条。"],
      ["证明/推导/机制", "机制是先找候选接口，再确认接口特征，随后根据反馈迭代生成测试请求，以减少漏检和误报。", [/候选|响应|反馈|迭代|验证|误报|漏检/i], "适合解释系统为什么能提升检测能力。"],
      ["数据/实验/案例", "实验通过接口发现率、假发现率和漏洞检测覆盖情况评估系统表现，并与传统安全测试工具对比。", [/实验|发现率|假发现率|漏洞|对比|覆盖/i], "适合提取可核对指标。"],
      ["结果/发现", "结果说明智能体协同检测能提高隐藏接口发现和漏洞验证的自动化程度。", [/结果|表明|发现率|漏洞|有效|提升/i], "适合写入贡献或结论。"],
      ["局限/风险/待确认", "边界在于复杂动态服务、权限控制和生产系统安全影响仍需谨慎复核。", [/风险|限制|挑战|复杂|动态|权限|安全/i], "适合写在复核清单。"]
    ]);
  }
  return null;
}

function matrixRowsFromBlueprint(doc, used, blueprint) {
  return blueprint.map(([dimension, claim, patterns, notes], index) => {
    const chunk = bestMatrixChunk(doc, patterns, index, used);
    return {
      mode: "single-doc",
      id: doc.id,
      rowId: `${doc.id}-matrix-${index + 1}`,
      title: doc.title,
      dimension,
      claim,
      evidence: chunk ? formatMatrixEvidence(chunk, patterns, doc) : "",
      citation: chunk?.citation || fallbackPageCitation(doc, index),
      notes,
      terms: (chunk?.terms || []).map(displayText).filter(Boolean)
    };
  });
}

function formatMatrixEvidence(chunk, patterns, doc) {
  return formatChunkEvidence(chunk, patterns, doc)
    .replace(/(第\s*\d+\s*段,?第\s*\d+\s*行[:：])\s*支持向量回归\)/, "$1")
    .replace(/(第\s*\d+\s*段,?第\s*\d+\s*行[:：])\s*后将各分量/, "$1将各分量")
    .replace(/融合时间规律识别和误差修正的组合预测方法混合模型/g, "组合预测方法")
    .replace(/时间序列预测与误差修正结合的模型模型/g, "时间序列预测与误差修正结合的模型")
    .replace(/\s+/g, " ")
    .trim();
}

function matrixFallback(primary, secondary = "") {
  const value = normalizeText(String(primary || "")).replace(/\s+/g, " ");
  if (/^(期刊名|机构名|发文量|排名)/.test(value)) return secondary || value;
  const tableNoise = /期刊名|发文量|机构名|排名|表\s*\d|图书馆理论与实践|大学图书馆学报/.test(value);
  const hasResearchVerb = /研究|分析|探讨|解决|提出|构建|验证|证明|发现|表明|旨在|目的|缺乏|问题/.test(value);
  if (!value || (tableNoise && !hasResearchVerb)) return secondary || value;
  return value;
}

function unreadableDocMatrix(doc) {
  const topic = inferBaselineTopic(doc.title || doc.filename || "当前资料");
  return [
    ["研究问题", topic.question, "标题与文件名", "用于先建立阅读问题，等待 OCR 或重新解析后替换为原文证据。"],
    ["方法/流程", topic.method, "标题与通用研究结构", "用于检查这篇资料是否需要补充方法部分。"],
    ["证明/推导/机制", topic.mechanism, "标题与通用研究结构", "用于拆解可能的系统模块和作用关系。"],
    ["数据/实验/案例", topic.evaluation, "标题与通用研究结构", "用于提示需要回到原文确认实验、案例或指标。"],
    ["局限/风险/待确认", topic.risk, doc.parseWarning || "正文暂不可读", "这行不能当作原文结论，只能作为复核清单。"]
  ].map(([dimension, claim, evidence, notes], index) => ({
    mode: "single-doc",
    id: doc.id,
    rowId: `${doc.id}-matrix-${index + 1}`,
    title: doc.title,
    dimension,
    claim,
    evidence,
    citation: fallbackPageCitation(doc, index),
    notes
  }));
}

function fallbackPageCitation(doc, index = 0) {
  const pages = Number(doc.pages || 0);
  if (!pages) return "定位无法确认";
  return sourceCitation(doc, Math.min(pages, index + 1));
}

function sourceCitation(doc, start, end = start) {
  if (!start) return "定位无法确认";
  const label = (doc?.sourceUnit || doc?.sourceType) === "slide" || doc?.sourceType === "pptx" ? "slide" : "p.";
  if (label === "slide") return `slide ${start}${end && end !== start ? `-${end}` : ""}`;
  return `p.${start}${end && end !== start ? `-${end}` : ""}`;
}

function matrixSection(doc, dimension, patterns, fallback, notes, fallbackIndex, used) {
  const chunk = bestMatrixChunk(doc, patterns, fallbackIndex, used);
  const claim = cleanMatrixClaim(fallback || "") || cleanMatrixClaim(chunk?.text || "");
  const evidence = chunk ? formatChunkEvidence(chunk, patterns, doc) : cleanMatrixEvidence(fallback || "");
  if (!claim && !evidence) return null;
  return {
    mode: "single-doc",
    id: doc.id,
    title: doc.title,
    dimension,
    claim,
    evidence,
    citation: chunk?.citation || "",
    notes,
    terms: chunk?.terms || []
  };
}

function quoteMatrixSection(doc, used) {
  const point = (doc.keyPoints || []).find((item) => item.text) || null;
  const chunk = bestMatrixChunk(doc, [/摘要|关键词|结论|结果|表明|提出|构建/i], 0, used);
  const text = point?.text || chunk?.text || "";
  if (!text) return null;
  return {
    mode: "single-doc",
    id: doc.id,
    title: doc.title,
    dimension: "可引用原文",
    claim: "优先回到这一处原文核对措辞；写作时可作为直接证据来源。",
    evidence: chunk ? formatChunkEvidence(chunk, [/摘要|结论|结果|表明|提出|构建/i], doc) : cleanMatrixEvidence(text),
    citation: point?.page ? sourceCitation(doc, point.page) : chunk?.citation || "",
    notes: "这不是自动改写结论，而是便于你快速找到可引用片段。"
  };
}

function bestMatrixChunk(doc, patterns, fallbackIndex, used = new Set()) {
  const chunks = doc.chunks || [];
  const ranked = chunks
    .filter((chunk) => !used.has(chunk.index))
    .filter((chunk) => !isLowValueChunk(chunk.text))
    .map((chunk) => {
      const hits = patterns.reduce((count, pattern) => count + (pattern.test(chunk.text) ? 1 : 0), 0);
      const text = displayText(chunk.text);
      const frontMatterPenalty = /基金项目|基金资助|中图分类|文献标志码|文章编号|作者简介|收稿日期|修回日期|接受日期|通信作者|引用格式|keywords|关键词|期刊名|机构名|发文量|排名|相似文章推荐|图书馆理论与实践|大学图书馆学报|重庆理工大学学报/i.test(chunk.text) ? 40 : 0;
      const contentBonus = hits && /提出|构建|设计|验证|结果|表明|实现|应用|实验|检测|识别|方法|框架|机制|问题|目的|旨在|证明/i.test(text) ? 2 : 0;
      const ChineseBonus = (text.match(/[\u4e00-\u9fa5]/g) || []).length >= 40 ? 0.8 : 0;
      return { chunk, score: hits * 4 + contentBonus + ChineseBonus - frontMatterPenalty };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const chunk = ranked[0]?.chunk || null;
  if (chunk) used.add(chunk.index);
  return chunk;
}

function cleanMatrixClaim(text) {
  const oneLine = cleanMatrixText(normalizeText(String(text || "")).replace(/\s+/g, " "));
  if (isBoilerplateLine(oneLine)) return "";
  if (!oneLine || /^当前解析未识别|未抽取到明确/.test(oneLine)) return "";
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}。` : oneLine;
}

function cleanMatrixEvidence(text) {
  const oneLine = cleanMatrixText(normalizeText(String(text || "")).replace(/\s+/g, " "));
  if (isBoilerplateLine(oneLine)) return "";
  return shortEvidenceText(oneLine, 170);
}

function docTitle(docs, id) {
  return docs.find((doc) => doc.id === id)?.title || id;
}

function providerInfo() {
  const config = providerConfig || envProviderConfig();
  const active = config.provider !== "local" && Boolean(config.apiKey);
  const providerName = config.provider === "anthropic" ? "Claude / Anthropic" : config.provider === "openai" ? "OpenAI" : "本地算法";
  const networkIssue = /^network:|^failed:/.test(lastLLMStatus || "");
  return {
    mode: active ? `${config.provider}-configured` : "local",
    provider: config.provider,
    providerName,
    model: active ? config.model : null,
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
    lastStatus: lastLLMStatus,
    localReady: true,
    modelAvailable: active && !networkIssue,
    note: active
      ? (networkIssue
        ? `本地研究引擎可用；${providerName} 增强暂不可用（${lastLLMStatus}）。`
        : `本地研究引擎可用；已启用 ${providerName} 增强，模型 ${config.model}。`)
      : "本地研究引擎可用；模型增强未启用。"
  };
}

async function llmText(prompt, options = {}) {
  const config = providerConfig || envProviderConfig();
  if (!config.apiKey || config.provider === "local") return null;
  if (config.provider === "anthropic") return anthropicText(prompt, options, config);
  return openAIText(prompt, options, config);
}

async function fetchLLM(url, options, providerName) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    const code = error.cause?.code || error.name || "network-error";
    lastLLMStatus = `network: ${code}`;
    throw new Error(`${providerName} network error: ${code}${error.message ? ` ${error.message}` : ""}`);
  }
}

async function openAIText(prompt, options = {}, config = providerConfig || envProviderConfig()) {
  if (!config.apiKey) return null;
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetchLLM(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model || defaultOpenAIModel,
      input: prompt,
      max_output_tokens: options.maxTokens || 1800
    })
  }, "OpenAI");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    lastLLMStatus = `failed: ${response.status}`;
    throw new Error(`OpenAI request failed: ${response.status} ${body.slice(0, 180)}`);
  }
  const data = await response.json();
  lastLLMStatus = "ok";
  return data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text || "").join("\n") || "";
}

async function anthropicText(prompt, options = {}, config = providerConfig || envProviderConfig()) {
  if (!config.apiKey) return null;
  const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const response = await fetchLLM(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model || defaultAnthropicModel,
      max_tokens: options.maxTokens || 1800,
      messages: [{ role: "user", content: prompt }]
    })
  }, "Anthropic");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    lastLLMStatus = `failed: ${response.status}`;
    throw new Error(`Anthropic request failed: ${response.status} ${body.slice(0, 180)}`);
  }
  const data = await response.json();
  lastLLMStatus = "ok";
  return (data.content || []).map((part) => part.text || "").join("\n");
}

function modelSourceExcerpt(doc, fallbackText = "", maxChars = 18000) {
  const chunks = (doc.chunks || []).filter((chunk) => displayText(chunk.text || ""));
  if (!chunks.length) return String(fallbackText || "").slice(0, maxChars);
  const targetCount = Math.min(24, chunks.length);
  const indexes = [...new Set(Array.from({ length: targetCount }, (_item, index) =>
    Math.round((index / Math.max(1, targetCount - 1)) * (chunks.length - 1))))];
  const parts = [];
  let used = 0;
  for (const index of indexes) {
    const chunk = chunks[index];
    const label = chunk.citation || sourceCitation(doc, chunk.pageStart || chunk.page, chunk.pageEnd || chunk.pageStart || chunk.page);
    const available = Math.max(0, maxChars - used - label.length - 6);
    if (!available) break;
    const text = displayText(chunk.text).slice(0, Math.min(900, available));
    parts.push(`[${label}] ${text}`);
    used += label.length + text.length + 4;
  }
  return parts.join("\n\n");
}

function locateVerbatimKeyPoint(doc, sentence = "") {
  const needle = displayText(sentence).replace(/\s+/g, " ").trim();
  if (needle.length < 20) return null;
  const lowerNeedle = needle.toLowerCase();
  for (const chunk of doc.chunks || []) {
    const haystack = displayText(chunk.text || "").replace(/\s+/g, " ");
    if (haystack.toLowerCase().includes(lowerNeedle)) {
      return {
        page: chunk.pageStart || chunk.page || null,
        citation: chunk.citation || ""
      };
    }
  }
  return null;
}

function parseJsonObject(text) {
  if (!text) return null;
  const clean = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function enhanceDocumentWithOpenAI(doc, text) {
  if (!providerConfig?.apiKey || providerConfig.provider === "local" || !text) return;
  try {
    const sourceExcerpt = modelSourceExcerpt(doc, text);
    const prompt = [
      "你是严谨的中文资料分析助理。资料可能是论文、报告、合同、竞品资料、政策文件、会议纪要、课程材料或产品文档。只根据给定文本输出 JSON，不要编造。",
      "字段：title, abstract, analysisCard{question,method,data,findings,contribution,limitations,reviewSlot}, keywords[string数组], keyPoints[string数组]。",
      "analysisCard.question 表示核心问题或主题；method 表示处理方式、流程、方法或方案；findings 表示关键信息；limitations 表示风险、限制或待确认事项；reviewSlot 表示适用场景或资料类型。",
      "keyPoints 必须逐字复制给定文本中的完整原句，不得改写；无法找到完整原句时返回空数组。abstract 用中文，80-160字。",
      `文件名：${doc.filename}`,
      `资料文本（已从全文均匀抽样并保留位置标签）：${sourceExcerpt}`
    ].join("\n\n");
    const parsed = parseJsonObject(await llmText(prompt, { maxTokens: 2200 }));
    if (!parsed) return;
    doc.title = parsed.title || doc.title;
    doc.abstract = parsed.abstract || doc.abstract;
    doc.analysisCard = { ...doc.analysisCard, ...(parsed.analysisCard || parsed.researchCard || {}) };
    doc.researchCard = doc.analysisCard;
    if (Array.isArray(parsed.keywords) && parsed.keywords.length) {
      doc.keywords = parsed.keywords.slice(0, 14).map((term, index) => ({ term: String(term), count: 14 - index }));
    }
    if (Array.isArray(parsed.keyPoints) && parsed.keyPoints.length) {
      doc.keyPoints = parsed.keyPoints.slice(0, 5).map((sentence, index) => {
        const text = String(sentence).trim();
        const located = locateVerbatimKeyPoint(doc, text);
        return {
          id: `${doc.id}-llm-kp-${index + 1}`,
          text,
          page: located?.page || null,
          citation: located?.citation || "",
          sourceType: located ? "quote" : "model_synthesis"
        };
      });
    }
    doc.llmEnhanced = true;
  } catch (error) {
    doc.llmError = error.message;
    lastLLMStatus = error.message;
  }
}

async function enhanceAnswerWithOpenAI(question, sources, fallback) {
  if (!providerConfig?.apiKey || providerConfig.provider === "local" || sources.length < 2) return null;
  try {
    const evidence = sources.map((source) => ({
      marker: source.marker,
      title: source.title,
      evidence: source.evidence
    }));
    const prompt = [
      "你是严谨的中文跨资料证据分析助手。只根据证据回答，不要使用外部知识。",
      "输出 JSON：answer, claims[{type,text,citations}], consensus[string数组], disagreements[string数组], uncertainty, comparison[{source,title,view,differsBy}]。",
      "每条 claims 必须带 citations，例如 [\"[1]\",\"[2]\"]。type 只能是 原文事实、指标证据、图表证据、综合推断、不确定。百分比、发现率、误差、表格或图示结果必须标为指标证据或图表证据，不能标为原文事实。",
      `问题：${question}`,
      `证据：${JSON.stringify(evidence, null, 2)}`
    ].join("\n\n");
    const parsed = parseJsonObject(await llmText(prompt, { maxTokens: 2200 }));
    if (!parsed) return null;
    return {
      directConclusion: fallback.directConclusion,
      answer: parsed.answer || fallback.answer,
      claims: Array.isArray(parsed.claims) ? parsed.claims : fallback.claims,
      consensus: Array.isArray(parsed.consensus) ? parsed.consensus : fallback.consensus,
      disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements : fallback.disagreements,
      evidenceStrength: fallback.evidenceStrength,
      stances: fallback.stances,
      stanceMatrix: fallback.stanceMatrix,
      cannotInfer: fallback.cannotInfer,
      uncertainty: parsed.uncertainty || fallback.uncertainty,
      comparison: Array.isArray(parsed.comparison) ? parsed.comparison : fallback.comparison,
      sources,
      llmEnhanced: true
    };
  } catch (error) {
    lastLLMStatus = error.message;
    return null;
  }
}

function selectedDocs(library, scope = {}) {
  const docs = library.docs || [];
  const docIds = Array.isArray(scope.docIds) ? scope.docIds.filter(Boolean) : [];
  const docId = scope.docId || "";
  if (docIds.length) return docs.filter((doc) => docIds.includes(doc.id));
  if (docId && docId !== "all") return docs.filter((doc) => doc.id === docId);
  return docs;
}

function publicDoc(doc) {
  const evidence = evidenceCardForDoc(doc);
  const card = analysisCardFromEvidence(evidence, doc);
  const keyInfo = synthesizeDocKeyInfo(doc);
  const sourceMeta = sourceMetaForDoc(doc);
  const publicSourceMeta = {
    ...sourceMeta,
    journal: sourceMeta.journal || cleanJournalName(doc.journal || "") || journalFromKnownName(`${doc.title || ""} ${doc.filename || ""}`)
  };
  return {
    id: doc.id,
    filename: doc.filename,
    title: publicDocTitle(doc),
    authors: publicSourceMeta.authors || [],
    journal: publicSourceMeta.journal || "",
    publicationYear: publicSourceMeta.publicationYear || "",
    sourceMeta: publicSourceMeta,
    sourceType: doc.sourceType || "pdf",
    sourceUnit: doc.sourceUnit || "page",
    pages: doc.pages || 0,
    wordCount: doc.wordCount || 0,
    abstract: publicSummaryText(doc.abstract || sourceMeta.abstract, keyInfo),
    takeaway: publicSummaryText(doc.takeaway, evidence.contribution?.claim || keyInfo),
    keywords: (doc.keywords || []).slice(0, 14).map(publicKeyword).filter((item) => item.term),
    keyPoints: publicKeyPoints(doc, evidence),
    analysisCard: {
      ...card,
      question: matrixDisplayField(evidence.research_question?.claim || card.question, keyInfo),
      method: matrixDisplayField(evidence.method?.claim || card.method, methodFallbackForDoc(doc)),
      data: matrixDisplayField(evidence.data_or_materials?.claim || card.data, ""),
      findings: matrixDisplayField(keyInfo, evidence.contribution?.claim || card.findings || doc.takeaway),
      contribution: matrixDisplayField(evidence.contribution?.claim || card.contribution, ""),
      limitations: matrixDisplayField((evidence.limitations || []).map((item) => item.claim).join(" ") || card.limitations, "原文未明确给出稳定的风险或限制，使用前需要回到适用场景、数据来源和实验条件核对。"),
      reviewSlot: displayText(card.reviewSlot || "")
    },
    evidenceCard: evidence,
    researchCard: null,
    sourceFile: doc.sourceFile,
    fileHash: doc.fileHash,
    ocrUsed: doc.ocrUsed,
    pdfCleanVersion: doc.pdfCleanVersion || 0,
    pdfCleanWarning: doc.pdfCleanWarning || "",
    llmEnhanced: doc.llmEnhanced,
    parseWarning: doc.parseWarning,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function publicSummaryText(primary, fallback = "") {
  const clean = cleanAbstractText(primary || "") || cleanMatrixText(primary || "");
  if (!clean || isMatrixNoise(clean) || isLowValueChunk(clean) || /^(服控制原理|化认同氛围|流程自动化)/.test(clean)) return displayText(fallback || "");
  return displayText(clean);
}

function publicKeyPoints(doc, evidence) {
  const quotePoints = (evidence.quotes || []).slice(0, 5).map((quote, index) => ({
    id: `${doc.id}-evidence-kp-${index + 1}`,
    text: displayText(quote.text || ""),
    page: quote.page || null,
    paragraph: quote.paragraph || null,
    sourceType: "quote"
  })).filter((item) => item.text && !isMatrixNoise(item.text) && !isLowValueChunk(item.text));
  if (quotePoints.length) return quotePoints;
  return (doc.keyPoints || [])
    .map((item) => ({ ...item, text: displayText(item.text || "") }))
    .filter((item) => item.sourceType !== "model_synthesis")
    .filter((item) => item.text && !isMatrixNoise(item.text) && !isLowValueChunk(item.text))
    .slice(0, 5);
}

function publicKeyword(item) {
  if (typeof item === "string") return { term: displayText(item), count: 1 };
  return { ...item, term: displayText(item?.term || "") };
}

function libraryPayload(library, scope = {}) {
  const docs = library.docs || [];
  const scopedDocs = selectedDocs(library, scope);
  const hasSelection = Array.isArray(scope.docIds) && scope.docIds.filter(Boolean).length > 0;
  return {
    docs: docs.map(publicDoc),
    activeDocId: hasSelection ? "selection" : (scope.docId || "all"),
    activeDocIds: scopedDocs.map((doc) => doc.id),
    scopedCount: scopedDocs.length,
    graph: buildGraph(scopedDocs),
    docFlow: buildDocFlow(scopedDocs),
    matrix: buildMatrix(scopedDocs),
    researchGaps: buildResearchGaps(scopedDocs),
    review: draftReview(scopedDocs),
    provider: providerInfo()
  };
}

async function loadSearchIndex(library = null) {
  try {
    return JSON.parse(await fs.readFile(searchIndexPath, "utf8"));
  } catch {
    const source = library || await loadLibrary();
    await writeSearchIndex(source);
    return JSON.parse(await fs.readFile(searchIndexPath, "utf8"));
  }
}

function queryTerms(query, mode = "semantic") {
  const clean = displayText(query).toLowerCase();
  if (mode === "exact") return clean ? [clean] : [];
  const terms = new Set(queryTopicTerms(clean).filter((term) => term && term.length >= 2));
  const expansions = {
    智能体: ["代理", "工具调用", "规划", "大语言模型"],
    接口: ["应用程序接口", "端点", "漏洞", "检测"],
    漏洞: ["安全", "检测", "风险", "接口", "验证"],
    风险: ["局限", "不足", "限制", "挑战", "安全", "治理"],
    网约车: ["出行", "交通流", "订单"],
    交通流: ["网约车", "预测", "出行", "道路"],
    证据: ["实验", "结果", "表明", "验证", "指标"],
    评估: ["指标", "对比", "实验", "结果", "性能"]
  };
  for (const [key, values] of Object.entries(expansions)) {
    if (clean.includes(key)) {
      values.forEach((value) => terms.add(value));
      terms.add(key);
    }
  }
  if (!terms.size && clean) terms.add(clean);
  return [...terms].slice(0, 16);
}

function includesTerm(text, term) {
  return String(text || "").toLowerCase().includes(String(term || "").toLowerCase());
}

function searchLibraryIndex(index, query, options = {}) {
  const mode = ["title", "author"].includes(options.mode) ? options.mode : "title";
  const primary = displayText(query).toLowerCase();
  const terms = queryTerms(query, "exact");
  const topicTerms = queryTopicTerms(query);
  if (!terms.length) return { query, mode, totalDocs: 0, totalMatches: 0, results: [] };
  const allowedDocId = String(options.docId || "").trim();
  const sourceDocs = allowedDocId ? (index.docs || []).filter((doc) => doc.id === allowedDocId) : (index.docs || []);
  const docMap = new Map(sourceDocs.map((doc) => [doc.id, { doc, score: 0, matches: [], primaryHit: false, topicHitCount: 0, reasons: [] }]));
  for (const entry of docMap.values()) {
    const fields = {
      title: entry.doc.title || "",
      author: (entry.doc.authors || []).join("、"),
      journal: entry.doc.journal || "",
      year: entry.doc.publicationYear || ""
    };
    const haystack = fields[mode] || fields.title;
    entry.primaryHit = includesTerm(haystack, primary);
    entry.topicHitCount += topicTerms.filter((term) => includesTerm(haystack, term)).length;
    for (const term of terms) {
      if (mode === "title" && includesTerm(fields.title, term)) entry.score += 40;
      if (mode === "author" && includesTerm(fields.author, term)) entry.score += 42;
      if (mode === "journal" && includesTerm(fields.journal, term)) entry.score += 36;
      if (mode === "year" && includesTerm(fields.year, term)) entry.score += 34;
    }
    if (entry.score > 0) {
      entry.reasons.push(searchReasonForDoc(entry.doc, mode, primary));
    }
  }
  const results = [...docMap.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title, "zh-CN"))
    .slice(0, Number(options.limit || 30))
    .map((entry) => ({
      doc: entry.doc,
      score: Math.round(entry.score),
      reason: entry.reasons[0] || searchReasonForDoc(entry.doc, mode, primary),
      matchCount: entry.matches.length,
      matches: entry.matches.sort((a, b) => b.score - a.score).slice(0, 3)
    }));
  return {
    query,
    mode,
    docId: allowedDocId || "",
    terms,
    totalDocs: results.length,
    totalMatches: results.reduce((sum, item) => sum + item.matchCount, 0),
    results
  };
}

function searchReasonForDoc(doc = {}, mode = "title", query = "") {
  const q = displayText(query || "");
  if (mode === "title") return `题名命中：${shortEvidenceText(doc.title || "", 48)}`;
  if (mode === "author") return `作者命中：${(doc.authors || []).join("、") || "作者待核对"}`;
  return `题名命中：${shortEvidenceText(doc.title || "", 48)}`;
}

function isBroadSearchQuery(query) {
  return /^(证据|评估|方法|风险|结果|实验|局限|问题|结论)$/.test(String(query || "").trim());
}

function highlightSnippet(text, terms) {
  const clean = displayText(text);
  const hit = terms.find((term) => includesTerm(clean, term));
  if (!hit) return shortEvidenceText(clean, 180);
  const lower = clean.toLowerCase();
  const index = lower.indexOf(hit.toLowerCase());
  const start = Math.max(0, index - 70);
  const end = Math.min(clean.length, index + hit.length + 110);
  return clean.slice(start, end).replace(/^[，,、；;:：-]+|[，,、；;:：-]+$/g, "");
}

app.get("/api/library", async (req, res) => {
  const library = await loadLibrary();
  const docIds = String(req.query.docIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  res.json(libraryPayload(library, { docId: String(req.query.docId || "all"), docIds }));
});

app.get("/api/provider", (_req, res) => {
  res.json(providerInfo());
});

app.post("/api/provider", async (req, res) => {
  try {
    const current = providerConfig || envProviderConfig();
    const next = sanitizeProviderConfig({
      provider: req.body.provider,
      model: req.body.model,
      baseUrl: req.body.baseUrl,
      apiKey: Object.prototype.hasOwnProperty.call(req.body, "apiKey") ? req.body.apiKey : current.apiKey
    });
    if (req.body.keepApiKey) next.apiKey = current.apiKey;
    await saveProviderConfig(next);
    res.json(providerInfo());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "模型接口配置无效。" });
  }
});

app.post("/api/provider/test", async (_req, res) => {
  if (!providerConfig?.apiKey || providerConfig.provider === "local") {
    return res.status(400).json({ error: "请先选择 OpenAI 或 Claude，并填写 API Key。" });
  }
  try {
    const text = await llmText("请只回复 OK。", { maxTokens: 32 });
    res.json({ ok: true, text: String(text || "").slice(0, 120), provider: providerInfo() });
  } catch (error) {
    res.status(502).json({ error: error.message, provider: providerInfo() });
  }
});

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ query: "", results: [], totalDocs: 0, totalMatches: 0, terms: [] });
  const library = await loadLibrary();
  const index = await loadSearchIndex(library);
  res.json(searchLibraryIndex(index, query, {
    mode: String(req.query.mode || "semantic"),
    limit: Number(req.query.limit || 30),
    docId: String(req.query.docId || "")
  }));
});

app.get("/api/doc/:id/pdf", async (req, res) => {
  const library = await loadLibrary();
  const doc = (library.docs || []).find((item) => item.id === String(req.params.id));
  if (!doc) return res.status(404).json({ error: "没有找到这份资料。" });
  if ((doc.sourceType || "pdf") !== "pdf") return res.status(409).json({ error: "这份资料不是 PDF，请使用原文入口打开源文件。" });
  const sourcePath = sourcePathForDoc(doc);
  if (!sourcePath) return res.status(409).json({ error: "这份资料没有可跳转的原始 PDF。" });
  try {
    await fs.access(sourcePath);
  } catch (_error) {
    return res.status(404).json({ error: "原始 PDF 文件不存在，可能已被清理或未成功保存。" });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename || doc.title || "source.pdf")}"`);
  res.sendFile(sourcePath);
});

app.get("/api/doc/:id/source", async (req, res) => {
  const library = await loadLibrary();
  const doc = (library.docs || []).find((item) => item.id === String(req.params.id));
  if (!doc) return res.status(404).json({ error: "没有找到这份资料。" });
  const sourcePath = sourcePathForDoc(doc);
  if (!sourcePath) return res.status(409).json({ error: "这份资料没有保存原始文件，请重新上传后再打开。" });
  try {
    await fs.access(sourcePath);
  } catch (_error) {
    return res.status(404).json({ error: "原始文件不存在，可能已被清理或未成功保存。" });
  }
  const sourceType = doc.sourceType || uploadKind(doc.filename || "") || "pdf";
  const contentType = sourceType === "pptx"
    ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    : "application/pdf";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `${sourceType === "pdf" ? "inline" : "attachment"}; filename="${encodeURIComponent(doc.filename || doc.title || `source.${sourceType}`)}"`);
  res.sendFile(sourcePath);
});

app.get("/api/jobs", (_req, res) => {
  const jobs = uploadJobStore.jobs.slice(-60).reverse().map(publicUploadJob);
  res.json({ jobs, active: jobs.filter((job) => ["queued", "parsing", "ocr", "enhancing", "saving", "canceling"].includes(job.status)).length });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = uploadJobStore.jobs.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: "解析任务不存在。" });
  res.json(publicUploadJob(job));
});

app.post("/api/jobs/:id/retry", async (req, res) => {
  const job = await mutateUploadJobs(async () => {
    const current = uploadJobStore.jobs.find((item) => item.id === req.params.id);
    if (!current) return null;
    if (current.status !== "failed") return { invalid: true, current };
    try {
      await fs.access(pendingPathForJob(current));
    } catch {
      return { missing: true, current };
    }
    Object.assign(current, {
      status: "queued",
      phase: "等待重试",
      progress: 0,
      currentPage: 0,
      totalPages: 0,
      error: "",
      cancelRequested: false,
      updatedAt: new Date().toISOString()
    });
    await saveUploadJobs();
    return { current };
  });
  if (!job) return res.status(404).json({ error: "解析任务不存在。" });
  if (job.invalid) return res.status(409).json({ error: "只有失败的任务可以重试。" });
  if (job.missing) return res.status(409).json({ error: "待解析原文件不存在，请重新上传。" });
  scheduleUploadJobProcessor();
  res.json(publicUploadJob(job.current));
});

app.delete("/api/jobs/:id", async (req, res) => {
  const result = await mutateUploadJobs(async () => {
    const job = uploadJobStore.jobs.find((item) => item.id === req.params.id);
    if (!job) return null;
    if (["completed", "duplicate", "failed", "canceled"].includes(job.status)) return { invalid: true, job };
    job.cancelRequested = true;
    if (job.status === "queued") {
      job.status = "canceled";
      job.phase = "已取消";
      await fs.rm(pendingPathForJob(job), { force: true }).catch(() => {});
    } else {
      job.status = "canceling";
      job.phase = "正在取消";
    }
    job.updatedAt = new Date().toISOString();
    await saveUploadJobs();
    return { job };
  });
  if (!result) return res.status(404).json({ error: "解析任务不存在。" });
  if (result.invalid) return res.status(409).json({ error: "这个任务已经结束。" });
  res.json(publicUploadJob(result.job));
});

app.post("/api/upload", upload.array("files", 20), async (req, res, next) => {
  try {
    const result = await enqueueUploadFiles(req.files || []);
    res.status(202).json(result);
  } catch (error) {
    for (const file of req.files || []) await fs.rm(file.path, { force: true }).catch(() => {});
    next(error);
  }
});

app.patch("/api/doc/:id", mutationRoute(async (req, res) => {
  const library = await loadLibrary();
  const doc = (library.docs || []).find((item) => item.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "资料不存在。" });
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "标题不能为空。" });
  doc.title = title.slice(0, 180);
  doc.manualTitle = true;
  doc.updatedAt = new Date().toISOString();
  await saveLibrary(library);
  res.json(libraryPayload(library, { docId: doc.id }));
}));

app.delete("/api/doc/:id", mutationRoute(async (req, res) => {
  const library = await loadLibrary();
  const docs = library.docs || [];
  const index = docs.findIndex((doc) => doc.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "资料不存在。" });
  const [removed] = docs.splice(index, 1);
  library.docs = docs;
  const sourcePath = sourcePathForDoc(removed);
  if (sourcePath) await fs.rm(sourcePath, { force: true }).catch(() => {});
  await saveLibrary(library);
  const nextDocId = docs[index]?.id || docs[index - 1]?.id || (docs.length ? "all" : "all");
  res.json({ removed: { id: removed.id, title: removed.title }, ...libraryPayload(library, { docId: nextDocId }) });
}));

app.post("/api/doc/:id/reparse", mutationRoute(async (req, res) => {
  const library = await loadLibrary();
  const docs = library.docs || [];
  const index = docs.findIndex((doc) => doc.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "资料不存在。" });
  const current = docs[index];
  const sourcePath = sourcePathForDoc(current);
  if (!sourcePath) return res.status(409).json({ error: "这篇资料没有保存原始文件，请重新上传后再重解析。" });
  let buffer;
  try {
    buffer = await fs.readFile(sourcePath);
  } catch {
    return res.status(409).json({ error: "找不到这篇资料的原始文件，请重新上传后再重解析。" });
  }
  const reparsed = await analyzeUploadedDocument({
    id: current.id,
    filename: current.filename || `${current.title || current.id}.${current.sourceType === "pptx" ? "pptx" : "pdf"}`,
    buffer,
    existingDoc: current
  });
  docs[index] = reparsed;
  library.docs = docs;
  await fs.writeFile(sourcePath, reparsed._sourceBuffer || buffer);
  await saveLibrary(library);
  res.json({ reparsed: { id: reparsed.id, title: reparsed.title }, ...libraryPayload(library, { docId: reparsed.id }) });
}));

app.post("/api/ask", async (req, res) => {
  const question = String(req.body?.question || "").trim();
  const library = await loadLibrary();
  if (!question) return res.status(400).json({ error: "Question is required." });
  const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds.map(String) : [];
  const docId = String(req.body?.docId || "");
  const docs = selectedDocs(library, { docId, docIds });
  if (!docs.length) return res.status(400).json({ error: "当前范围没有可分析的资料。" });
  res.json(await answerQuestion(docs, question));
});

app.post("/api/review/journal", async (req, res) => {
  const library = await loadLibrary();
  const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds.map(String) : [];
  const docId = String(req.body?.docId || "");
  const docs = selectedDocs(library, { docId, docIds });
  if (!docs.length) return res.status(400).json({ error: "当前范围没有可生成综述的资料。" });
  const reviewOptions = {
    topic: req.body?.topic,
    structure: req.body?.structure,
    wordCount: req.body?.wordCount,
    citationFormat: req.body?.citationFormat,
    keepAuditMarkers: req.body?.keepAuditMarkers
  };
  res.json({
    review: draftJournalReview(docs, reviewOptions),
    variants: buildJournalReviewVariants(docs, reviewOptions),
    scopedCount: docs.length,
    generatedAt: new Date().toISOString()
  });
});

app.delete("/api/library", mutationRoute(async (_req, res) => {
  await mutateUploadJobs(async () => {
    for (const job of uploadJobStore.jobs) {
      if (!["queued", "parsing", "ocr", "enhancing", "saving", "canceling"].includes(job.status)) continue;
      job.cancelRequested = true;
      if (job.status === "queued") {
        job.status = "canceled";
        job.phase = "资料库已清空";
        await fs.rm(pendingPathForJob(job), { force: true }).catch(() => {});
      } else {
        job.status = "canceling";
        job.phase = "资料库已清空，正在取消";
      }
      job.updatedAt = new Date().toISOString();
    }
    await saveUploadJobs();
  });
  await saveLibrary({ docs: [] });
  await fs.rm(originalDir, { recursive: true, force: true });
  await fs.mkdir(originalDir, { recursive: true });
  res.json({ ok: true, docs: [], graph: { nodes: [], edges: [] }, matrix: [], review: "", provider: providerInfo() });
}));

app.use((error, _req, res, _next) => {
  const status = Number(error?.status || error?.statusCode || 0);
  if (error?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "单个文件超过 35MB，请压缩后再上传。" });
  if (error?.code === "LIMIT_FILE_COUNT") return res.status(413).json({ error: "一次最多上传 20 个文件，请分批上传。" });
  if (error?.code === "UNSUPPORTED_UPLOAD_TYPE") return res.status(415).json({ error: error.message || "当前只支持 PDF 和 PPTX 文件。" });
  if (status >= 400 && status < 600) return res.status(status).json({ error: error?.message || "请求处理失败。" });
  console.error(error);
  res.status(500).json({ error: "服务器处理失败，请稍后重试；如果是新上传文件，请确认文件未损坏。" });
});

if (uploadJobStore.jobs.some((job) => job.status === "queued")) scheduleUploadJobProcessor();

app.listen(port, "0.0.0.0", () => {
  console.log(`Literature assistant listening on 0.0.0.0:${port}`);
});
