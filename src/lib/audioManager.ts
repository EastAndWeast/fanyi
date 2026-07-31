// 预览音量管理：通过 WebAudio 增益节点实现 0~3x 音量控制
//
// 限制：createMediaElementSource 对每个 video 元素只能调用一次，
// 调用后 video 的音频不再直接输出到扬声器，必须经由 WebAudio 图。
// 模块级管理确保同一个 video 不会重复创建 source。

let audioCtx: AudioContext | null = null
let sourceNode: MediaElementAudioSourceNode | null = null
let gainNode: GainNode | null = null

/**
 * 为 video 元素初始化 WebAudio 增益图（source → gain → destination）。
 * 若已为同一 video 创建过 source 则直接复用。
 */
export function setupPreviewAudio(
  video: HTMLVideoElement,
  volume: number
): void {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  if (!sourceNode) {
    sourceNode = audioCtx.createMediaElementSource(video)
    gainNode = audioCtx.createGain()
    gainNode.gain.value = volume
    sourceNode.connect(gainNode)
    gainNode.connect(audioCtx.destination)
  }
}

/**
 * 更新预览音量（实时生效）。
 */
export function setPreviewVolume(volume: number): void {
  if (gainNode) {
    gainNode.gain.value = volume
  }
}

/**
 * 恢复 AudioContext（浏览器要求用户交互后才能播放声音）。
 */
export function resumePreviewAudio(): void {
  if (audioCtx?.state === 'suspended') {
    audioCtx.resume()
  }
}

/**
 * 销毁当前 WebAudio 图（组件卸载时调用）。
 * video 元素移出 DOM 后，其 source 也会失效。
 */
export function teardownPreviewAudio(): void {
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
    sourceNode = null
    gainNode = null
  }
}
