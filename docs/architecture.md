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
