import type { SubtitleSegment, ApiConfig } from '../types'

interface STTResponse {
  segments: { start: number; end: number; text: string }[]
}

interface TranslateResponse {
  translations: string[]
}

// ── WAV 分块逻辑（镜像后端 functions/api/stt.ts 的实现）──────────────
//
// 为什么要前端分块：
// 之前前端将整个 WAV 一次性发给后端，后端串行逐块调用 Workers AI Whisper。
// 长音频（3 分钟以上）的串行处理总时间超过 Cloudflare Pages Functions
// 超时限制，网关返回 524。
// 改为前端切分 → 每块单独请求 → 后端每次只处理一块（数秒返回），彻底消除超时。

// 16kHz / 16bit / 单声道 PCM，每秒 32000 字节
const CHUNK_MAX_BYTES = 30 * 32000
const CHUNK_BYTES = 30 * 32000
const STT_MAX_RETRIES = 2

interface WavParsed {
  sampleRate: number
  numChannels: number
  bitsPerSample: number
  dataOffset: number
  dataLength: number
}

function parseWav(buffer: ArrayBuffer): WavParsed | null {
  const bytes = new Uint8Array(buffer)
  const dv = new DataView(buffer)
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE'
  ) {
    return null
  }

  let sampleRate = 16000
  let numChannels = 1
  let bitsPerSample = 16
  let dataOffset = -1
  let dataLength = 0

  let pos = 12
  while (pos + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(...bytes.subarray(pos, pos + 4))
    const chunkSize = dv.getUint32(pos + 4, true)
    if (chunkId === 'fmt ') {
      numChannels = dv.getUint16(pos + 10, true)
      sampleRate = dv.getUint32(pos + 12, true)
      bitsPerSample = dv.getUint16(pos + 22, true)
    } else if (chunkId === 'data') {
      dataOffset = pos + 8
      dataLength = chunkSize
      break
    }
    pos += 8 + chunkSize + (chunkSize % 2)
  }

  if (dataOffset === -1) return null
  return { sampleRate, numChannels, bitsPerSample, dataOffset, dataLength }
}

function sliceWav(buffer: ArrayBuffer): ArrayBuffer[] {
  const parsed = parseWav(buffer)
  if (!parsed) return [buffer]

  const bytesPerSec = parsed.sampleRate * parsed.numChannels * (parsed.bitsPerSample / 8)
  const actualDataLength = Math.min(
    parsed.dataLength,
    buffer.byteLength - parsed.dataOffset
  )

  if (actualDataLength <= CHUNK_MAX_BYTES) return [buffer]

  const bytes = new Uint8Array(buffer)
  const data = bytes.subarray(parsed.dataOffset, parsed.dataOffset + actualDataLength)
  const chunks: ArrayBuffer[] = []

  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    const chunkData = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length))
    const header = new Uint8Array(44)
    const dv = new DataView(header.buffer)
    header.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
    dv.setUint32(4, 36 + chunkData.length, true)
    header.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
    header.set([0x66, 0x6d, 0x74, 0x20], 12) // "fmt "
    dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true)
    dv.setUint16(22, parsed.numChannels, true)
    dv.setUint32(24, parsed.sampleRate, true)
    dv.setUint32(28, bytesPerSec, true)
    dv.setUint16(32, parsed.numChannels * (parsed.bitsPerSample / 8), true)
    dv.setUint16(34, parsed.bitsPerSample, true)
    header.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
    dv.setUint32(40, chunkData.length, true)

    const chunk = new Uint8Array(44 + chunkData.length)
    chunk.set(header)
    chunk.set(chunkData, 44)
    chunks.push(chunk.buffer as ArrayBuffer)
  }
  return chunks
}

/**
 * 调用后端 STT 接口（Workers AI Whisper）
 *
 * 前端将 WAV 按 30 秒切分，每块单独发送一个请求，避免长音频在后端
 * 串行处理时触发 Cloudflare 524 超时。
 *
 * @param audioWav WAV 格式的 ArrayBuffer（16kHz 单声道 16-bit）
 * @param onProgress 进度回调（已完成块数, 总块数）
 * @returns 字幕片段数组（仅英文，textZh 为空）
 */
