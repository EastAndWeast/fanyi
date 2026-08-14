// Cloudflare Pages Function: 批量文本转语音
// 支持双引擎：
//   1. free      — Workers AI melotts（免费但不稳定，成功率 ~40%）
//   2. volcengine — 火山引擎豆包语音合成 2.0（doubao-seed-tts-2.0，需用户 key）
//
// 请求体：{ engine, texts, lang?, apiKey?, appId?, voiceType? }
// 返回：{ results: ({ audio: string } | { error: string })[], successCount, totalCount }

interface Env {
  AI: Ai
}

type TtsEngine = 'free' | 'volcengine'

interface TTSBatchRequest {
  engine?: TtsEngine
  texts: string[]
  lang?: string
  // 火山引擎配置
  apiKey?: string
  appId?: string
  voiceType?: string
}

interface TTSBatchResult {
  audio: string // base64 编码的 WAV 音频
}

interface TTSError {
  error: string
}

/** 单条文本的最大长度，超出截断 */
const MAX_TEXT_LENGTH = 500
/** melotts 每条文本的最大重试次数 */
const MAX_RETRIES = 3
/** 重试间隔基数（毫秒） */
const RETRY_BASE_MS = 1000

// ── 火山引擎常量 ──────────────────────────────────────────────
// 火山引擎有两套计费接入，路径不同、协议一致：
//   按量计费:   /api/v3/tts/unidirectional
//   资源包(plan): /api/v3/plan/tts/unidirectional
// 依次尝试，命中后在当前 isolate 内记住，避免后续请求重复试错
const VOLC_TTS_URLS = [
  'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
]
let volcWorkingUrl: string | null = null
const VOLC_RESOURCE_ID = 'seed-tts-2.0'
// PCM 输出采样率（seed-tts-2.0 默认 24kHz）
const VOLC_PCM_SAMPLE_RATE = 24000

// ── 通用工具函数 ──────────────────────────────────────────────

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

/** 生成唯一请求 ID（Workers 支持 crypto.randomUUID） */
function uuid(): string {
  return crypto.randomUUID()
}

/**
 * 将 PCM 数据（16-bit 单声道）封装为 WAV 格式
 * 用于火山引擎返回的裸 PCM 数据
 */
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataLength = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // RIFF header
  writeStr(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeStr(view, 8, 'WAVE')
  writeStr(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * 1 * 16) / 8, true) // byteRate
  view.setUint16(32, 1 * (16 / 8), true) // blockAlign
  view.setUint16(34, 16, true) // bitsPerSample
  writeStr(view, 36, 'data')
  view.setUint32(40, dataLength, true)

  bytes.set(pcm, 44)
  return bytes
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

// ── 引擎1：melotts（免费兜底）──────────────────────────────

/**
 * 调用 melotts 合成单条文本（含重试）
 * melotts 返回 Uint8Array | { audio: string } | Response
 */
async function synthWithMelotts(
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

      let audioBytes: Uint8Array | null = null
      if (result instanceof Uint8Array) {
        audioBytes = result
      } else if (
        result &&
        typeof result === 'object' &&
        typeof (result as { audio?: unknown }).audio === 'string'
      ) {
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
      console.error(`[TTS] melotts error (retry ${retry}):`, lastError)
    }

    if (retry < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (retry + 1)))
    }
  }

  throw new Error(lastError || 'melotts 合成失败')
}

// ── 引擎2：火山引擎豆包 TTS 2.0 ────────────────────────────

/**
 * 调用火山引擎 V3 TTS 接口合成单条文本
 *
 * V3 unidirectional 接口返回流式多行 JSON，每行 { code, data }，
 * data 为 base64 编码的 PCM 音频片段，需拼接后封装为 WAV。
 *
 * 认证：同时发送 Bearer / X-Api-Key / X-Api-Access-Key 三种头，
 * 兼容方舟 Ark API Key、新版语音控制台 API Key、旧版 Access Token。
 */
