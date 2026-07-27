export function createInitialState(storage) {
  return {
    docs: [],
    graph: { nodes: [], edges: [] },
    matrix: [],
    researchGaps: null,
    review: "",
    journalReview: "",
    journalReviewVariants: [],
    activeJournalVariantIndex: 0,
    impactAnalysis: null,
    provider: null,
    lastAnswer: null,
    graphCenterId: storage.getItem("graphCenterId") || "",
    selectedGraphEdgeId: "",
    activeDocId: storage.getItem("activeDocId") || "",
    activeDocIds: [],
    selectedDocIds: readStoredSelection(storage),
    scopedCount: 0,
    docFlow: null,
    search: "",
    searchMode: storage.getItem("searchMode") || "title",
    searchResults: null,
    searchLoading: false,
    searchDocId: "",
    expandedDocId: storage.getItem("expandedDocId") || "",
    uploadJobs: []
  };
}

export function readStoredSelection(storage) {
  try {
    const ids = JSON.parse(storage.getItem("selectedDocIds") || "[]");
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  } catch {
    storage.removeItem("selectedDocIds");
    return [];
  }
}
