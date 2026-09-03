import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await runTsc(resolve(appDir, 'tsconfig.build.json'))
const distDir = resolve(appDir, 'dist')
await mkdir(distDir, { recursive: true })
await Promise.all([
  cp(resolve(appDir, 'index.html'), resolve(distDir, 'index.html')),
  cp(resolve(appDir, 'styles.css'), resolve(distDir, 'styles.css')),
])

function runTsc(project) {
  return new Promise((resolvePromise, rejectPromise) => {
    const command = process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
    const child = spawn(command, ['-p', project], { stdio: 'inherit' })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`tsc exited with code ${code ?? 'unknown'}`))
    })
  })
}
