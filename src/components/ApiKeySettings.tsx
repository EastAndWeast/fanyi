import { useState } from 'react'
import { useStore } from '../store'
import { API_PRESETS } from '../types'
import type { ApiConfig } from '../types'
import { testApiConnection } from '../lib/api'

interface ApiKeySettingsProps {
  onClose?: () => void
  compact?: boolean
}

type TestStatus =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string }

export default function ApiKeySettings({
  onClose,
  compact,
}: ApiKeySettingsProps) {
  const apiConfig = useStore((s) => s.apiConfig)
  const updateApiConfig = useStore((s) => s.updateApiConfig)
  const [showKey, setShowKey] = useState(false)
  const [testStatus, setTestStatus] = useState<TestStatus>({ state: 'idle' })

  const handleProviderChange = (provider: ApiConfig['provider']) => {
    const preset = API_PRESETS[provider]
    updateApiConfig({
      provider,
      endpoint: preset.endpoint,
      model: preset.model,
    })
    setTestStatus({ state: 'idle' })
  }

  const handleTestApi = async () => {
    if (!apiConfig.apiKey) {
      setTestStatus({ state: 'error', message: '请先填写 API Key' })
      return
    }
    if (!apiConfig.endpoint) {
      setTestStatus({ state: 'error', message: '请先填写 API Endpoint' })
      return
    }
    if (!apiConfig.model) {
      setTestStatus({ state: 'error', message: '请先填写模型名称' })
      return
    }
    setTestStatus({ state: 'testing' })
    try {
      const result = await testApiConnection(apiConfig)
      setTestStatus({
        state: 'success',
        message: `连接成功！测试翻译：“${result}”`,
      })
    } catch (err) {
      setTestStatus({
        state: 'error',
        message: err instanceof Error ? err.message : '连接失败',
      })
    }
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-4 p-5'}>
      {!compact && (
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-base font-semibold text-slate-200">
            翻译 API 配置
          </h3>
          {onClose && (
            <button
              type="button"
              aria-label="关闭 API 配置"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 text-xl leading-none"
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* 服务商选择 */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400">服务商</label>
        <div className="grid grid-cols-3 gap-2">
          {(
            Object.entries(API_PRESETS) as [
              ApiConfig['provider'],
              { label: string }
            ][]
          ).map(([key, preset]) => (
            <button
              type="button"
              key={key}
              onClick={() => handleProviderChange(key)}
              className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                apiConfig.provider === key
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-700 text-slate-400'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div className="space-y-2">
        <label htmlFor="translation-api-key" className="text-xs text-slate-400">
          API Key
        </label>
        <div className="relative">
          <input
            id="translation-api-key"
            type={showKey ? 'text' : 'password'}
            value={apiConfig.apiKey}
            onChange={(e) => updateApiConfig({ apiKey: e.target.value })}
            placeholder="粘贴你的 API Key"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 pr-10 text-sm text-slate-200 outline-none focus:border-indigo-500 placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </div>

      {/* 自定义端点 */}
      {apiConfig.provider === 'custom' && (
        <>
          <div className="space-y-2">
            <label
              htmlFor="translation-api-endpoint"
              className="text-xs text-slate-400"
            >
              API Endpoint (OpenAI 兼容)
            </label>
            <input
              id="translation-api-endpoint"
              type="text"
              value={apiConfig.endpoint}
              onChange={(e) => updateApiConfig({ endpoint: e.target.value })}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 placeholder:text-slate-600"
            />
            <p className="text-xs text-slate-600">
              填 Base URL 即可（如 https://open.bigmodel.cn/api/paas/v4），系统会自动补全 /chat/completions
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="translation-api-model"
              className="text-xs text-slate-400"
            >
              模型名称
            </label>
            <input
              id="translation-api-model"
              type="text"
              value={apiConfig.model}
              onChange={(e) => updateApiConfig({ model: e.target.value })}
              placeholder="gpt-4o-mini"
              className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 placeholder:text-slate-600"
            />
          </div>
        </>
      )}

      {/* 非自定义时可编辑模型 */}
      {apiConfig.provider !== 'custom' && (
        <div className="space-y-2">
          <label
            htmlFor="translation-api-model"
            className="text-xs text-slate-400"
          >
            模型
          </label>
          <input
            id="translation-api-model"
            type="text"
            value={apiConfig.model}
            onChange={(e) => updateApiConfig({ model: e.target.value })}
            placeholder="模型名称"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 placeholder:text-slate-600"
          />
        </div>
      )}

      {/* 检测 API 连接 */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={handleTestApi}
          disabled={testStatus.state === 'testing'}
          className="w-full rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-60 disabled:cursor-wait text-slate-200 px-3 py-2 text-sm font-medium transition-colors"
        >
          {testStatus.state === 'testing' ? '检测中…' : '检测 API 连接'}
        </button>
        {testStatus.state === 'success' && (
          <p className="text-xs text-green-400 break-all">✅ {testStatus.message}</p>
        )}
        {testStatus.state === 'error' && (
          <p className="text-xs text-red-400 break-all">❌ {testStatus.message}</p>
        )}
      </div>

      <p className="text-xs text-slate-500">
        API Key 仅保存在你的浏览器中，不会上传到服务器。
      </p>
    </div>
  )
}
