import fs from "node:fs/promises";
import path from "node:path";
import { createSerialExecutor } from "../../shared/async/serial-executor.js";

export const ACTIVE_UPLOAD_STATUSES = Object.freeze(["queued", "parsing", "ocr", "enhancing", "saving", "canceling"]);
const INTERRUPTED_UPLOAD_STATUSES = new Set(["parsing", "ocr", "enhancing", "saving", "canceling"]);
const FINISHED_UPLOAD_STATUSES = new Set(["completed", "duplicate", "failed", "canceled"]);

export function createUploadJobStore({ file, pendingDir, fsApi = fs, now = () => new Date().toISOString() } = {}) {
  if (!file?.read || !file?.write || !pendingDir) throw new Error("upload job persistence dependencies are required.");
  const mutations = createSerialExecutor();
  let store = { jobs: [] };

  function pendingPath(job = {}) {
    const pendingFile = path.basename(String(job.pendingFile || ""));
    return pendingFile ? path.join(pendingDir, pendingFile) : "";
  }

  async function initialize() {
    return mutations.run(async () => {
      store = await file.read();
      if (!Array.isArray(store.jobs)) store.jobs = [];
      let changed = false;
      for (const job of store.jobs) {
        if (!INTERRUPTED_UPLOAD_STATUSES.has(job.status)) continue;
        const sourcePath = pendingPath(job);
        if (job.status === "canceling" || job.cancelRequested) {
          Object.assign(job, { status: "canceled", phase: "已取消", error: "", cancelRequested: true, updatedAt: now() });
          if (sourcePath) await fsApi.rm(sourcePath, { force: true }).catch(() => {});
        } else {
          try {
            if (!sourcePath) throw new Error("missing pending file");
            await fsApi.access(sourcePath);
            Object.assign(job, { status: "queued", phase: "等待恢复解析", progress: 0, cancelRequested: false, updatedAt: now() });
          } catch {
            Object.assign(job, { status: "failed", phase: "原始文件缺失", error: "服务重启后找不到待解析文件，请重新上传。", cancelRequested: false, updatedAt: now() });
          }
        }
        changed = true;
      }
      if (changed) await file.write(store);
      return store;
    });
  }

  function all() { return store.jobs; }
  function find(id) { return store.jobs.find((job) => job.id === id) || null; }
  function nextQueued() { return store.jobs.find((job) => job.status === "queued") || null; }
  function hasQueued() { return store.jobs.some((job) => job.status === "queued"); }
  function findActiveByHash(hash) { return store.jobs.find((job) => job.fileHash === hash && ACTIVE_UPLOAD_STATUSES.includes(job.status)) || null; }

  async function mutate(operation) {
    return mutations.run(async () => {
      const result = await operation(store);
      await file.write(store);
      return result;
    });
  }

  async function update(id, patch = {}) {
    return mutate(async () => {
      const job = find(id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: now() });
      return job;
    });
  }

  async function updateProgress(id, patch = {}) {
    return mutate(async () => {
      const job = find(id);
      if (!job || job.cancelRequested) throw Object.assign(new Error("解析任务已取消。"), { code: "JOB_CANCELED" });
      Object.assign(job, patch, { updatedAt: now() });
      return job;
    });
  }

  async function retry(id) {
    return mutate(async () => {
      const job = find(id);
      if (!job) return null;
      if (job.status !== "failed") return { invalid: true, current: job };
      try {
        const sourcePath = pendingPath(job);
        if (!sourcePath) throw new Error("missing pending file");
        await fsApi.access(sourcePath);
      } catch {
        return { missing: true, current: job };
      }
      Object.assign(job, { status: "queued", phase: "等待重试", progress: 0, currentPage: 0, totalPages: 0, error: "", cancelRequested: false, updatedAt: now() });
      return { current: job };
    });
  }

  async function cancel(id) {
    return mutate(async () => {
      const job = find(id);
      if (!job) return null;
      if (FINISHED_UPLOAD_STATUSES.has(job.status)) return { invalid: true, job };
      job.cancelRequested = true;
      if (job.status === "queued") {
        job.status = "canceled";
        job.phase = "已取消";
        const sourcePath = pendingPath(job);
        if (sourcePath) await fsApi.rm(sourcePath, { force: true }).catch(() => {});
      } else {
        job.status = "canceling";
        job.phase = "正在取消";
      }
      job.updatedAt = now();
      return { job };
    });
  }

  async function cancelAll(phase = "资料库已清空") {
    return mutate(async () => {
      for (const job of store.jobs) {
        if (!ACTIVE_UPLOAD_STATUSES.includes(job.status)) continue;
        job.cancelRequested = true;
        if (job.status === "queued") {
          job.status = "canceled";
          job.phase = phase;
          const sourcePath = pendingPath(job);
          if (sourcePath) await fsApi.rm(sourcePath, { force: true }).catch(() => {});
        } else {
          job.status = "canceling";
          job.phase = `${phase}，正在取消`;
        }
        job.updatedAt = now();
      }
    });
  }

  function toPublic(job = {}) {
    return {
      id: job.id,
      filename: job.filename,
      status: job.status,
      phase: job.phase || "",
      progress: Math.max(0, Math.min(100, Number(job.progress || 0))),
      currentPage: Number(job.currentPage || 0),
      totalPages: Number(job.totalPages || 0),
      error: job.error || "",
      docId: job.docId || "",
      docTitle: job.docTitle || "",
      duplicateOf: job.duplicateOf || "",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  return Object.freeze({ initialize, all, find, nextQueued, hasQueued, findActiveByHash, mutate, update, updateProgress, retry, cancel, cancelAll, pendingPath, toPublic });
}
