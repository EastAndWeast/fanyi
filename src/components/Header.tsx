import { useStore } from '../store'

export default function Header() {
  const step = useStore((s) => s.step)
  const reset = useStore((s) => s.reset)

  const steps = [
    { key: 'upload', label: '上传' },
    { key: 'processing', label: '处理' },
    { key: 'editor', label: '编辑' },
    { key: 'export', label: '导出' },
  ]

  const currentIndex = steps.findIndex((s) => s.key === step)

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg
            className="w-6 h-6 text-indigo-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M7 15h3M14 15h3M7 11h10" />
          </svg>
          <span className="font-semibold text-slate-200 text-sm sm:text-base">
            视频字幕翻译器
          </span>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center gap-1 sm:gap-2">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center">
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${
                  i === currentIndex
                    ? 'bg-indigo-600 text-white'
                    : i < currentIndex
                      ? 'text-indigo-400'
                      : 'text-slate-600'
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
                    i === currentIndex
                      ? 'bg-white/20'
                      : i < currentIndex
                        ? 'bg-indigo-600'
                        : 'bg-slate-700'
                  }`}
                >
                  {i < currentIndex ? '✓' : i + 1}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-3 sm:w-6 h-px ${i < currentIndex ? 'bg-indigo-600' : 'bg-slate-700'}`}
                />
              )}
            </div>
          ))}
        </div>

        {/* 重置按钮 */}
        {step !== 'upload' && (
          <button
            onClick={reset}
            className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded transition-colors"
          >
            重新开始
          </button>
        )}
      </div>
    </header>
  )
}
