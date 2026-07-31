// Cloudflare Pages Function: 语音识别 (Workers AI Whisper)
// 接收音频 FormData，返回字幕片段数组

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

    // 将音频转为 number[] 供 Workers AI 使用
    const audioArrayBuffer = await audioFile.arrayBuffer()
    const audioBytes = Array.from(new Uint8Array(audioArrayBuffer))

    console.log(`[STT] Audio size: ${audioBytes.length} bytes, type: ${audioFile.type}`)

    // 调用 Workers AI Whisper 模型
    let result: {
      text?: string
      vtt?: string
      word_count?: number
      words?: WhisperWord[]
    }
    try {
      result = await env.AI.run('@cf/openai/whisper', {
        audio: audioBytes,
        language: 'en',
      }) as {
        text?: string
        vtt?: string
        word_count?: number
        words?: WhisperWord[]
      }
    } catch (aiError) {
      console.error(`[STT] Workers AI error:`, aiError)
      const errMsg = aiError instanceof Error ? aiError.message : String(aiError)
      // 如果是内部错误，返回更友好的信息
      if (errMsg.includes('internal error')) {
        return Response.json(
          { error: '语音识别服务暂时不可用，请稍后重试' },
          { status: 503 }
        )
      }
      throw aiError
    }

    console.log(`[STT] Result keys: ${Object.keys(result).join(', ')}`)

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
      const audioDuration = Math.max((audioArrayBuffer.byteLength - 44) / 32000, 1)
      segments = segmentsFromText(result.text, audioDuration)
    }

    if (segments.length === 0) {
      return Response.json(
        { error: '未能识别到语音内容' },
        { status: 422 }
      )
    }

    return Response.json({ segments })
  } catch (err) {
    const message = err instanceof Error ? err.message : '语音识别失败'
    return Response.json({ error: message }, { status: 500 })
  }
}
