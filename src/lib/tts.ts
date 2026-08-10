// 英文 TTS 配音合成模块
//
// 将字幕的英文文本发送给后端 TTS API（Workers AI melotts），
// 合成语音并解码为 AudioBuffer，供后续时长对齐和音轨替换使用。
//
// 后端单批最多 5 条文本（含重试），前端 3 路并发，
// 实现参考 api.ts 的 callSTT / callTranslate 并发池模式。

import type { SubtitleSegment, TtsConfig } from '../types'

// 单批 TTS 最大条数（与后端 tts.ts 的限制对齐）
const TTS_BATCH_SIZE = 5
// 并发批次数（3 路，平衡速度与后端压力）
const TTS_CONCURRENCY = 3

interface TTSBatchResponse {
  results: { audio?: string; error?: string }[]
  successCount: number
  totalCount: number
}

/**
 * base64 字符串 → ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  // decodeAudioData 需要可转移的 ArrayBuffer
  return bytes.buffer.slice(0) as ArrayBuffer
}

/**
 * 单批 TTS 请求（按引擎类型传递不同参数）
 */
async function requestTTSBatch(
  texts: string[],
  config: TtsConfig
): Promise<TTSBatchResponse> {
  const payload: Record<string, unknown> = {
    texts,
    engine: config.engine,
  }
  if (config.engine === 'volcengine') {
    payload.apiKey = config.apiKey
    payload.appId = config.appId
    payload.voiceType = config.voiceType
  } else {
    payload.lang = 'en'
  }

  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `TTS 请求失败 (${response.status})`)
  }

  return (await response.json()) as TTSBatchResponse
}

/**
 * 批量合成英文配音
 *
 * 将字幕的英文文本分批发送给后端，解码返回的音频为 AudioBuffer。
 * 合成失败的条目返回 null（时长对齐时做静音处理）。
 *
 * @param subtitles 字幕数组（使用 textEn 作为合成源文本）
 * @param config TTS 引擎配置（决定使用免费 melotts 还是火山引擎）
 * @param onProgress 进度回调（已完成条数, 总条数）
 * @returns 与 subtitles 等长的 AudioBuffer 数组（失败为 null）
 */
export async function synthesizeVoice(
  subtitles: SubtitleSegment[],
  config: TtsConfig,
  onProgress?: (completed: number, total: number) => void
): Promise<(AudioBuffer | null)[]> {
  const total = subtitles.length
  onProgress?.(0, total)

  // 用于解码 WAV 音频的 AudioContext（decodeAudioData 不需要 resume）
  const audioCtx = new AudioContext()

  // 按 TTS_BATCH_SIZE 分批，记录每批对应的原始字幕索引
  // 跳过没有英文文本的条目（直接标记为 null）
  const batches: { texts: string[]; indices: number[] }[] = []
  for (let i = 0; i < total; i += TTS_BATCH_SIZE) {
    const batchTexts: string[] = []
    const indices: number[] = []
    for (let j = i; j < Math.min(i + TTS_BATCH_SIZE, total); j++) {
      const text = subtitles[j].textEn.trim()
      if (text) {
        batchTexts.push(text)
        indices.push(j)
      }
    }
    if (batchTexts.length > 0) {
      batches.push({ texts: batchTexts, indices })
    }
  }

  const results: (AudioBuffer | null)[] = new Array(total).fill(null)
  let completed = subtitles.filter((s) => !s.textEn.trim()).length // 空文本直接计入已完成
  onProgress?.(completed, total)

  // 并发池：同时最多 TTS_CONCURRENCY 个批次
  let nextBatch = 0

  async function worker() {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++]
      try {
        const resp = await requestTTSBatch(batch.texts, config)
        for (let k = 0; k < resp.results.length; k++) {
          const origIndex = batch.indices[k]
          const item = resp.results[k]
          if (item.audio) {
            try {
              const arrayBuffer = base64ToArrayBuffer(item.audio)
              results[origIndex] = await audioCtx.decodeAudioData(arrayBuffer)
            } catch (decodeErr) {
              console.warn('[TTS] 音频解码失败:', decodeErr)
            }
          }
          completed++
          onProgress?.(completed, total)
        }
      } catch (err) {
        // 整批失败，所有条目标记完成（null）
        console.error('[TTS] 批次失败:', err)
        completed += batch.indices.length
        onProgress?.(completed, total)
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(TTS_CONCURRENCY, batches.length); w++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  audioCtx.close().catch(() => {})

  const successCount = results.filter(Boolean).length
  console.log(`[TTS] 合成完成: ${successCount}/${total} 成功`)

  return results
}
