export function buildTopicClusters(documents = [], claims = []) {
  const profiles = documents.map((doc) => documentProfile(doc, claims.filter((claim) => claim.docIds?.includes(doc.id))));
  const clusters = [];
  for (const profile of profiles) {
    const target = clusters.find((cluster) => shouldJoinCluster(cluster, profile));
    if (target) target.profiles.push(profile);
    else clusters.push({ profiles: [profile] });
  }
  return clusters.map((cluster, index) => clusterSummary(cluster.profiles, index + 1));
}

export function dominantCluster(project = {}) {
  const clusters = project.topicClusters || [];
  const active = clusters.find((cluster) => cluster.id === project.activeClusterId);
  if (active) return active;
  return clusters.find((cluster) => cluster.scope === "same_domain_topic") || clusters[0] || null;
}

function documentProfile(doc, claims = []) {
  const text = cleanText([doc.title, doc.abstract, ...claims.map((claim) => claim.text)].join(" "));
  const terms = topTerms(text);
  return {
    docId: doc.id,
    title: cleanText(doc.title || doc.filename),
    domain: inferDomain(text),
    method: inferMethodType(text),
    evidence: inferEvidenceType(text),
    terms,
    claimIds: claims.map((claim) => claim.id)
  };
}

function shouldJoinCluster(cluster, profile) {
  const head = cluster.profiles[0];
  if (!head) return false;
  if (profile.domain !== "general" && profile.domain === head.domain) return true;
  if (profile.method !== "general_method" && profile.method === head.method && termOverlap(profile.terms, head.terms) >= 0.18) return true;
  return termOverlap(profile.terms, head.terms) >= 0.28;
}

function clusterSummary(profiles, index) {
  const domains = [...new Set(profiles.map((item) => item.domain))];
  const methods = [...new Set(profiles.map((item) => item.method))];
  const evidences = [...new Set(profiles.map((item) => item.evidence))];
  const terms = topTerms(profiles.flatMap((item) => [...item.terms, item.title]).join(" "));
  const scope = profiles.length === 1
    ? "single_source_boundary"
    : domains.length === 1 && methods.length <= 2
      ? "same_domain_topic"
      : methods.length === 1 || evidences.length === 1
        ? "cross_domain_methodology"
        : "unrelated_sources";
  return {
    id: `cluster-${index}`,
    scope,
    label: clusterLabel(domains, terms),
    documentIds: profiles.map((item) => item.docId),
    claimIds: profiles.flatMap((item) => item.claimIds),
    domains,
    methods,
    evidenceTypes: evidences,
    keywords: terms.slice(0, 8),
    writingMode: scope === "same_domain_topic" ? "综合综述" : scope === "cross_domain_methodology" ? "方法论比较" : scope === "single_source_boundary" ? "单篇述评" : "分主题写作",
    canSynthesize: scope === "same_domain_topic" || scope === "cross_domain_methodology"
  };
}

function clusterLabel(domains, terms) {
  const domain = domains.find((item) => item !== "general");
  const labels = {
    agent_security: "智能体与接口安全",
    traffic_control: "交通控制与出行预测",
    bibliometrics: "文献计量与知识图谱",
    marketing_ai: "人工智能营销与消费研究",
    ideology_ai: "生成式人工智能与认同机制",
    llm_agent: "大语言模型智能体"
  };
  return labels[domain] || terms.slice(0, 3).join("、") || "未命名主题";
}

function inferDomain(text) {
  if (/REST|API|漏洞|接口|安全检测/i.test(text)) return "agent_security";
  if (/交叉口|交通|网约车|轨迹|延误|SUMO|出行/i.test(text)) return "traffic_control";
  if (/域外汉籍|文献计量|知识图谱|CiteSpace|CNKI|中国知网/i.test(text)) return "bibliometrics";
  if (/营销|消费|消费者|品牌/i.test(text)) return "marketing_ai";
  if (/意识形态|认同|青年|感性化/i.test(text)) return "ideology_ai";
  if (/智能体|大语言模型|LLM|RAG|工具调用/i.test(text)) return "llm_agent";
  return "general";
}

function inferMethodType(text) {
  if (/实验|仿真|对比|评估|benchmark|evaluation/i.test(text)) return "empirical_evaluation";
  if (/文献计量|知识图谱|共现|引文|CiteSpace|VOSviewer/i.test(text)) return "bibliometric_mapping";
  if (/框架|系统|架构|流程|pipeline|framework/i.test(text)) return "system_framework";
  if (/机制|理论|范式|模型/i.test(text)) return "theoretical_model";
  return "general_method";
}

function inferEvidenceType(text) {
  if (/\d+(?:\.\d+)?\s*%|准确率|召回率|误差|延误|发现率|MAPE|RMSE/i.test(text)) return "metric_evidence";
  if (/访谈|问卷|案例|样本/i.test(text)) return "sample_case";
  if (/文献|期刊|CNKI|中国知网|引文/i.test(text)) return "literature_dataset";
  if (/机制|理论|解释/i.test(text)) return "conceptual_argument";
  return "general_evidence";
}

function topTerms(text) {
  return [...new Set(cleanText(text).match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9-]{2,}/g) || [])]
    .filter((term) => !/^(本文|研究|方法|数据|结果|问题|文献|模型|系统|the|and|for|with)$/i.test(term))
    .slice(0, 24);
}

function termOverlap(left = [], right = []) {
  const a = new Set(left);
  const b = new Set(right);
  const shared = [...a].filter((term) => b.has(term)).length;
  return shared / Math.max(1, new Set([...a, ...b]).size);
}

function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
