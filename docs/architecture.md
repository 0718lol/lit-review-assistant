# Architecture

The application is migrating from a server and browser monolith to explicit layers. New modules must follow this dependency direction:

`http -> application -> domain <- infrastructure`

`bootstrap` composes concrete implementations. `shared` may not depend on any other application layer.

## Layer Rules

- `domain` contains deterministic research and evidence rules. It must not import Express, file-system APIs, parsers, model clients, configuration, or repositories.
- `application` coordinates use cases through domain functions and repository/parser ports.
- `infrastructure` implements storage, PDF/PPTX parsing, OCR, search, and model-provider adapters.
- `http` validates requests, calls application use cases, and presents responses.
- `config` resolves environment-specific runtime values but contains no business rules.
- `bootstrap` is the only layer allowed to instantiate and connect all concrete dependencies.

Modules under `src/` have a 450-line hard budget. Existing root monoliths are migration sources and must not receive new feature logic when an appropriate module exists.

## Migration Invariants

- API response contracts remain backward compatible during extraction-only changes.
- Evidence golden rules must remain fully passing.
- Runtime data is never used by portable tests.
- Pure code moves and behavior changes are separate commits.
- JSON storage remains the active adapter until repository contracts are stable enough for a separate SQLite migration.

## Evidence Quality Pipeline

Evidence analysis is split across deterministic domain and parser modules:

- `src/infrastructure/parsers/pdf/quality-router.js` assesses document and page text, selects only abnormal pages for OCR, and merges recovered page text conservatively.
- `src/domain/evidence/document-kind.js` determines whether research-matrix fields apply to a document. Teaching/reference slides remain searchable but do not require fabricated research fields.
- `src/domain/evidence/selection-state.js` prevents duplicate selection within one field and applies a visible penalty, rather than a blanket ban, when a source span supports multiple fields.
- `src/domain/evidence/coverage.js` reports parse, candidate, selection, dimension, quality, support, and direct-quote failure stages separately.

`scripts/eval-evidence.js --strict` is the corpus-level release gate. Portable
regression tests continue to use isolated fixtures and must not depend on the
active local library.
