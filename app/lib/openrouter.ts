import 'server-only'

// The ONLY LLM call in this app. Everything else stays deterministic — this is a
// suggestion helper for the dashboard categorize banner, never an authority: the
// model proposes, the human confirms, and nothing is written without a click.
//
// The key is server-only (`OPENROUTER_API_KEY` in .env.local / Vercel env), so it
// never reaches the browser bundle. Put a spend cap on the OpenRouter dashboard.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/** Cheap, fast, good enough at tiny structured JSON. Override with OPENROUTER_MODEL. */
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite'

const TIMEOUT_MS = 45_000

export function aiConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim()
}

/** One chat completion, returned as raw text. Throws with a reason a human can act on. */
export async function askOpenRouter({
  system,
  prompt,
  title,
  model = DEFAULT_MODEL,
  temperature = 0,
}: {
  system: string
  prompt: string
  /** Shown on the OpenRouter dashboard, so spend can be read per feature. ASCII only — it goes in an HTTP header. */
  title: string
  model?: string
  temperature?: number
}): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new Error('No OPENROUTER_API_KEY set — add it to .env.local.')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${key}`,
      // Header values must be Latin-1: strip anything else rather than throwing.
      'X-Title': title.replace(/[^\x20-\x7e]/g, '-'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  // OpenRouter can answer 200 with an error body, or an empty choice when the
  // upstream model times out on its side. Say which one it was.
  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    error?: { message?: string }
  }
  if (json.error) throw new Error(`OpenRouter said: ${json.error.message ?? 'unknown error'}`)
  const text = json.choices?.[0]?.message?.content
  if (!text) throw new Error(`${model} sent an empty reply`)
  return text
}

/** The first [...] / {...} in a reply, so a markdown fence or "Here you go:" can't break the parse. */
export function sliceJson(text: string, open: '[' | '{' = '['): string {
  const close = open === '[' ? ']' : '}'
  const a = text.indexOf(open)
  const b = text.lastIndexOf(close)
  if (a === -1 || b === -1 || b < a) throw new Error('no JSON in the reply')
  return text.slice(a, b + 1)
}
