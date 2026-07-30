# PaperAtlas UI Quality Guide

## Product Direction

PaperAtlas is a literature understanding workstation, not a PDF summarizer or marketing site. The interface should feel like a quiet research desk: dense enough for serious comparison, but never crowded enough to hide evidence, actions, or source status.

## Visual System

- Primary ink: `#0f172a` for headings and key facts.
- Body ink: `#334155` for readable research prose.
- Muted ink: `#64748b` for secondary labels and source status.
- Evidence teal: `#0f766e` for source-backed facts.
- Synthesis blue: `#285f9f` for cross-document interpretation.
- Boundary red: `#b42318` for risk, contradiction, and cannot-infer states.
- Audit amber: `#b7791f` for weak or pending evidence.

## Interaction Rules

- Do not promise interactions that are not reliable. If relation evidence is best shown below the chart, say that directly.
- Fullscreen views must prioritize reading and inspection. They should not require hunting through nested panels.
- Graph labels must never be clipped by SVG bounds. Labels near edges should align inward.
- Relation text can sit on lines only without boxes; boxed edge labels are avoided because they cover nodes.
- Source-backed facts, synthesis, and audit warnings must have visibly different treatments.

## Text Rules

- Avoid implementation words in UI: `claim`, `quote`, `location`, `confidence`, `gap`.
- Use user-facing terms: `核心主张`, `原文片段`, `页码/章节定位`, `证据强弱`, `研究空白`.
- Avoid meta writing instructions inside generated prose: no `综述应`, `写作重点`, `不宜按文献顺序`.
- If a document is a writing guide or formatting manual, label it as reference material and keep it out of research synthesis.

## Verification Checklist

- Desktop and narrow viewport do not clip button text, graph labels, or titles.
- Every long panel can be read in fullscreen without nested scrolling traps.
- Graph view shows relation type text and keeps node text readable.
- Review facts show multiple facts per research document and separate reference material.
- UI smoke tests pass after every visual change.
