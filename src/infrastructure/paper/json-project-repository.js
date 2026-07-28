import { createAtomicJsonFile } from "../storage/atomic-json-file.js";

export function createJsonProjectRepository({ filePath }) {
  const file = createAtomicJsonFile({ filePath, fallback: () => ({ projects: [] }) });

  async function readStore() {
    const store = await file.read();
    if (!Array.isArray(store.projects)) store.projects = [];
    return store;
  }

  async function list() {
    const store = await readStore();
    return store.projects.map(projectSummary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function get(id) {
    const store = await readStore();
    return structuredClone(store.projects.find((item) => item.id === id) || null);
  }

  async function save(project) {
    const store = await readStore();
    const index = store.projects.findIndex((item) => item.id === project.id);
    if (index === -1) store.projects.push(structuredClone(project));
    else store.projects[index] = structuredClone(project);
    await file.write(store);
    return structuredClone(project);
  }

  async function remove(id) {
    const store = await readStore();
    const index = store.projects.findIndex((item) => item.id === id);
    if (index === -1) return false;
    store.projects.splice(index, 1);
    await file.write(store);
    return true;
  }

  return Object.freeze({ list, get, save, remove });
}

function projectSummary(project) {
  return {
    id: project.id,
    title: project.title,
    topic: project.topic,
    paperType: project.paperType,
    documentCount: project.documentIds?.length || 0,
    sectionCount: project.outline?.length || 0,
    draftBlockCount: project.draftBlocks?.length || 0,
    auditStatus: project.audit?.status || "not_run",
    updatedAt: project.updatedAt,
    createdAt: project.createdAt
  };
}
