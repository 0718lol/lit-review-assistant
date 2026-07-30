import fs from "node:fs/promises";

export function createProviderSettings({ configPath, env = process.env, defaultOpenAIModel, defaultAnthropicModel } = {}) {
  if (!configPath) throw new Error("configPath is required for provider settings.");

  function fromEnv() {
    if (env.OPENAI_API_KEY) {
      return {
        provider: "openai",
        model: defaultOpenAIModel,
        baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY
      };
    }
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY) {
      return {
        provider: "anthropic",
        model: defaultAnthropicModel,
        baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        apiKey: env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY
      };
    }
    return {
      provider: "local",
      model: defaultOpenAIModel,
      baseUrl: "https://api.openai.com/v1",
      apiKey: ""
    };
  }

  function sanitize(config = {}) {
    const provider = ["openai", "openai-compatible", "anthropic", "local"].includes(config.provider) ? config.provider : "local";
    const baseUrl = safeBaseUrl(provider, config.baseUrl);
    const model = String(config.model || (provider === "anthropic" ? defaultAnthropicModel : defaultOpenAIModel)).trim();
    return { provider, model, baseUrl, apiKey: String(config.apiKey || "") };
  }

  async function load() {
    const fallback = fromEnv();
    try {
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      const merged = sanitize({ ...fallback, ...saved });
      merged.apiKey = merged.provider === fallback.provider ? fallback.apiKey || "" : "";
      return { config: merged, error: null };
    } catch (error) {
      try {
        return { config: sanitize(fallback), error: null };
      } catch (fallbackError) {
        return {
          config: { provider: "local", model: defaultOpenAIModel, baseUrl: "", apiKey: "" },
          error: fallbackError || error
        };
      }
    }
  }

  async function save(config = {}) {
    const sanitized = sanitize(config);
    const persisted = {
      provider: sanitized.provider,
      model: sanitized.model,
      baseUrl: sanitized.baseUrl
    };
    await fs.writeFile(configPath, JSON.stringify(persisted, null, 2));
    return sanitized;
  }

  return Object.freeze({ fromEnv, load, sanitize, save });
}

function safeBaseUrl(provider, rawBaseUrl = "") {
  const fallback = provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  if (provider === "local") return "";
  const value = String(rawBaseUrl || fallback).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError("模型 Base URL 格式不正确。");
  }
  if (url.protocol !== "https:") throw httpError("模型 Base URL 只允许 https，不能使用 http 或本地地址。");
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLocalHost(host)) throw httpError("模型 Base URL 不能指向 localhost、内网或保留地址。");
  if (provider === "openai" && !/(^|\.)openai\.com$|(^|\.)azure\.com$|(^|\.)azurefd\.net$/.test(host)) {
    throw httpError("OpenAI 模式只允许 OpenAI 或 Azure OpenAI 的 https 地址。");
  }
  if (provider === "anthropic" && !/(^|\.)anthropic\.com$/.test(host)) {
    throw httpError("Claude / Anthropic 模式只允许 Anthropic 官方 https 地址。");
  }
  return url.toString().replace(/\/+$/, "");
}

function isPrivateOrLocalHost(host = "") {
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(127|10)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^(0|169\.254)\./.test(host)) return true;
  return host === "::1" || host === "[::1]";
}

function httpError(message) {
  return Object.assign(new Error(message), { status: 400 });
}
