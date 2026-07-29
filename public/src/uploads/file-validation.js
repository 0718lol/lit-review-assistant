export function uploadFileIssue(file) {
  const name = String(file?.name || "");
  const lower = name.toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (lower.endsWith(".pdf") || lower.endsWith(".pptx") || lower.endsWith(".docx") || lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "";
  if (type === "application/pdf" || type === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || type === "text/markdown" || type === "text/plain") return "";
  if (lower.endsWith(".ppt")) return `${name} 是旧版 PPT，请另存为 PPTX 或导出为 PDF 后上传。`;
  if (lower.endsWith(".doc")) return `${name} 是旧版 Word，请另存为 DOCX 或导出为 PDF 后上传。`;
  return `${name || "当前文件"} 不是支持的资料格式；当前支持 PDF、PPTX、DOCX、Markdown 和 TXT。`;
}
