export function createEvidenceQuality({
  displayText,
  isBoilerplateLine,
  isDataSourceLeadPhrase,
  isFundingOrMetadataNoise = () => false,
  isLikelyTitleOrByline,
  isLowValueChunk,
  toHalfWidth
}) {
  function startsMidSentenceFragment(text = "") {
    const clean = displayText(text);
    if (!clean) return true;
    if (/^[,，。；;:：、)\]）\-−=+*/\\\d\s]+/.test(clean)) return true;
    if (/^(籍|单量|流量|行距离|层策略|用例生成|非线性强的特点|分别为|答是|回答是|于跟随|级感知|策模型|低了|然基于|内在复杂性|方面|其中|同时|因此|这|该|其|他们|它们|这些|上述|前者|后者|结果[,，]|值[,，]|图\d+|表\d+)/.test(clean)) return true;
    if (/^[一二三四五六七八九十]方面/.test(clean)) return true;
    if (/^[^。！？!?；;]{0,10}(?:的|地|得|中|上|下|内|外|后|前|过程|策略|用例|结果)[,，]/.test(clean)) return true;
    return false;
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
    if (isDataSourceLeadPhrase(clean)) return false;
    if (startsMidSentenceFragment(clean)) return true;
    if (/^(之下|之中|其中|因此|同时|并且|以及|或者|从而|对于|基于|通过|采用|利用|为了|与|和|的|了|在|将|由|把|向|对|模型|特征|征)[\u4e00-\u9fa5,，]/.test(clean)) return true;
    if (/[，,、:：]$/.test(clean) && clean.length < 120) return true;
    if (/(?:和|及|与|或|的|将|把|对|在|基于|通过|采用)[。！？!?；;]?$/.test(clean)) return true;
    return false;
  }

  function isEvidenceNoise(text) {
    const clean = toHalfWidth(String(text || "")).replace(/\s+/g, " ").trim();
    if (isFundingOrMetadataNoise(clean)) return true;
    if (/^[\u4e00-\u9fa5]{1,4}[、，][\u4e00-\u9fa5]{1,4}[:：]《[^》]{2,80}》.*(?:19|20)\d{2}年?\.?$/.test(clean)) return true;
    return /基金项目|基金资助|作者简介|收稿日期|修回日期|通信作者|通讯作者|参考文献|相似文章推荐|本文引用格式|引用格式|Citation format|关键词[:：]|中图分类号|文献标志码|文章编号|版权所有|copyright|doi[:：]|https?:\/\/|www\./i.test(clean) ||
      /^[\d\s\-—–.,;:()（）]+$/.test(clean) ||
      /(大学|学院|研究院|实验室|中心)[,， ]*(大学|学院|研究院|实验室|中心)/.test(clean);
  }

  function evidenceTypeForQuote(text = "") {
    const clean = displayText(text);
    if (!clean) return { type: "missing", role: "缺失证据", directQuoteEligible: false };
    const sourceLead = isDataSourceLeadPhrase(clean);
    const symbolCount = (clean.match(/[=<>∑√±×÷≈≤≥{}[\]|]/g) || []).length;
    const formulaLike = isFormulaFragment(clean) ||
      /(?:式\s*\(?\d+\)?|公式|其中\s*[A-Za-z]\s*为|变量|系数|参数|−1|ρ=|β=|α=|λ=)/.test(clean) ||
      (symbolCount >= 3 && symbolCount / Math.max(clean.length, 1) > 0.04);
    const tableReference = /(?:表\s*\d+|table\s*\d+|如表\s*\d+|见表\s*\d+)/i.test(clean);
    const figureReference = /(?:图\s*\d+|figure\s*\d+|如图\s*\d+|见图\s*\d+|图\d+\([a-z]\))/i.test(clean);
    const deferredToTable = /(?:结果|数据|数值|指标|趋势|比较)(?:见|如)表\s*\d+(?:所示)?[。；;]?$/i.test(clean);
    const deferredToFigure = /(?:结果|数据|数值|指标|趋势|结构)(?:见|如)图\s*\d+(?:\([a-z]\))?(?:所示)?[。；;]?$/i.test(clean);
    const pointerOnly = /^(?:具体)?(?:见|如)(?:图|表)\s*\d+(?:\([a-z]\))?(?:所示)?[。；;]?$/i.test(clean);
    const fragmentLike = (!sourceLead && startsMidSentenceFragment(clean)) ||
      (!sourceLead && isIncompleteEvidenceFragment(clean)) ||
      /^[,，。；;:：)\]）\-−=+*/\\\d\s]+/.test(clean) ||
      /^[−\-–—]?\s*\d+(?:\.\d+)?\s*[,，;；]?\s*其中/.test(clean);
    if (fragmentLike && formulaLike) return { type: "invalid_fragment", role: "残缺公式片段", directQuoteEligible: false };
    if (formulaLike) return { type: "metric_evidence", role: "公式/指标证据，需回原文表格或公式核对", directQuoteEligible: false };
    if (tableReference && (pointerOnly || deferredToTable)) return { type: "metric_evidence", role: "表格/指标证据，需回表核对", directQuoteEligible: false };
    if (figureReference && (pointerOnly || deferredToFigure)) return { type: "figure_evidence", role: "图示证据，需回图核对", directQuoteEligible: false };
    if (fragmentLike) return { type: "invalid_fragment", role: "残句或跨段片段", directQuoteEligible: false };
    if (isFundingOrMetadataNoise(clean) || /参考文献|DOI|作者简介|基金项目|通讯作者|收稿日期|修回日期|责任编辑/i.test(clean)) {
      return { type: "context_only", role: "来源或版面信息，不可作结论证据", directQuoteEligible: false };
    }
    const researchBullet = clean.length >= 42 && /\b(?:we (?:use|propose|develop|show|find|evaluate)|method|approach|result|data|dataset|limitation|challenge|objective)\b/i.test(clean);
    if (!/[。.！？!?；;]$/.test(clean) && clean.length < 80 && !researchBullet) return { type: "context_only", role: "短片段背景信息", directQuoteEligible: false };
    return { type: "direct_quote", role: "完整自然句，可作为直接原文证据", directQuoteEligible: true };
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
    const sourceLead = context.key === "data_or_materials" && isDataSourceLeadPhrase(clean);
    if (/^[,，。；;:：)\]）\-−=+*/\\\d\s]+/.test(clean) || (!sourceLead && startsMidSentenceFragment(clean))) {
      score -= 0.28;
      issues.push("starts_mid_sentence");
    }
    if (/[，,、:：]$/.test(clean) || (!sourceLead && isIncompleteEvidenceFragment(clean))) {
      score -= 0.18;
      issues.push("incomplete_sentence");
    }
    if (isFormulaFragment(clean) || /(?:ρ|β|α|λ|∑|−1|=\s*\d|其中\s*[A-Za-z]\s*为|变量|系数|参数)/.test(clean)) {
      score -= 0.3;
      issues.push("formula_fragment");
    }
    if (isFundingOrMetadataNoise(clean) || /参考文献|DOI|http|基金项目|作者简介|通讯作者|收稿日期|修回日期|责任编辑|第\s*\d+\s*卷|No\.\d|Vol\./i.test(clean)) {
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

  function notUsableReason({ quote, dimension, support, quoteQuality, evidenceType }) {
    if (!quote?.text) return "missing_quote";
    if (evidenceType && !evidenceType.directQuoteEligible) return `not_direct_quote:${evidenceType.type}`;
    if (quoteQuality?.score != null && quoteQuality.score < 0.5) return `low_quote_quality:${quoteQuality.issues.join(",") || "quote_quality_low"}`;
    const blockingQualityIssues = (quoteQuality?.issues || []).filter((issue) => /formula_fragment|reference_noise|header_footer_noise|starts_mid_sentence|incomplete_sentence/.test(issue));
    if (blockingQualityIssues.length) return `quote_quality:${blockingQualityIssues.join(",")}`;
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

  return {
    evidenceTypeForQuote,
    isEvidenceNoise,
    isFormulaFragment,
    isIncompleteEvidenceFragment,
    missingReasonForEvidence,
    notUsableReason,
    quoteQualityAssessment,
    sourceQualityForCandidate,
    startsMidSentenceFragment
  };
}
