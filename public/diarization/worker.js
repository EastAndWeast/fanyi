// 多说话人检测（speaker diarization）Web Worker
//
// 基于 sherpa-onnx 官方 WASM 版（sherpa-onnx-wasm-simd-v1.13.5-speaker-diarization），
// 在浏览器本地完成声纹聚类，不上传音频。
//
// 运行时文件（loader js + wasm + 胶水 js）随仓库发布于 /diarization/ 目录；
// 官方 release 包内的 .data 文件（45.6MB，超出 Cloudflare Pages 单文件 25MB 限制）
// 不进仓库，改为运行时从 HuggingFace 下载两个模型文件并在内存中拼出等效布局：
//   .data = [README 1011 字节][embedding.onnx 39593761 字节][segmentation.onnx 5992913 字节]
// 已逐字节验证（MD5 一致）HF 上的模型与官方 .data 内嵌文件完全相同。
//
// 消息协议（主线程 → worker）：
//   { cmd: 'load' }                          下载/缓存模型并初始化 wasm（只需一次）
//   { cmd: 'process', samples, numClusters } samples 为 16kHz 单声道 Float32Array（transferable）
// 回复（worker → 主线程）：
//   { type: 'progress', phase: 'download' | 'init', percent: 0-100 }
//   { type: 'loaded' }
//   { type: 'result', segments: [{ start, end, speaker }] }  秒，speaker 从 0 开始
//   { type: 'error', message }

/* global importScripts, createOfflineSpeakerDiarization, caches */

// ── 模型下载地址（均已验证 Access-Control-Allow-Origin: *）────────────────
// 声纹 embedding 模型（3D-Speaker ERes2Net base，中英通用，39.6MB）
// 备选（GitHub release，无 CORS，不可直接用于浏览器 fetch）：
//   https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
var EMBEDDING_MODEL_URL =
  'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
// 语音分割模型（pyannote-segmentation-3.0 fp32 版，6MB；与官方 wasm .data 内嵌的
// 是同一个文件，注意不是更小的 model.int8.onnx）
// 备选（GitHub release，无 CORS）：
//   https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 内的 model.onnx
var SEGMENTATION_MODEL_URL =
  'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx'

// 官方 .data 的固定布局（来自 wasm 构建时 --preload-file 的顺序与字节偏移）
var README_BYTES = 1011
var EMBEDDING_BYTES = 39593761
var SEGMENTATION_BYTES = 5992913

var CACHE_NAME = 'sherpa-models'

var sd = null // OfflineSpeakerDiarization 实例
var loading = null // 进行中的初始化 Promise（防止重复 load）

function reportProgress(phase, percent) {
  postMessage({ type: 'progress', phase: phase, percent: percent })
}

function reportError(err) {
  postMessage({
    type: 'error',
    message: err && err.message ? err.message : String(err),
  })
}

// 下载（或读缓存）一个模型文件，返回 Uint8Array；带进度回报
async function fetchModel(url, expectedSize, basePercent, spanPercent) {
  var cache = null
  try {
    cache = await caches.open(CACHE_NAME)
    var cached = await cache.match(url)
    if (cached) {
      var buf = await cached.arrayBuffer()
      if (buf.byteLength === expectedSize) {
        reportProgress('download', basePercent + spanPercent)
        return new Uint8Array(buf)
      }
      // 尺寸不符（可能是旧版本缓存），删除后重新下载
      await cache.delete(url)
    }
  } catch {
    // Cache API 不可用（如非安全上下文）时静默降级为直接下载
    cache = null
  }

  var resp = await fetch(url)
  if (!resp.ok) {
    throw new Error('模型下载失败 (' + resp.status + ')')
  }
  var total = Number(resp.headers.get('content-length')) || expectedSize
  var data = new Uint8Array(total)
  var loaded = 0
  var reader = resp.body.getReader()
  for (;;) {
    var chunk = await reader.read()
    if (chunk.done) break
    data.set(chunk.value, loaded)
    loaded += chunk.value.length
    reportProgress(
      'download',
      basePercent + Math.round((loaded / total) * spanPercent)
    )
  }
  if (loaded !== expectedSize) {
    throw new Error('模型文件大小异常：期望 ' + expectedSize + '，实际 ' + loaded)
  }

  if (cache) {
    try {
      await cache.put(url, new Response(data.slice().buffer))
    } catch {
      // 缓存写入失败（配额不足等）不影响功能
    }
  }
  return data
}

