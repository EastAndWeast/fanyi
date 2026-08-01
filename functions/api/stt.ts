// Cloudflare Pages Function: 语音识别 (Workers AI Whisper)
// 接收音频 FormData，返回字幕片段数组
// 注意：@cf/openai/whisper 的 Workers binding 仅接受 number[] 作为 audio
// （测试确认不支持 base64 string，报 5006 oneOf 不匹配），
// 而 number[] JSON 膨胀约 3.5 倍，长音频单次请求会触发 3006 "Request is too large"，
// 因此将音频按 30 秒分块逐块转写，再拼接时间戳偏移

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
// - 超过 CHUNK_MAX_BYTES 才分块（30 秒），短视频保持单块识别质量最好
// - 分块后每块 30 秒（960K numbers → JSON 约 3.3MB），远低于 Workers AI 3006 限制
//   （社区报告 2MB 原始音频即 ~7MB JSON 触发 3006，30 秒块 3.3MB 有充足余量）
const CHUNK_MAX_BYTES = 30 * 32000
const CHUNK_BYTES = 30 * 32000

/**
 * 动态解析 WAV 结构，提取 fmt 参数和 data chunk 位置。
 * ffmpeg.wasm 生成的 WAV 可能含额外 chunk（LIST/fact 等），头部不一定 44 字节。
 */
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
  // 校验 RIFF/WAVE 标记
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

  // 遍历子 chunk（从 offset 12 开始）
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
    // chunk 按偶数对齐
    pos += 8 + chunkSize + (chunkSize % 2)
  }

  if (dataOffset === -1) return null
  return { sampleRate, numChannels, bitsPerSample, dataOffset, dataLength }
}

/**
 * 将 WAV 按时长切片为多段独立的标准 44 字节 PCM WAV。
 * 动态解析原始 WAV 结构（不假设头恰好 44 字节），每块用全新的标准头部。
 */
function sliceWav(buffer: ArrayBuffer): ArrayBuffer[] {
  const parsed = parseWav(buffer)
  if (!parsed) return [buffer] // 非标准 WAV，不切片直接整体返回

  const bytesPerSec = parsed.sampleRate * parsed.numChannels * (parsed.bitsPerSample / 8)
  const actualDataLength = Math.min(
    parsed.dataLength,
    buffer.byteLength - parsed.dataOffset
  )

  // 短音频不分块
  if (actualDataLength <= CHUNK_MAX_BYTES) return [buffer]

  const bytes = new Uint8Array(buffer)
  const data = bytes.subarray(parsed.dataOffset, parsed.dataOffset + actualDataLength)
  const chunks: ArrayBuffer[] = []

  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    const chunkData = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length))
    // 为每块构建标准 44 字节 PCM WAV 头
    const header = new Uint8Array(44)
    const dv = new DataView(header.buffer)
    header.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
    dv.setUint32(4, 36 + chunkData.length, true)
    header.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
    header.set([0x66, 0x6d, 0x74, 0x20], 12) // "fmt "
    dv.setUint32(16, 16, true) // PCM fmt size
    dv.setUint16(20, 1, true) // audioFormat = PCM
    dv.setUint16(22, parsed.numChannels, true)
    dv.setUint32(24, parsed.sampleRate, true)
    dv.setUint32(28, bytesPerSec, true)
    dv.setUint16(32, parsed.numChannels * (parsed.bitsPerSample / 8), true) // blockAlign
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

    // 将音频切片（短视频单块，长音频按 30 秒分块），每块转 number[] 供 Workers AI 使用
    const audioArrayBuffer = await audioFile.arrayBuffer()
    const chunks = sliceWav(audioArrayBuffer)
    console.log(
      `[STT] Audio size: ${audioArrayBuffer.byteLength} bytes, type: ${audioFile.type}, chunks: ${chunks.length}`
    )

    const allSegments: SubtitleSegment[] = []

    // 逐块转写（串行，避免并发触发限流）
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const audioBytes = Array.from(new Uint8Array(chunk))
      console.log(
        `[STT] Chunk ${i + 1}/${chunks.length}: ${audioBytes.length} numbers (${chunk.byteLength} bytes)`
      )

      // 调用 Workers AI Whisper 模型
      let result: {
        text?: string
        vtt?: string
        word_count?: number
        words?: WhisperWord[]
      }
      try {
        // workers-types 的 whisper 类型未声明 language 字段，但运行时需要它
        // （不传 language 在多语言音频时会报 3010），用类型断言绕过
        result = await env.AI.run('@cf/openai/whisper', {
          audio: audioBytes,
          language: 'en',
        } as { audio: number[] }) as {
          text?: string
          vtt?: string
          word_count?: number
          words?: WhisperWord[]
        }
      } catch (aiError) {
        console.error(`[STT] Workers AI error (chunk ${i + 1}):`, aiError)
        const errMsg = aiError instanceof Error ? aiError.message : String(aiError)
        // 3010 "Invalid audio input"：该块可能是纯静音/噪声段，跳过继续下一块
        if (errMsg.includes('Invalid audio input') || errMsg.includes('3010')) {
          console.warn(`[STT] Chunk ${i + 1} skipped (invalid/silent audio)`) 
          continue
        }
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
