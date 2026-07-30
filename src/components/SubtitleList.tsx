import { useRef, useEffect } from 'react'
import { useStore } from '../store'
import type { SubtitleSegment } from '../types'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function SubtitleList() {
  const subtitles = useStore((s) => s.subtitles)
  const updateSubtitle = useStore((s) => s.updateSubtitle)
  const activeSubtitleId = useStore((s) => s.activeSubtitleId)
  const setActiveSubtitle = useStore((s) => s.setActiveSubtitle)
  const listRef = useRef<HTMLDivElement>(null)

  // 当激活字幕变化时滚动到该字幕
  useEffect(() => {
    if (activeSubtitleId !== null && listRef.current) {
      const el = listRef.current.querySelector(
        `[data-sub-id="${activeSubtitleId}"]`
      )
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeSubtitleId])

  const handleEnChange = (id: number, value: string) => {
    updateSubtitle(id, { textEn: value })
  }

  const handleZhChange = (id: number, value: string) => {
    updateSubtitle(id, { textZh: value })
  }

  const handleFocus = (sub: SubtitleSegment) => {
    setActiveSubtitle(sub.id)
  }

  if (subtitles.length === 0) {
    return (
      <div className="text-center text-slate-500 py-8 text-sm">
        暂无字幕
      </div>
    )
  }

  return (
    <div ref={listRef} className="space-y-2 max-h-full overflow-y-auto pr-1">
      {subtitles.map((sub) => (
        <div
          key={sub.id}
          data-sub-id={sub.id}
          className={`rounded-lg border p-3 transition-colors ${
            activeSubtitleId === sub.id
              ? 'border-indigo-500 bg-indigo-500/10'
              : 'border-slate-700 bg-slate-800/50'
          }`}
        >
          {/* 时间戳 */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-slate-400 font-mono">
              {formatTime(sub.start)}
            </span>
            <span className="text-xs text-slate-600">→</span>
            <span className="text-xs text-slate-400 font-mono">
              {formatTime(sub.end)}
            </span>
          </div>

          {/* 英文字幕 */}
          <input
            type="text"
            value={sub.textEn}
            onChange={(e) => handleEnChange(sub.id, e.target.value)}
            onFocus={() => handleFocus(sub)}
            className="w-full bg-transparent text-sm text-slate-200 outline-none mb-1 placeholder:text-slate-600"
            placeholder="英文字幕"
          />

          {/* 中文字幕 */}
          <input
            type="text"
            value={sub.textZh}
            onChange={(e) => handleZhChange(sub.id, e.target.value)}
            onFocus={() => handleFocus(sub)}
            className="w-full bg-transparent text-sm text-amber-300/90 outline-none placeholder:text-slate-600"
            placeholder="中文字幕"
          />
        </div>
      ))}
    </div>
  )
}
