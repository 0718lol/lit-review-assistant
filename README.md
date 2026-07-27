# Literature Review Assistant

文献速读与综述助手：批量上传 PDF/PPTX 后，自动生成逐篇摘要、证据卡、关系图、跨文档问答、研究空白和期刊式综述草稿。

## Features

- PDF/PPTX upload and parsing
- PDF cleaning for headers, footers, page numbers, formula fragments, figure/table captions, and reference noise
- Per-document evidence cards with quote quality, dimension audit, confidence, and source positions
- Cross-document synthesis with citations and uncertainty boundaries
- 2D/3D relationship graph views
- Journal-style review draft generation
- Research package export with evidence audit CSV files
- API, UI, and evidence-quality regression scripts

## Quick Start

```bash
npm install
npm start
```

The server reads `PORT` from the environment and binds to `0.0.0.0`.

```bash
PORT=3000 npm start
```

## Tests

```bash
npm run test:api
npm run test:ui
npm run test:evidence
npm run eval:corpus
```

API, UI, and evidence regression tests use isolated temporary data directories
and do not modify the local knowledge base. `npm test` runs only these portable
fixture-based checks. `npm run eval:corpus` evaluates the active local corpus and
exits non-zero when a golden document or required field fails, an evidence schema
contract is broken, or non-quotable evidence is marked usable. Corpus-wide
missing and dimension-mismatch counts remain visible as quality warnings. Set
`DATA_DIR` or `EVIDENCE_LIBRARY_PATH` to evaluate a different corpus.

## OCR

Image-only PDFs are OCRed even when the PDF container itself is structurally
valid. OCR covers all pages by default. Set `OCR_MAX_PAGES` to a positive value
only when a deliberate processing limit is needed; partial coverage is shown in
the document warning and must not be treated as a full-document analysis.

## Background Parsing

Uploads are saved to a persistent background queue and return immediately. The
UI reports queued, parsing, OCR, evidence-analysis, and saving progress for each
file. Failed jobs can be retried, and queued or running jobs can be canceled.
Pending jobs are stored under `data/` and resume after a server restart. OCR is
processed one document at a time so it does not exhaust local CPU or memory.

## Model Provider

The app can run without a model provider using local heuristic analysis. If model enhancement is needed, configure it in the UI or with environment variables:

```bash
OPENAI_API_KEY=... npm start
```

API keys are not committed and should not be written into source code.

## Repository Notes

Runtime data is intentionally ignored:

- `data/`
- `exports/`
- `node_modules/`
- local logs and temporary files

This prevents uploaded PDFs, generated backups, provider config, and exported research packages from being pushed to GitHub.
