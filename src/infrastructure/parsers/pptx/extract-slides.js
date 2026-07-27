import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { normalizeText } from "../../../shared/text/core.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

export async function extractPptxSlides(buffer, { onProgress = null } = {}) {
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
    pageTexts.push(normalizeText([slideText, notesText ? `备注：${notesText}` : ""].filter(Boolean).join("\n")));
    await onProgress?.({
      status: "parsing",
      phase: `解析幻灯片 ${index + 1}/${slidePaths.length}`,
      progress: Math.round(15 + ((index + 1) / slidePaths.length) * 50),
      currentPage: index + 1,
      totalPages: slidePaths.length
    });
  }
  if (!normalizeText(pageTexts.join("\n\n")).trim()) {
    throw Object.assign(new Error("这个 PPTX 没有抽到可分析文字，可能主要是图片或扫描页；请导出为 PDF 后上传，或先用 OCR 生成可复制文本。"), { status: 422 });
  }
  return pageTexts;
}

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
  return xmlParser.parse(await file.async("string"));
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

function uniqueStrings(items = []) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const value = String(item || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
