const stopwords = new Set(`
the a an and or of to in for on with by as is are was were be been being from that this these those it its at into
we our us they their them which can may using used use based between through across than such also not have has had
资料 文件 文档 内容 问题 方法 模型 数据 结果 通过 基于 进行 一个 一种 以及 可以 主要 相关 分析 提出 实现 不同 其中 对于 文献 论文 报告
`.trim().split(/\s+/));

export function normalizeText(text) {
  return collapseRepeatedCjkGlyphs(decodePdfGlyphEncoding(text))
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sentences(text) {
  return normalizeText(text)
    .replace(/([。！？!?])\s*/g, "$1\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => !isBoilerplateLine(sentence))
    .filter((sentence) => {
      const cjkCount = (sentence.match(/[\u4e00-\u9fa5]/g) || []).length;
      return sentence.length <= 420 && (sentence.length >= 35 || cjkCount >= 12);
    });
}

export function toHalfWidth(text) {
  return String(text || "")
    .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

export function isBoilerplateLine(text) {
  const clean = toHalfWidth(text).replace(/\s+/g, " ").trim().toLowerCase();
  if (!clean) return true;
  if (isFundingOrMetadataNoise(clean)) return true;
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

export function isFundingOrMetadataNoise(text) {
  const clean = toHalfWidth(String(text || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  const fundingSignals = /(本文系|本[文研究课题]为|基金项目|基金资助|资助项目|项目编号|课题编号|课题项目|阶段性研究成果|教育部人文社会科学研究|国家社会科学基金|国家自然科学基金|省教育科技创新科研项目|高校辅导员研究)/;
  const frontMatterSignals = /(中图分类号|文献标志码|文献标识码|文章编号|收稿日期|修回日期|接受日期|发布日期|通信作者|通讯作者|作者简介|责任编辑)/;
  if (fundingSignals.test(clean)) return true;
  if (frontMatterSignals.test(clean)) return true;
  if (/^(based on|supported by|funded by|foundation item|funding|acknowledg(e)?ments?)\b/i.test(lower) && /(项目|基金|课题|资助|成果|foundation|grant|supported)/i.test(clean)) return true;
  if (/(foundation|grant|supported by|funded by).{0,120}(no\.?|number|project)/i.test(clean)) return true;
  return false;
}

export function tokens(text) {
  const source = String(text || "");
  const latin = source.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const cjkRuns = source.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const cjk = [];
  for (const run of cjkRuns) {
    if (run.length <= 8) cjk.push(run);
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= run.length - size; index += 1) cjk.push(run.slice(index, index + size));
    }
  }
  return [...latin, ...cjk].filter((token) => !stopwords.has(token) && !/^\d+$/.test(token));
}

export function topKeywords(text, limit = 12) {
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
