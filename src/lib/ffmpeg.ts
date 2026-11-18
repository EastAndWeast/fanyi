// FFmpeg.wasm 通过 UMD 脚本加载（index.html 中的 <script> 标签）
// 使用 UMD 而非 ESM 以确保 Worker 为 classic 类型（支持 importScripts）

declare global {
  interface Window {
    FFmpegWASM?: {
      FFmpeg: new () => FFmpegInstance
    }
  }
}

interface FFmpegInstance {
  loaded: boolean
  load(opts: {
    coreURL: string
    wasmURL: string
    workerURL?: string
  }): Promise<void>
  writeFile(path: string, data: Uint8Array | string): Promise<boolean>
  readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string>
  exec(args: string[]): Promise<number>
  deleteFile(path: string): Promise<boolean>
  on(event: string, callback: (data: unknown) => void): void
  terminate(): void
}

let ffmpegInstance: FFmpegInstance | null = null
let loadingPromise: Promise<FFmpegInstance> | null = null

// FFmpeg.wasm 单线程核心同域分片托管（public/ffmpeg/）：
// Cloudflare Pages 单文件限制 25MB，而 ffmpeg-core.wasm 约 31MB，
// 因此拆分为两个 ~15.4MB 分片随静态资源同域部署，彻底摆脱国内访问外部 CDN 不稳定的问题。
const ST_LOCAL_JS_URL = '/ffmpeg/ffmpeg-core.js'
const ST_LOCAL_WASM_PARTS = [
  '/ffmpeg/ffmpeg-core.wasm.part0',
  '/ffmpeg/ffmpeg-core.wasm.part1',
]

// 多线程核心 @ffmpeg/core-mt（仅在支持 SharedArrayBuffer + 跨域隔离时尝试，失败自动降级到本地单线程）
const MT_CDN_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt/dist/umd',
  'https://fastly.jsdelivr.net/npm/@ffmpeg/core-mt/dist/umd',
  'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/umd',
]

/**
 * 判断当前环境能否使用多线程核心。
 * 需要 SharedArrayBuffer 且页面处于跨域隔离状态（COOP/COEP 生效）。
 * 手机浏览器（尤其微信/QQ/小米等内置浏览器）通常返回 false，自动降级到单线程。
 */
function canUseMultiThread(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof globalThis.crossOriginIsolated !== 'undefined' &&
    globalThis.crossOriginIsolated === true
  )
}

/**
 * 返回当前将使用的 FFmpeg 运行模式，供 UI 提示使用。
 */
export function getFFmpegMode(): 'multi-thread' | 'single-thread' {
  return canUseMultiThread() ? 'multi-thread' : 'single-thread'
}

/**
 * 带重试的二进制拉取（应对弱网/偶发断连）
 */
