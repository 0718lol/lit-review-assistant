import { normalizeText, toHalfWidth } from "../../../shared/text/core.js";

export function cleanPdfPageTexts(pageTexts = []) {
  const normalized = (pageTexts || []).map((text) => normalizeText(text || ""));
  const repeated = repeatedPdfLayoutLines(normalized);
  return normalized.map((pageText) => cleanPdfPageText(pageText, repeated));
}

export function cleanPdfPageText(pageText = "", repeatedLines = new Set()) {
  const lines = normalizeText(pageText)
    .split(/\n+/)
    .map((line) => cleanPdfLineText(line))
    .filter(Boolean)
    .filter((line) => !repeatedLines.has(normalizePdfLayoutLine(line)))
    .filter((line) => !isPdfLayoutNoiseLine(line));
  return mergePdfTextLines(lines).join("\n");
}

export function cleanPdfLineText(text = "") {
  return toHalfWidth(String(text || ""))
    .replace(/[‐‑‒–—－]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function sectionForText(text = "", current = "") {
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
  return /基金项目|基金资助|作者简介|通信作者|通讯作者|收稿日期|修回日期|引用格式|相似文章推荐|中图分类号|文献标志码|文章编号/.test(clean);
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
  return !(previous.length < 18 && next.length < 18);
}

function mergeSpacer(previous = "", next = "") {
  if (/[\u4e00-\u9fa5]$/.test(previous) && /^[\u4e00-\u9fa5]/.test(next)) return "";
  if (/[-‐‑‒–—]$/.test(previous)) return "";
  return " ";
}
