import type { SubtitleSegment, ApiConfig } from '../types'

interface STTResponse {
  segments: { start: number; end: number; text: string }[]
}

interface TranslateResponse {
  translations: string[]
}

/**
 * 调用后端 STT 接口（Workers AI Whisper）
 * @param audioWav WAV 格式的 ArrayBuffer
 * @returns 字幕片段数组（仅英文，textZh 为空）
 */
export async function callSTT(
  audioWav: ArrayBuffer
): Promise<SubtitleSegment[]> {
  const formData = new FormData()
  const blob = new Blob([audioWav], { type: 'audio/wav' })
  formData.append('audio', blob, 'audio.wav')

  const response = await fetch('/api/stt', {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `语音识别失败 (${response.status})`)
  }

  const data = (await response.json()) as STTResponse

  return data.segments.map((seg, index) => ({
    id: index,
    start: seg.start,
    end: seg.end,
    textEn: seg.text,
    textZh: '',
  }))
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

/**
 * 调用后端翻译接口
 * @param config API 配置
 * @param texts 待翻译的英文字幕文本数组
 * @returns 中文翻译数组
 */
export async function callTranslate(
  config: ApiConfig,
  texts: string[]
): Promise<string[]> {
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
