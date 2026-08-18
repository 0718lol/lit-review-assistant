import fs from "node:fs/promises";
import path from "node:path";

export function createLibraryBackup({ storePath, backupDir, retention = 30, fsApi = fs, now = () => new Date() } = {}) {
  if (!storePath || !backupDir) throw new Error("library and backup paths are required.");

  return async function backupLibrary() {
    try {
      const content = await fsApi.readFile(storePath);
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      await fsApi.writeFile(path.join(backupDir, `library-${stamp}.json`), content);
      const backups = (await fsApi.readdir(backupDir)).filter((file) => /^library-.*\.json$/.test(file)).sort();
      for (const file of backups.slice(0, Math.max(0, backups.length - retention))) {
        await fsApi.rm(path.join(backupDir, file), { force: true }).catch(() => {});
      }
    } catch {
      // A missing previous library is expected on first use; backups remain best effort.
    }
  };
}
