import { normalizeText } from "../../../shared/text/core.js";

export function assessPdfPageText(text = "") {
  const clean = normalizeText(text);
  const cjkCount = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = clean.match(/[A-Za-z]{3,}/g) || [];
  const meaningfulCount = cjkCount + latinWords.reduce((sum, word) => sum + word.length, 0);
  const privateGlyphs = (clean.match(/[�\uE000-\uF8FF]/g) || []).length;
  const lines = clean.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const shortLines = lines.filter((line) => line.length <= 3).length;
  const privateGlyphRatio = privateGlyphs / Math.max(1, clean.length);
  const shortLineRatio = shortLines / Math.max(1, lines.length);
  const reasons = [];

  if (meaningfulCount < 24) reasons.push("insufficient_text");
  if (privateGlyphRatio > 0.02) reasons.push("private_glyphs");
  if (lines.length >= 12 && shortLineRatio > 0.55) reasons.push("fragmented_lines");

  const status = meaningfulCount < 24
    ? "unreadable"
    : reasons.length
      ? "suspicious"
      : "healthy";
  const score = Math.max(0, Math.min(1,
    Math.min(1, meaningfulCount / 180) -
    Math.min(0.5, privateGlyphRatio * 4) -
    (shortLineRatio > 0.55 ? 0.2 : 0)
  ));

  return {
    status,
    score: Number(score.toFixed(2)),
    meaningfulCount,
    privateGlyphRatio: Number(privateGlyphRatio.toFixed(4)),
    shortLineRatio: Number(shortLineRatio.toFixed(4)),
    reasons
  };
}

export function assessPdfTextCoverage(pageTexts = [], expectedPages = pageTexts.length) {
  const pageCount = Math.max(Number(expectedPages || 0), pageTexts.length);
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    ...assessPdfPageText(pageTexts[index] || "")
  }));
  const healthyCount = pages.filter((page) => page.status === "healthy").length;
  const readableCount = pages.filter((page) => page.status !== "unreadable").length;
  const unreadablePages = pages.filter((page) => page.status === "unreadable").map((page) => page.page);
  const suspiciousPages = pages.filter((page) => page.status === "suspicious").map((page) => page.page);
  const coverage = pageCount ? readableCount / pageCount : 0;
  const status = readableCount === 0
    ? "unreadable"
    : unreadablePages.length || suspiciousPages.length
      ? "partial"
      : "healthy";

  return {
    status,
    pageCount,
    healthyCount,
    readableCount,
    coverage: Number(coverage.toFixed(4)),
    unreadablePages,
    suspiciousPages,
    recoveryPages: [...new Set([...unreadablePages, ...suspiciousPages])].sort((a, b) => a - b),
    pages
  };
}

export function shouldRoutePdfPages(report = {}) {
  return report.status !== "healthy" && Array.isArray(report.recoveryPages) && report.recoveryPages.length > 0;
}

export function pdfPagesForOcr(report = {}) {
  return (report.pages || [])
    .filter((page) => page.status === "unreadable" || page.reasons?.includes("private_glyphs"))
    .map((page) => page.page);
}

export function mergeRecoveredPageTexts(primary = [], recovered = [], report = assessPdfTextCoverage(primary)) {
  const recoverySet = new Set(report.recoveryPages || []);
  const length = Math.max(primary.length, recovered.length, Number(report.pageCount || 0));
  return Array.from({ length }, (_, index) => {
    const page = index + 1;
    const original = normalizeText(primary[index] || "");
    const replacement = normalizeText(recovered[index] || "");
    if (!recoverySet.has(page) || !replacement) return original;
    const originalAssessment = assessPdfPageText(original);
    const recoveredAssessment = assessPdfPageText(replacement);
    return recoveredAssessment.score > originalAssessment.score ? replacement : original;
  });
}