async function synthWithVolcengineAt(
  url: string,
  apiKey: string,
  appId: string,
  voiceType: string,
  text: string
): Promise<string> {
  // 默认音色：seed-tts-2.0 的 Vivi 2.0（uranus_bigtts 系列；
  // 1.0 的 moon_bigtts 音色与 seed-tts-2.0 不兼容）
  const speaker = voiceType || 'zh_female_vv_uranus_bigtts'
  const requestId = uuid()
  const userId = uuid()

  // 三发认证，兼容三种密钥体系：
  // - Bearer:           方舟 Ark API Key
  // - X-Api-Key:        新版语音控制台 API Key（新版只需这一个头）
  // - X-Api-Access-Key: 旧版语音控制台 Access Token（需配合 X-Api-App-Key）
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Api-Key': apiKey,
    'X-Api-Access-Key': apiKey,
    'X-Api-Resource-Id': VOLC_RESOURCE_ID,
    'X-Api-Request-Id': requestId,
  }
  if (appId) {
    headers['X-Api-App-Key'] = appId
  }

  const body = {
    user: { uid: userId },
    req_params: {
      text: text.slice(0, MAX_TEXT_LENGTH),
      speaker,
      audio_params: {
        format: 'pcm',
        sample_rate: VOLC_PCM_SAMPLE_RATE,
      },
    },
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`火山引擎 HTTP ${response.status}: ${errText.slice(0, 200)}`)
  }

  // V3 流式响应：多行 JSON，逐行解析并累积 PCM 数据
  const fullText = await response.text()
  const pcmChunks: Uint8Array[] = []
  let hasError = false
  let errorMsg = ''

  for (const line of fullText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const msg = JSON.parse(trimmed) as {
        code?: number
        data?: string
        message?: string
      }
      const code = msg.code
      // code 0 / 20000000 / undefined(部分事件) 视为成功
      if (code !== undefined && code !== 0 && code !== 20000000) {
        hasError = true
        errorMsg = msg.message || `错误码 ${code}`
        console.error('[TTS] 火山引擎业务错误:', code, msg.message)
        break
      }
      if (msg.data) {
        pcmChunks.push(base64ToUint8Array(msg.data))
      }
    } catch {
      // 非 JSON 行（如空行/分隔符），跳过
    }
  }

  if (hasError) {
    throw new Error(`火山引擎: ${errorMsg}`)
  }

  // 拼接 PCM 并封装为 WAV
  const totalLength = pcmChunks.reduce((sum, c) => sum + c.byteLength, 0)
  if (totalLength === 0) {
    throw new Error('火山引擎未返回音频数据')
  }

  const mergedPcm = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of pcmChunks) {
    mergedPcm.set(chunk, offset)
    offset += chunk.byteLength
  }

  const wav = pcmToWav(mergedPcm, VOLC_PCM_SAMPLE_RATE)
  return uint8ToBase64(wav)
}

/**
 * 依次尝试按量计费 / 资源包(plan) 两套端点，命中后记住可用端点。
 * 两套端点协议完全一致，仅路径不同；用户用哪种计费方式取决于其控制台开通情况。
 */
async function synthWithVolcengine(
  apiKey: string,
  appId: string,
  voiceType: string,
  text: string
): Promise<string> {
  // 已命中的端点优先，其余按默认顺序跟上
  const candidates = volcWorkingUrl
    ? [volcWorkingUrl, ...VOLC_TTS_URLS.filter((u) => u !== volcWorkingUrl)]
    : VOLC_TTS_URLS

  let lastError: Error | null = null
  for (const url of candidates) {
    try {
      const audio = await synthWithVolcengineAt(url, apiKey, appId, voiceType, text)
      volcWorkingUrl = url
      return audio
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(`[TTS] 火山引擎端点失败 (${url}):`, lastError.message)
    }
  }
  throw lastError || new Error('火山引擎合成失败')
}

// ── 路由：根据 engine 选择引擎 ──────────────────────────────

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  try {
    const body = (await request.json()) as TTSBatchRequest
    const {
      engine = 'free',
      texts,
      lang = 'en',
      apiKey,
      appId,
      voiceType,
    } = body

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return Response.json({ error: '没有待合成的文本' }, { status: 400 })
    }

    // 火山引擎模式校验
    if (engine === 'volcengine') {
      if (!apiKey) {
        return Response.json(
          { error: '火山引擎模式需要填写 API Key' },
          { status: 400 }
        )
      }
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

        let audioBase64: string
        if (engine === 'volcengine') {
          audioBase64 = await synthWithVolcengine(
            apiKey!,
            appId || '',
            voiceType || '',
            text
          )
        } else {
          audioBase64 = await synthWithMelotts(env, text, lang)
        }
        results.push({ audio: audioBase64 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : '合成失败'
        results.push({ error: msg })
      }
    }

    const successCount = results.filter((r) => 'audio' in r).length
    console.log(
      `[TTS] engine=${engine}, batch: ${successCount}/${batch.length} succeeded`
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
