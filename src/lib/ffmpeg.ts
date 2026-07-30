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

// FFmpeg.wasm 核心文件使用 jsdelivr CDN（支持 CORS:* + CORP:cross-origin，可配合 COEP 使用）
// 不本地托管是因为 ffmpeg-core.wasm (32MB) 超过 Cloudflare Pages 25MB 单文件限制
// 注意: jsdelivr 对 scoped 包带版本号的 URL 解析有 bug（返回 400），
// 必须省略版本号，CDN 会自动解析到 latest（当前为 0.12.10）
//
// 双核心策略：
// - 单线程核心 @ffmpeg/core：不依赖 SharedArrayBuffer，手机/微信/国产浏览器等
//   无法跨域隔离的环境也能用，但速度较慢
// - 多线程核心 @ffmpeg/core-mt：需要 SharedArrayBuffer（跨域隔离），电脑端可用，速度快
//   额外需要 workerURL（pthread worker）
const ST_CORE_JS_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core/dist/umd/ffmpeg-core.js'
const ST_CORE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core/dist/umd/ffmpeg-core.wasm'
const MT_CORE_JS_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt/dist/umd/ffmpeg-core.js'
const MT_CORE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt/dist/umd/ffmpeg-core.wasm'
const MT_CORE_WORKER_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt/dist/umd/ffmpeg-core.worker.js'

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
 * 将 URL 转为 Blob URL（获取跨域资源并转为同源 Blob，绕过 COEP 限制）
 * 参考官方 @ffmpeg/util 的 toBlobURL 实现
 */
async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status}`)
  }
  const blob = new Blob([await resp.arrayBuffer()], { type: mimeType })
  return URL.createObjectURL(blob)
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
      throw new Error('FFmpeg UMD 脚本未加载')
    }

    const ff = new window.FFmpegWASM.FFmpeg()

    const useMT = canUseMultiThread()

    const loadOpts: {
      coreURL: string
      wasmURL: string
      workerURL?: string
    } = {
      coreURL: await toBlobURL(
        useMT ? MT_CORE_JS_URL : ST_CORE_JS_URL,
        'text/javascript'
      ),
      wasmURL: await toBlobURL(
        useMT ? MT_CORE_WASM_URL : ST_CORE_WASM_URL,
        'application/wasm'
      ),
    }

    // 多线程核心额外需要 pthread worker
    if (useMT) {
      loadOpts.workerURL = await toBlobURL(MT_CORE_WORKER_URL, 'text/javascript')
    }

    await ff.load(loadOpts)

    ffmpegInstance = ff
    return ff
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
  await ff.exec([
    '-i', inputName,
    '-vn',
    '-ar', '16000',
    '-ac', '1',
    '-f', 'wav',
    outputName,
  ])

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

  onLog?.('正在合成音频...')
  const code = await ff.exec([
    '-i', recName,
    '-i', origName,
    // 画面取录制结果，声音取原视频（?表示原视频无音轨时不报错）
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c:v', 'copy',
    ...audioArgs,
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
