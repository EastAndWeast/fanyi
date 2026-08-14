// 多说话人检测（speaker diarization）主线程封装
//
// 内部创建 /diarization/worker.js（sherpa-onnx WASM），完成：
//   WAV ArrayBuffer → 16kHz 单声道 Float32Array → Worker → 声纹聚类
// 全程在浏览器本地运行，音频不上传。
// 首次使用需下载约 45MB 模型（HuggingFace CDN），之后走 Cache API 缓存。

export interface DiarizationSegment {
  start: number // 秒
  end: number // 秒
  speaker: number // 说话人编号，从 0 开始
}

export type DiarizationPhase = 'download' | 'init' | 'process'

interface DetectOptions {
  // 说话人数：>0 为指定人数；不传或 <=0 为自动聚类
  numClusters?: number
  // 进度回调：phase 为阶段，percent 为 0-100（'process' 阶段无法预估进度，固定回 0）
  onProgress?: (phase: DiarizationPhase, percent: number) => void
}

// 解析 WAV（16-bit PCM）为 Float32Array（-1..1），偏移解析逻辑参考 api.ts 的 parseWav
function wavToFloat32(buffer: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buffer)
  const dv = new DataView(buffer)
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE'
  ) {
    throw new Error('无效的 WAV 文件')
  }

  let numChannels = 1
  let bitsPerSample = 16
  let dataOffset = -1
  let dataLength = 0

  let pos = 12
  while (pos + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(...bytes.subarray(pos, pos + 4))
    const chunkSize = dv.getUint32(pos + 4, true)
    if (chunkId === 'fmt ') {
      numChannels = dv.getUint16(pos + 10, true)
      bitsPerSample = dv.getUint16(pos + 22, true)
    } else if (chunkId === 'data') {
      dataOffset = pos + 8
      dataLength = chunkSize
      break
    }
    pos += 8 + chunkSize + (chunkSize % 2)
  }

  if (dataOffset === -1 || bitsPerSample !== 16) {
    throw new Error('仅支持 16-bit PCM WAV')
  }

  const frameCount = Math.floor(
    Math.min(dataLength, buffer.byteLength - dataOffset) / (2 * numChannels)
  )
  const samples = new Float32Array(frameCount)
  // extractAudio 产物为单声道；若为多声道则取第一声道
  for (let i = 0; i < frameCount; i++) {
    samples[i] = dv.getInt16(dataOffset + i * 2 * numChannels, true) / 32768
  }
  return samples
}

// 能力检查：需要 Worker 与 Cache API（secure context）
export function isDiarizationAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof caches !== 'undefined'
}

// 当前活跃的 worker（同一时间只跑一个检测任务，便于组件卸载时终止）
let activeWorker: Worker | null = null
let activeReject: ((err: Error) => void) | null = null

/**
 * 检测音频中的说话人
 *
 * @param wav 16kHz 单声道 16-bit PCM WAV（extractAudio 的产物）
 * @returns 说话人分段数组（秒），speaker 从 0 开始
 */
export function detectSpeakers(
  wav: ArrayBuffer,
  opts: DetectOptions = {}
): Promise<DiarizationSegment[]> {
  const samples = wavToFloat32(wav)
  const numClusters = opts.numClusters && opts.numClusters > 0 ? opts.numClusters : -1

  // 若已有任务在跑，先终止（理论上不会发生，防御性处理）
  cancelDiarization()

  return new Promise<DiarizationSegment[]>((resolve, reject) => {
    const worker = new Worker('/diarization/worker.js')
    activeWorker = worker
    activeReject = reject

    const cleanup = () => {
      worker.terminate()
      if (activeWorker === worker) {
        activeWorker = null
        activeReject = null
      }
    }

    worker.onerror = (e) => {
      cleanup()
      reject(new Error(`说话人检测 Worker 错误: ${e.message || '未知错误'}`))
    }

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg.type === 'progress') {
        opts.onProgress?.(msg.phase, msg.percent)
      } else if (msg.type === 'loaded') {
        opts.onProgress?.('process', 0)
        worker.postMessage(
          { cmd: 'process', samples, numClusters },
          [samples.buffer]
        )
      } else if (msg.type === 'result') {
        cleanup()
        resolve(msg.segments as DiarizationSegment[])
      } else if (msg.type === 'error') {
        cleanup()
        reject(new Error(msg.message))
      }
    }

    worker.postMessage({ cmd: 'load' })
  })
}

/** 终止正在进行的检测（组件卸载时调用） */
export function cancelDiarization(): void {
  if (activeWorker) {
    activeWorker.terminate()
    activeWorker = null
  }
  if (activeReject) {
    activeReject(new Error('说话人检测已取消'))
    activeReject = null
  }
}
