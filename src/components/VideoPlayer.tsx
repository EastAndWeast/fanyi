import { useRef, useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import type { SubtitleSegment, SubtitleSettings } from '../types'
import {
  setupPreviewAudio,
  setPreviewVolume,
  resumePreviewAudio,
  teardownPreviewAudio,
} from '../lib/audioManager'

interface VideoPlayerProps {
  videoRef?: React.RefObject<HTMLVideoElement | null>
}

export default function VideoPlayer({ videoRef }: VideoPlayerProps) {
  const internalRef = useRef<HTMLVideoElement>(null)
  const ref = videoRef || internalRef
  const videoUrl = useStore((s) => s.videoUrl)
  const subtitles = useStore((s) => s.subtitles)
  const settings = useStore((s) => s.settings)
  const activeSubtitleId = useStore((s) => s.activeSubtitleId)

  const [currentTime, setCurrentTime] = useState(0)

  // 找到当前时间对应的字幕
  const currentSubs = subtitles.filter(
    (s) => currentTime >= s.start && currentTime <= s.end
  )

  const handleTimeUpdate = useCallback(() => {
    if (ref.current) {
      setCurrentTime(ref.current.currentTime)
    }
  }, [ref])

  // 点击字幕跳转
  const seekToSubtitle = useCallback(
    (sub: SubtitleSegment) => {
      if (ref.current) {
        ref.current.currentTime = sub.start + 0.01
        ref.current.play()
      }
    },
    [ref]
  )

  // 当外部设置 activeSubtitleId 时，跳转到该字幕
  useEffect(() => {
    if (activeSubtitleId !== null) {
      const sub = subtitles.find((s) => s.id === activeSubtitleId)
      if (sub && ref.current) {
        const t = ref.current.currentTime
        if (t < sub.start || t > sub.end) {
          ref.current.currentTime = sub.start + 0.01
        }
      }
    }
  }, [activeSubtitleId, subtitles, ref])

  // 初始化 WebAudio 增益图（突破浏览器 volume ≤ 1 的限制）
  useEffect(() => {
    if (!ref.current) return
    try {
      setupPreviewAudio(ref.current, settings.volume)
    } catch {
      // createMediaElementSource 失败（如已创建过），忽略
    }
    return () => {
      teardownPreviewAudio()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 音量变化时实时更新增益
  useEffect(() => {
    setPreviewVolume(settings.volume)
    // 同时设置 video.volume 作为 fallback（WebAudio 不可用时 0~1 范围有效）
    if (ref.current) {
      ref.current.volume = Math.min(settings.volume, 1)
    }
  }, [settings.volume, ref])

  // 播放时恢复 AudioContext（浏览器要求用户交互后才能发声）
  const handlePlay = useCallback(() => {
    resumePreviewAudio()
  }, [])

  if (!videoUrl) return null

  return (
    <div className="relative w-full bg-black rounded-xl overflow-hidden group">
      <video
        ref={ref}
        src={videoUrl}
        className="w-full max-h-[60vh] object-contain"
        onTimeUpdate={handleTimeUpdate}
        onPlay={handlePlay}
        controls
        playsInline
      />

      {/* 字幕叠加层 */}
      <SubtitleOverlay
        subs={currentSubs}
        settings={settings}
        onClick={seekToSubtitle}
      />
    </div>
  )
}

// 字幕叠加层组件
function SubtitleOverlay({
  subs,
  settings,
}: {
  subs: SubtitleSegment[]
  settings: SubtitleSettings
  onClick: (sub: SubtitleSegment) => void
}) {
  if (subs.length === 0) return null

  const visibleSubs = subs.filter((s) => {
    if (settings.showEn && settings.showZh) return s.textEn || s.textZh
    if (settings.showEn) return s.textEn
    if (settings.showZh) return s.textZh
    return false
  })

  if (visibleSubs.length === 0) return null

  const bgStyle = settings.background
    ? `rgba(0,0,0,${settings.bgOpacity})`
    : 'transparent'

  return (
    <div
      className="absolute left-1/2 pointer-events-none w-full px-4 text-center"
      style={{
        top: `${settings.positionY}%`,
        transform: 'translate(-50%, -50%)',
      }}
    >
      <div
        className="inline-block rounded-lg px-4 py-2 max-w-[90%]"
        style={{ background: bgStyle }}
      >
        {settings.showZh &&
          visibleSubs.map((s) =>
            s.textZh ? (
              <div
                key={`zh-${s.id}`}
                style={{
                  color: settings.zhColor,
                  fontSize: `${settings.fontSize}px`,
                  lineHeight: '1.4',
                  fontWeight: 600,
                }}
                className="mb-1"
              >
                {s.textZh}
              </div>
            ) : null
          )}
        {settings.showEn &&
          visibleSubs.map((s) =>
            s.textEn ? (
              <div
                key={`en-${s.id}`}
                style={{
                  color: settings.enColor,
                  fontSize: `${settings.fontSize - 4}px`,
                  lineHeight: '1.4',
                }}
              >
                {s.textEn}
              </div>
            ) : null
          )}
      </div>
    </div>
  )
}
