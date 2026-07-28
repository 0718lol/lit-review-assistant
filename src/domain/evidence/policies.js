export function createEvidencePolicies({ displayText }) {
  if (typeof displayText !== "function") throw new Error("displayText is required by evidence policies.");

  function classifyEvidenceCandidate(text = "") {
    const clean = displayText(text);
    const checks = [
      ["limitation", "limitation_boundary", /不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏|limitation|constraint|risk|bias|cannot|may fail|future work|challenge/i],
      ["method", "method_action", /采用|构建|提出|设计|使用|基于|利用|引入|建立|开发|实现|融合|分解|优化|训练|控制|检测|识别|可通过|we (?:use|propose|develop|train|evaluate)|method|approach|framework|algorithm|pipeline/i],
      ["data_or_materials", "data_source", /实验数据采用|数据采用|数据来源|样本来源|研究对象|实验对象|应用场景|仿真场景|问卷|访谈|订单|接口|漏洞|期刊|文献|引文|数据集|data|dataset|sample|corpus|participants|documents|case study|benchmark/i],
      ["evidence", "result_metric", /实验|仿真|指标|结果|对比|验证|图\s*\d+|表\s*\d+|\d+(?:\.\d+)?\s*%|准确率|召回率|误差|延误|求解速度|发现率|发文量|相关系数|ρ=|experiment|evaluation|result|metric|accuracy|error|comparison/i],
      ["research_question", "problem_statement", /针对|解决|问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有|重要|research question|problem|objective|aim|motivation|(?:this (?:study|paper|work)|we) (?:examines?|investigates?|addresses?|studies?)/i],
      ["contribution", "contribution_claim", /贡献|创新|有效|提升|降低|优于|实现|价值|意义|结论|表明|证明|发现|contribution|we (?:show|find|demonstrate|present)|results? (?:show|suggest)|conclude/i]
    ];
    const matched = checks.find(([, , pattern]) => pattern.test(clean));
    if (!matched) return { dimension: "background", spanType: "background_or_noise", confidence: 0.35 };
    return { dimension: matched[0], spanType: matched[1], confidence: 0.78 };
  }

  function candidateTypesForQuote(text = "") {
    const clean = displayText(text);
    const types = [];
    if (/针对|解决|问题|挑战|不足|缺乏|目的|旨在|需求|难以|现有|research question|problem|objective|aim|motivation|(?:this (?:study|paper|work)|we) (?:examines?|investigates?|addresses?|studies?)/i.test(clean)) types.push("research_question");
    if (/采用|构建|提出|设计|使用|基于|利用|引入|建立|开发|融合|分解|优化|训练|控制|检测|识别|分析|we (?:use|propose|develop|train|evaluate)|method|approach|framework|algorithm|pipeline/i.test(clean)) types.push("method");
    if (/数据|样本|材料|文献|语料|案例|对象|场景|仿真|问卷|订单|接口|漏洞|期刊|引文|数据集|data|dataset|sample|corpus|participants|documents|case study|benchmark/i.test(clean)) types.push("data_or_materials");
    if (/结果|表明|证明|发现|显示|提升|降低|优于|有效|结论|贡献|创新|result|finding|show|demonstrate|accuracy|error|experiment|evaluation/i.test(clean)) types.push("evidence");
    if (/不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|泛化|约束|瓶颈|缺乏|limitation|constraint|risk|bias|cannot|may fail|future work|challenge/i.test(clean)) types.push("limitations");
    return types.length ? types : ["background"];
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
    if (classificationDimension === "limitation" && key !== "limitations") return false;
    const types = candidate.candidateTypes || candidateTypesForQuote(candidate.quote || "");
    if (key === "research_question" && types.includes("data_or_materials") && !isExplicitResearchQuestionCandidate(candidate.quote)) return false;
    if (types.includes(key)) return true;
    if (key === "main_claims" && types.some((type) => ["contribution", "evidence", "research_question"].includes(type))) return true;
    if (key === "contribution" && types.some((type) => ["contribution", "evidence"].includes(type))) return true;
    return false;
  }

  function isExplicitResearchQuestionCandidate(text = "") {
    const clean = displayText(text);
    return /研究问题|研究目的|问题[:：]|(?:本文|本研究|文章|该文|we|this (?:study|paper|work)).{0,28}(?:旨在|目的|针对|解决|探讨|考察|研究|objective|aim|address|investigate|examine)|针对[^。；;]{4,100}(?:问题|挑战|不足|需求)|\b(?:research question|problem statement|objective|aim)\b/i.test(clean);
  }

  function fieldSelectionBoost(key, quote = "") {
    const clean = displayText(quote);
    let boost = 0;
    if (startsMidSentenceFragment(clean)) boost -= 28;
    if (key === "method") {
      if (/(?:本文|本研究|文章|该文).{0,20}(?:采用|运用|使用|提出|构建|设计|基于|利用|引入|建立|开发)/.test(clean)) boost += 24;
      if (/(?:本文|本研究).{0,18}提出一种[^。；;]{6,80}(?:方法|模型|框架|策略|流程)/.test(clean)) boost += 30;
      if (/鉴于此,?(?:本文|本研究).{0,18}提出一种/.test(clean)) boost += 18;
      if (/为此,?拟通过|定量与定性结合|知识图谱绘制|文献计量综合分析/.test(clean)) boost += 22;
      if (/已有|综述了|相关研究|理论基础/.test(clean) && !/为此|本文|本研究|拟通过/.test(clean)) boost -= 18;
      if (/并不特别要求某种指定的控制策略|可以与本文提出的控制模块替换|可以与提出的控制模块替换/.test(clean)) boost -= 30;
      if (/分别为|遗忘门|输入门|输出门|对偶问题|KKT|公式|变量|系数/.test(clean)) boost -= 24;
    }
    if (key === "data_or_materials") {
      if (/实验数据采用|数据采用|数据来源|样本来源|研究对象为|选取[^。；;]{0,40}(?:数据|样本|案例|对象)/.test(clean)) boost += 28;
      if (/(?:实验设计)?基于SUMO|微观仿真软件|搭建[^。；;]{0,50}(?:仿真实验场景|实验场景|仿真场景)/.test(clean)) boost += 56;
      if (/具体实验场景/.test(clean)) boost += 12;
      if (/筛选的\s*\d+\s*篇文献|\d+\s*篇(?:文献|论文)|中国知网|期刊来源类别|样本文献|数据集|订单数据|出行流量数据/.test(clean)) boost += 28;
      if (/中国知网.{0,80}(?:期刊|论文|文献)|(?:期刊|论文|文献).{0,80}中国知网/.test(clean)) boost += 16;
      if (/仿真实验表明|结果表明|实验表明|研究发现|显著降低|平均延误|提升|优于|有效/.test(clean)) boost -= 36;
      if (/^(?:具体)?实验场景设计如图\d+所示[。；;]?$/.test(clean)) boost -= 46;
      if (/如图\d+所示[。；;]?$/.test(clean) && !/(?:基于SUMO|微观仿真软件|搭建|数据来源|样本来源|实验数据采用|数据采用)/.test(clean)) boost -= 30;
      if (/^\S{0,8}(?:距离|数量|比例|占比|平均)/.test(clean)) boost -= 14;
    }
    if (key === "evidence") {
      if (/结果表明|实验表明|仿真.*表明|对比|优于|提升|降低|准确率|召回率|误差|延误|\d+(?:\.\d+)?\s*%/.test(clean)) boost += 18;
      if (/机制|逻辑设定|反馈|认同效果|传播范围|传播效果|影响|解释|表明|说明|证明/.test(clean)) boost += 8;
      if (/实验数据采用|数据来源|样本来源/.test(clean) && !/结果|表明|对比|提升|降低|优于/.test(clean)) boost -= 18;
    }
    if (key === "limitations") {
      if (/虽然[^。；;]{0,80}但|不足|局限|限制|依赖|偏差|风险|仍需|不能|难以|挑战|误报|外推|瓶颈/.test(clean)) boost += 18;
      if (/提供.*可能|机遇|提升|优化|有效|优势|有助于/.test(clean) && !/不足|局限|限制|风险|挑战|难以/.test(clean)) boost -= 18;
    }
    if (key === "contribution") {
      if (/^(?:贡献|主要贡献|contribution)[:：]/i.test(clean)) boost += 30;
      if (/\d+(?:\.\d+)?\s*%|accuracy|precision|recall|error rate|结果表明|实验表明/i.test(clean) && !/^(?:贡献|主要贡献|contribution)[:：]/i.test(clean)) boost -= 12;
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

  function isDataSourceLeadPhrase(text = "") {
    const clean = displayText(text);
    return /^(?:(?:实验设计)?基于SUMO|基于[^。；;]{2,50}(?:数据集|语料库|数据库|样本|文献|论文|实验场景|仿真场景)|实验数据采用|数据采用|数据来源|样本来源|材料来源|研究对象为|实验对象为|在(?:中国知网|CNKI)|首先,?在(?:中国知网|CNKI)|data(?: and materials| source)?[:：]|the data\b|the (?:training|test|validation) (?:data|set)\b|we (?:use|evaluate on|train on)[^.;]{0,80}(?:data|dataset|benchmark|corpus|sample))/i.test(clean) && /[。！？!?；;]$/.test(clean);
  }

  return Object.freeze({
    candidateMatchesField,
    candidateMatchesFieldContext,
    candidateTypesForQuote,
    claimTypeForField,
    classifyEvidenceCandidate,
    fieldSelectionBoost,
    isDataSourceLeadPhrase,
    isExplicitResearchQuestionCandidate
  });
}

function startsMidSentenceFragment(text = "") {
  const clean = String(text || "").trim();
  if (!clean) return true;
  if (/^[,，。；;:：、)\]）\-−=+*/\\\d\s]+/.test(clean)) return true;
  if (/^(籍|单量|流量|行距离|层策略|用例生成|非线性强的特点|分别为|于跟随|级感知|策模型|低了|然基于|内在复杂性|方面|其中|同时|因此|这|该|其|他们|它们|这些|上述|前者|后者|结果|值|图\d+|表\d+)/.test(clean)) return true;
  if (/^[一二三四五六七八九十]方面/.test(clean)) return true;
  return /^[^。！？!?；;]{0,10}(?:的|地|得|中|上|下|内|外|后|前|过程|策略|用例|结果)[,，]/.test(clean);
}
