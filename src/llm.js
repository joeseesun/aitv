// All site-funded DeepSeek calls are Flash-only; never log keys or prompts.
export const FLASH_MODEL = "deepseek-flash";
export function flashTarget(model = FLASH_MODEL, baseUrl = "https://api.deepseek.com") {
  if (![FLASH_MODEL, "deepseek-v4-flash"].includes(model)) throw new Error("网站仅允许 DeepSeek Flash");
  const url = new URL(baseUrl);
  if (url.origin !== "https://api.deepseek.com" || url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("DeepSeek 仅允许官方接口");
  }
  return { model: FLASH_MODEL, endpoint: `${url.origin}${url.pathname.replace(/\/$/, "")}/chat/completions` };
}
export async function requestDeepSeek({ apiKey, model = FLASH_MODEL, baseUrl, messages, json = true, temperature = 0.7, maxTokens = 4096, timeoutMs = 120000, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("缺 DEEPSEEK_API_KEY");
  const target = flashTarget(model, baseUrl);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error("AI 输出额度超出限制");
  const body = JSON.stringify({ model: target.model, temperature, max_tokens: maxTokens,
    thinking: { type: "disabled" }, messages,
    ...(json ? { response_format: { type: "json_object" } } : {}) });
  if (new TextEncoder().encode(body).length > 100000) throw new Error("AI 输入过长");
  const res = await fetchImpl(target.endpoint, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const usage = data.usage;
  if (usage) console.info("[ai-usage]", JSON.stringify({ model: target.model,
    promptTokens: Number(usage.prompt_tokens) || 0, completionTokens: Number(usage.completion_tokens) || 0 }));
  if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error("AI 输出被截断或未正常结束");
  return choice?.message?.content ?? "";
}
export function makeDeepSeek({ apiKey, model = FLASH_MODEL, baseUrl = "https://api.deepseek.com", timeoutMs = 120000, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("缺 DEEPSEEK_API_KEY");
  flashTarget(model, baseUrl);
  return async function llm(prompt, { json = true, temperature = 0.7 } = {}) {
    return requestDeepSeek({ apiKey, model, baseUrl, timeoutMs, fetchImpl, json, temperature,
      messages: [{ role: "user", content: String(prompt).toWellFormed?.() ?? String(prompt) }] });
  };
}