async function fetchBufferWithRetry(url: string, retries = 2): Promise<ArrayBuffer> {
  let lastError: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} (${url})`)
      }
      return await resp.arrayBuffer()
    } catch (err) {
      lastError = err
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 将 URL 转为 Blob URL（获取资源并转为同源 Blob，绕过 COEP 限制）
 */
async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const buf = await fetchBufferWithRetry(url)
  const blob = new Blob([buf], { type: mimeType })
  return URL.createObjectURL(blob)
}

/**
 * 并行拉取多个分片并在内存中拼接为一个 Blob URL
 */
async function partsToBlobURL(urls: string[], mimeType: string): Promise<string> {
  const buffers = await Promise.all(urls.map((u) => fetchBufferWithRetry(u)))
  const blob = new Blob(buffers, { type: mimeType })
  return URL.createObjectURL(blob)
}

/**
 * 加载本地同域单线程核心配置
 */
async function loadLocalSingleThreadOpts(): Promise<{
  coreURL: string
  wasmURL: string
}> {
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(ST_LOCAL_JS_URL, 'text/javascript'),
    partsToBlobURL(ST_LOCAL_WASM_PARTS, 'application/wasm'),
  ])
  return { coreURL, wasmURL }
}

/**
 * 尝试从多个 CDN 加载多线程核心，全部失败则返回 null（由调用方降级到本地单线程）
 */
async function tryLoadMultiThreadOpts(): Promise<{
  coreURL: string
  wasmURL: string
  workerURL: string
} | null> {
  for (const base of MT_CDN_BASES) {
    try {
      const [coreURL, wasmURL, workerURL] = await Promise.all([
        toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
        toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript'),
      ])
      return { coreURL, wasmURL, workerURL }
    } catch (err) {
      console.warn(`[FFmpeg] 多线程核心 CDN 加载失败 (${base}):`, err)
    }
  }
  return null
}

/**
 * 从 File/URL 读取为 Uint8Array
 */
async function fetchFileData(input: File | string): Promise<Uint8Array> {
  if (input instanceof File) {
    const buf = await input.arrayBuffer()
    return new Uint8Array(buf)
  }
  const resp = await fetch(input)
  const buf = await resp.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * 懒加载 FFmpeg.wasm 实例
 */
async function getFFmpeg(): Promise<FFmpegInstance> {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance
  if (loadingPromise) return loadingPromise

  loadingPromise = (async () => {
    if (!window.FFmpegWASM?.FFmpeg) {
      throw new Error('FFmpeg 脚本未加载，请刷新页面重试')
    }

    const ff = new window.FFmpegWASM.FFmpeg()

    try {
      let loadOpts: {
        coreURL: string
        wasmURL: string
        workerURL?: string
      } | null = null

      if (canUseMultiThread()) {
        loadOpts = await tryLoadMultiThreadOpts()
      }

      if (!loadOpts) {
        loadOpts = await loadLocalSingleThreadOpts()
      }

      await ff.load(loadOpts)
      ffmpegInstance = ff
      return ff
    } catch (err) {
      // 加载失败时重置 loadingPromise，确保点击「重试」可以重新发起加载
      loadingPromise = null
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`音视频处理组件加载失败，请检查网络后重试（${detail}）`)
    }
  })()

  return loadingPromise
}

/**
 * 从视频文件中提取音频为 16kHz 单声道 WAV
 */
export async function extractAudio(
  videoFile: File,
  onLog?: (message: string) => void
): Promise<ArrayBuffer> {
  const ff = await getFFmpeg()

  const inputName = 'input_video'
  const outputName = 'output_audio.wav'

  onLog?.('正在写入视频文件...')
  await ff.writeFile(inputName, await fetchFileData(videoFile))

  onLog?.('正在提取音频...')
  const code = await ff.exec([
    '-i', inputName,
    '-vn',
    '-ar', '16000',
    '-ac', '1',
    '-f', 'wav',
    outputName,
  ])

  if (code !== 0) {
    // 纯音频场景下最常见的原因：ffmpeg.wasm 默认编译不含该编码的 decoder
    throw new Error('音频提取失败：浏览器（ffmpeg.wasm）可能不支持该音频编码，请尝试转换为 WAV/MP3 后重试')
  }

  const data = await ff.readFile(outputName)

  // 清理
  try {
    await ff.deleteFile(inputName)
    await ff.deleteFile(outputName)
  } catch {
    // 忽略
  }

  // data 是 Uint8Array
  const arr = data as Uint8Array
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer
}

/**
 * 将原视频的音轨混流进录制好的视频中
 *
 * MediaRecorder 的 WebAudio 音频捕获链路脆弱（可能静默失败导致无音轨），
 * 这里直接取原视频文件的音轨与录制的画面混流，保证导出必有原始音质的声音。
 * 同时 ffmpeg 重新封装还能补全 MediaRecorder 输出缺失的时长元数据（可拖动进度条）。
 */
export async function muxOriginalAudio(
  recordedBlob: Blob,
  originalVideo: File,
  extension: string,
  volume?: number,
  onLog?: (message: string) => void
): Promise<Blob> {
  const ff = await getFFmpeg()

  const recName = `rec_input.${extension}`
  const origName = 'orig_input'
  const outName = `mux_output.${extension}`

  onLog?.('正在写入录制文件...')
  await ff.writeFile(recName, new Uint8Array(await recordedBlob.arrayBuffer()))
  await ff.writeFile(origName, await fetchFileData(originalVideo))

  // 容器决定音频编码：mp4 用 aac，webm 用 opus
  const audioArgs =
    extension === 'mp4'
      ? ['-c:a', 'aac', '-b:a', '192k']
      : ['-c:a', 'libopus', '-b:a', '128k']

  // 音量滤镜：volume=1.0 为原声，>1 放大，<1 减小
  const volumeArgs =
    volume !== undefined && volume !== 1
      ? ['-af', `volume=${volume}`]
      : []

  onLog?.('正在合成音频...')
  const code = await ff.exec([
    '-i', recName,
    '-i', origName,
    // 画面取录制结果，声音取原视频（?表示原视频无音轨时不报错）
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c:v', 'copy',
    ...audioArgs,
    ...volumeArgs,
    '-shortest',
    outName,
  ])

  if (code !== 0) {
    throw new Error(`音频混流失败（ffmpeg 退出码 ${code}）`)
  }

  const data = (await ff.readFile(outName)) as Uint8Array

  // 清理
  try {
    await ff.deleteFile(recName)
    await ff.deleteFile(origName)
    await ff.deleteFile(outName)
  } catch {
    // 忽略
  }

  if (data.byteLength === 0) {
    throw new Error('音频混流失败（输出为空）')
  }

  return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], {
    type: extension === 'mp4' ? 'video/mp4' : 'video/webm',
  })
}

/**
 * 检查 SharedArrayBuffer 是否可用
 */
export function checkSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
}
