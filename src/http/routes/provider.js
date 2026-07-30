export function registerProviderRoutes(app, dependencies) {
  const {
    getProviderConfig,
    envProviderConfig,
    sanitizeProviderConfig,
    saveProviderConfig,
    providerInfo,
    llmText
  } = dependencies;

  app.get("/api/provider", (_req, res) => {
    res.json(providerInfo());
  });

  app.post("/api/provider", async (req, res) => {
    try {
      const current = getProviderConfig() || envProviderConfig();
      const next = sanitizeProviderConfig({
        provider: req.body.provider,
        model: req.body.model,
        baseUrl: req.body.baseUrl,
        apiKey: Object.prototype.hasOwnProperty.call(req.body, "apiKey") ? req.body.apiKey : current.apiKey
      });
      if (req.body.keepApiKey) next.apiKey = current.apiKey;
      await saveProviderConfig(next);
      res.json(providerInfo());
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message || "模型接口配置无效。" });
    }
  });

  app.post("/api/provider/test", async (_req, res) => {
    const config = getProviderConfig();
    if (!config?.apiKey || config.provider === "local") {
      return res.status(400).json({ error: "请先选择中转站、OpenAI 或 Claude，并填写 API Key。" });
    }
    try {
      const response = await llmText("请只回复 OK。", { maxTokens: 32 });
      res.json({ ok: true, text: String(response || "").slice(0, 120), provider: providerInfo() });
    } catch (error) {
      res.status(502).json({ error: error.message, provider: providerInfo() });
    }
  });
}
