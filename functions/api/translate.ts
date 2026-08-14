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
  targetLang?: 'en' | 'zh' // 目标语言，默认 'en'
}

// 内置免费翻译使用的 Workers AI 模型
// 注意：llama-3.1-8b-instruct 已于 2026-05-30 被弃用（错误码 5028），
// GLM 是官方推荐替代品，多语言支持好，翻译为英文质量稳定
const BUILTIN_MODEL = '@cf/zai-org/glm-4.7-flash'

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

// 按目标语言生成翻译提示词
function buildSystemPrompt(targetLang: 'en' | 'zh'): string {
  const langName = targetLang === 'zh' ? '中文' : '英文'
  return `你是一个专业的翻译助手。请将以下文本翻译为${langName}。
每一行格式为 [序号] 原文文本（可能是日语、中文、韩语、法语等各种语言）。
请保持序号不变，将每行内容翻译为${langName}。
输出格式必须是JSON数组，如：["Translation 1", "Translation 2", ...]
只输出JSON数组，不要添加任何其他文字、markdown标记或解释。
保持翻译简洁自然，适合字幕显示。如果原文已经是${langName}，请原样输出。`
}

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

// 单次调用 Workers AI 翻译（返回原始 translations，可能含空条目）
async function runBuiltinAI(env: Env, numberedTexts: string, count: number, systemPrompt: string): Promise<string[]> {
  // 新模型可能返回 OpenAI 兼容格式（choices）或老式格式（response）
  const result = (await env.AI.run(BUILTIN_MODEL as Parameters<Ai['run']>[0], {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: numberedTexts },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  })) as {
    response?: string
    choices?: { message?: { content?: string } }[]
  }

  const content =
    result.response ?? result.choices?.[0]?.message?.content ?? ''
  if (!content) {
    // 模型偶发返回空内容（实测约 4% 概率），让调用方按空翻译处理并触发补翻
    console.warn('[Translate] Builtin AI returned empty content')
    return new Array(count).fill('')
  }
  return parseTranslations(content, new Array(count).fill(''))
}

// 找出翻译结果中的空条目索引
function emptyIndexesOf(translations: string[]): number[] {
  return translations
    .map((t, i) => (!t || !t.trim() ? i : -1))
    .filter((i) => i >= 0)
}

/**
 * 补翻空条目：GLM 偶发漏翻个别条目（实测约 4.6%，常见于批次最后一条或整批异常），
 * 把空条目拆成更小批次重新翻译，最多 2 轮，大幅降低"部分字幕没翻译"的概率。
 */
async function fillEmptyTranslations(
  runBatch: (texts: string[], numberedTexts: string) => Promise<string[]>,
  texts: string[],
  translations: string[],
  maxRounds = 2
): Promise<string[]> {
  const current = [...translations]
  for (let round = 0; round < maxRounds; round++) {
    const empties = emptyIndexesOf(current)
    if (empties.length === 0) break

    // 每小批最多 5 条，减少单次输出被再次漏翻的概率
    const SUB_BATCH = 5
    for (let start = 0; start < empties.length; start += SUB_BATCH) {
      const idxs = empties.slice(start, start + SUB_BATCH)
      const subTexts = idxs.map((i) => texts[i])
      const numbered = subTexts.map((t, i) => `[${i}] ${t}`).join('\n')
      try {
        const subResults = await runBatch(subTexts, numbered)
        idxs.forEach((globalIdx, j) => {
          const t = subResults[j]
          if (t && t.trim()) current[globalIdx] = t
        })
        console.log(
          `[Translate] Refill round ${round + 1}: ${idxs.length} empty -> ${idxs.filter((g, j) => subResults[j]?.trim()).length} filled`
        )
      } catch (err) {
        // 补翻失败不影响主流程，保留空条目
        console.error('[Translate] Refill batch failed:', err)
      }
    }
  }
  return current
}

// 内置免费翻译：调用 Workers AI，无需用户提供 Key
async function translateWithBuiltinAI(
  env: Env,
  texts: string[],
  numberedTexts: string,
  systemPrompt: string
): Promise<Response> {
  let translations: string[]
  try {
    translations = await runBuiltinAI(env, numberedTexts, texts.length, systemPrompt)
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
      // 注意：不能用 502/504，Cloudflare 代理域名会拦截这两个状态码
      // 并替换响应 body，导致前端拿不到真实错误信息
      { status: 500 }
    )
  }

  // 补翻漏掉的条目（小批重试，最多 2 轮）
  const finalTranslations = await fillEmptyTranslations(
    (subTexts, numbered) => runBuiltinAI(env, numbered, subTexts.length, systemPrompt),
    texts,
    translations
  )
  return Response.json({ translations: finalTranslations, source: 'builtin' })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  try {
    const body = (await request.json()) as TranslateRequest
    const { apiKey, model, texts } = body
    const endpoint = normalizeEndpoint(body.endpoint || '')
    const systemPrompt = buildSystemPrompt(body.targetLang === 'zh' ? 'zh' : 'en')

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
      return translateWithBuiltinAI(env, texts, numberedTexts, systemPrompt)
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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: numberedTexts },
        ],
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      return Response.json(
        { error: `翻译API错误 (${response.status}): ${errText}` },
        // 同上：避开会被 Cloudflare 代理拦截的 502
        { status: 500 }
      )
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }

    const content = data.choices?.[0]?.message?.content || ''
    const translations = parseTranslations(content, texts)

    // 自定义模型同样可能漏翻个别条目，补翻空条目（小批重试，最多 2 轮）
    const finalTranslations = await fillEmptyTranslations(
      async (subTexts, numbered) => {
        const subResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: numbered },
            ],
            temperature: 0.3,
          }),
        })
        if (!subResponse.ok) {
          throw new Error(`补翻请求失败 (${subResponse.status})`)
        }
        const subData = (await subResponse.json()) as {
          choices?: { message?: { content?: string } }[]
        }
        const subContent = subData.choices?.[0]?.message?.content || ''
        return parseTranslations(subContent, subTexts)
      },
      texts,
      translations
    )

    return Response.json({ translations: finalTranslations, source: 'custom' })
  } catch (err) {
    const message = err instanceof Error ? err.message : '翻译请求失败'
    return Response.json({ error: message }, { status: 500 })
  }
}
