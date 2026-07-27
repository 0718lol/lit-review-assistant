export function uploadFileIssue(file) {
  const name = String(file?.name || "");
  const lower = name.toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (lower.endsWith(".pdf") || lower.endsWith(".pptx")) return "";
  if (type === "application/pdf" || type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "";
  if (lower.endsWith(".ppt")) return `${name} 是旧版 PPT，请另存为 PPTX 或导出为 PDF 后上传。`;
  return `${name || "当前文件"} 不是支持的资料格式；当前支持 PDF 和 PPTX。`;
}
