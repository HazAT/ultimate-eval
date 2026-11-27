import { Instance } from '../api.ts'
import { shortAnswer } from './fake.ts'
import { perfInstance } from './instance.ts'
import { prompt, seed } from './seed.ts'

const commit = process.argv[2]
if (!commit) {
  console.error('usage: node src/perf/smoke.ts <sha>')
  process.exitCode = 1
} else {
  const cancel = new AbortController()
  const onSignal = (signal: NodeJS.Signals) => cancel.abort(new Error(`${signal}: smoke cancelled`))
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const started = performance.now()
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`
  let instance: Awaited<ReturnType<typeof perfInstance>> | undefined
  let api: Instance | undefined
  const close = () => api?.close()
  cancel.signal.addEventListener('abort', close, { once: true })
  try {
    instance = await perfInstance(commit, { signal: cancel.signal, log: (line) => console.log(`${commit}: ${line}`) })
    const data = await seed(instance, { sidebar: 5, turns: 10, signal: cancel.signal })
    await instance.snapshot()
    await instance.restore()
    api = new Instance(instance.base)
    cancel.signal.throwIfAborted()
    await api.open()
    await prompt(api, data.transcriptIds[0]!, 'Performance smoke prompt.', shortAnswer.text, cancel.signal)
    close()
    await instance.stop()
    cancel.signal.throwIfAborted()
    console.log(`smoke ${commit}: ok (${elapsed()}, seed ${data.seconds.toFixed(1)} s)`)
  } catch (error) {
    console.error(`smoke ${commit}: failed (${elapsed()}): ${cancel.signal.reason ?? error}`)
    process.exitCode = cancel.signal.aborted ? 130 : 1
  } finally {
    close()
    await instance?.stop()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
