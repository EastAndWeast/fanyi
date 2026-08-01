/**
 * 微信/旧内核兼容构建：把 Vite 的 ES Module 产物降级为 ES2015 + IIFE，
 * 并在 index.html 注入 <script nomodule> 回退（core-js polyfill + legacy bundle）。
 *
 * 使用方式：在 vite build 之后执行 `node scripts/legacy-build.mjs`
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(root, 'dist')
const htmlPath = resolve(distDir, 'index.html')

if (!existsSync(htmlPath)) {
  console.error('[legacy-build] dist/index.html 不存在，请先执行 vite build')
  process.exit(1)
}

let html = readFileSync(htmlPath, 'utf8')

// 找到 module 入口脚本（Vite 产物形如 <script type="module" crossorigin src="/assets/index-xxx.js">）
const moduleMatch = html.match(/<script type="module"[^>]*src="([^"]+\.js)"[^>]*><\/script>/)
if (!moduleMatch) {
  console.error('[legacy-build] 未找到 <script type="module"> 入口，跳过')
  process.exit(1)
}
const moduleSrc = moduleMatch[1]
const legacySrc = moduleSrc.replace(/\.js$/, '-legacy.js')
const entryPath = resolve(distDir, moduleSrc.replace(/^\//, ''))

console.log(`[legacy-build] 转译 ${moduleSrc} -> ${legacySrc} (ES2015 + IIFE)`)

await build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'iife',
  target: 'es2015',
  outfile: resolve(distDir, legacySrc.replace(/^\//, '')),
  minify: true,
  legalComments: 'none',
})

// 注入 nomodule 回退脚本：现代浏览器忽略 nomodule，旧内核（不支持 module）执行它们
const nomoduleBlock =
  `    <script nomodule src="/vendor/core-js.min.js"></script>\n` +
  `    <script nomodule src="${legacySrc}"></script>\n`
if (html.includes('nomodule')) {
  console.warn('[legacy-build] index.html 已包含 nomodule 脚本，跳过注入')
} else {
  html = html.replace('</body>', nomoduleBlock + '  </body>')
  writeFileSync(htmlPath, html)
}

console.log('[legacy-build] 完成 ✅')
