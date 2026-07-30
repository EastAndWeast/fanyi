import type { SubtitleSegment } from '../types'

/**
 * 将秒数格式化为 SRT 时间戳: HH:MM:SS,mmm
 */
function formatSRTTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/**
 * 将秒数格式化为 VTT 时间戳: HH:MM:SS.mmm
 */
function formatVTTTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/**
 * 生成 SRT 格式字幕
 */
export function generateSRT(
  subtitles: SubtitleSegment[],
  lang: 'en' | 'zh' | 'both' = 'both'
): string {
  return subtitles
    .map((sub, index) => {
      const texts: string[] = []
      if (lang === 'en' || lang === 'both') texts.push(sub.textEn)
      if (lang === 'zh' || lang === 'both') {
        if (sub.textZh) texts.push(sub.textZh)
      }

      if (texts.length === 0) return ''

      return `${index + 1}\n${formatSRTTime(sub.start)} --> ${formatSRTTime(sub.end)}\n${texts.join('\n')}`
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 生成 VTT 格式字幕
 */
export function generateVTT(
  subtitles: SubtitleSegment[],
  lang: 'en' | 'zh' | 'both' = 'both'
): string {
  const body = subtitles
    .map((sub) => {
      const texts: string[] = []
      if (lang === 'en' || lang === 'both') texts.push(sub.textEn)
      if (lang === 'zh' || lang === 'both') {
        if (sub.textZh) texts.push(sub.textZh)
      }

      if (texts.length === 0) return ''

      return `${formatVTTTime(sub.start)} --> ${formatVTTTime(sub.end)}\n${texts.join('\n')}`
    })
    .filter(Boolean)
    .join('\n\n')

  return `WEBVTT\n\n${body}`
}

/**
 * 触发文件下载
 */
export function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
