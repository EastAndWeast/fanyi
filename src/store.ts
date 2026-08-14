import { create } from 'zustand'
import type {
  SubtitleSegment,
  SubtitleSettings,
  ApiConfig,
  TtsConfig,
  AppStep,
  SourceLanguage,
  SpeakerInfo,
} from './types'
import {
  DEFAULT_SETTINGS,
  DEFAULT_API_CONFIG,
  DEFAULT_TTS_CONFIG,
  DEFAULT_SOURCE_LANGUAGE,
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

  // TTS 配音配置
  ttsConfig: TtsConfig

  // 源语言（视频/音频说的语言，用于语音识别；'auto' 为自动检测）
  sourceLanguage: SourceLanguage

  // 多说话人检测与配音
  speakers: SpeakerInfo[] // 检测到的说话人及各自音色（不持久化，随视频生命周期）
  diarizationEnabled: boolean // 是否启用多人声音检测
  speakerCount: number | null // 指定说话人数；null = 自动聚类

  // 配音开关与合成好的配音音轨
  // 放全局 store 而非 ExportView 组件内：否则「返回编辑」再回来开关被重置、
  // 音轨丢失，导出会静默退回原声（用户以为开了配音，导出还是原声）
  voiceOverEnabled: boolean
  voiceTrack: AudioBuffer | null // 不持久化，随视频生命周期

  // Actions
  setStep: (step: AppStep) => void
  setVideo: (file: File) => void
  clearVideo: () => void
  setSubtitles: (subs: SubtitleSegment[]) => void
  updateSubtitle: (id: number, patch: Partial<SubtitleSegment>) => void
  setActiveSubtitle: (id: number | null) => void
  updateSettings: (patch: Partial<SubtitleSettings>) => void
  updateApiConfig: (patch: Partial<ApiConfig>) => void
  updateTtsConfig: (patch: Partial<TtsConfig>) => void
  setSourceLanguage: (lang: SourceLanguage) => void
  setSpeakers: (speakers: SpeakerInfo[]) => void
  setSpeakerVoice: (id: number, voiceType: string) => void
  setDiarizationEnabled: (enabled: boolean) => void
  setSpeakerCount: (count: number | null) => void
  setVoiceOverEnabled: (enabled: boolean) => void
  setVoiceTrack: (track: AudioBuffer | null) => void
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
  ttsConfig: TtsConfig
  sourceLanguage: SourceLanguage
  diarizationEnabled: boolean
  speakerCount: number | null
} {
  const defaults = {
    settings: DEFAULT_SETTINGS,
    apiConfig: DEFAULT_API_CONFIG,
    ttsConfig: DEFAULT_TTS_CONFIG,
    sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
    diarizationEnabled: true,
    speakerCount: null,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    return {
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      apiConfig: { ...DEFAULT_API_CONFIG, ...parsed.apiConfig },
      ttsConfig: { ...DEFAULT_TTS_CONFIG, ...parsed.ttsConfig },
      sourceLanguage: parsed.sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE,
      diarizationEnabled: parsed.diarizationEnabled ?? true,
      speakerCount:
        typeof parsed.speakerCount === 'number' && parsed.speakerCount > 0
          ? parsed.speakerCount
          : null,
    }
  } catch {
    return defaults
  }
}

function persist(
  settings: SubtitleSettings,
  apiConfig: ApiConfig,
  ttsConfig: TtsConfig,
  sourceLanguage: SourceLanguage,
  diarizationEnabled: boolean,
  speakerCount: number | null
) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ settings, apiConfig, ttsConfig, sourceLanguage, diarizationEnabled, speakerCount })
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
  ttsConfig: initial.ttsConfig,
  sourceLanguage: initial.sourceLanguage,
  speakers: [],
  diarizationEnabled: initial.diarizationEnabled,
  speakerCount: initial.speakerCount,
  voiceOverEnabled: false,
  voiceTrack: null,

  setStep: (step) => set({ step }),

  setVideo: (file) => {
    const url = URL.createObjectURL(file)
    set({ videoFile: file, videoUrl: url, mediaKind: detectMediaKind(file) })
  },

  clearVideo: () =>
    set((state) => {
      if (state.videoUrl) URL.revokeObjectURL(state.videoUrl)
      return { videoFile: null, videoUrl: null, subtitles: [], videoDuration: 0, mediaKind: 'video', speakers: [], voiceTrack: null }
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
      persist(settings, state.apiConfig, state.ttsConfig, state.sourceLanguage, state.diarizationEnabled, state.speakerCount)
      return { settings }
    }),

  updateApiConfig: (patch) =>
    set((state) => {
      const apiConfig = { ...state.apiConfig, ...patch }
      persist(state.settings, apiConfig, state.ttsConfig, state.sourceLanguage, state.diarizationEnabled, state.speakerCount)
      return { apiConfig }
    }),

  updateTtsConfig: (patch) =>
    set((state) => {
      const ttsConfig = { ...state.ttsConfig, ...patch }
      persist(state.settings, state.apiConfig, ttsConfig, state.sourceLanguage, state.diarizationEnabled, state.speakerCount)
      return { ttsConfig }
    }),

  setSourceLanguage: (lang) =>
    set((state) => {
      persist(state.settings, state.apiConfig, state.ttsConfig, lang, state.diarizationEnabled, state.speakerCount)
      return { sourceLanguage: lang }
    }),

  setSpeakers: (speakers) => set({ speakers }),

  setSpeakerVoice: (id, voiceType) =>
    set((state) => ({
      speakers: state.speakers.map((s) =>
        s.id === id ? { ...s, voiceType } : s
      ),
    })),

  setDiarizationEnabled: (enabled) =>
    set((state) => {
      persist(state.settings, state.apiConfig, state.ttsConfig, state.sourceLanguage, enabled, state.speakerCount)
      return { diarizationEnabled: enabled }
    }),

  setSpeakerCount: (count) =>
    set((state) => {
      persist(state.settings, state.apiConfig, state.ttsConfig, state.sourceLanguage, state.diarizationEnabled, count)
      return { speakerCount: count }
    }),

  setVoiceOverEnabled: (enabled) => set({ voiceOverEnabled: enabled }),

  setVoiceTrack: (track) => set({ voiceTrack: track }),

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
        speakers: [],
        voiceTrack: null,
      }
    }),
}))
