import { useStore } from '../store'

export default function StyleSettings() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)

  return (
    <div className="space-y-4">
      {/* 语言开关 */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400">显示语言</label>
        <div className="flex gap-2">
          <button
            onClick={() => updateSettings({ showEn: !settings.showEn })}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              settings.showEn
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-700 text-slate-400'
            }`}
          >
            英文
          </button>
          <button
            onClick={() => updateSettings({ showZh: !settings.showZh })}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              settings.showZh
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-700 text-slate-400'
            }`}
          >
            中文
          </button>
        </div>
      </div>

      {/* 颜色选择 */}
      <div className="space-y-2">
        {settings.showEn && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">英文颜色</span>
            <input
              type="color"
              value={settings.enColor}
              onChange={(e) => updateSettings({ enColor: e.target.value })}
            />
          </div>
        )}
        {settings.showZh && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">中文颜色</span>
            <input
              type="color"
              value={settings.zhColor}
              onChange={(e) => updateSettings({ zhColor: e.target.value })}
            />
          </div>
        )}
      </div>

      {/* 位置选择 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-slate-400">字幕位置（距底部）</label>
          <span className="text-xs text-slate-300">
            {100 - settings.positionY}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="90"
          step="1"
          value={100 - settings.positionY}
          onChange={(e) =>
            updateSettings({ positionY: 100 - parseInt(e.target.value) })
          }
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-slate-500">
          <span>底部</span>
          <span>中间</span>
          <span>顶部</span>
        </div>
        <p className="text-xs text-slate-500">
          距底部约 1/3（33%）可避免被抖音等平台的底部 UI 遮挡
        </p>
      </div>

      {/* 字号 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-slate-400">字号</label>
          <span className="text-xs text-slate-300">{settings.fontSize}px</span>
        </div>
        <input
          type="range"
          min="14"
          max="48"
          step="2"
          value={settings.fontSize}
          onChange={(e) =>
            updateSettings({ fontSize: parseInt(e.target.value) })
          }
          className="w-full"
        />
      </div>

      {/* 背景开关 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-300">字幕背景</span>
          <button
            onClick={() => updateSettings({ background: !settings.background })}
            className={`relative h-6 w-11 rounded-full transition-colors ${
              settings.background ? 'bg-indigo-600' : 'bg-slate-600'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                settings.background ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        {settings.background && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs text-slate-400">背景透明度</label>
              <span className="text-xs text-slate-300">
                {Math.round(settings.bgOpacity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={settings.bgOpacity}
              onChange={(e) =>
                updateSettings({ bgOpacity: parseFloat(e.target.value) })
              }
              className="w-full"
            />
          </div>
        )}
      </div>
    </div>
  )
}
