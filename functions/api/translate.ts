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
// 注意：llama-3.1-8b-instruct 已于 2026-05-30 被弃用（错误码 5028），
// GLM 是官方推荐替代品，且中文原生，英译中质量更好
const BUILTIN_MODEL = '@cf/zai-org/glm-4.7-flash'
const FALLBACK_TRANSLATE_MODEL = '@cf/meta/m2m100-1.2b'
// 单次 Workers AI 调用硬超时（毫秒）：避免单次推理卡死触发 Cloudflare 100s 网关 524 超时
const BUILTIN_TIMEOUT_MS = 28_000

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

// 单次调用 Workers AI 翻译（含硬超时，返回原始 translations，可能含空条目）
async function runBuiltinAI(env: Env, numberedTexts: string, count: number): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const aiPromise = env.AI.run(BUILTIN_MODEL as Parameters<Ai['run']>[0], {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: numberedTexts },
    ],
    temperature: 0.3,
    // 关闭 thinking 推理模式，避免推理 token 占满预算导致 content 为空或耗时过长
    max_tokens: 2048,
    chat_template_kwargs: { enable_thinking: false },
  } as Record<string, unknown>) as Promise<{
    response?: string
    choices?: { message?: { content?: string } }[]
  }>

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('内置翻译模型响应超时')),
      BUILTIN_TIMEOUT_MS
    )
  })

  let result: {
    response?: string
    choices?: { message?: { content?: string } }[]
  }
  try {
    result = await Promise.race([aiPromise, timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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

// 兜底翻译模型：使用 Workers AI 专用翻译模型 @cf/meta/m2m100-1.2b 并行逐条翻译（速度极快，无推理延迟）
async function translateWithM2M100(env: Env, texts: string[]): Promise<string[]> {
  return Promise.all(
    texts.map(async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return ''
      try {
        const res = (await env.AI.run(
          FALLBACK_TRANSLATE_MODEL as Parameters<Ai['run']>[0],
          {
            text: trimmed,
            source_lang: 'en',
            target_lang: 'zh',
          }
        )) as { translated_text?: string }
        return res.translated_text?.trim() || ''
      } catch (err) {
        console.warn('[Translate] M2M100 fallback item failed:', err)
        return ''
      }
    })
  )
}

// 内置免费翻译：优先使用 GLM（关闭 thinking），失败或漏翻条目自动用 M2M100 兜底
async function translateWithBuiltinAI(
  env: Env,
  texts: string[],
  numberedTexts: string
): Promise<Response> {
  let translations: string[] = new Array(texts.length).fill('')
  try {
    translations = await runBuiltinAI(env, numberedTexts, texts.length)
  } catch (aiError) {
    const errMsg = aiError instanceof Error ? aiError.message : String(aiError)
    console.error('[Translate] Workers AI GLM error:', errMsg)
    if (isQuotaError(errMsg)) {
      return Response.json(
        { error: QUOTA_EXCEEDED_MESSAGE, quotaExceeded: true },
        { status: 429 }
      )
    }
    // 非额度错误时继续走下方 M2M100 兜底，不直接失败
  }

  // 对空条目使用 M2M100 快速兜底补翻
  const empties = emptyIndexesOf(translations)
  if (empties.length > 0) {
    const emptyTexts = empties.map((i) => texts[i])
    const fallbackResults = await translateWithM2M100(env, emptyTexts)
    empties.forEach((globalIdx, j) => {
      if (fallbackResults[j]) {
        translations[globalIdx] = fallbackResults[j]
      }
    })
  }

  if (emptyIndexesOf(translations).length === texts.length) {
    return Response.json(
      { error: '内置翻译服务暂时不可用，请稍后重试或配置自己的 API Key' },
      // 注意：不能用 502/504，Cloudflare 代理域名会拦截这两个状态码
      // 并替换响应 body，导致前端拿不到真实错误信息
      { status: 500 }
    )
  }

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
              { role: 'system', content: SYSTEM_PROMPT },
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
