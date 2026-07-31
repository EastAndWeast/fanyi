import type { SubtitleSegment, SubtitleSettings } from '../types'

interface BurnOptions {
  video: HTMLVideoElement
  subtitles: SubtitleSegment[]
  settings: SubtitleSettings
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

interface BurnResult {
  blob: Blob
  mimeType: string
  extension: string
}

/**
 * 选择最佳的 MediaRecorder MIME 类型
 */
function getSupportedMimeType(): { mimeType: string; extension: string } {
  const candidates = [
    // 优先 MP4（H.264 + AAC），兼容常见播放器和视频平台
    // 注意：必须显式指定 avc1+mp4a，裸 video/mp4 会被 Chrome 默认选 VP9+Opus，
    // 导致 Windows 播放器无声甚至无画面
    { mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', extension: 'mp4' },
    { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
    // 不支持 H.264+AAC 时回退到 WebM
    { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
    { mimeType: 'video/webm;codecs=h264,opus', extension: 'webm' },
    { mimeType: 'video/webm', extension: 'webm' },
  ]

  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) {
      return c
    }
  }

  return { mimeType: 'video/webm', extension: 'webm' }
}

/**
 * 在 Canvas 上绘制字幕
 */
function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  time: number,
  subtitles: SubtitleSegment[],
  settings: SubtitleSettings
) {
  const currentSubs = subtitles.filter(
    (s) => time >= s.start && time <= s.end
  )

  if (currentSubs.length === 0) return

  const w = canvas.width
  const h = canvas.height
  const fontSize = Math.round(settings.fontSize * (h / 480))
  const padding = Math.round(fontSize * 0.4)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 计算所有需要绘制的文本行
  const lines: { text: string; color: string; size: number }[] = []
  for (const sub of currentSubs) {
    if (settings.showZh && sub.textZh) {
      lines.push({
        text: sub.textZh,
        color: settings.zhColor,
        size: fontSize,
      })
    }
    if (settings.showEn && sub.textEn) {
      lines.push({
        text: sub.textEn,
        color: settings.enColor,
        size: fontSize - 4,
      })
    }
  }

  if (lines.length === 0) return

  // 计算文本块的总高度
  let totalHeight = 0
  let maxWidth = 0
  for (const line of lines) {
    ctx.font = `600 ${line.size}px sans-serif`
    const metrics = ctx.measureText(line.text)
    const lineW = Math.min(metrics.width, w * 0.9)
    maxWidth = Math.max(maxWidth, lineW)
    totalHeight += line.size + padding * 0.5
  }

  // Y 位置计算：positionY 为字幕中心距顶部的百分比 (0-100)
  // 夹取到安全范围，避免字幕块超出画面上下边界
  const margin = totalHeight / 2 + h * 0.02
  let y = (h * settings.positionY) / 100
  y = Math.min(Math.max(y, margin), h - margin)

  // 绘制背景
  if (settings.background) {
    const bgX = w / 2 - maxWidth / 2 - padding
    const bgY = y - totalHeight / 2 - padding * 0.5
    const bgW = maxWidth + padding * 2
    const bgH = totalHeight + padding
    ctx.fillStyle = `rgba(0,0,0,${settings.bgOpacity})`
    ctx.beginPath()
    const r = 8
    ctx.roundRect(bgX, bgY, bgW, bgH, r)
    ctx.fill()
  }

  // 逐行绘制文本
  let currentY = y - totalHeight / 2 + lines[0].size / 2
  for (const line of lines) {
    ctx.font = `600 ${line.size}px sans-serif`

    // 描边（增强可读性）
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'
    ctx.lineWidth = Math.max(2, line.size / 12)
    ctx.lineJoin = 'round'

    // 自动换行
    const maxWidthLine = w * 0.9
    const words = line.text.split(' ')
    const drawLines: string[] = []
    let currentLine = ''

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word
      if (ctx.measureText(testLine).width > maxWidthLine && currentLine) {
        drawLines.push(currentLine)
        currentLine = word
      } else {
        currentLine = testLine
      }
    }
    if (currentLine) drawLines.push(currentLine)

    for (const dl of drawLines) {
      ctx.strokeText(dl, w / 2, currentY)
      ctx.fillStyle = line.color
      ctx.fillText(dl, w / 2, currentY)
      currentY += line.size + padding * 0.5
    }
  }
}

