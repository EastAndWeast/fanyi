// 字幕片段
export interface SubtitleSegment {
  id: number
  start: number // 秒
  end: number // 秒
  textEn: string
  textOriginal: string // 原文（源语言识别结果）
}

// 字幕样式设置
export interface SubtitleSettings {
  showEn: boolean
  showOriginal: boolean
  enColor: string
  originalColor: string
  positionY: number // 字幕垂直位置：距顶部百分比 0-100
  fontSize: number
  background: boolean
  bgOpacity: number // 0-1
  volume: number // 音量倍率：1 = 原声大小，>1 放大，<1 减小
}

// 翻译API配置
export interface ApiConfig {
  provider: 'deepseek' | 'glm' | 'custom'
  apiKey: string
  endpoint: string
  model: string
}

// TTS 配音引擎配置
type TtsEngine = 'free' | 'volcengine'

export interface TtsConfig {
  // 引擎：'free' = 内置 melotts（免费但不稳定）；'volcengine' = 火山引擎豆包TTS
  engine: TtsEngine
  // 火山引擎 API Key / Access Token
  apiKey: string
  // 火山引擎 App ID（应用标识，控制台获取）
  appId: string
  // 音色 ID（如 'zh_female_wanwanxiaohe_moon_bigtts'）
  voiceType: string
}

// 应用步骤
export type AppStep = 'upload' | 'processing' | 'editor' | 'export'

// 处理阶段
export type ProcessingStage =
  | 'idle'
  | 'extracting'
  | 'transcribing'
  | 'translating'
  | 'done'
  | 'error'

// API 预设
export const API_PRESETS: Record<
  ApiConfig['provider'],
  { endpoint: string; model: string; label: string }
> = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    label: 'DeepSeek',
  },
  glm: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    label: 'GLM (智谱)',
  },
  custom: {
    endpoint: '',
    model: '',
    label: '自定义',
  },
}

// 源语言选项：'auto' 为自动检测（Whisper 不传 language 参数），其余为常见语种
export type SourceLanguage =
  | 'auto'
  | 'en'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'it'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'hi'
  | 'th'
  | 'vi'

export const SOURCE_LANGUAGES: { value: SourceLanguage; label: string }[] = [
  { value: 'auto', label: '自动检测' },
  { value: 'ja', label: '日语' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'es', label: '西班牙语' },
  { value: 'it', label: '意大利语' },
  { value: 'pt', label: '葡萄牙语' },
  { value: 'ru', label: '俄语' },
  { value: 'ar', label: '阿拉伯语' },
  { value: 'hi', label: '印地语' },
  { value: 'th', label: '泰语' },
  { value: 'vi', label: '越南语' },
]

export const DEFAULT_SOURCE_LANGUAGE: SourceLanguage = 'auto'

// 默认样式
export const DEFAULT_SETTINGS: SubtitleSettings = {
  showEn: true,
  showOriginal: true,
  enColor: '#ffffff',
  originalColor: '#ffd700',
  positionY: 67, // 默认位于画面下方约 1/3 处
  fontSize: 24,
  background: true,
  bgOpacity: 0.5,
  volume: 1, // 默认与原声一样大
}

// 默认API配置
export const DEFAULT_API_CONFIG: ApiConfig = {
  provider: 'deepseek',
  apiKey: '',
  endpoint: API_PRESETS.deepseek.endpoint,
  model: API_PRESETS.deepseek.model,
}

// 默认 TTS 配置（免费引擎兄底，用户可在导出页切换火山引擎）
export const DEFAULT_TTS_CONFIG: TtsConfig = {
  engine: 'free',
  apiKey: '',
  appId: '',
  voiceType: '',
}
