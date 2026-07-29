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
    graphNodeOffsets: readStoredGraphNodeOffsets(storage),
    selectedGraphEdgeId: "",
    docFlowCenterId: storage.getItem("docFlowCenterId") || "",
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

function readStoredGraphNodeOffsets(storage) {
  try {
    const offsets = JSON.parse(storage.getItem("graphNodeOffsets") || "{}");
    return offsets && typeof offsets === "object" && !Array.isArray(offsets) ? offsets : {};
  } catch {
    storage.removeItem("graphNodeOffsets");
    return {};
  }
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
