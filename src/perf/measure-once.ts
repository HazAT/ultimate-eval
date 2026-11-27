import { measure } from './browser.ts'
import { perfInstance } from './instance.ts'
import { seed } from './seed.ts'

const [commit, size] = process.argv.slice(2)
if (!commit || (size !== undefined && size !== '--small')) {
  console.error('usage: node src/perf/measure-once.ts <sha|main> [--small]')
  process.exitCode = 1
} else {
  const cancel = new AbortController()
  const onSignal = (name: NodeJS.Signals) => cancel.abort(new Error(`${name}: measurement cancelled`))
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const options = { signal: cancel.signal, log: (line: string) => console.error(`${commit}: ${line}`) }
  let instance: Awaited<ReturnType<typeof perfInstance>> | undefined
  try {
    instance = await perfInstance(commit, options)
    const data = await seed(instance, { ...options, ...(size === '--small' ? { sidebar: 50, turns: 100 } : {}) })
    await instance.snapshot()
    console.log(JSON.stringify(await measure(instance, data, options), null, 2))
  } catch (error) {
    console.error(error)
    process.exitCode = cancel.signal.aborted ? 130 : 1
  } finally {
    await instance?.stop()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
