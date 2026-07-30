import { useState, useRef } from 'react'
import { useStore } from '../store'
import VideoPlayer from './VideoPlayer'
import { burnSubtitlesToVideo, downloadBlob } from '../lib/subtitleBurner'
import { muxOriginalAudio } from '../lib/ffmpeg'
import { generateSRT, generateVTT, downloadFile } from '../lib/srt'

export default function ExportView() {
  const subtitles = useStore((s) => s.subtitles)
  const settings = useStore((s) => s.settings)
  const videoFile = useStore((s) => s.videoFile)
  const setStep = useStore((s) => s.setStep)
  const reset = useStore((s) => s.reset)

  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState<'recording' | 'muxing'>('recording')
  const [error, setError] = useState('')
  const abortControllerRef = useRef<AbortController | null>(null)

  const handleExportVideo = async () => {
    if (!videoFile) return

    setExporting(true)
    setError('')
    setProgress(0)
    setStage('recording')

    // 创建一个隐藏的视频元素用于录制
    // 注意：不能用 width/height=2px 或 display:none，否则浏览器不会解码视频帧
    // 用真实尺寸 + 屏幕外定位，确保视频帧正常解码
    const videoEl = document.createElement('video')
    videoEl.src = URL.createObjectURL(videoFile)
    videoEl.muted = true
    videoEl.defaultMuted = true
    videoEl.playsInline = true
    videoEl.crossOrigin = 'anonymous'
    videoEl.style.position = 'fixed'
    videoEl.style.left = '-9999px'
    videoEl.style.top = '0'
    videoEl.style.width = '640px'
    videoEl.style.height = 'auto'
    videoEl.style.opacity = '0.01'
    videoEl.style.pointerEvents = 'none'
    document.body.appendChild(videoEl)

    abortControllerRef.current = new AbortController()

    try {
      // 等待视频可以播放（readyState >= 3，确保第一帧已解码）
      if (videoEl.readyState < 3) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('视频加载超时'))
          }, 15000)
          videoEl.oncanplay = () => {
            clearTimeout(timeout)
            resolve()
          }
          videoEl.onerror = () => {
            clearTimeout(timeout)
            reject(new Error('视频加载失败'))
          }
        })
      }
      // 额外等待一帧确保解码完成
      await new Promise((r) => requestAnimationFrame(r))

      const result = await burnSubtitlesToVideo({
        video: videoEl,
        subtitles,
        settings,
        onProgress: (p) => setProgress(p),
        signal: abortControllerRef.current.signal,
      })

      // 用 ffmpeg 将原视频音轨混流进录制结果，保证导出视频有声音
      // （MediaRecorder 的实时音频捕获可能静默失败，导致导出无音轨）
      let finalBlob = result.blob
      setStage('muxing')
      try {
        finalBlob = await muxOriginalAudio(
          result.blob,
          videoFile,
          result.extension
        )
        console.log('[Export] Audio muxed, final size:', finalBlob.size)
      } catch (muxErr) {
        // 混流失败时回退到录制结果（可能仍带录制的音轨）
        console.warn('[Export] 音频混流失败，使用录制原始结果:', muxErr)
      }

      // 下载结果
      const baseName = videoFile.name.replace(/\.[^.]+$/, '')
      downloadBlob(finalBlob, `${baseName}_subtitles.${result.extension}`)
      setProgress(1)  // 确保进度显示为 100%
    } catch (err) {
      if (err instanceof Error && err.message === '用户取消') {
        // 用户取消，不做错误处理
      } else {
        setError(err instanceof Error ? err.message : '导出失败')
      }
    } finally {
      document.body.removeChild(videoEl)
      URL.revokeObjectURL(videoEl.src)
      setExporting(false)
      abortControllerRef.current = null
    }
  }

  const handleCancel = () => {
    abortControllerRef.current?.abort()
  }

  const handleDownloadSRT = (lang: 'en' | 'zh' | 'both') => {
    const baseName = videoFile?.name.replace(/\.[^.]+$/, '') || 'subtitles'
    const suffix = lang === 'both' ? '' : `_${lang}`
    downloadFile(generateSRT(subtitles, lang), `${baseName}${suffix}.srt`)
  }

  const handleDownloadVTT = (lang: 'en' | 'zh' | 'both') => {
    const baseName = videoFile?.name.replace(/\.[^.]+$/, '') || 'subtitles'
    const suffix = lang === 'both' ? '' : `_${lang}`
    downloadFile(generateVTT(subtitles, lang), `${baseName}${suffix}.vtt`)
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row gap-4 p-4 max-w-7xl mx-auto w-full">
      {/* 左侧：预览 */}
      <div className="flex-1 min-w-0">
        <VideoPlayer />
        <button
          onClick={() => setStep('editor')}
          className="mt-3 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          ← 返回编辑
        </button>
      </div>

      {/* 右侧：导出选项 */}
      <div className="w-full lg:w-96 space-y-4">
        {/* 导出视频 */}
        <div className="rounded-xl bg-slate-800/30 border border-slate-700/50 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200 mb-1">
              导出带字幕视频
            </h3>
            <p className="text-xs text-slate-500">
              将字幕直接烧录到视频画面中（实时录制，时长与视频相同）
            </p>
          </div>

          {!exporting && progress === 0 && (
            <button
              onClick={handleExportVideo}
              className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3 text-sm font-medium transition-colors"
            >
              开始导出
            </button>
          )}

          {exporting && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{stage === 'muxing' ? '正在合成音频...' : '正在录制...'}</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-200"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <button
                onClick={handleCancel}
                className="w-full rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2 text-sm font-medium transition-colors"
              >
                取消
              </button>
            </div>
          )}

          {!exporting && progress > 0 && progress < 1 && !error && (
            <p className="text-xs text-slate-500">导出已取消</p>
          )}

          {!exporting && progress >= 1 && (
            <p className="text-xs text-green-400">导出完成！文件已开始下载。</p>
          )}

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* 导出字幕文件 */}
        <div className="rounded-xl bg-slate-800/30 border border-slate-700/50 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200 mb-1">
              下载字幕文件
            </h3>
            <p className="text-xs text-slate-500">
              适用于外挂字幕播放器或视频编辑软件
            </p>
          </div>

          {/* SRT */}
          <div className="space-y-1.5">
            <p className="text-xs text-slate-400 font-medium">SRT 格式</p>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => handleDownloadSRT('both')}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                双语
              </button>
              <button
                onClick={() => handleDownloadSRT('en')}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                英文
              </button>
              <button
                onClick={() => handleDownloadSRT('zh')}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                中文
              </button>
            </div>
          </div>

          {/* VTT */}
          <div className="space-y-1.5">
            <p className="text-xs text-slate-400 font-medium">VTT 格式</p>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => handleDownloadVTT('both')}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                双语
              </button>
              <button
                onClick={() => handleDownloadVTT('en')}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                英文
              </button>
              <button
                onClick={() => handleDownloadVTT('zh')}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                中文
              </button>
            </div>
          </div>
        </div>

        {/* 字幕统计 */}
        <div className="rounded-xl bg-slate-800/30 border border-slate-700/50 p-4">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">
            字幕统计
          </h3>
          <div className="grid grid-cols-2 gap-3 text-center">
            <div className="rounded-lg bg-slate-800/50 p-2">
              <p className="text-lg font-bold text-slate-200">
                {subtitles.length}
              </p>
              <p className="text-xs text-slate-500">条字幕</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 p-2">
              <p className="text-lg font-bold text-slate-200">
                {subtitles.filter((s) => s.textZh).length}
              </p>
              <p className="text-xs text-slate-500">已翻译</p>
            </div>
          </div>
        </div>

        {/* 完成 */}
        <button
          onClick={reset}
          className="w-full rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 px-4 py-2.5 text-sm font-medium transition-colors"
        >
          处理新视频
        </button>
      </div>
    </div>
  )
}