// 把两个模型按官方 .data 布局拼接，返回 blob URL（交给 emscripten 当作 .data 加载）
function buildDataBlobUrl(embedding, segmentation) {
  // README 内容无关紧要（运行时不读取），只需保证恰好 1011 字节以维持后续偏移
  var readme = new Uint8Array(README_BYTES)
  var note =
    '# sherpa-onnx speaker diarization data package\n' +
    '# reconstructed at runtime from HuggingFace model files.\n'
  for (var i = 0; i < README_BYTES; i++) {
    readme[i] = i < note.length ? note.charCodeAt(i) : 0x20 // 空格填充
  }
  var blob = new Blob([readme, embedding, segmentation])
  return URL.createObjectURL(blob)
}

async function load() {
  reportProgress('download', 0)
  // embedding 39.6MB / 分割 6MB，按字节占比分配进度（约 87% / 13%）
  var embedding = await fetchModel(EMBEDDING_MODEL_URL, EMBEDDING_BYTES, 0, 87)
  var segmentation = await fetchModel(
    SEGMENTATION_MODEL_URL,
    SEGMENTATION_BYTES,
    87,
    13
  )
  var dataUrl = buildDataBlobUrl(embedding, segmentation)

  reportProgress('init', 0)

  await new Promise(function (resolve, reject) {
    // emscripten 全局 Module：onRuntimeInitialized 回调后 wasm 可用；
    // locateFile 把 .data 重定向到我们拼出的 blob，其余文件走 /diarization/ 本地
    self.Module = {
      onRuntimeInitialized: function () {
        resolve()
      },
      locateFile: function (path) {
        if (path.endsWith('.data')) return dataUrl
        return '/diarization/' + path
      },
      print: function (msg) {
        console.log('[sherpa-onnx]', msg)
      },
      printErr: function (msg) {
        console.warn('[sherpa-onnx]', msg)
      },
      onAbort: function (reason) {
        reject(new Error('wasm 初始化中止: ' + reason))
      },
    }

    try {
      importScripts('/diarization/sherpa-onnx-speaker-diarization.js')
      importScripts('/diarization/sherpa-onnx-wasm-main-speaker-diarization.js')
    } catch (e) {
      reject(e)
    }
  })

  // 默认配置即读取虚拟文件系统根目录的 ./segmentation.onnx 与 ./embedding.onnx
  // （由 .data 预加载包写入），聚类参数在 process 时按用户设置覆盖
  sd = createOfflineSpeakerDiarization(self.Module)
  reportProgress('init', 100)
  postMessage({ type: 'loaded' })
}

function processAudio(samples, numClusters) {
  if (!sd) {
    throw new Error('模型尚未初始化')
  }
  var config = sd.config
  config.clustering = {
    // numClusters <= 0 表示自动聚类（threshold 越小分出的人越多）
    numClusters: numClusters > 0 ? numClusters : -1,
    threshold: 0.5,
  }
  sd.setConfig(config)
  var segments = sd.process(samples)
  postMessage({ type: 'result', segments: segments || [] })
}

onmessage = function (e) {
  var msg = e.data
  if (msg.cmd === 'load') {
    if (!loading) {
      loading = load().catch(function (err) {
        loading = null
        reportError(err)
      })
    }
  } else if (msg.cmd === 'process') {
    Promise.resolve(loading)
      .then(function () {
        processAudio(msg.samples, msg.numClusters || -1)
      })
      .catch(function (err) {
        reportError(err)
      })
  }
}
