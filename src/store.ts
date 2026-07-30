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

  // 视频
  videoFile: File | null
  videoUrl: string | null
  videoDuration: number

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
  subtitles: [],
  activeSubtitleId: null,
  settings: initial.settings,
  apiConfig: initial.apiConfig,

  setStep: (step) => set({ step }),

  setVideo: (file) => {
    const url = URL.createObjectURL(file)
    set({ videoFile: file, videoUrl: url })
  },

  clearVideo: () =>
    set((state) => {
      if (state.videoUrl) URL.revokeObjectURL(state.videoUrl)
      return { videoFile: null, videoUrl: null, subtitles: [], videoDuration: 0 }
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
      }
    }),
}))
