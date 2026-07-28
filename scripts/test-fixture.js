import fs from "node:fs/promises";
import path from "node:path";

const createdAt = "2026-01-01T00:00:00.000Z";

function fixtureDoc(id, title, journal, paragraphs, options = {}) {
  const sourceType = options.sourceType || "pdf";
  return {
    id,
    filename: `${title}.${sourceType === "pptx" ? "pptx" : "pdf"}`,
    title,
    journal,
    pages: paragraphs.length,
    wordCount: paragraphs.join(" ").length,
    keywords: [],
    keyPoints: [],
    chunks: paragraphs.map((text, index) => ({
      index: index + 1,
      text,
      page: index + 1,
      pageStart: index + 1,
      pageEnd: index + 1,
      citation: `p.${index + 1}`,
      section: index === 0 ? "abstract" : index === paragraphs.length - 1 ? "conclusion" : "method",
      terms: []
    })),
    sourceType,
    sourceUnit: sourceType === "pptx" ? "slide" : "page",
    pdfCleanVersion: 4,
    createdAt,
    updatedAt: createdAt
  };
}

export async function writeTestDataDir(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const docs = [
    fixtureDoc("fixture-traffic-control", "新型混合交通交叉口信号与车辆轨迹协同控制方法", "交通运输系统工程与信息", [
      "研究问题：本文旨在解决混合交通交叉口中信号配时与车辆轨迹难以协同优化的问题。",
      "方法路径：本文构建信号配时与车辆轨迹双层协同控制框架，并通过滚动优化算法求解。",
      "实验设计基于SUMO微观仿真软件搭建三组交通需求场景，并生成仿真车辆轨迹数据作为研究对象。",
      "实验结果表明，该方法降低平均延误 18.4%，并提高交叉口通过效率 11.2%。",
      "局限边界：当前实验依赖仿真场景，真实道路中的泛化能力仍需进一步验证。"
    ]),
    fixtureDoc("fixture-ride-hailing", "混合模型在网约车出行预测研究中的应用", "交通运输系统工程与信息", [
      "研究问题：本文研究城市网约车订单在周期波动和突发需求下的短时预测问题。",
      "方法路径：本文采用时间序列分解与组合预测模型，对趋势项和周期项分别建模。",
      "数据材料：实验数据采用 2017 年海口市两个月的 270 万条网约车订单。",
      "结果表明，组合模型的平均预测误差低于三个单一基线模型。",
      "局限边界：模型依赖单一城市订单数据，跨城市应用仍需验证。"
    ]),
    fixtureDoc("fixture-books", "近三十年域外汉籍研究的现状与展望", "图书馆理论与实践", [
      "研究问题：本文旨在梳理近三十年域外汉籍研究的主题演进和研究不足。",
      "方法路径：研究采用文献计量综合分析和知识图谱绘制方法。",
      "数据材料：研究从中国知网筛选 809 篇核心期刊论文作为样本文献。",
      "结果表明，研究热点由文献整理逐步转向传播路径和跨文化阐释。",
      "局限边界：部分海外材料获取困难，样本文献覆盖仍然不足。"
    ]),
    fixtureDoc("fixture-agent", "大语言模型智能体的设计方法研究", "计算机应用", [
      "研究问题：本文研究大语言模型智能体在复杂任务中规划、工具调用和反馈修正的问题。",
      "方法路径：本文提出包含任务分解、语义检索、工具调用和反馈迭代的智能体框架。",
      "数据材料：实验使用三个公开任务数据集和十二类工具调用场景。",
      "评估结果表明，该框架在任务完成率指标上优于无反馈基线模型。",
      "局限边界：智能体仍然依赖工具描述质量，并可能在长任务中累积误差。"
    ]),
    fixtureDoc("fixture-consumer", "人工智能驱动下的消费研究新范式", "营销科学学报", [
      "研究问题：本文探讨生成式人工智能如何改变消费者感知与决策机制。",
      "方法路径：研究构建消费感知、行为模拟和自主实验三阶段分析框架。",
      "数据材料：研究材料包括访谈样本、在线实验数据和消费决策案例。",
      "实验结果显示，不同交互提示会显著改变消费者的风险判断。",
      "局限边界：样本主要来自青年群体，结论不能直接外推到全部消费者。"
    ]),
    fixtureDoc("fixture-english-agent", "Learning From Examples for Intelligent Agents", "Artificial Intelligence Review", [
      "Research question: This study examines how intelligent agents learn reliable policies from labeled examples;",
      "Method: We compare decision trees, ensemble learning, and neural network classifiers on the same tasks;",
      "Data and materials: The evaluation uses three public benchmark datasets with fixed training and test splits;",
      "Classification systems produce task labels from input features. Results show that ensemble learning improves classification accuracy by 8.2 percentage points over the baseline;",
      "Contribution: The study demonstrates a reproducible evaluation workflow for example-driven intelligent agents;",
      "Limitation: The experiments cover supervised tasks only, so transfer to interactive environments remains uncertain;"
    ], { sourceType: "pptx" })
  ];
  await fs.writeFile(path.join(dataDir, "library.json"), JSON.stringify({ docs }, null, 2));
  await fs.writeFile(path.join(dataDir, "provider-config.json"), JSON.stringify({ provider: "local", model: "", baseUrl: "" }, null, 2));
}
