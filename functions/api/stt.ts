// Cloudflare Pages Function: 语音识别 (Workers AI Whisper)
// 接收音频 FormData，返回字幕片段数组
// 注意：Whisper 的 audio 参数需传 base64 字符串（传 number[] 时 JSON 体积膨胀 3-4 倍，
// 长音频会触发 Workers AI 错误 3006 "Request is too large"），
// 大音频需按块转写再拼接（官方推荐做法）

interface Env {
  AI: Ai
}

interface SubtitleSegment {
  start: number
  end: number
  text: string
}

interface WhisperWord {
  word?: string
  start?: number
  end?: number
}

// 分块参数（16kHz / 16bit / 单声道 WAV，每秒 32000 字节）：
// - 超过 CHUNK_MAX_BYTES 才分块（约 3.6 分钟），短视频保持单块识别质量最好
// - 分块后每块约 3 分钟（5.76MB，base64 后约 7.7MB），远低于 Workers AI 请求限制
const CHUNK_MAX_BYTES = 7 * 1024 * 1024
const CHUNK_BYTES = 180 * 32000

/**
 * 将 WAV 二进制按字节切片为多段独立 WAV（重写每段的文件头）
 * WAV 结构：44 字节 RIFF 头 + PCM 数据（16kHz 单声道 16bit）
 */
function sliceWav(buffer: ArrayBuffer): ArrayBuffer[] {
  const bytes = new Uint8Array(buffer)
  if (bytes.length <= 44 + CHUNK_MAX_BYTES) return [buffer]

  const header = bytes.subarray(0, 44)
  const data = bytes.subarray(44)
  const chunks: ArrayBuffer[] = []

  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    const chunkData = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length))
    // 重建头：修正 RIFF size（offset 4）和 data size（offset 40）
    const chunkHeader = new Uint8Array(44)
    chunkHeader.set(header)
    const dv = new DataView(chunkHeader.buffer)
    dv.setUint32(4, 36 + chunkData.length, true)
    dv.setUint32(40, chunkData.length, true)

    const chunk = new Uint8Array(44 + chunkData.length)
    chunk.set(chunkHeader)
    chunk.set(chunkData, 44)
    chunks.push(chunk.buffer as ArrayBuffer)
  }
  return chunks
}

