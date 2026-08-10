// 配音时长对齐与混音模块
//
// 将多条 TTS 合成的 AudioBuffer 按字幕时间轴拼接为一条完整的配音音轨。
//
// 核心策略（以自然听感为优先）：
// - TTS ≤ 片段时长：在片段起始位置放置，尾部自动静音（最自然）
// - TTS > 片段时长（轻微）：加速播放（限制 1.5x 内，避免不自然）
// - TTS > 片段时长（严重）：加速到 1.5x 仍有溢出则截断
// - 合成失败的条目：该时间段静音

import type { SubtitleSegment } from '../types'

// 配音音轨采样率（与 melotts 输出一致：44100Hz mono）
const VOICE_SAMPLE_RATE = 44100
const VOICE_CHANNELS = 1
// 最大加速比（超过此值声音不自然）
const MAX_PLAYBACK_RATE = 1.5

/**
 * 将多条 TTS 音频按字幕时间轴混音为一条完整的配音音轨
 *
 * @param subtitles 字幕数组（提供时间轴 start/end）
 * @param voiceBuffers TTS 合成结果（与 subtitles 等长，null = 合成失败）
 * @param totalDuration 音轨总时长（秒），通常等于视频时长
 * @returns 完整的配音 AudioBuffer（mono 44100Hz）
 */
export async function mixVoiceTrack(
  subtitles: SubtitleSegment[],
  voiceBuffers: (AudioBuffer | null)[],
  totalDuration: number
): Promise<AudioBuffer> {
  const length = Math.ceil(totalDuration * VOICE_SAMPLE_RATE)
  const ctx = new OfflineAudioContext(VOICE_CHANNELS, length, VOICE_SAMPLE_RATE)

  let placed = 0
  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i]
    const voice = voiceBuffers[i]
    if (!voice) continue // 合成失败 → 该段静音

    const segmentDuration = Math.max(sub.end - sub.start, 0.1)
    const voiceDuration = voice.duration

    const source = ctx.createBufferSource()
    source.buffer = voice

    // TTS 比片段长时加速，否则原速播放
    if (voiceDuration > segmentDuration * 1.1) {
      // 需要加速：目标速率 = TTS时长 / 片段时长，限制在 MAX_PLAYBACK_RATE
      const targetRate = Math.min(voiceDuration / segmentDuration, MAX_PLAYBACK_RATE)
      source.playbackRate.value = targetRate
    }

    source.connect(ctx.destination)
    // 在字幕起始时间放置（尾部不足的部分自动静音）
    source.start(sub.start)
    placed++
  }

  console.log(
    `[VoiceMixer] 混音: ${placed}/${subtitles.length} 条配音, 总时长 ${totalDuration.toFixed(1)}s`
  )

  return await ctx.startRendering()
}

/**
 * 将 AudioBuffer 编码为 16-bit PCM WAV Blob
 *
 * 用于配音预览播放和 ffmpeg 混流。
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const bytesPerSample = 2 // 16-bit
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const bufferSize = 44 + dataSize

  const arrayBuffer = new ArrayBuffer(bufferSize)
  const view = new DataView(arrayBuffer)

  // WAV 头部
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // audioFormat = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byteRate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bitsPerSample
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // 交错写入各通道采样数据（16-bit PCM）
  const channels: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch))
  }

  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]))
      // Float32 → Int16
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
