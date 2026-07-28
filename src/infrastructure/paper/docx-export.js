import JSZip from "jszip";

export async function createPaperDocx(project) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes());
  zip.file("_rels/.rels", rootRelationships());
  zip.file("docProps/core.xml", coreProperties(project));
  zip.file("docProps/app.xml", appProperties());
  zip.file("word/document.xml", documentXml(project));
  zip.file("word/styles.xml", stylesXml());
  zip.file("word/_rels/document.xml.rels", documentRelationships());
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function documentXml(project) {
  const blocksBySection = new Map((project.outline || []).map((section) => [
    section.id,
    (project.draftBlocks || []).filter((block) => block.sectionId === section.id).sort((a, b) => a.order - b.order)
  ]));
  const body = [
    paragraph(project.title || "未命名论文", "Title"),
    ...((project.outline || []).flatMap((section) => [
      paragraph(section.title, "Heading1"),
      ...(blocksBySection.get(section.id) || []).map((block) => paragraph(block.text, "Normal"))
    ])),
    paragraph("参考文献", "Heading1"),
    ...((project.references || []).map((ref) => paragraph(`[${ref.number}] ${formatReference(ref, project.citationStyle)}`, "Reference"))),
    paragraph("证据审计附录", "Heading1"),
    paragraph(`审计状态：${auditStatus(project.audit)}`, "Audit"),
    ...((project.audit?.issues || []).map((issue) => paragraph(`[${severityLabel(issue.severity)}] ${issue.message}`, "Audit")))
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

function paragraph(text, style) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xml(clean)}</w:t></w:r></w:p>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:lang w:val="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="480"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="480"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:spacing w:before="360" w:after="180"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Reference"><w:name w:val="Reference"/><w:pPr><w:ind w:left="480" w:hanging="480"/><w:spacing w:after="80"/></w:pPr><w:rPr><w:sz w:val="21"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Audit"><w:name w:val="Audit"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;
}

function contentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

function rootRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function documentRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function coreProperties(project) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(project.title || "未命名论文")}</dc:title><dc:creator>文献速读与综述助手</dc:creator><cp:lastModifiedBy>文献速读与综述助手</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

function appProperties() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Literature Review Assistant</Application></Properties>`;
}

function formatReference(ref, style) {
  const authors = (ref.authors || []).join(", ") || "作者待核对";
  if (style === "apa") return `${authors}. (${ref.year || "n.d."}). ${ref.title}. ${ref.journal || ""}.`;
  return `${authors}. ${ref.title}[J]. ${ref.journal || "来源待核对"}, ${ref.year || "年份待核对"}.`;
}

function auditStatus(audit = {}) { return ({ ready: "通过", blocked: "存在阻止导出的证据问题", needs_review: "需要人工核对", not_run: "尚未运行" })[audit.status] || audit.status || "尚未运行"; }
function severityLabel(value) { return ({ blocker: "阻止项", warning: "待核对", info: "提示" })[value] || value; }
function xml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
