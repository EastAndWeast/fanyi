import { create } from 'zustand'
import type {
  SubtitleSegment,
  SubtitleSettings,
  ApiConfig,
  AppStep,
} from './types'
import {
  DEFAULT_SETTINGS,
  DEFAULT_API_CONFIG,
} from './types'

interface AppState {
  // 步骤
  step: AppStep

  // 媒体文件（视频或音频，沿用 videoFile 名以控制改动范围）
  videoFile: File | null
  videoUrl: string | null
  videoDuration: number
  // 媒体类型：由 detectMediaKind 在 setVideo 时判定，组件据此区分视频/音频模式
  mediaKind: 'video' | 'audio'

  // 字幕
  subtitles: SubtitleSegment[]
  activeSubtitleId: number | null

  // 样式
  settings: SubtitleSettings

  // API配置
  apiConfig: ApiConfig

  // Actions
  setStep: (step: AppStep) => void
  setVideo: (file: File) => void
  clearVideo: () => void
  setSubtitles: (subs: SubtitleSegment[]) => void
  updateSubtitle: (id: number, patch: Partial<SubtitleSegment>) => void
  setActiveSubtitle: (id: number | null) => void
  updateSettings: (patch: Partial<SubtitleSettings>) => void
  updateApiConfig: (patch: Partial<ApiConfig>) => void
  reset: () => void
}

const AUDIO_EXT = /\.(ac3|eac3|aac|m4a|mp3|wav|flac|ogg|opus|wma|amr|aiff?)$/i
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi|wmv|flv|mpg|mpeg|ts|3gp)$/i

/**
 * 是否为受支持的视频/音频文件（上传时用于拦截 .txt/.pdf 等非媒体文件）。
 * 优先认 MIME，缺失时按扩展名兜底。
 */
export function isMediaFile(file: File): boolean {
  const t = file.type
  if (t.startsWith('audio/') || t.startsWith('video/')) return true
  return AUDIO_EXT.test(file.name) || VIDEO_EXT.test(file.name)
}

/**
 * 判定媒体类型（用于区分视频/音频模式）。
 * AC3 的 file.type 在多数浏览器为空串，若仅靠 startsWith('audio/') 会被误判为视频，
 * 导致导出页错误展示压制面板；此处用扩展名兜底。
 */
export function detectMediaKind(file: File): 'video' | 'audio' {
  const t = file.type
  if (t.startsWith('audio/')) return 'audio'
  if (t.startsWith('video/')) return 'video'
  if (AUDIO_EXT.test(file.name)) return 'audio'
  if (VIDEO_EXT.test(file.name)) return 'video'
  return 'video' // 兜底（上传时 isMediaFile 已拦截非媒体文件）
}

const STORAGE_KEY = 'vst-state'

function loadPersisted(): {
  settings: SubtitleSettings
  apiConfig: ApiConfig
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { settings: DEFAULT_SETTINGS, apiConfig: DEFAULT_API_CONFIG }
    const parsed = JSON.parse(raw)
    return {
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      apiConfig: { ...DEFAULT_API_CONFIG, ...parsed.apiConfig },
    }
  } catch {
    return { settings: DEFAULT_SETTINGS, apiConfig: DEFAULT_API_CONFIG }
  }
}

function persist(settings: SubtitleSettings, apiConfig: ApiConfig) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ settings, apiConfig })
    )
  } catch {
    // ignore
  }
}

const initial = loadPersisted()

export const useStore = create<AppState>((set) => ({
  step: 'upload',
  videoFile: null,
  videoUrl: null,
  videoDuration: 0,
  mediaKind: 'video',
  subtitles: [],
  activeSubtitleId: null,
  settings: initial.settings,
  apiConfig: initial.apiConfig,

  setStep: (step) => set({ step }),

  setVideo: (file) => {
    const url = URL.createObjectURL(file)
    set({ videoFile: file, videoUrl: url, mediaKind: detectMediaKind(file) })
  },

  clearVideo: () =>
    set((state) => {
      if (state.videoUrl) URL.revokeObjectURL(state.videoUrl)
      return { videoFile: null, videoUrl: null, subtitles: [], videoDuration: 0, mediaKind: 'video' }
    }),

  setSubtitles: (subtitles) => set({ subtitles }),

  updateSubtitle: (id, patch) =>
    set((state) => ({
      subtitles: state.subtitles.map((s) =>
        s.id === id ? { ...s, ...patch } : s
      ),
    })),

  setActiveSubtitle: (id) => set({ activeSubtitleId: id }),

  updateSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch }
      persist(settings, state.apiConfig)
      return { settings }
    }),

  updateApiConfig: (patch) =>
    set((state) => {
      const apiConfig = { ...state.apiConfig, ...patch }
      persist(state.settings, apiConfig)
      return { apiConfig }
    }),

  reset: () =>
    set((state) => {
      if (state.videoUrl) URL.revokeObjectURL(state.videoUrl)
      return {
        step: 'upload',
        videoFile: null,
        videoUrl: null,
        subtitles: [],
        videoDuration: 0,
        activeSubtitleId: null,
        mediaKind: 'video',
      }
    }),
}))
