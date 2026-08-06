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
// 并发请求数：Cloudflare Workers AI 免费版可承受 3 路并发，
// 太多会触发限流。3 路可将 20 块的识别时间从 ~5 分钟降到 ~2 分钟。
const STT_CONCURRENCY = 3

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
 * 单块 STT 请求（含自动重试）
 * 返回该块识别到的字幕片段（可为空数组——纯音乐/背景音块）
 */
async function processSTTChunk(
  chunk: ArrayBuffer,
  chunkIndex: number,
  totalChunks: number
): Promise<STTResponse> {
  let lastError: Error | null = null

  for (let retry = 0; retry <= STT_MAX_RETRIES; retry++) {
    try {
      const formData = new FormData()
      const blob = new Blob([chunk], { type: 'audio/wav' })
      formData.append('audio', blob, 'audio.wav')

      const response = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      })

      // 422 = "未能识别到语音内容"：该块可能为纯音乐/背景音/静音，
      // 属于正常情况，跳过该块继续后续识别，不中断整个流程
      if (response.status === 422) {
        console.warn(`[STT] Chunk ${chunkIndex + 1}/${totalChunks} returned 422 (no speech detected), skipping`)
        return { segments: [] }
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || `语音识别失败 (${response.status})`)
      }

      return (await response.json()) as STTResponse
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (retry < STT_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
      }
    }
  }

  throw lastError || new Error('语音识别失败')
}

/**
 * 调用后端 STT 接口（Workers AI Whisper）
 *
 * 前端将 WAV 按 30 秒切分，每块单独发送请求（STT_CONCURRENCY 路并发），
 * 避免长音频在后端串行处理时触发 Cloudflare 524 超时。
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
  const total = chunks.length
  onProgress?.(0, total)

  // 并发池：同时最多 STT_CONCURRENCY 个请求
  const results: STTResponse[] = new Array(total)
  let completed = 0
  let nextIndex = 0

  async function worker() {
    while (nextIndex < total) {
      const i = nextIndex++
      results[i] = await processSTTChunk(chunks[i], i, total)
      completed++
      onProgress?.(completed, total)
    }
  }

  // 启动 STT_CONCURRENCY 个 worker 并等待全部完成
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(STT_CONCURRENCY, total); w++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  // 按块顺序合并结果（带时间偏移）
  const allSegments: SubtitleSegment[] = []
  let segId = 0
  for (let i = 0; i < total; i++) {
    const offsetSeconds = (i * CHUNK_BYTES) / 32000
    for (const seg of results[i].segments) {
      allSegments.push({
        id: segId++,
        start: seg.start + offsetSeconds,
        end: seg.end + offsetSeconds,
        textEn: seg.text,
        textZh: '',
      })
    }
  }

  if (allSegments.length === 0) {
    throw new Error(
      '未能识别到语音内容，视频可能为纯音乐/背景音，或语音不清晰'
    )
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
// 一次性翻译过多条会导致 JSON 输出截断，所有翻译变空。
// 从 40 降到 20：批次过大会增加 GLM 推理时间，触发 Cloudflare 524 超时
const TRANSLATE_BATCH_SIZE = 20
const TRANSLATE_MAX_RETRIES = 2
// 翻译并发数：3 路可将 8 批的翻译时间从 ~5 分钟降到 ~2 分钟
const TRANSLATE_CONCURRENCY = 3

/**
 * 调用后端翻译接口（自动分批 + 并发请求）
 *
 * 每批含自动重试（应对偶发的 Cloudflare 524 超时），TRANSLATE_CONCURRENCY 路并发发送。
 *
 * @param config API 配置
 * @param texts 待翻译的英文字幕文本数组
 * @param onProgress 进度回调（已完成批数, 总批数）
 * @returns 中文翻译数组
 */
export async function callTranslate(
  config: ApiConfig,
  texts: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<string[]> {
  // 将文本切分为多个批次
  const batches: string[][] = []
  for (let i = 0; i < texts.length; i += TRANSLATE_BATCH_SIZE) {
    batches.push(texts.slice(i, i + TRANSLATE_BATCH_SIZE))
  }
  const totalBatches = batches.length
  onProgress?.(0, totalBatches)

  // 并发池：同时最多 TRANSLATE_CONCURRENCY 个批次
  const results: string[][] = new Array(totalBatches)
  let completed = 0
  let nextIndex = 0

  async function worker() {
    while (nextIndex < totalBatches) {
      const i = nextIndex++
      results[i] = await callTranslateBatchWithRetry(config, batches[i])
      completed++
      onProgress?.(completed, totalBatches)
    }
  }

  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(TRANSLATE_CONCURRENCY, totalBatches); w++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  // 按批次顺序合并结果
  const merged: string[] = []
  for (let i = 0; i < totalBatches; i++) {
    merged.push(...results[i])
  }
  return merged
}

/**
 * 单批翻译请求（含自动重试）
 *
 * Cloudflare Pages Functions 有网关超时限制（约 100 秒），
 * Workers AI GLM 模型偶尔响应较慢会触发 524。
 * 自动重试 2 次，每次间隔递增。
 */
async function callTranslateBatchWithRetry(
  config: ApiConfig,
  texts: string[]
): Promise<string[]> {
  let lastError: Error | null = null

  for (let retry = 0; retry <= TRANSLATE_MAX_RETRIES; retry++) {
    try {
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
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // 额度用尽类错误不重试
      if (lastError.message.includes('额度已用完')) {
        throw lastError
      }
      if (retry < TRANSLATE_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (retry + 1)))
      }
    }
  }

  throw lastError || new Error('翻译失败')
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
