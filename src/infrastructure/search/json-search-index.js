import fs from "node:fs/promises";

export function createJsonSearchIndex({ filePath, version, buildIndex, fsApi = fs } = {}) {
  if (!filePath || !Number.isInteger(version) || typeof buildIndex !== "function") {
    throw new Error("search index path, version, and builder are required.");
  }

  async function read() {
    return JSON.parse(await fsApi.readFile(filePath, "utf8"));
  }

  async function write(library) {
    await fsApi.writeFile(filePath, JSON.stringify(buildIndex(library)));
  }

  async function ensure(library) {
    try {
      const index = await read();
      const docs = library.docs || [];
      const indexedIds = new Set((index.docs || []).map((doc) => doc.id));
      if (index.version === version && docs.length === indexedIds.size && docs.every((doc) => indexedIds.has(doc.id))) return index;
    } catch {
      // Missing or invalid indexes are rebuilt from the canonical library.
    }
    await write(library);
    return read();
  }

  async function load(library) {
    try {
      return await read();
    } catch {
      await write(library);
      return read();
    }
  }

  return Object.freeze({ read, write, ensure, load });
}
