import crypto from "node:crypto";
import fs from "node:fs/promises";

export function createAtomicJsonFile({ filePath, fallback, fsApi = fs }) {
  if (!filePath) throw new Error("filePath is required for atomic JSON storage.");
  if (typeof fallback !== "function") throw new Error("fallback must create a fresh default value.");

  async function read() {
    try {
      return JSON.parse(await fsApi.readFile(filePath, "utf8"));
    } catch {
      return fallback();
    }
  }

  async function write(value) {
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fsApi.writeFile(temporaryPath, JSON.stringify(value, null, 2));
      await fsApi.rename(temporaryPath, filePath);
    } catch (error) {
      if (typeof fsApi.rm === "function") await fsApi.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  return Object.freeze({ read, write });
}