export async function callSTT(
  audioWav: ArrayBuffer,
  onProgress?: (completed: number, total: number) => void
): Promise<SubtitleSegment[]> {
  const chunks = sliceWav(audioWav)
  const allSegments: SubtitleSegment[] = []
  let segId = 0

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length)

    let data: STTResponse | null = null
    let lastError: Error | null = null

    // 单块最多重试 STT_MAX_RETRIES 次（应对偶发的 524 / 网络波动）
    for (let retry = 0; retry <= STT_MAX_RETRIES; retry++) {
      try {
        const formData = new FormData()
        const blob = new Blob([chunks[i]], { type: 'audio/wav' })
        formData.append('audio', blob, 'audio.wav')

        const response = await fetch('/api/stt', {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          throw new Error(err.error || `语音识别失败 (${response.status})`)
        }

        data = (await response.json()) as STTResponse
        lastError = null
        break
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // 最后一次重试不再等待
        if (retry < STT_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
        }
      }
    }

    if (lastError) throw lastError
    if (!data) throw new Error('语音识别失败')

    // 按块起始时间偏移后合并
    const offsetSeconds = (i * CHUNK_BYTES) / 32000
    for (const seg of data.segments) {
      allSegments.push({
        id: segId++,
        start: seg.start + offsetSeconds,
        end: seg.end + offsetSeconds,
        textEn: seg.text,
        textZh: '',
      })
    }
  }

  onProgress?.(chunks.length, chunks.length)

  if (allSegments.length === 0) {
    throw new Error('未能识别到语音内容')
  }

  return allSegments
}

/**
 * 规范化 API Endpoint：
 * 用户只填 Base URL（如 https://open.bigmodel.cn/api/paas/v4）时
 * 自动补全 /chat/completions 后缀
 */
export function normalizeEndpoint(endpoint: string): string {
  let url = endpoint.trim().replace(/\/+$/, '')
  if (!url) return url
  if (!url.endsWith('/chat/completions')) {
    url += '/chat/completions'
  }
  return url
}

// 每批翻译的最大条数：Workers AI GLM 模型 max_tokens 有限（4096），
// 一次性翻译过多条会导致 JSON 输出截断，所有翻译变空。实测 40 条以下稳定。
const TRANSLATE_BATCH_SIZE = 40

/**
 * 调用后端翻译接口（自动分批，避免长视频一次性翻译超出模型 token 限制）
 * @param config API 配置
 * @param texts 待翻译的英文字幕文本数组
 * @returns 中文翻译数组
 */
export async function callTranslate(
  config: ApiConfig,
  texts: string[]
): Promise<string[]> {
  // 少量文本直接单次请求
  if (texts.length <= TRANSLATE_BATCH_SIZE) {
    return callTranslateBatch(config, texts)
  }

  // 分批翻译后合并结果
  const results: string[] = []
  for (let i = 0; i < texts.length; i += TRANSLATE_BATCH_SIZE) {
    const batch = texts.slice(i, i + TRANSLATE_BATCH_SIZE)
    const translations = await callTranslateBatch(config, batch)
    results.push(...translations)
  }
  return results
}

/**
 * 单批翻译请求（内部函数）
 */
async function callTranslateBatch(
  config: ApiConfig,
  texts: string[]
): Promise<string[]> {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: normalizeEndpoint(config.endpoint),
      apiKey: config.apiKey,
      model: config.model,
      texts,
    }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `翻译失败 (${response.status})`)
  }

  const data = (await response.json()) as TranslateResponse
  return data.translations
}

/**
 * 检测 API 连接：发送一条测试文本，验证配置是否可用
 * @returns 测试文本的翻译结果
 */
export async function testApiConnection(config: ApiConfig): Promise<string> {
  const translations = await callTranslate(config, [
    'Hello, this is a connection test.',
  ])
  const result = translations[0]?.trim()
  if (!result) {
    throw new Error('API 返回为空，请检查模型名称是否正确')
  }
  return result
}
