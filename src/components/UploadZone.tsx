import { useRef, useState } from 'react'
import { useStore } from '../store'
import { getFFmpegMode } from '../lib/ffmpeg'
import ApiKeySettings from './ApiKeySettings'
import { API_PRESETS } from '../types'

export default function UploadZone() {
  const setVideo = useStore((s) => s.setVideo)
  const setStep = useStore((s) => s.setStep)
  const apiConfig = useStore((s) => s.apiConfig)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showApiSettings, setShowApiSettings] = useState(
    () => !apiConfig.apiKey.trim()
  )

  const ffmpegMode = getFFmpegMode()
  const hasApiKey = Boolean(apiConfig.apiKey.trim())

  const handleFile = (file: File) => {
    if (!file.type.startsWith('video/')) {
      alert('请上传视频文件')
      return
    }
    setVideo(file)
    setStep('processing')
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="w-full max-w-2xl mx-auto py-6 space-y-6">
        {/* 单线程兼容模式提示（手机 / 微信 / 国产浏览器等无法跨域隔离时） */}
        {ffmpegMode === 'single-thread' && (
          <div className="rounded-lg border border-sky-600/40 bg-sky-600/10 p-4 text-sm text-sky-200">
            <p className="font-semibold mb-1">当前为单线程兼容模式</p>
            <p className="text-xs text-sky-200/80">
              你的浏览器不支持多线程加速（手机自带浏览器、微信内打开等常见），
              音频提取仍可正常使用，只是速度较慢。建议视频不要太长；
              如需更快，请用电脑 Chrome/Edge 打开。
            </p>
          </div>
        )}

        {/* 上传前 API 配置 */}
        <div
          className={`rounded-xl border overflow-hidden ${
            hasApiKey
              ? 'border-green-600/40 bg-green-600/5'
              : 'border-blue-600/50 bg-blue-600/10'
          }`}
        >
          <button
            type="button"
            onClick={() => setShowApiSettings((value) => !value)}
            aria-expanded={showApiSettings}
            aria-controls="upload-api-settings"
            className="w-full flex items-center justify-between gap-4 p-4 text-left"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    hasApiKey ? 'bg-green-400' : 'bg-blue-400'
                  }`}
                />
                <p
                  className={`text-sm font-semibold ${
                    hasApiKey ? 'text-green-300' : 'text-blue-300'
                  }`}
                >
                  翻译 API {hasApiKey ? '已配置' : '未配置'}
                </p>
              </div>
              <p className="text-xs text-slate-400 mt-1 ml-4 truncate">
                {hasApiKey
                  ? `${API_PRESETS[apiConfig.provider].label} · ${apiConfig.model}`
                  : '请在上传视频前配置，处理完成后将自动生成中文字幕'}
              </p>
            </div>
            <span className="flex-shrink-0 text-xs text-indigo-300">
              {showApiSettings ? '收起' : hasApiKey ? '修改配置' : '立即配置'}
            </span>
          </button>

          {showApiSettings && (
            <div
              id="upload-api-settings"
              className="border-t border-slate-700/60 p-4"
            >
              <ApiKeySettings compact />
            </div>
          )}
        </div>

        {!hasApiKey && (
          <div className="rounded-lg bg-slate-800/40 px-4 py-3 text-xs text-slate-400">
            不配置 API Key 也可以继续，仅生成英文字幕。
          </div>
        )}

        {/* 上传区域 */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative rounded-2xl border-2 border-dashed p-12 cursor-pointer transition-all ${
            isDragging
              ? 'border-indigo-500 bg-indigo-500/10 scale-[1.02]'
              : 'border-slate-700 hover:border-slate-600 bg-slate-800/30'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleChange}
            className="hidden"
          />

          <div className="text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-indigo-600/20 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-indigo-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-medium text-slate-200">
                拖拽视频到此处
              </p>
              <p className="text-sm text-slate-400 mt-1">
                或点击选择文件
              </p>
            </div>
            <p className="text-xs text-slate-500">
              支持 MP4、WebM、MOV 等格式
            </p>
          </div>
        </div>

        {/* 功能说明 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            {
              icon: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
              title: '自动识别',
              desc: 'AI 自动提取英文字幕',
            },
            {
              icon: 'M3 5h12 M9 3v2 M14 17h-4l4-7 M5 21l4-7',
              title: 'AI 翻译',
              desc: '自动翻译为中文',
            },
            {
              icon: 'M12 2v20 M2 5h20 M2 12h20 M2 19h20',
              title: '自定义样式',
              desc: '颜色、位置、字号',
            },
          ].map((f, i) => (
            <div
              key={i}
              className="rounded-xl bg-slate-800/50 border border-slate-700/50 p-4"
            >
              <svg
                className="w-5 h-5 text-indigo-400 mb-2"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={f.icon} />
              </svg>
              <p className="text-sm font-medium text-slate-300">{f.title}</p>
              <p className="text-xs text-slate-500 mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
