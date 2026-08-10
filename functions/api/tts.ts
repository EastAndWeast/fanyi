// Cloudflare Pages Function: 文本转语音 (Workers AI melotts)
// 接收英文文本，返回 MP3 音频二进制
// 用于阶段2：英文 TTS 配音

interface Env {
  AI: Ai
}

/**
 * 将 base64 字符串解码为 Uint8Array
 * Workers AI TTS 模型可能返回 { audio: "<base64>" } 格式
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

interface TTSRequest {
  text: string
  lang?: string
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  try {
    const body = (await request.json()) as TTSRequest
    const { text, lang = 'en' } = body

    if (!text || !text.trim()) {
      return Response.json({ error: '没有待合成的文本' }, { status: 400 })
    }

    // 调用 Workers AI melotts TTS 模型
    // 输入: { prompt: 文本, lang: 语言 }
    // 输出: MP3 二进制音频（Response body）
    //
    // 注意：workers-types 对 melotts 的返回类型声明可能不完整，
    // 做运行时类型判断兼容处理（参考 stt.ts 的类型断言策略）
    const result = (await env.AI.run('@cf/myshell-ai/melotts' as Parameters<
      Ai['run']
    >[0], {
      prompt: text.slice(0, 1000), // 限制单次合成长度，避免超时
      lang,
    })) as unknown

    // melotts 返回值类型（AiTextToSpeechOutput）有两种可能：
    // 1. Uint8Array —— 直接是 MP3 二进制
    // 2. { audio: string } —— base64 编码的 MP3
    let audioBytes: Uint8Array | null = null

    if (result instanceof Uint8Array) {
      audioBytes = result
    } else if (
      result &&
      typeof result === 'object' &&
      typeof (result as { audio?: unknown }).audio === 'string'
    ) {
      // { audio: "<base64>" } 格式：解码 base64
      audioBytes = base64ToUint8Array((result as { audio: string }).audio)
    } else if (result instanceof Response) {
      // 兜底：部分版本可能返回 Response 对象
      audioBytes = new Uint8Array(await result.arrayBuffer())
    }

    if (audioBytes && audioBytes.byteLength > 0) {
      return new Response(audioBytes.buffer as ArrayBuffer, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-cache',
        },
      })
    }

    // 返回格式不在预期内
    console.error('[TTS] Unexpected result type:', typeof result)
    return Response.json(
      { error: 'TTS 返回格式异常，请稍后重试' },
      { status: 500 }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'TTS 合成失败'
    console.error('[TTS] Error:', message)
    // 避开 Cloudflare 代理会拦截的状态码
    const status =
      /quota|limit|exceed|429/i.test(message) ? 429 : 500
    return Response.json({ error: message }, { status })
  }
}
