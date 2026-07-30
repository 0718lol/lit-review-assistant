export function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

export function plainReview(markdown) {
  return String(markdown || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*-\s+/gm, "• ")
    .replace(/[-]/g, "")
    .replace(/\.{3}|…/g, "")
    .trim();
}

export function friendlyText(value) {
  return cleanUiText(plainLanguageText(preferChineseText(expandTerms(toHalfWidth(String(value || ""))))));
}

export function toHalfWidth(text) {
  return String(text || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

export function expandTerms(text) {
  return String(text || "")
    .replace(/[‐‑‒–—－]/g, "-")
    .replace(/[-]/g, "")
    .replace(/摘\s*要\s*[:：]?/g, "")
    .replace(/^关\s*键\s*词\s*[:：]?.*$/i, "")
    .replace(/^keywords?\s*[:：]?.*$/i, "")
    .replace(/singular\s*spectrum\s*analysis|singularspectrumanalysis/gi, "奇异谱分析")
    .replace(/SSA\s*-\s*LSTM\s*-\s*SVR/gi, "麻雀搜索算法优化的长短期记忆网络与支持向量回归组合预测模型")
    .replace(/LSTM\s*-\s*SVR/gi, "长短期记忆网络与支持向量回归结合的预测模型")
    .replace(/\bMAPE\b/gi, "平均绝对百分比误差")
    .replace(/\bRMSE\b/gi, "均方根误差")
    .replace(/\bACC\b/gi, "预测准确率")
    .replace(/\bCAVs?\b/gi, "网联自动驾驶车辆")
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
    .replace(/\bARIMA\b/gi, "差分整合移动平均模型")
    .replace(/\bDLDP\b/gi, "深度学习目的地预测方法")
    .replace(/\bNAUTILUS\b|\bRESTler\b|\bZAP\b|\bBurp\s*Suite\b/gi, "传统安全测试工具")
    .replace(/麻雀搜索算法算法/g, "麻雀搜索算法")
    .replace(/人工智能智能体/g, "智能体")
    .replace(/上下文协议\s*\(\s*模型上下文协议\s*\)/g, "模型上下文协议")
    .replace(/引文理论引文理论/g, "引文理论")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanUiText(text) {
  return trimDanglingTail(String(text || "")
    .replace(/[�]/g, "")
    .replace(/[-]/g, "")
    .replace(/(?:Based on|Supported by|Funded by)\s+(?=本文系|基金|项目|课题|国家|教育部|省|市)/gi, "")
    .replace(/本文系[^。！？!?]{0,320}(?:阶段性研究成果|研究成果|项目|课题|基金)[^。！？!?]{0,120}[。！？!?]?/g, "")
    .replace(/(?:基金项目|基金资助|资助项目|项目编号|课题编号)[:：]?[^。！？!?]{0,260}[。！？!?]?/g, "")
    .replace(/(?:国家社会科学基金|国家自然科学基金|教育部人文社会科学研究|省教育科技创新科研项目)[^。！？!?]{0,260}[。！？!?]?/g, "")
    .replace(/\b(?:Based on the|Abstract|Keywords?)[:：]?\s*/gi, "")
    .replace(/\.{3}|…/g, "")
    .replace(/\s*[\u2026]+/g, "")
    .replace(/\s+([,，。；;:：])/g, "$1")
    .replace(/([。；;:：]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim());
}

function trimDanglingTail(text) {
  let clean = String(text || "").trim();
  clean = clean.replace(/[(（\[【"'“‘]+[。；;,.，、\s]*$/g, "");
  const pairs = [["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"], ["“", "”"], ["‘", "’"]];
  for (const [open, close] of pairs) {
    if (clean.lastIndexOf(open) > clean.lastIndexOf(close)) {
      const index = clean.lastIndexOf(open);
      if (index >= Math.floor(clean.length * 0.45)) clean = clean.slice(0, index);
      continue;
    }
    const opens = (clean.match(new RegExp(escapeRegExp(open), "g")) || []).length;
    const closes = (clean.match(new RegExp(escapeRegExp(close), "g")) || []).length;
    if (opens > closes) {
      const index = clean.lastIndexOf(open);
      if (index >= Math.floor(clean.length * 0.55)) clean = clean.slice(0, index);
    }
  }
  return clean
    .replace(/[(（][^()（）]{0,24}[。.]?$/g, "")
    .replace(/[，,、；;:：\-—\s]+$/g, "")
    .replace(/(?:核心结论是)?(?:贡献结论|核心主张|原文显示主要贡献或结论是)$/g, "")
    .trim();
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function plainLanguageText(text) {
  return String(text || "")
    .replace(/麻雀搜索算法优化的长短期记忆网络与支持向量回归组合预测模型/g, "融合时间规律识别和误差修正的组合预测方法")
    .replace(/长短期记忆网络与支持向量回归结合的预测模型/g, "时间序列预测与误差修正结合的模型")
    .replace(/奇异谱分析\s*\(\s*奇异谱分析\s*,\s*麻雀搜索算法\s*\)/g, "奇异谱分析")
    .replace(/奇异谱分析\s*\([^)]{0,40}麻雀搜索算法[^)]{0,40}\)/g, "奇异谱分析")
    .replace(/^(摘要|关键词|\[关键词\])[:：]?/, "")
    .replace(/^[,，;；:：\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function preferChineseText(text) {
  const original = String(text || "").replace(/\s+/g, " ").trim();
  const originalCjk = (original.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (!originalCjk) return original;
  let clean = original
    .replace(/(?:Based on|Supported by|Funded by)\s+(?=本文系|基金|项目|课题|国家|教育部|省|市)/gi, "")
    .replace(/[|｜]\s*[A-Za-z][A-Za-z &]+(?:\d{4}.*)?$/g, "")
    .replace(/\b[A-Z][A-Za-z]+(?:\s+[A-Z]?[A-Za-z]+){4,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  if (latin > cjk * 1.2) {
    const chineseOnly = clean.split(/[。！？!?；;]/)
      .filter((part) => (part.match(/[\u4e00-\u9fa5]/g) || []).length >= 8)
      .join("。");
    if (chineseOnly) clean = chineseOnly;
  }
  return clean.replace(/\s+/g, " ").trim();
}
