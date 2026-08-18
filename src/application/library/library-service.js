import { createSerialExecutor } from "../../shared/async/serial-executor.js";

export function createLibraryService({
  repository,
  backup,
  searchIndex,
  recoverSources,
  migratePdfText,
  ensureEvidence,
  ensureMetadata
} = {}) {
  if (!repository?.read || !repository?.write) throw new Error("library repository is required.");
  if (!backup || !searchIndex?.ensure || !searchIndex?.write) throw new Error("library persistence dependencies are required.");
  const mutations = createSerialExecutor();

  async function load() {
    const library = await repository.read();
    const recovered = await recoverSources(library);
    const pdfChanged = await migratePdfText(recovered.library);
    const evidenceChanged = ensureEvidence(recovered.library);
    const metadataChanged = ensureMetadata(recovered.library);
    if (recovered.changed || pdfChanged || evidenceChanged || metadataChanged) await save(recovered.library);
    else await searchIndex.ensure(recovered.library);
    return recovered.library;
  }

  async function save(library) {
    await backup();
    await repository.write(library);
    await searchIndex.write(library);
  }

  function mutate(operation) {
    return mutations.run(operation);
  }

  return Object.freeze({ load, save, mutate });
}
