import type { SubtitleOrder, SubtitleSegment } from '../types'

/**
 * 按指定语言和双语顺序收集单条字幕文本行
 */
function collectTexts(
  sub: SubtitleSegment,
  lang: 'en' | 'zh' | 'both',
  order: SubtitleOrder
): string[] {
  if (lang === 'en') return sub.textEn ? [sub.textEn] : []
  if (lang === 'zh') return sub.textZh ? [sub.textZh] : []

  const langOrder: ('zh' | 'en')[] =
    order === 'zh-en' ? ['zh', 'en'] : ['en', 'zh']
  const texts: string[] = []
  for (const l of langOrder) {
    if (l === 'zh' && sub.textZh) texts.push(sub.textZh)
    if (l === 'en' && sub.textEn) texts.push(sub.textEn)
  }
  return texts
}

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
  lang: 'en' | 'zh' | 'both' = 'both',
  order: SubtitleOrder = 'en-zh'
): string {
  return subtitles
    .map((sub, index) => {
      const texts = collectTexts(sub, lang, order)
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
  lang: 'en' | 'zh' | 'both' = 'both',
  order: SubtitleOrder = 'en-zh'
): string {
  const body = subtitles
    .map((sub) => {
      const texts = collectTexts(sub, lang, order)
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
