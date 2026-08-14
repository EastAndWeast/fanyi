import { useRef, useState } from 'react'
import { useStore, isMediaFile } from '../store'
import { getFFmpegMode } from '../lib/ffmpeg'
import ApiKeySettings from './ApiKeySettings'
import TtsSettings from './TtsSettings'
import { API_PRESETS, SOURCE_LANGUAGES } from '../types'

export default function UploadZone() {
  const setVideo = useStore((s) => s.setVideo)
  const setStep = useStore((s) => s.setStep)
  const apiConfig = useStore((s) => s.apiConfig)
  const ttsConfig = useStore((s) => s.ttsConfig)
  const sourceLanguage = useStore((s) => s.sourceLanguage)
  const setSourceLanguage = useStore((s) => s.setSourceLanguage)
  const diarizationEnabled = useStore((s) => s.diarizationEnabled)
  const setDiarizationEnabled = useStore((s) => s.setDiarizationEnabled)
  const speakerCount = useStore((s) => s.speakerCount)
  const setSpeakerCount = useStore((s) => s.setSpeakerCount)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  // 默认收起：内置免费翻译开箱即用，无需引导用户展开配置
  const [showApiSettings, setShowApiSettings] = useState(false)
  // TTS 配置默认收起，用户按需展开
  const [showTtsSettings, setShowTtsSettings] = useState(false)

  const ffmpegMode = getFFmpegMode()
  const hasApiKey = Boolean(apiConfig.apiKey.trim())

  const handleFile = (file: File) => {
    // 统一用 isMediaFile 判定（MIME 缺失时靠扩展名兜底，如 AC3）
    if (!isMediaFile(file)) {
      alert('请上传视频或音频文件')
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
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-700">
            <p className="font-semibold mb-1">当前为单线程兼容模式</p>
            <p className="text-xs text-sky-600">
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
              ? 'border-green-200 bg-green-50'
              : 'border-blue-500 bg-blue-50'
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
                    hasApiKey ? 'bg-green-500' : 'bg-blue-500'
                  }`}
                />
                <p
                  className={`text-sm font-semibold ${
                    hasApiKey ? 'text-green-600' : 'text-blue-600'
                  }`}
                >
                  翻译 API {hasApiKey ? '已配置' : '使用内置免费翻译'}
                </p>
              </div>
              <p className="text-xs text-slate-500 mt-1 ml-4 truncate">
                {hasApiKey
                  ? `${API_PRESETS[apiConfig.provider].label} · ${apiConfig.model}`
                  : '无需配置即可翻译，配置自己的 Key 可获得更稳定的质量'}
              </p>
            </div>
            <span className="flex-shrink-0 text-xs text-blue-600">
              {showApiSettings ? '收起' : hasApiKey ? '修改配置' : '立即配置'}
            </span>
          </button>

          {showApiSettings && (
            <div
              id="upload-api-settings"
              className="border-t border-slate-200 p-4"
            >
              <ApiKeySettings compact />
            </div>
          )}
        </div>

        {!hasApiKey && (
          <div className="rounded-lg bg-slate-100 px-4 py-3 text-xs text-slate-500">
            未配置时默认使用内置免费翻译（每日限额，先到先得）；额度用完后可配置自己的 API Key 继续翻译。
          </div>
        )}

        {/* 配音 TTS 配置 */}
        <div
          className={`rounded-xl border overflow-hidden ${
            ttsConfig.engine === 'volcengine' && ttsConfig.apiKey
              ? 'border-green-200 bg-green-50'
              : 'border-slate-200 bg-white'
          }`}
        >
          <button
            type="button"
            onClick={() => setShowTtsSettings((value) => !value)}
            aria-expanded={showTtsSettings}
            className="w-full flex items-center justify-between gap-4 p-4 text-left"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    ttsConfig.engine === 'volcengine' && ttsConfig.apiKey
                      ? 'bg-green-500'
                      : 'bg-slate-400'
                  }`}
                />
                <p
                  className={`text-sm font-semibold ${
                    ttsConfig.engine === 'volcengine' && ttsConfig.apiKey
                      ? 'text-green-600'
                      : 'text-slate-600'
                  }`}
                >
                  配音 TTS{' '}
                  {ttsConfig.engine === 'volcengine' && ttsConfig.apiKey
                    ? '已配置'
                    : ttsConfig.engine === 'free'
                      ? '使用免费引擎'
                      : '未配置密钥'}
                </p>
              </div>
              <p className="text-xs text-slate-500 mt-1 ml-4 truncate">
                {ttsConfig.engine === 'free'
                  ? '内置 melotts 免费引擎（成功率约40%）'
                  : ttsConfig.apiKey
                    ? `火山引擎 · ${ttsConfig.voiceType || '默认女声'}`
                    : '选填，配置火山引擎可获得稳定的高质量配音'}
              </p>
            </div>
            <span className="flex-shrink-0 text-xs text-blue-600">
              {showTtsSettings ? '收起' : '配置'}
            </span>
          </button>

          {showTtsSettings && (
            <div className="border-t border-slate-200 p-4">
              <TtsSettings />
            </div>
          )}
        </div>

        {/* 多说话人检测 */}
        <div className="rounded-lg bg-white border border-slate-200 px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-700">检测多人声音</p>
              <p className="text-xs text-slate-400 mt-0.5">
                本地识别不同说话人，导出时可分配不同音色（首次使用需下载约 45MB 模型）
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDiarizationEnabled(!diarizationEnabled)}
              className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                diarizationEnabled ? 'bg-blue-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                  diarizationEnabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          {diarizationEnabled && (
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-500 flex-shrink-0">
                说话人数
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={speakerCount ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  const n = parseInt(v, 10)
                  setSpeakerCount(v === '' || isNaN(n) || n < 1 ? null : n)
                }}
                placeholder="自动"
                className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-slate-400">
                留空自动判断；检测不准时可手动指定
              </p>
            </div>
          )}
        </div>

        {/* 源语言选择 */}
        <div className="flex items-center gap-3 rounded-lg bg-white border border-slate-200 px-4 py-3">
          <label className="text-sm font-medium text-slate-700 flex-shrink-0">
            视频语言
          </label>
          <select
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value as typeof sourceLanguage)}
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-blue-500"
          >
            {SOURCE_LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 flex-shrink-0 hidden sm:block">
            默认自动检测，识别不准时可手动指定
          </p>
        </div>

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
              ? 'border-blue-500 bg-blue-500/10 scale-[1.02]'
              : 'border-slate-300 hover:border-slate-400 bg-slate-50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,audio/*,.ac3,.eac3,.aac,.m4a,.mp3,.wav,.flac,.ogg,.opus"
            onChange={handleChange}
            className="hidden"
          />

          <div className="text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-blue-600/10 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-blue-600"
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
              <p className="text-lg font-medium text-slate-800">
                拖拽视频或音频到此处
              </p>
              <p className="text-sm text-slate-500 mt-1">
                或点击选择文件
              </p>
            </div>
            <p className="text-xs text-slate-400">
              支持 MP4、WebM、MOV，以及 MP3、WAV、M4A、AC3 等
            </p>
          </div>
        </div>

        {/* 功能说明 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            {
              icon: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
              title: '自动识别',
              desc: 'AI 自动识别语音字幕',
            },
            {
              icon: 'M3 5h12 M9 3v2 M14 17h-4l4-7 M5 21l4-7',
              title: 'AI 翻译',
              desc: '翻译为英文',
            },
            {
              icon: 'M12 2v20 M2 5h20 M2 12h20 M2 19h20',
              title: '自定义样式',
              desc: '颜色、位置、字号',
            },
          ].map((f, i) => (
            <div
              key={i}
              className="rounded-xl bg-white border border-slate-200 p-4"
            >
              <svg
                className="w-5 h-5 text-blue-600 mb-2"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={f.icon} />
              </svg>
              <p className="text-sm font-medium text-slate-700">{f.title}</p>
              <p className="text-xs text-slate-400 mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
