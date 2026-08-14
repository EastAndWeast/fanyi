// 说话人归并：把 diarization 检测结果映射到每条字幕上
//
// 规则：每条字幕取与其时间段重叠时长最长的 diarization 段的 speaker；
// 没有任何重叠（如纯音乐段识别出的字幕）则不写 speaker 字段。

import type { SubtitleSegment } from '../types'
import type { DiarizationSegment } from './diarization'

/**
 * @param subtitles 字幕数组（原地写入 speaker 字段）
 * @param segments diarization 输出的说话人分段
 * @returns 实际使用到的 speaker id 列表（升序）
 */
export function assignSpeakers(
  subtitles: SubtitleSegment[],
  segments: DiarizationSegment[]
): number[] {
  const used = new Set<number>()

  for (const sub of subtitles) {
    let bestSpeaker: number | undefined
    let bestOverlap = 0
    for (const seg of segments) {
      const overlap = Math.min(sub.end, seg.end) - Math.max(sub.start, seg.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestSpeaker = seg.speaker
      }
    }
    if (bestSpeaker !== undefined) {
      sub.speaker = bestSpeaker
      used.add(bestSpeaker)
    }
  }

  return [...used].sort((a, b) => a - b)
}
