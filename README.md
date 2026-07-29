# PaperAtlas 文献地图

面向学生和研究者的文献理解工作台：批量上传 PDF/PPTX/Markdown/TXT 后，自动生成逐篇摘要、证据卡、可修正关系图、跨文档问答、研究空白和期刊式综述草稿。

## Features

- PDF/PPTX/Markdown/TXT upload and parsing
- PDF cleaning for headers, footers, page numbers, formula fragments, figure/table captions, and reference noise
- Hierarchical PDF quality routing with selective page OCR for abnormal structured pages
- Per-document evidence cards with quote quality, dimension audit, confidence, and source positions
- Research-document applicability checks that keep teaching/reference slides out of research-field coverage metrics
- Cross-document synthesis with citations and uncertainty boundaries
- 2D/3D relationship graph views
- Standard relation schema with user-correctable relationship edges
- Journal-style review draft generation
- Research package export with evidence audit CSV files
- Research package export with evidence audit CSV, Mermaid, GraphML, and mindmap Markdown files
- API, UI, and evidence-quality regression scripts

## Quick Start

```bash
npm install
npm start
```

The server reads `HOST` and `PORT` from the environment. It defaults to `0.0.0.0`.

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

## Tests

```bash
npm test
npm run test:architecture
npm run test:modules
npm run test:api
npm run test:ui
npm run test:evidence
npm run eval:corpus
```

Architecture, module, API, UI, and evidence regression tests use isolated temporary
data directories and do not modify the local knowledge base. `npm test` runs all
portable fixture-based checks. `npm run eval:corpus` evaluates the active local corpus and
exits non-zero when a golden document or required field fails, an evidence schema
contract is broken, non-quotable evidence is marked usable, or research-document
coverage falls below the configured quality gates. Teaching/reference slides and
unreadable source files are reported separately instead of lowering research-field
coverage or encouraging fabricated evidence. Set `DATA_DIR` or
`EVIDENCE_LIBRARY_PATH` to evaluate a different corpus. The default gates require
85% usable applicable fields, zero candidate-empty failures, and at most four
dimension mismatches; override them with `EVIDENCE_MIN_USABLE_RATE`,
`EVIDENCE_MAX_CANDIDATE_EMPTY`, and `EVIDENCE_MAX_DIMENSION_MISMATCH`.

## Architecture

The codebase is being migrated from root-level server and browser monoliths into
small backend and frontend modules with enforced dependency and line-budget rules.
See [docs/architecture.md](docs/architecture.md) for layer boundaries, migration
invariants, and the rules applied by `npm run test:architecture`.

## OCR

PDF parsing first performs a document-level check. For otherwise readable PDFs,
only blank, private-glyph, or severely fragmented pages are routed to OCR and are
merged back when the recovered text is better. Fully image-only or unreadable PDFs
still use the full-document OCR fallback. Set `OCR_MAX_PAGES` to a positive value
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
