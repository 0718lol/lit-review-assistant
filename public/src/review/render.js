import { cleanUiText, escapeHtml, plainReview } from "../shared/text.js";

export function renderReviewDraft(markdown, emptyText) {
  const text = plainReview(markdown);
  if (!text) return escapeHtml(emptyText);
  const sections = splitReviewSections(text);
  if (!sections.length) return escapeHtml(text);
  return `<div class="review-rendered">${sections.map((section) => `
    <section class="review-block ${reviewBlockClass(section.title)}">
      <h3>${escapeHtml(section.title)}</h3>
      <div>${reviewLinesToHtml(section.body)}</div>
    </section>`).join("")}</div>`;
}

export function renderJournalReviewDraft(markdown, emptyText) {
  const text = plainReview(markdown);
  if (!text) return escapeHtml(emptyText);
  const lines = normalizeJournalReviewLines(text);
  if (!lines.length) return escapeHtml(emptyText);
  const [title, ...body] = lines;
  return `<article class="journal-article"><h1>${escapeHtml(title)}</h1>${body.map(journalLineToHtml).join("")}</article>`;
}

function normalizeJournalReviewLines(text = "") {
  const lines = String(text).split("\n").map((line) => cleanJournalCitationMarkers(cleanUiText(line))).filter(Boolean);
  const badTitle = /^(高水平期刊式文献综述草稿|期刊式文献综述草稿|文献综述草稿|相关领域研究综述|当前资料研究综述)$/;
  let removedBadTitle = false;
  while (lines.length && badTitle.test(lines[0])) {
    lines.shift();
    removedBadTitle = true;
  }
  if (removedBadTitle && /^摘要$/.test(lines[0] || "")) return [];
  const duplicateIndex = lines.findIndex((line, index) => index > 0 && /^摘要$/.test(line));
  if (duplicateIndex > 1 && badTitle.test(lines[duplicateIndex - 1])) lines.splice(duplicateIndex - 1, 1);
  return lines;
}

function cleanJournalCitationMarkers(line = "") {
  return String(line || "")
    .replace(/(?:\s*\[\d+\]){1,}/g, "")
    .replace(/\s+([，。；：,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function journalLineToHtml(line = "") {
  const clean = cleanUiText(line);
  if (!clean) return "";
  if (/^摘要$/.test(clean)) return `<h2>${escapeHtml(clean)}</h2>`;
  if (/^关键词[:：]/.test(clean)) return `<p class="journal-keywords">${escapeHtml(clean)}</p>`;
  if (/^\d+\s+/.test(clean) || /^参考文献$/.test(clean)) return `<h2>${escapeHtml(clean)}</h2>`;
  if (/^\[\d+\]/.test(clean)) return `<p class="journal-reference">${escapeHtml(clean)}</p>`;
  if (/^\[(待人工核对|证据状态)\]/.test(clean)) return `<p class="journal-audit">${escapeHtml(clean)}</p>`;
  return `<p>${escapeHtml(clean)}</p>`;
}

function splitReviewSections(text) {
  const lines = String(text || "").split("\n").map((line) => cleanUiText(line)).filter((line) => line.length);
  if (!lines.length) return [];
  const headings = /^(文献综述草稿|核心主题|原文事实层|综合推断层|待核对层|可继续追问与简答|高水平期刊式文献综述草稿|综述主题|组织方式|[一二三四五六七八九十]、.+|资料来源)$/;
  const sections = [];
  let current = { title: lines[0], body: [] };
  for (const line of lines.slice(1)) {
    if (headings.test(line)) {
      sections.push(current);
      current = { title: line, body: [] };
    } else current.body.push(line);
  }
  sections.push(current);
  return sections.filter((section) => section.title || section.body.length);
}

function reviewBlockClass(title = "") {
  if (/原文事实/.test(title)) return "review-facts";
  if (/综合推断|中心论点|综合观点|结论/.test(title)) return "review-synthesis";
  if (/待核对|证据状态|缺口|不能/.test(title)) return "review-audit";
  if (/资料来源/.test(title)) return "review-sources";
  return "";
}

function reviewLinesToHtml(lines = []) {
  return lines.map((line) => {
    const clean = cleanUiText(line);
    if (/^\[\d+\]\s+/.test(clean)) return `<p class="review-line source-head">${escapeHtml(clean)}</p>`;
    if (/^- (研究问题|方法路径|数据\/材料|主要结论|证据\d+|边界条件|核心事实)：/.test(clean)) {
      const [, label = "事实", body = clean] = clean.match(/^- ([^：]+)：(.+)$/) || [];
      return `<p class="review-line fact-item"><b>${escapeHtml(label)}</b><span>${escapeHtml(body.trim())}</span></p>`;
    }
    if (/^(•|-|\d+[.、])/.test(clean)) return `<p class="review-line item">${escapeHtml(clean)}</p>`;
    if (/^\[待人工核对\]|\[证据状态\]/.test(clean)) return `<p class="review-line audit">${escapeHtml(clean)}</p>`;
    return `<p class="review-line">${escapeHtml(clean)}</p>`;
  }).join("");
}