/**
 * 使用 Canvas + MediaRecorder 将字幕烧录到视频中
 * 实时录制：视频时长 = 录制时长
 *
 * 流程：先播放视频 → 捕获音频 → 组合流 → 创建录制器 → 开始录制
 * 这个顺序确保：
 * 1. video.play() 不被 createMediaElementSource 阻断
 * 2. MediaRecorder 从一开始就拥有完整的音视频流，避免动态添加轨道导致崩溃
 */
export async function burnSubtitlesToVideo(
  options: BurnOptions
): Promise<BurnResult> {
  const { video, subtitles, settings, onProgress, signal } = options

  // 获取视频原始尺寸
  const videoW = video.videoWidth
  const videoH = video.videoHeight

  if (!videoW || !videoH) {
    throw new Error('无法获取视频尺寸')
  }

  // 创建 Canvas
  const canvas = document.createElement('canvas')
  canvas.width = videoW
  canvas.height = videoH
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    throw new Error('无法创建 Canvas 上下文')
  }

  // 为 Canvas roundRect 添加 polyfill（旧浏览器）
  if (!ctx.roundRect) {
    ctx.roundRect = function (
      x: number,
      y: number,
      w: number,
      h: number,
      r: number
    ) {
      this.beginPath()
      this.moveTo(x + r, y)
      this.arcTo(x + w, y, x + w, y + h, r)
      this.arcTo(x + w, y + h, x, y + h, r)
      this.arcTo(x, y + h, x, y, r)
      this.arcTo(x, y, x + w, y, r)
      this.closePath()
      return this
    }
  }

  // 创建 Canvas 视频流
  const canvasStream = canvas.captureStream(30) // 30fps

  // ========== 步骤1：启动视频播放（静音） ==========
  video.currentTime = 0
  video.muted = true
  video.defaultMuted = true

  // 等待视频帧解码完成再开始绘制
  // readyState >= 2 (HAVE_CURRENT_DATA) 确保有可绘制的帧
  if (video.readyState < 2) {
    console.log('[Burn] Waiting for video frame to decode...')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('视频帧解码超时')), 10000)
      const onReady = () => {
        if (video.readyState >= 2) {
          clearTimeout(timeout)
          video.removeEventListener('loadeddata', onReady)
          video.removeEventListener('canplay', onReady)
          resolve()
        }
      }
      video.addEventListener('loadeddata', onReady)
      video.addEventListener('canplay', onReady)
    })
  }

  // 先绘制第一帧，确保 canvas 流有视频内容
  ctx.drawImage(video, 0, 0, videoW, videoH)
  console.log('[Burn] First frame drawn, canvasStream video tracks:', canvasStream.getVideoTracks().length)

  const playPromise = video.play()
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('timeout')), 5000)
  })

  try {
    await Promise.race([playPromise, timeoutPromise])
    console.log('[Burn] Play succeeded')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Burn] Play failed:', msg)
    throw new Error(
      msg === 'timeout'
        ? '视频无法自动播放，请点击页面后重试'
        : '视频播放失败: ' + msg
    )
  }

  // ========== 步骤2：捕获音频（播放成功后） ==========
  let combinedStream: MediaStream = canvasStream
  try {
    const audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume()
    }
    const source = audioCtx.createMediaElementSource(video)
    const dest = audioCtx.createMediaStreamDestination()
    // 音量放大：增益 + 压限器组合
    // 纯增益会削波（超出 [-1,1] 的波形被剪掉），响度提升有限还会破音；
    // 压限器把峰值压回安全范围，让整体响度真正提升
    const gainNode = audioCtx.createGain()
    gainNode.gain.value = settings.volume
    source.connect(gainNode)
    // 倍率 > 1 时需要压限器防止削波失真；≤ 1 时直接输出
    if (settings.volume > 1) {
      const compressor = audioCtx.createDynamicsCompressor()
      compressor.threshold.value = -10
      compressor.knee.value = 6
      compressor.ratio.value = 6
      compressor.attack.value = 0.003
      compressor.release.value = 0.25
      gainNode.connect(compressor)
      compressor.connect(dest)
    } else {
      gainNode.connect(dest)
    }
    // 不连接到 audioCtx.destination，避免声音外放

    // 关键：muted 会让 MediaElementSource 输出静音信号（实测 RMS=0），
    // 导致录制的音轨是无声数据。音频已被重定向到 WebAudio 且未连接
    // destination，此处取消静音不会外放，但能让真实音频进入录制流
    video.muted = false
    video.volume = 1

    const audioTracks = dest.stream.getAudioTracks()
    if (audioTracks.length > 0) {
      combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioTracks,
      ])
      console.log('[Burn] Audio tracks combined')
    }
  } catch (e) {
    console.warn('[Burn] 音频捕获失败，导出视频将无音频:', e)
  }

  // ========== 步骤3：创建录制器并开始录制 ==========
  const { mimeType, extension } = getSupportedMimeType()
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 192_000,
  })

  return new Promise((resolve, reject) => {
    const chunks: Blob[] = []
    let rafId = 0
    let drawInterval: ReturnType<typeof setInterval> | null = null
    let settled = false

    const cleanup = () => {
      cancelAnimationFrame(rafId)
      if (drawInterval) clearInterval(drawInterval)
      video.pause()
      video.currentTime = 0
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.onstop = () => {
      if (settled) return
      settled = true
      const blob = new Blob(chunks, { type: mimeType })
      cleanup()
      console.log('[Burn] Recording complete, blob size:', blob.size)
      resolve({ blob, mimeType, extension })
    }

    recorder.onerror = (e: Event) => {
      // 某些编码器警告（如 avc1 codec description changed）会触发 onerror
      // 但实际录制仍在继续，只记录警告不中断
      const errorEvent = e as ErrorEvent
      const errMsg = errorEvent.error?.message || errorEvent.message || '未知错误'
      console.warn('[Burn] Recorder warning (non-fatal):', errMsg)
      // 不设置 settled，不 reject — 让 onstop 正常处理
    }

    // 处理取消
    if (signal) {
      signal.addEventListener('abort', () => {
        if (settled) return
        settled = true
        cleanup()
        if (recorder.state !== 'inactive') {
          recorder.stop()
        }
        reject(new Error('用户取消'))
      })
    }

    // 绘制循环
    let lastDrawAt = 0
    const draw = () => {
      if (recorder.state === 'inactive') return

      const time = video.currentTime

      // 绘制视频帧
      ctx.drawImage(video, 0, 0, videoW, videoH)

      // 绘制字幕
      drawSubtitle(ctx, canvas, time, subtitles, settings)

      lastDrawAt = performance.now()

      // 更新进度
      if (onProgress && video.duration) {
        onProgress(Math.min(time / video.duration, 1))
      }
    }

    // 只用单一绘制循环，避免多循环叠加导致 CPU 过载、
    // 实时编码器丢帧和码率骤降
    if ('requestVideoFrameCallback' in video) {
      // 优先：与视频帧精确同步，每个新帧只绘制一次
      const rvfcDraw = () => {
        if (settled || recorder.state === 'inactive') return
        draw()
        ;(video as any).requestVideoFrameCallback(rvfcDraw)
      }
      ;(video as any).requestVideoFrameCallback(rvfcDraw)
      console.log('[Burn] Using requestVideoFrameCallback for frame sync')
    } else {
      // 回退：requestAnimationFrame
      rafId = requestAnimationFrame(function loop() {
        draw()
        if (recorder.state !== 'inactive') {
          rafId = requestAnimationFrame(loop)
        }
      })
    }
    // 低频看门狗：标签页切后台时 rVFC/rAF 会停止触发，
    // 用它保证画面不冻结（仅在超过 200ms 未绘制时补画）
    drawInterval = setInterval(() => {
      if (recorder.state === 'inactive') return
      if (performance.now() - lastDrawAt > 200) draw()
    }, 250)

    // 视频结束时停止录制
    video.onended = () => {
      console.log('[Burn] Video ended')
      if (settled) return
      if (recorder.state !== 'inactive') {
        recorder.stop()
      }
    }

    // 开始录制
    recorder.start(100)
    console.log('[Burn] Recorder started')
  })
}

/**
 * 下载 Blob 文件
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 大文件下载开始前撤销 URL 会导致部分浏览器取消下载
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
