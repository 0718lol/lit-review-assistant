import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MINIMUM_NODE_MAJOR = 18;

export async function checkRuntimeEnvironment({ paths, nodeVersion = process.versions.node, fsApi = fs } = {}) {
  if (!paths) throw new Error("paths are required for runtime checks.");
  const major = Number.parseInt(String(nodeVersion || "").split(".")[0], 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(`Node.js 版本过低：当前 ${nodeVersion || "未知"}，至少需要 ${MINIMUM_NODE_MAJOR}.0.0。`);
  }

  const directories = [
    paths.dataDir,
    paths.uploadDir,
    paths.originalDir,
    paths.backupDir,
    paths.ocrLangDir,
    paths.pendingUploadDir
  ];
  for (const directory of directories) {
    try {
      await fsApi.access(directory, constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new Error(`运行目录不可读写：${directory}（${error?.message || "权限不足"}）。`);
    }
  }

  const warnings = [];
  for (const language of ["chi_sim", "eng"]) {
    const modelPath = path.join(paths.ocrLangDir, `${language}.traineddata.gz`);
    try {
      await fsApi.access(modelPath, constants.R_OK);
    } catch {
      warnings.push(`OCR 语言模型缺失：${modelPath}；普通文本解析仍可使用，图片型 PDF 的识别可能失败。`);
    }
  }
  return Object.freeze({ nodeVersion: String(nodeVersion), warnings });
}

export function startupListenError(error, { host, port } = {}) {
  if (error?.code === "EADDRINUSE") return `启动失败：${host}:${port} 端口已被占用，请设置其他 PORT 后重试。`;
  if (error?.code === "EACCES") return `启动失败：没有权限监听 ${host}:${port}，请改用普通用户端口。`;
  return `启动失败：无法监听 ${host}:${port}（${error?.message || "未知错误"}）。`;
}
