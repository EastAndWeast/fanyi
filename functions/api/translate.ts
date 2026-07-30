// Cloudflare Pages Function: 翻译代理
// 接收翻译API配置和待翻译文本，返回翻译结果
// 未配置 API Key 时自动使用内置 Workers AI 免费翻译（每日限额）

interface Env {
  AI: Ai
}

interface TranslateRequest {
  endpoint: string
  apiKey: string
  model: string
  texts: string[]
}

// 内置免费翻译使用的 Workers AI 模型
const BUILTIN_MODEL = '@cf/meta/llama-3.1-8b-instruct'

// 内置额度用尽时的提示文案
const QUOTA_EXCEEDED_MESSAGE =
  '内置免费翻译今日额度已用完，请在设置中配置自己的 API Key 后重试。未来会提供更加便捷的方式。'

// 规范化 endpoint：只填 Base URL 时自动补全 /chat/completions
function normalizeEndpoint(endpoint: string): string {
  let url = endpoint.trim().replace(/\/+$/, '')
  if (url && !url.endsWith('/chat/completions')) {
    url += '/chat/completions'
  }
  return url
}

const SYSTEM_PROMPT = `你是一个专业的英译中翻译助手。请将以下英文文本翻译为简体中文。
每一行格式为 [序号] 英文文本。
请保持序号不变，只翻译英文内容为简体中文。
输出格式必须是JSON数组，如：["翻译1", "翻译2", ...]
只输出JSON数组，不要添加任何其他文字、markdown标记或解释。
保持翻译简洁自然，适合字幕显示。`

// 解析模型返回的翻译内容，容错 markdown 代码块和非 JSON 格式
function parseTranslations(content: string, texts: string[]): string[] {
  let translations: string[] = []

  // 去除可能的markdown代码块标记
  let cleaned = content.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      translations = parsed.map((t) => String(t))
    }
  } catch {
    // JSON解析失败，尝试逐行解析 [序号] 翻译 格式
    translations = texts.map((_, i) => {
      const regex = new RegExp(
        `\\[${i}\\]\\s*(.+?)(?=\\[\\d+\\]|$)`,
        's'
      )
      const match = cleaned.match(regex)
      return match ? match[1].trim() : ''
    })
  }

  // 确保翻译数量与原文匹配
  while (translations.length < texts.length) {
    translations.push('')
  }
  return translations.slice(0, texts.length)
}

// 判断 Workers AI 错误是否为额度/限流类错误
function isQuotaError(message: string): boolean {
  return /quota|limit|exceed|capacity|rate|429|3040/i.test(message)
}

// 内置免费翻译：调用 Workers AI，无需用户提供 Key
async function translateWithBuiltinAI(
  env: Env,
  texts: string[],
  numberedTexts: string
): Promise<Response> {
  let result: { response?: string }
  try {
    result = (await env.AI.run(BUILTIN_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: numberedTexts },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    })) as { response?: string }
  } catch (aiError) {
    const errMsg = aiError instanceof Error ? aiError.message : String(aiError)
    console.error('[Translate] Workers AI error:', errMsg)
    if (isQuotaError(errMsg)) {
      return Response.json(
        { error: QUOTA_EXCEEDED_MESSAGE, quotaExceeded: true },
        { status: 429 }
      )
    }
    return Response.json(
      { error: `内置翻译服务暂时不可用，请稍后重试或配置自己的 API Key（${errMsg}）` },
      { status: 502 }
    )
  }

  const translations = parseTranslations(result.response || '', texts)
  return Response.json({ translations, source: 'builtin' })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  try {
    const body = (await request.json()) as TranslateRequest
    const { apiKey, model, texts } = body
    const endpoint = normalizeEndpoint(body.endpoint || '')

    if (!texts || texts.length === 0) {
      return Response.json(
        { error: '没有待翻译的文本' },
        { status: 400 }
      )
    }

    // 构建翻译提示词：将所有文本编号后一次性翻译，保持顺序
    const numberedTexts = texts
      .map((t, i) => `[${i}] ${t}`)
      .join('\n')

    // 未配置用户 Key 时，使用内置 Workers AI 免费翻译
    if (!apiKey) {
      return translateWithBuiltinAI(env, texts, numberedTexts)
    }

    if (!endpoint || !model) {
      return Response.json(
        { error: '缺少API配置（endpoint/model）' },
        { status: 400 }
      )
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: numberedTexts },
        ],
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      return Response.json(
        { error: `翻译API错误 (${response.status}): ${errText}` },
        { status: 502 }
      )
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }

    const content = data.choices?.[0]?.message?.content || ''
    const translations = parseTranslations(content, texts)

    return Response.json({ translations, source: 'custom' })
  } catch (err) {
    const message = err instanceof Error ? err.message : '翻译请求失败'
    return Response.json({ error: message }, { status: 500 })
  }
}
