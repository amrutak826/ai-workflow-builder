// Calls a real LLM API for llm_call steps. Supports Groq, OpenRouter, and
// Gemini free tiers. Falls back to a disclosed artificial-delay stub if
// LLM_PROVIDER=stub or no API key is configured, per the assignment's
// explicit allowance for that.

type LlmResult = { text: string; provider: string; stubbed: boolean };

export async function callLlm(prompt: string, config: Record<string, any> = {}): Promise<LlmResult> {
  const provider = (process.env.LLM_PROVIDER || "stub").toLowerCase();
  const apiKey = process.env.LLM_API_KEY;

  if (provider === "stub" || !apiKey) {
    // Disclosed artificial delay so it behaves like a real network call
    // for retry/timeout testing.
    await new Promise((r) => setTimeout(r, 800));
    return {
      text: `[STUBBED LLM RESPONSE] echo: ${prompt.slice(0, 200)}`,
      provider: "stub",
      stubbed: true,
    };
  }

  if (provider === "groq") {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model || "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return { text: json.choices[0].message.content, provider: "groq", stubbed: false };
  }

  if (provider === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return { text: json.choices[0].message.content, provider: "openrouter", stubbed: false };
  }

  if (provider === "gemini") {
    const model = config.model || "gemini-1.5-flash";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return { text: json.candidates[0].content.parts[0].text, provider: "gemini", stubbed: false };
  }

  throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
}
