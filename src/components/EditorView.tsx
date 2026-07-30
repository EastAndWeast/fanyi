import { useState } from 'react'
import { useStore } from '../store'
import VideoPlayer from './VideoPlayer'
import SubtitleList from './SubtitleList'
import StyleSettings from './StyleSettings'
import ApiKeySettings from './ApiKeySettings'
import { callTranslate } from '../lib/api'

type TabType = 'subtitles' | 'style' | 'api'

export default function EditorView() {
  const setStep = useStore((s) => s.setStep)
  const subtitles = useStore((s) => s.subtitles)
  const setSubtitles = useStore((s) => s.setSubtitles)
  const apiConfig = useStore((s) => s.apiConfig)

  const [tab, setTab] = useState<TabType>('subtitles')
  const [retranslating, setRetranslating] = useState(false)
  const [translateError, setTranslateError] = useState('')

  const handleRetranslate = async () => {
    if (!apiConfig.apiKey) {
      setTab('api')
      return
    }

    setRetranslating(true)
    setTranslateError('')
    try {
      const texts = subtitles.map((s) => s.textEn)
      const translations = await callTranslate(apiConfig, texts)
      setSubtitles(
        subtitles.map((s, i) => ({ ...s, textZh: translations[i] || '' }))
      )
    } catch (err) {
      setTranslateError(
        err instanceof Error ? err.message : '翻译失败'
      )
    } finally {
      setRetranslating(false)
    }
  }

  const tabs: { key: TabType; label: string }[] = [
    { key: 'subtitles', label: '字幕' },
    { key: 'style', label: '样式' },
    { key: 'api', label: 'API' },
  ]

  return (
    <div className="flex-1 flex flex-col lg:flex-row gap-4 p-4 max-w-7xl mx-auto w-full">
      {/* 左侧：视频预览 */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        <VideoPlayer />

        {/* 操作按钮 */}
        <div className="flex gap-2">
          <button
            onClick={handleRetranslate}
            disabled={retranslating}
            className="flex-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 text-slate-200 px-4 py-2.5 text-sm font-medium transition-colors"
          >
            {retranslating ? '翻译中...' : '重新翻译'}
          </button>
          <button
            onClick={() => setStep('export')}
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 text-sm font-medium transition-colors"
          >
            导出视频
          </button>
        </div>

        {translateError && (
          <p className="text-xs text-red-400 px-1">{translateError}</p>
        )}
      </div>

      {/* 右侧：字幕编辑 + 设置 */}
      <div className="w-full lg:w-96 flex flex-col rounded-xl bg-slate-800/30 border border-slate-700/50 overflow-hidden">
        {/* 标签切换 */}
        <div className="flex border-b border-slate-700/50">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/5'
                  : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden p-3 max-h-[50vh] lg:max-h-[calc(100vh-280px)]">
          {tab === 'subtitles' && <SubtitleList />}
          {tab === 'style' && <StyleSettings />}
          {tab === 'api' && <ApiKeySettings compact />}
        </div>
      </div>
    </div>
  )
}
