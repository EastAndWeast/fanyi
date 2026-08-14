import type { SourceLanguage } from '../types'

// 源语言启发式判定结果：'other' 表示中英以外的其他语言
export type DetectedLanguage = 'en' | 'zh' | 'other'

// CJK 统一表意文字（含扩展 A 与兼容表意文字）
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g
// 基本拉丁字母（不含 accented 字符）
const LATIN_RE = /[A-Za-z]/g

/**
 * 根据原文字幕文本启发式判定源语言：
 * - CJK 字符占比 > 20% 判为中文
 * - 基本拉丁字母占比过半判为英文
 * - 其余判为 other（日/韩/法/德等，中英都需翻译）
 *
 * 仅用于 sourceLanguage 为 'auto' 时决定翻译方向，误判时用户可在上传页显式指定。
 */
export function detectSourceLanguage(text: string): DetectedLanguage {
  const chars = text.replace(/\s/g, '')
  if (!chars) return 'other'
  const cjkCount = (chars.match(CJK_RE) || []).length
  const latinCount = (chars.match(LATIN_RE) || []).length
  if (cjkCount / chars.length > 0.2) return 'zh'
  if (latinCount / chars.length > 0.5) return 'en'
  return 'other'
}

/**
 * 结合用户指定的源语言得出翻译方向：
 * - 显式指定 en/zh 时直接采用，其余具体语种视为 other（中英都需翻译）
 * - auto 时按全部原文字幕文本启发式判定
 */
export function resolveTranslateDirection(
  sourceLanguage: SourceLanguage,
  originalText: string
): DetectedLanguage {
  if (sourceLanguage === 'en' || sourceLanguage === 'zh') return sourceLanguage
  if (sourceLanguage !== 'auto') return 'other'
  return detectSourceLanguage(originalText)
}
