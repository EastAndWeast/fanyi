// Cloudflare Pages Function: 翻译代理
// 接收翻译API配置和待翻译文本，返回翻译结果

interface TranslateRequest {
  endpoint: string
  apiKey: string
  model: string
  texts: string[]
}

// 规范化 endpoint：只填 Base URL 时自动补全 /chat/completions
function normalizeEndpoint(endpoint: string): string {
  let url = endpoint.trim().replace(/\/+$/, '')
  if (url && !url.endsWith('/chat/completions')) {
    url += '/chat/completions'
  }
  return url
}

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context

  try {
    const body = (await request.json()) as TranslateRequest
    const { apiKey, model, texts } = body
    const endpoint = normalizeEndpoint(body.endpoint || '')

    if (!endpoint || !apiKey || !model) {
      return Response.json(
        { error: '缺少API配置（endpoint/apiKey/model）' },
        { status: 400 }
      )
    }

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

    const systemPrompt = `你是一个专业的英译中翻译助手。请将以下英文文本翻译为简体中文。
每一行格式为 [序号] 英文文本。
请保持序号不变，只翻译英文内容为简体中文。
输出格式必须是JSON数组，如：["翻译1", "翻译2", ...]
只输出JSON数组，不要添加任何其他文字、markdown标记或解释。
保持翻译简洁自然，适合字幕显示。`

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
        { status: 502 }
      )
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }

    const content = data.choices?.[0]?.message?.content || ''

    // 尝试解析返回的JSON数组
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
    translations = translations.slice(0, texts.length)

    return Response.json({ translations })
  } catch (err) {
    const message = err instanceof Error ? err.message : '翻译请求失败'
    return Response.json({ error: message }, { status: 500 })
  }
}
