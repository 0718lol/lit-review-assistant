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
  return String(text || "")
    .replace(/[�]/g, "")
    .replace(/[-]/g, "")
    .replace(/\.{3}|…/g, "")
    .replace(/\s*[\u2026]+/g, "")
    .replace(/\s+([,，。；;:：])/g, "$1")
    .replace(/([。；;:：]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
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
