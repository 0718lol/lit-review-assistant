export function registerPaperProjectRoutes(app, service) {
  app.get("/api/paper-projects", async (_req, res, next) => {
    try { res.json({ projects: await service.list() }); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects", async (req, res, next) => {
    try { res.status(201).json(await service.create(req.body || {})); } catch (error) { next(error); }
  });

  app.get("/api/paper-projects/:id", async (req, res, next) => {
    try { res.json(await service.get(req.params.id)); } catch (error) { next(error); }
  });

  app.patch("/api/paper-projects/:id", async (req, res, next) => {
    try { res.json(await service.update(req.params.id, req.body || {})); } catch (error) { next(error); }
  });

  app.delete("/api/paper-projects/:id", async (req, res, next) => {
    try { res.json(await service.remove(req.params.id)); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects/:id/theses", async (req, res, next) => {
    try { res.json(await service.suggestTheses(req.params.id)); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects/:id/outline", async (req, res, next) => {
    try { res.json(await service.generateOutline(req.params.id)); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects/:id/sections/:sectionId/generate", async (req, res, next) => {
    try { res.json(await service.generateSection(req.params.id, req.params.sectionId)); } catch (error) { next(error); }
  });

  app.patch("/api/paper-projects/:id/sections/:sectionId", async (req, res, next) => {
    try { res.json(await service.updateSection(req.params.id, req.params.sectionId, req.body || {})); } catch (error) { next(error); }
  });

  app.patch("/api/paper-projects/:id/blocks/:blockId", async (req, res, next) => {
    try { res.json(await service.updateBlock(req.params.id, req.params.blockId, req.body || {})); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects/:id/audit", async (req, res, next) => {
    try { res.json(await service.runAudit(req.params.id)); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects/:id/impact", async (req, res, next) => {
    try { res.json(await service.impact(req.params.id, req.body?.documentIds || [])); } catch (error) { next(error); }
  });

  app.post("/api/paper-projects/:id/revisions/:revisionId/restore", async (req, res, next) => {
    try { res.json(await service.restoreRevision(req.params.id, req.params.revisionId)); } catch (error) { next(error); }
  });

  app.get("/api/paper-projects/:id/export/markdown", async (req, res, next) => {
    try {
      const markdown = await service.exportMarkdown(req.params.id);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="paper-${encodeURIComponent(req.params.id)}.md"`);
      res.send(markdown);
    } catch (error) { next(error); }
  });

  app.get("/api/paper-projects/:id/export/docx", async (req, res, next) => {
    try {
      const bytes = await service.exportDocx(req.params.id);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="paper-${encodeURIComponent(req.params.id)}.docx"`);
      res.send(bytes);
    } catch (error) { next(error); }
  });
}
