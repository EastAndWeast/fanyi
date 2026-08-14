import { useState, useRef } from 'react'
import { useStore } from '../store'
import VideoPlayer from './VideoPlayer'
import { burnSubtitlesToVideo, downloadBlob, hasValidAudio } from '../lib/subtitleBurner'
import { muxOriginalAudio } from '../lib/ffmpeg'
import { generateSRT, generateVTT, downloadFile } from '../lib/srt'
import type { SubtitleLang } from '../lib/srt'
import { synthesizeVoice } from '../lib/tts'
import { mixVoiceTrack } from '../lib/voiceMixer'

// 预置豆包（火山引擎）音色，均为 seed-tts-2.0 专用音色（uranus_bigtts 系列），
// 支持中英文混读。注意：1.0 的 moon_bigtts 系列与 seed-tts-2.0 不兼容
// （会报 resource ID is mismatched with speaker related resource）。
// 音色 ID 出处：火山引擎文档「音色列表 - 豆包语音合成模型2.0」（docs/6561/1257544），
// 实际可用音色以控制台开通情况为准（未开通的音色可改用「自定义」输入）
const VOICE_PRESETS: { id: string; label: string }[] = [
  { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0（女声）' },
  { id: 'zh_female_kailangjiejie_uranus_bigtts', label: '开朗姐姐 2.0（女声）' },
  { id: 'zh_female_jitangmei_uranus_bigtts', label: '鸡汤妹妹 2.0（女声）' },
  { id: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说 2.0（男声）' },
  { id: 'zh_male_fanjuanqingnian_uranus_bigtts', label: '反卷青年 2.0（男声）' },
  { id: 'zh_male_kailangdidi_uranus_bigtts', label: '开朗弟弟 2.0（男声）' },
]

export default function ExportView() {
  const subtitles = useStore((s) => s.subtitles)
  const settings = useStore((s) => s.settings)
  const videoFile = useStore((s) => s.videoFile)
  const mediaKind = useStore((s) => s.mediaKind)
  const setStep = useStore((s) => s.setStep)
  const reset = useStore((s) => s.reset)
  const ttsConfig = useStore((s) => s.ttsConfig)
  const updateTtsConfig = useStore((s) => s.updateTtsConfig)
  const speakers = useStore((s) => s.speakers)
  const setSpeakerVoice = useStore((s) => s.setSpeakerVoice)
  // 配音开关与音轨放全局 store：避免「返回编辑」再回来时组件重置导致静默用原声导出
  const voiceOverEnabled = useStore((s) => s.voiceOverEnabled)
  const setVoiceOverEnabled = useStore((s) => s.setVoiceOverEnabled)
  const voiceTrack = useStore((s) => s.voiceTrack)
  const setVoiceTrack = useStore((s) => s.setVoiceTrack)

  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState<'recording' | 'muxing'>('recording')
  const [error, setError] = useState('')
  const [exportedUrl, setExportedUrl] = useState<string | null>(null)
  const [exportedName, setExportedName] = useState('')
  const abortControllerRef = useRef<AbortController | null>(null)

  // 配音相关状态
  const [voiceSynthesizing, setVoiceSynthesizing] = useState(false)
  const [voiceProgress, setVoiceProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const [voiceError, setVoiceError] = useState('')
  const [voiceStats, setVoiceStats] = useState<{
    success: number
    total: number
  } | null>(null)
  const [showTtsKey, setShowTtsKey] = useState(false)
  // 每位说话人是否使用「自定义」音色输入（key 为 speaker id）
  const [customVoiceMode, setCustomVoiceMode] = useState<
    Record<number, boolean>
  >({})
  // 音色试听：正在试听的标识（'single' 或 speaker id 的字符串形式）
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState('')

  // 用指定音色合成一句英文示例并播放（验证音色是否开通、听感是否符合预期）
  const handlePreviewVoice = async (voiceType: string, key: string) => {
    setPreviewError('')
    setPreviewingVoice(key)
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: 'volcengine',
          texts: ['Hello! Nice to meet you. This is a voice preview.'],
          apiKey: ttsConfig.apiKey,
          appId: ttsConfig.appId,
          voiceType,
        }),
      })
      const data = (await resp.json()) as {
        error?: string
        results?: { audio?: string; error?: string }[]
      }
      const item = data.results?.[0]
      if (!resp.ok || !item?.audio) {
        throw new Error(data.error || item?.error || '试听合成失败')
      }
      await new Audio(`data:audio/wav;base64,${item.audio}`).play()
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '试听失败')
    } finally {
      setPreviewingVoice(null)
    }
  }

  // 获取媒体文件的实际时长（秒），用于确保配音音轨长度匹配
  const getMediaDuration = (file: File | null): Promise<number> => {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('没有文件'))
        return
      }
      const url = URL.createObjectURL(file)
      const media = document.createElement(
        file.type.startsWith('audio/') ? 'audio' : 'video'
      )
      media.preload = 'metadata'
      media.src = url
      media.onloadedmetadata = () => {
        URL.revokeObjectURL(url)
        const d = media.duration
        resolve(isFinite(d) ? d : 0)
      }
      media.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('无法读取媒体时长'))
      }
    })
  }

  const handleSynthesizeVoice = async () => {
    setVoiceSynthesizing(true)
    setVoiceError('')
    setVoiceProgress(null)
    setVoiceTrack(null)
    setVoiceStats(null)
    try {
      const { buffers: voiceBuffers, firstError } = await synthesizeVoice(subtitles, ttsConfig, (completed, total) => {
        setVoiceProgress({ completed, total })
      }, speakers)

      const successCount = voiceBuffers.filter(Boolean).length
      setVoiceStats({ success: successCount, total: subtitles.length })

      if (successCount === 0) {
        throw new Error(
          firstError
            ? `配音合成失败：${firstError}`
            : '所有配音合成失败，免费 TTS 服务可能暂时不可用，请稍后重试'
        )
      }

      // 获取视频/音频实际时长，确保配音音轨长度匹配
      const totalDuration = await getMediaDuration(videoFile).catch(() => 0)
      // 回退：字幕最后一条 end + 余量
      const fallbackDuration =
        subtitles.length > 0
          ? subtitles[subtitles.length - 1].end + 3
          : 60
      const track = await mixVoiceTrack(
        subtitles,
        voiceBuffers,
        totalDuration > 0 ? totalDuration : fallbackDuration
      )
      setVoiceTrack(track)
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : '配音合成失败')
    } finally {
      setVoiceSynthesizing(false)
    }
  }

  const handleExportVideo = async () => {
    if (!videoFile) return

    // 配音已开启但音轨未合成时，导出按钮处于禁用状态（显示「请先合成配音」），不会走到这里

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
        voiceTrack: voiceOverEnabled && voiceTrack ? voiceTrack : undefined,
      })

      // 检测录制结果是否已包含有效音频
      // 配音模式下不做原音频混流（会覆盖配音）；原声模式下检测并补救
      let finalBlob = result.blob
      if (!voiceOverEnabled || !voiceTrack) {
        const audioOk = await hasValidAudio(result.blob)
        if (audioOk) {
          console.log('[Export] 录制已含有效音频，跳过混流步骤')
        } else {
          console.log('[Export] 录制无有效音频，启动 ffmpeg 混流')
          setStage('muxing')
          try {
            finalBlob = await muxOriginalAudio(
              result.blob,
              videoFile,
              result.extension,
              settings.volume
            )
            console.log('[Export] Audio muxed, final size:', finalBlob.size)
          } catch (muxErr) {
            // 混流失败时回退到录制结果（可能仍带录制的音轨）
            console.warn('[Export] 音频混流失败，使用录制原始结果:', muxErr)
          }
        }
      }

      // 尝试自动下载（桌面浏览器有效，微信等内嵌浏览器无效）
      const baseName = videoFile.name.replace(/\.[^.]+$/, '')
      const fileName = `${baseName}_subtitles.${result.extension}`
      downloadBlob(finalBlob, fileName)

      // 同时生成预览 URL（微信等无法自动下载时，用户可长按预览视频保存）
      setExportedUrl(URL.createObjectURL(finalBlob))
      setExportedName(fileName)
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

  const handleDownloadSRT = (lang: SubtitleLang) => {
    const baseName = videoFile?.name.replace(/\.[^.]+$/, '') || 'subtitles'
    const suffix = lang === 'zh-en' ? '' : `_${lang}`
    downloadFile(generateSRT(subtitles, lang), `${baseName}${suffix}.srt`)
  }

  const handleDownloadVTT = (lang: SubtitleLang) => {
    const baseName = videoFile?.name.replace(/\.[^.]+$/, '') || 'subtitles'
    const suffix = lang === 'zh-en' ? '' : `_${lang}`
    downloadFile(generateVTT(subtitles, lang), `${baseName}${suffix}.vtt`)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 p-4 max-w-7xl mx-auto w-full overflow-y-auto">
      {/* 左侧：预览 */}
      <div className="flex-1 min-w-0">
        <VideoPlayer />
        <button
          onClick={() => setStep('editor')}
          className="mt-3 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          ← 返回编辑
        </button>
      </div>

      {/* 右侧：导出选项 */}
      <div className="w-full lg:w-96 space-y-4">
        {/* 导出视频（音频模式无此步骤，改为提示卡） */}
        {mediaKind === 'audio' ? (
          <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-blue-700">纯音频模式</h3>
            <p className="text-xs text-blue-600 leading-relaxed">
              无需压制画面，请直接下载下方的字幕文件（SRT / VTT）即可外挂播放。
            </p>
          </div>
        ) : (
        <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 mb-1">
              导出带字幕视频
            </h3>
            <p className="text-xs text-slate-400">
              将字幕直接烧录到视频画面中（实时录制，时长与视频相同）
            </p>
          </div>

          {/* 配音设置 */}
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <button
              type="button"
              onClick={() => setVoiceOverEnabled(!voiceOverEnabled)}
              className="flex w-full items-center justify-between"
            >
              <span className="text-sm text-slate-700">英文配音</span>
              <span className="flex items-center gap-2">
                <span
                  className={`text-xs font-medium ${
                    voiceOverEnabled ? 'text-blue-600' : 'text-slate-400'
                  }`}
                >
                  {voiceOverEnabled ? '已开启' : '已关闭'}
                </span>
                <span
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    voiceOverEnabled ? 'bg-blue-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      voiceOverEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </span>
            </button>

            {voiceOverEnabled && (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">
                  使用 AI 将英文字幕合成为语音配音
                </p>

                {/* 引擎选择 */}
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => updateTtsConfig({ engine: 'free' })}
                      className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                        ttsConfig.engine === 'free'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      免费（内置）
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTtsConfig({ engine: 'volcengine' })}
                      className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                        ttsConfig.engine === 'volcengine'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 text-slate-500'
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
                  {ttsConfig.engine === 'free' && speakers.length > 1 && (
                    <p className="text-xs text-amber-600">
                      免费引擎只支持单一音色，多人配音请配置火山引擎
                    </p>
                  )}
                </div>

                {/* 火山引擎配置 */}
                {ttsConfig.engine === 'volcengine' && (
                  <div className="space-y-2 rounded-lg bg-slate-50 p-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-slate-500">
                        Access Token / API Key
                      </label>
                      <div className="relative">
                        <input
                          type={showTtsKey ? 'text' : 'password'}
                          value={ttsConfig.apiKey}
                          onChange={(e) => updateTtsConfig({ apiKey: e.target.value })}
                          placeholder="填入火山引擎密钥"
                          className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 pr-12 text-xs text-slate-800 outline-none focus:border-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTtsKey(!showTtsKey)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
                        >
                          {showTtsKey ? '隐藏' : '显示'}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-500">App ID（选填）</label>
                      <input
                        type="text"
                        value={ttsConfig.appId}
                        onChange={(e) => updateTtsConfig({ appId: e.target.value })}
                        placeholder="语音控制台的 App ID"
                        className="w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-500"
                      />
                    </div>
                    {/* 音色：多位说话人时逐人选择，否则维持单一音色输入 */}
                    {speakers.length > 1 ? (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-500">
                          检测到 {speakers.length} 位说话人，为每位选择音色：
                        </p>
                        {speakers.map((sp, idx) => (
                          <div key={sp.id} className="space-y-1">
                            <label className="text-xs text-slate-500">
                              说话人 {idx + 1}
                            </label>
                            {customVoiceMode[sp.id] ? (
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  value={sp.voiceType}
                                  onChange={(e) =>
                                    setSpeakerVoice(sp.id, e.target.value)
                                  }
                                  placeholder="自定义音色 ID"
                                  className="flex-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-500"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setCustomVoiceMode((prev) => ({
                                      ...prev,
                                      [sp.id]: false,
                                    }))
                                  }
                                  className="flex-shrink-0 rounded border border-slate-200 bg-white px-2 text-xs text-slate-500 hover:text-slate-700"
                                >
                                  预置
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-1.5">
                                <select
                                  value={
                                    VOICE_PRESETS.some(
                                      (p) => p.id === sp.voiceType
                                    )
                                      ? sp.voiceType
                                      : ''
                                  }
                                  onChange={(e) => {
                                    if (e.target.value === '__custom__') {
                                      setCustomVoiceMode((prev) => ({
                                        ...prev,
                                        [sp.id]: true,
                                      }))
                                      setSpeakerVoice(sp.id, '')
                                    } else {
                                      setSpeakerVoice(sp.id, e.target.value)
                                    }
                                  }}
                                  className="flex-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-500"
                                >
                                  <option value="">默认女声</option>
                                  {VOICE_PRESETS.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.label}
                                    </option>
                                  ))}
                                  <option value="__custom__">自定义...</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handlePreviewVoice(sp.voiceType, String(sp.id))
                                  }
                                  disabled={
                                    !ttsConfig.apiKey ||
                                    previewingVoice !== null
                                  }
                                  className="flex-shrink-0 rounded border border-slate-200 bg-white px-2 text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {previewingVoice === String(sp.id)
                                    ? '…'
                                    : '试听'}
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                        <p className="text-xs text-slate-400">
                          留空的使用默认女声；预置音色需在控制台开通
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <label className="text-xs text-slate-500">音色 ID（选填）</label>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={ttsConfig.voiceType}
                            onChange={(e) => updateTtsConfig({ voiceType: e.target.value })}
                            placeholder="如 zh_female_vv_uranus_bigtts"
                            className="flex-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              handlePreviewVoice(ttsConfig.voiceType, 'single')
                            }
                            disabled={!ttsConfig.apiKey || previewingVoice !== null}
                            className="flex-shrink-0 rounded border border-slate-200 bg-white px-2 text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {previewingVoice === 'single' ? '…' : '试听'}
                          </button>
                        </div>
                        <p className="text-xs text-slate-400">
                          留空使用默认女声（Vivi 2.0）；注意需为 seed-tts-2.0 音色（uranus_bigtts 系列）
                        </p>
                      </div>
                    )}
                    {previewError && (
                      <p className="text-xs text-red-600">试听失败：{previewError}</p>
                    )}
                  </div>
                )}

                {!voiceTrack && !voiceSynthesizing && (
                  <button
                    type="button"
                    onClick={handleSynthesizeVoice}
                    disabled={ttsConfig.engine === 'volcengine' && !ttsConfig.apiKey}
                    className="w-full rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 px-3 py-2 text-sm font-medium transition-colors"
                  >
                    {ttsConfig.engine === 'volcengine' && !ttsConfig.apiKey
                      ? '请先填写密钥'
                      : '合成配音'}
                  </button>
                )}

                {voiceSynthesizing && voiceProgress && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>正在合成配音...</span>
                      <span>
                        {voiceProgress.completed}/{voiceProgress.total}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{
                          width: `${
                            (voiceProgress.completed / voiceProgress.total) * 100
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {voiceTrack && (
                  <p className="text-xs text-green-600 font-medium">
                    ✓ 配音已就绪
                    {voiceStats
                      ? `（${voiceStats.success}/${voiceStats.total} 条成功）`
                      : ''}
                  </p>
                )}

                {voiceError && (
                  <p className="text-xs text-red-500">{voiceError}</p>
                )}
              </div>
            )}
          </div>

          {!exporting && progress === 0 && (
            <button
              onClick={handleExportVideo}
              disabled={voiceOverEnabled && !voiceTrack}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-3 text-sm font-medium transition-colors"
            >
              {voiceOverEnabled && !voiceTrack ? '请先合成配音' : '开始导出'}
            </button>
          )}

          {exporting && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{stage === 'muxing' ? '正在合成音频...' : '正在录制...'}</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-200"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <button
                onClick={handleCancel}
                className="w-full rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 text-sm font-medium transition-colors"
              >
                取消
              </button>
            </div>
          )}

          {!exporting && progress > 0 && progress < 1 && !error && (
            <p className="text-xs text-slate-400">导出已取消</p>
          )}

          {!exporting && progress >= 1 && (
            <div className="space-y-3">
              <p className="text-xs text-green-600 font-medium">导出完成！</p>
              <p className="text-xs text-slate-500">
                文件已开始下载。如果未自动下载（如微信内），请播放下方预览视频，长按画面选择「保存视频」。
              </p>
              <button
                onClick={() => {
                  if (exportedUrl) {
                    const a = document.createElement('a')
                    a.href = exportedUrl
                    a.download = exportedName
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }
                }}
                className="w-full rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 text-sm font-medium transition-colors"
              >
                重新下载
              </button>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
        </div>
        )}

        {/* 导出结果预览（微信等无法自动下载时长按保存） */}
        {!exporting && exportedUrl && (
          <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 mb-1">
                预览导出结果
              </h3>
              <p className="text-xs text-slate-400">
                长按视频画面可保存到相册（微信/手机浏览器）
              </p>
            </div>
            <video
              src={exportedUrl}
              controls
              playsInline
              className="w-full rounded-lg bg-black max-h-[40vh] lg:max-h-[50vh] object-contain"
            />
          </div>
        )}

        {/* 导出字幕文件 */}
        <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 mb-1">
              下载字幕文件
            </h3>
            <p className="text-xs text-slate-400">
              适用于外挂字幕播放器或视频编辑软件
            </p>
          </div>

          {/* SRT */}
          <div className="space-y-1.5">
            <p className="text-xs text-slate-500 font-medium">SRT 格式</p>
            <div className="grid grid-cols-4 gap-2">
              <button
                onClick={() => handleDownloadSRT('zh-en')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                中英双语
              </button>
              <button
                onClick={() => handleDownloadSRT('zh')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                中文
              </button>
              <button
                onClick={() => handleDownloadSRT('en')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                英文
              </button>
              <button
                onClick={() => handleDownloadSRT('original')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                原文
              </button>
            </div>
          </div>

          {/* VTT */}
          <div className="space-y-1.5">
            <p className="text-xs text-slate-500 font-medium">VTT 格式</p>
            <div className="grid grid-cols-4 gap-2">
              <button
                onClick={() => handleDownloadVTT('zh-en')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                中英双语
              </button>
              <button
                onClick={() => handleDownloadVTT('zh')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                中文
              </button>
              <button
                onClick={() => handleDownloadVTT('en')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                英文
              </button>
              <button
                onClick={() => handleDownloadVTT('original')}
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1.5 text-xs font-medium transition-colors"
              >
                原文
              </button>
            </div>
          </div>
        </div>

        {/* 字幕统计 */}
        <div className="rounded-xl bg-white border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-2">
            字幕统计
          </h3>
          <div className="grid grid-cols-2 gap-3 text-center">
            <div className="rounded-lg bg-slate-100 p-2">
              <p className="text-lg font-bold text-slate-800">
                {subtitles.length}
              </p>
              <p className="text-xs text-slate-400">条字幕</p>
            </div>
            <div className="rounded-lg bg-slate-100 p-2">
              <p className="text-lg font-bold text-slate-800">
                {subtitles.filter((s) => s.textOriginal).length}
              </p>
              <p className="text-xs text-slate-400">已翻译</p>
            </div>
          </div>
        </div>

        {/* 完成 */}
        <button
          onClick={reset}
          className="w-full rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 px-4 py-2.5 text-sm font-medium transition-colors"
        >
          处理新文件
        </button>
      </div>
    </div>
  )
}