/**
 * Uint8Array 转 base64（分块拼接避免展开超大参数列表爆栈）
 * btoa 是 Cloudflare Workers 全局 API，无需 nodejs_compat
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP))
  }
  return btoa(binary)
}

// 解析 WebVTT 时间戳为秒数
function parseTimestamp(ts: string): number {
  const parts = ts.trim().replace(',', '.').split(':')
  if (parts.length === 3) {
    return (
      parseInt(parts[0]) * 3600 +
      parseInt(parts[1]) * 60 +
      parseFloat(parts[2])
    )
  }
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1])
  }
  return parseFloat(parts[0])
}

// 解析 VTT 文本为字幕片段
export function parseVTT(vtt: string): SubtitleSegment[] {
  const lines = vtt.split('\n')
  const segments: SubtitleSegment[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()

    // 寻找时间戳行 (格式: 00:00:01.000 --> 00:00:03.000)
    const timeMatch = line.match(
      /(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})/
    )

    if (timeMatch) {
      const start = parseTimestamp(timeMatch[1])
      const end = parseTimestamp(timeMatch[2])

      // 收集字幕文本（可能多行）
      const textLines: string[] = []
      i++
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim())
        i++
      }

      const text = textLines.join(' ').trim()
      if (text && text !== '') {
        segments.push({ start, end, text })
      }
    } else {
      i++
    }
  }

  return segments
}

export function segmentsFromWords(words: WhisperWord[]): SubtitleSegment[] {
  const segments: SubtitleSegment[] = []
  let currentWords: string[] = []
  let start = 0
  let end = 0

  const flush = () => {
    if (currentWords.length === 0) return
    segments.push({
      start,
      end,
      text: currentWords.join(' ').replace(/\s+([,.!?;:])/g, '$1'),
    })
    currentWords = []
  }

  for (const item of words) {
    const word = item.word?.trim()
    if (!word || typeof item.start !== 'number' || typeof item.end !== 'number') {
      continue
    }

    if (currentWords.length === 0) start = item.start
    currentWords.push(word)
    end = item.end

    if (/[.!?。！？]$/.test(word) || currentWords.length >= 10 || end - start >= 5) {
      flush()
    }
  }

  flush()
  return segments
}

export function segmentsFromText(text: string, duration: number): SubtitleSegment[] {
  const parts =
    text.match(/[^.!?。！？]+[.!?。！？]?/g)?.map((part) => part.trim()).filter(Boolean) ||
    [text.trim()]
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  let start = 0

  return parts.map((part, index) => {
    const isLast = index === parts.length - 1
    const end = isLast
      ? duration
      : Math.min(duration, start + (duration * part.length) / totalLength)
    const segment = { start, end, text: part }
    start = end
    return segment
  })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  try {
    const formData = await request.formData()
    const audioFile = formData.get('audio') as File | null

    if (!audioFile) {
      return Response.json({ error: '未找到音频文件' }, { status: 400 })
    }

    // 将音频切片（短视频单块，长音频按 3 分钟分块）并转 base64 供 Workers AI 使用
    const audioArrayBuffer = await audioFile.arrayBuffer()
    const chunks = sliceWav(audioArrayBuffer)
    console.log(
      `[STT] Audio size: ${audioArrayBuffer.byteLength} bytes, type: ${audioFile.type}, chunks: ${chunks.length}`
    )

    const allSegments: SubtitleSegment[] = []

    // 逐块转写（串行，避免并发触发限流）
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const audioBase64 = bytesToBase64(new Uint8Array(chunk))
      console.log(`[STT] Chunk ${i + 1}/${chunks.length}: ${chunk.byteLength} bytes`)

      // 调用 Workers AI Whisper 模型
      let result: {
        text?: string
        vtt?: string
        word_count?: number
        words?: WhisperWord[]
      }
      try {
        // 运行时 audio 参数接受 base64 字符串（官方文档
        // build-a-workers-ai-whisper-with-chunking 即用 audio: base64），
        // workers-types 类型定义滞后仅声明 number[]，故放宽输入类型
        result = await (env.AI.run as (
          model: string,
          inputs: { audio: string; language?: string },
          options?: unknown
        ) => Promise<{
          text?: string
          vtt?: string
          word_count?: number
          words?: WhisperWord[]
        }>)('@cf/openai/whisper', {
          audio: audioBase64,
          language: 'en',
        })
      } catch (aiError) {
        console.error(`[STT] Workers AI error (chunk ${i + 1}):`, aiError)
        const errMsg = aiError instanceof Error ? aiError.message : String(aiError)
        // 如果是内部错误，返回更友好的信息
        if (errMsg.includes('internal error')) {
          return Response.json(
            { error: '语音识别服务暂时不可用，请稍后重试' },
            { status: 503 }
          )
        }
        if (errMsg.includes('too large')) {
          return Response.json(
            { error: '音频数据过大，请将视频分段后再试' },
            { status: 413 }
          )
        }
        throw aiError
      }

      console.log(`[STT] Chunk ${i + 1} result keys: ${Object.keys(result).join(', ')}`)

      // 优先解析 VTT 格式（含时间戳）
      let segments: SubtitleSegment[] = []
      if (result.vtt) {
        segments = parseVTT(result.vtt)
      }

      // VTT 缺失或解析失败时，使用 Whisper 的单词时间戳生成字幕
      if (segments.length === 0 && result.words?.length) {
        segments = segmentsFromWords(result.words)
      }

      // 最后降级：按音频时长将纯文本拆成多个有效时间段
      if (segments.length === 0 && result.text) {
        // 前端固定上传 16kHz、单声道、16-bit PCM WAV
        const audioDuration = Math.max((chunk.byteLength - 44) / 32000, 1)
        segments = segmentsFromText(result.text, audioDuration)
      }

      // 分块时按块起始时间偏移，再合并到总结果
      const offsetSeconds = (i * CHUNK_BYTES) / 32000
      for (const seg of segments) {
        allSegments.push({
          start: seg.start + offsetSeconds,
          end: seg.end + offsetSeconds,
          text: seg.text,
        })
      }
    }

    if (allSegments.length === 0) {
      return Response.json(
        { error: '未能识别到语音内容' },
        { status: 422 }
      )
    }

    return Response.json({ segments: allSegments })
  } catch (err) {
    const message = err instanceof Error ? err.message : '语音识别失败'
    return Response.json({ error: message }, { status: 500 })
  }
}
