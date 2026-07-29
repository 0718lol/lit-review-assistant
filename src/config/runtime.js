import fs from "node:fs/promises";
import path from "node:path";

export function createRuntimeConfig({ rootDir, env = process.env } = {}) {
  if (!rootDir) throw new Error("rootDir is required to build runtime configuration.");
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(rootDir, "data");
  const paths = Object.freeze({
    rootDir,
    dataDir,
    publicDir: path.join(rootDir, "public"),
    uploadDir: path.join(dataDir, "uploads"),
    originalDir: path.join(dataDir, "originals"),
    backupDir: path.join(dataDir, "backups"),
    ocrLangDir: path.join(dataDir, "tessdata"),
    ocrCacheDir: path.join(dataDir, "tesseract-cache"),
    storePath: path.join(dataDir, "library.json"),
    searchIndexPath: path.join(dataDir, "search-index.json"),
    providerConfigPath: path.join(dataDir, "provider-config.json"),
    uploadJobsPath: path.join(dataDir, "jobs.json"),
    paperProjectsPath: path.join(dataDir, "paper-projects.json"),
    pendingUploadDir: path.join(dataDir, "pending")
  });
  return Object.freeze({
    paths,
    host: String(env.HOST || "0.0.0.0"),
    port: Number(env.PORT || 3000),
    defaultOpenAIModel: env.OPENAI_MODEL || "gpt-5",
    defaultAnthropicModel: env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    ocrMaxPages: Number(env.OCR_MAX_PAGES || 0),
    pdfCleanVersion: 4,
    evidenceCardVersion: 47
  });
}

export async function ensureRuntimeDirectories(paths) {
  await Promise.all([
    paths.uploadDir,
    paths.originalDir,
    paths.backupDir,
    paths.ocrLangDir,
    paths.pendingUploadDir
  ].map((directory) => fs.mkdir(directory, { recursive: true })));
}
