// Cloudflare Pages Function: 批量文本转语音 (Workers AI melotts)
// 接收多条英文文本，逐条合成（含重试），返回 base64 编码的音频数组
// 用于阶段2：英文 TTS 配音
//
// melotts 单次成功率约 30-50%（3043 内部错误），后端重试 3 次可将
// 单条综合成功率提升到 ~80%+

interface Env {
  AI: Ai
}

interface TTSBatchRequest {
  texts: string[]
  lang?: string
}

interface TTSBatchResult {
  audio: string // base64 编码的 WAV 音频
}

interface TTSError {
  error: string
}

/** 单条文本的最大长度，超出截断（melotts 长文本更容易 3043） */
const MAX_TEXT_LENGTH = 500

/** 每条文本的最大重试次数（首次 + 重试 = 总共 maxRetries+1 次） */
const MAX_RETRIES = 3

/** 重试间隔基数（毫秒），实际间隔 = base * (retry + 1) */
const RETRY_BASE_MS = 1000

/**
 * 将 base64 字符串解码为 Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * 将 Uint8Array 编码为 base64 字符串
 */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  // 分块处理避免 call stack 溢出（大音频文件）
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

/**
 * 调用 melotts 合成单条文本的语音（含重试）
 *
 * melotts 返回值类型（AiTextToSpeechOutput）：
 * - Uint8Array：直接是 WAV 二进制
 * - { audio: string }：base64 编码的 WAV
 *
 * @returns base64 编码的音频，或抛出错误
 */
async function synthSingle(
  env: Env,
  text: string,
  lang: string
): Promise<string> {
  const prompt = text.slice(0, MAX_TEXT_LENGTH)
  let lastError = ''

  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    try {
      const result = (await env.AI.run('@cf/myshell-ai/melotts' as Parameters<
        Ai['run']
      >[0], {
        prompt,
        lang,
      })) as unknown

      // 提取音频字节
      let audioBytes: Uint8Array | null = null

      if (result instanceof Uint8Array) {
        audioBytes = result
      } else if (
        result &&
        typeof result === 'object' &&
        typeof (result as { audio?: unknown }).audio === 'string'
      ) {
        // { audio: "<base64>" } 格式
        audioBytes = base64ToUint8Array((result as { audio: string }).audio)
      } else if (result instanceof Response) {
        audioBytes = new Uint8Array(await result.arrayBuffer())
      }

      if (audioBytes && audioBytes.byteLength > 0) {
        return uint8ToBase64(audioBytes)
      }

      lastError = '返回格式异常'
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.error(`[TTS] synth error (retry ${retry}):`, lastError)
    }

    // 重试前等待（递增间隔）
    if (retry < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (retry + 1)))
    }
  }

  throw new Error(lastError || 'TTS 合成失败')
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  try {
    const body = (await request.json()) as TTSBatchRequest
    const { texts, lang = 'en' } = body

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return Response.json({ error: '没有待合成的文本' }, { status: 400 })
    }

    // 限制单批数量，避免 Pages Functions 超时（~100秒）
    const batch = texts.slice(0, 5)

    const results: (TTSBatchResult | TTSError)[] = []

    for (const text of batch) {
      try {
        if (!text || !text.trim()) {
          results.push({ error: '空文本' })
          continue
        }
        const audioBase64 = await synthSingle(env, text, lang)
        results.push({ audio: audioBase64 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : '合成失败'
        results.push({ error: msg })
      }
    }

    const successCount = results.filter((r) => 'audio' in r).length
    console.log(
      `[TTS] Batch done: ${successCount}/${batch.length} succeeded`
    )

    return Response.json({
      results,
      successCount,
      totalCount: batch.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'TTS 批量合成失败'
    console.error('[TTS] Fatal error:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}
