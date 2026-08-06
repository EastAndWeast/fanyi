import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { extractAudio } from '../lib/ffmpeg'
import { callSTT, callTranslate } from '../lib/api'
import type { ProcessingStage } from '../types'

const STAGE_INFO: Record<
  ProcessingStage,
  { label: string; desc: string }
> = {
  idle: { label: '准备中', desc: '' },
  extracting: { label: '提取音频', desc: '正在从视频中提取音频...' },
  transcribing: { label: '语音识别', desc: 'AI 正在识别英文语音...' },
  translating: { label: '翻译', desc: '正在翻译为中文...' },
  done: { label: '完成', desc: '处理完成！' },
  error: { label: '错误', desc: '处理失败' },
}

const STAGES: ProcessingStage[] = [
  'extracting',
  'transcribing',
  'translating',
]

export default function ProcessingView() {
  const videoFile = useStore((s) => s.videoFile)
  const mediaKind = useStore((s) => s.mediaKind)
  const apiConfig = useStore((s) => s.apiConfig)
  const setSubtitles = useStore((s) => s.setSubtitles)
  const setStep = useStore((s) => s.setStep)
  const clearVideo = useStore((s) => s.clearVideo)

  const [stage, setStage] = useState<ProcessingStage>('idle')
  const [error, setError] = useState('')
  const [sttProgress, setSttProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const [translateProgress, setTranslateProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const startedRef = useRef(false)

  // 纯音频模式下，「提取音频」实际是转码为 WAV，文案需相应调整
  const extractingDesc =
    mediaKind === 'audio' ? '正在转换音频格式...' : '正在从视频中提取音频...'

  // 语音识别进度文案：多块时显示 "识别中 3/20..."
  const transcribingDesc =
    sttProgress && sttProgress.total > 1
      ? `AI 正在识别英文语音（${sttProgress.completed}/${sttProgress.total}）...`
      : 'AI 正在识别英文语音...'

  // 翻译进度文案：多批时显示 "翻译中 3/10..."
  const translatingDesc =
    translateProgress && translateProgress.total > 1
      ? `正在翻译为中文（${translateProgress.completed}/${translateProgress.total}）...`
      : '正在翻译为中文...'

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void process()
  }, [])

  const process = async () => {
    if (!videoFile) return

    try {
      // 步骤1: 提取音频
      setStage('extracting')
      const audioWav = await extractAudio(videoFile, (msg) =>
        console.log(msg)
      )

      // 步骤2: 语音识别（前端分块逐块发送，避免长音频触发 524 超时）
      setStage('transcribing')
      setSttProgress(null)
      const subs = await callSTT(audioWav, (completed, total) => {
        setSttProgress({ completed, total })
      })

      // 步骤3: 翻译（未配置 API Key 时后端自动使用内置免费翻译）
      setStage('translating')
      setTranslateProgress(null)
      try {
        const texts = subs.map((s) => s.textEn)
        const translations = await callTranslate(
          apiConfig,
          texts,
          (completed, total) => {
            setTranslateProgress({ completed, total })
          }
        )
        const translated = subs.map((s, i) => ({
          ...s,
          textZh: translations[i] || '',
        }))
        setSubtitles(translated)
      } catch (translateErr) {
        // 翻译失败不阻塞，保留英文字幕
        console.error('翻译失败:', translateErr)
        setSubtitles(subs)
        setError(
          translateErr instanceof Error
            ? translateErr.message
            : '翻译失败，已保留英文字幕'
        )
      }

      setStage('done')
      setTimeout(() => setStep('editor'), 800)
    } catch (err) {
      console.error('处理失败:', err)
      setStage('error')
      setError(err instanceof Error ? err.message : '处理失败')
    }
  }

  const handleRetry = () => {
    startedRef.current = false
    setError('')
    setStage('idle')
    setTimeout(() => void process(), 100)
  }

  const handleBack = () => {
    clearVideo()
    setStep('upload')
  }

  const currentStageIndex = STAGES.indexOf(stage)

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* 进度展示 */}
        <div className="text-center space-y-2">
          <div className="w-20 h-20 mx-auto relative">
            {stage === 'error' ? (
              <div className="w-full h-full rounded-full bg-red-600/20 flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-red-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              </div>
            ) : stage === 'done' ? (
              <div className="w-full h-full rounded-full bg-green-600/20 flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-green-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
            ) : (
              <div className="w-full h-full rounded-full border-4 border-slate-200 border-t-blue-500 animate-spin" />
            )}
          </div>

          <h2 className="text-lg font-semibold text-slate-800">
            {STAGE_INFO[stage].label}
          </h2>
          <p className="text-sm text-slate-500">
            {stage === 'error'
              ? error
              : stage === 'extracting'
                ? extractingDesc
                : stage === 'transcribing'
                  ? transcribingDesc
                  : stage === 'translating'
                    ? translatingDesc
                    : STAGE_INFO[stage].desc}
          </p>
        </div>

        {/* 步骤列表 */}
        {stage !== 'error' && (
          <div className="space-y-3">
            {STAGES.map((s, i) => {
              const isActive = i === currentStageIndex
              const isDone = i < currentStageIndex || stage === 'done'

              return (
                <div
                  key={s}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                    isActive
                      ? 'border-blue-500 bg-blue-500/10'
                      : isDone
                        ? 'border-green-200 bg-green-50'
                        : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0">
                    {isDone ? (
                      <span className="text-green-400">✓</span>
                    ) : isActive ? (
                      <span className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    ) : (
                      <span className="text-slate-300">{i + 1}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm font-medium ${
                        isActive
                          ? 'text-blue-600'
                          : isDone
                            ? 'text-green-600'
                            : 'text-slate-500'
                      }`}
                    >
                      {STAGE_INFO[s].label}
                    </p>
                    <p className="text-xs text-slate-400 truncate">
                      {s === 'extracting'
                        ? extractingDesc
                        : s === 'transcribing'
                          ? transcribingDesc
                          : s === 'translating'
                            ? translatingDesc
                            : STAGE_INFO[s].desc}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* 翻译失败提示 */}
        {error && stage !== 'error' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-600">
            <p className="font-semibold mb-1">翻译失败</p>
            <p>{error}。英文字幕已保留，你可以在编辑界面手动填写或稍后重试。</p>
          </div>
        )}

        {/* 错误操作 */}
        {stage === 'error' && (
          <div className="flex gap-2">
            <button
              onClick={handleRetry}
              className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium transition-colors"
            >
              重试
            </button>
            <button
              onClick={handleBack}
              className="flex-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 text-sm font-medium transition-colors"
            >
              返回
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
