import crypto from "node:crypto";
import fs from "node:fs/promises";

export function createAtomicJsonFile({ filePath, fallback }) {
  if (!filePath) throw new Error("filePath is required for atomic JSON storage.");
  if (typeof fallback !== "function") throw new Error("fallback must create a fresh default value.");

  async function read() {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      return fallback();
    }
  }

  async function write(value) {
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2));
    await fs.rename(temporaryPath, filePath);
  }

  return Object.freeze({ read, write });
}
