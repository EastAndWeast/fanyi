import { useState } from 'react'
import { useStore } from '../store'

/**
 * TTS 配音配置组件
 *
 * 引擎选择 + 火山引擎密钥/音色配置。
 * 在上传页和导出页共用，保持配置 UI 一致。
 */
export default function TtsSettings() {
  const ttsConfig = useStore((s) => s.ttsConfig)
  const updateTtsConfig = useStore((s) => s.updateTtsConfig)
  const [showKey, setShowKey] = useState(false)

  return (
    <div className="space-y-3">
      {/* 引擎选择 */}
      <div className="space-y-1.5">
        <label className="text-xs text-slate-500">配音引擎</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => updateTtsConfig({ engine: 'free' })}
            className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
              ttsConfig.engine === 'free'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            免费（内置）
          </button>
          <button
            type="button"
            onClick={() => updateTtsConfig({ engine: 'volcengine' })}
            className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
              ttsConfig.engine === 'volcengine'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            火山引擎
          </button>
        </div>
        {ttsConfig.engine === 'free' && (
          <p className="text-xs text-slate-400">
            melotts 免费引擎，成功率约 40%，失败片段自动静音
          </p>
        )}
      </div>

      {/* 火山引擎配置 */}
      {ttsConfig.engine === 'volcengine' && (
        <div className="space-y-3 rounded-lg bg-slate-50 p-3">
          {/* 密钥 */}
          <div className="space-y-1">
            <label className="text-xs text-slate-500">
              Access Token / API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={ttsConfig.apiKey}
                onChange={(e) => updateTtsConfig({ apiKey: e.target.value })}
                placeholder="填入火山引擎密钥"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-12 text-sm text-slate-800 outline-none focus:border-blue-500 placeholder:text-slate-400"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>

          {/* App ID */}
          <div className="space-y-1">
            <label className="text-xs text-slate-500">App ID（选填）</label>
            <input
              type="text"
              value={ttsConfig.appId}
              onChange={(e) => updateTtsConfig({ appId: e.target.value })}
              placeholder="语音控制台的 App ID"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 placeholder:text-slate-400"
            />
          </div>

          {/* 音色 ID */}
          <div className="space-y-1">
            <label className="text-xs text-slate-500">音色 ID（选填）</label>
            <input
              type="text"
              value={ttsConfig.voiceType}
              onChange={(e) => updateTtsConfig({ voiceType: e.target.value })}
              placeholder="如 zh_female_wanwanxiaohe_moon_bigtts"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 placeholder:text-slate-400"
            />
            <p className="text-xs text-slate-400">
              在控制台开通音色后复制音色 ID，留空使用默认女声
            </p>
          </div>

          <p className="text-xs text-slate-400">
            密钥仅保存在你的浏览器中，不会上传到服务器。资源 ID：seed-tts-2.0
          </p>
        </div>
      )}
    </div>
  )
}
