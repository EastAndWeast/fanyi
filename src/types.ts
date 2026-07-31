// 字幕片段
export interface SubtitleSegment {
  id: number
  start: number // 秒
  end: number // 秒
  textEn: string
  textZh: string
}

// 字幕样式设置
export interface SubtitleSettings {
  showEn: boolean
  showZh: boolean
  enColor: string
  zhColor: string
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

// 默认样式
export const DEFAULT_SETTINGS: SubtitleSettings = {
  showEn: true,
  showZh: true,
  enColor: '#ffffff',
  zhColor: '#ffd700',
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
