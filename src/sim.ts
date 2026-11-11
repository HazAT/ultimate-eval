/**
 * The simulated user: a fixed model (Claude Code, Opus 5.5, low effort) that plays the scenario's person. Each call is
 * one decision from the scenario card and what Ultimate has said so far. It never sees code or the hidden spec.
 * `claude -p` runs with no tools, no session persistence, no user settings and a short system prompt of our own, so
 * a call costs about 1k tokens of prompt instead of Claude Code's own ~98k.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Question } from './api.ts'

export const SIM_MODEL = 'claude-opus-5-5'
export const SIM_EFFORT = 'low'

export const SYSTEM = `You play a person using Ultimate, an AI coding assistant, through its chat. You are given a scenario card that says who you are, what you want, what counts as done, prepared answers per topic, and limits. Stay in character: short, friendly, natural messages, the way a busy product owner types. Never write code, name files, or suggest implementation. Stay on the goal. Prefer the prepared answers, in your own words; when you must answer something they do not cover, answer in the spirit of the goal and set "improvised" to true. You reply with exactly one JSON object.`

export const SIM_PROMPT_SHA = createHash('sha256').update(SYSTEM).digest('hex').slice(0, 12)

/** What the simulated user decides on one turn. */
export type Decision =
  | { action: 'message'; text: string; improvised: boolean; why: string }
  | {
      action: 'answer'
      messageId: number
      answers: { question: string; answer: string | string[] }[]
      note?: string
      improvised: boolean
      why: string
    }
  | { action: 'wait'; why: string }
  | { action: 'done'; why: string }

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['message', 'answer', 'wait', 'done'] },
    text: { type: 'string', description: 'For message: what you type.' },
    messageId: { type: 'number', description: 'For answer: the open card you answer.' },
    answers: {
      type: 'array',
      description:
        'For answer: one entry per question you answer. For choice, confirm and scale give the exact option label (Yes/No for confirm, the number for scale); for multi a list of exact labels; for text your words.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['question', 'answer'],
      },
    },
    note: { type: 'string', description: 'For answer: an optional note added to the card.' },
    improvised: { type: 'boolean' },
    why: { type: 'string', description: 'One short line: why this action.' },
  },
  required: ['action', 'improvised', 'why'],
}

export type Card = { id: number; from: number | string; text: string; questions: Question[] }
export type Said = { at: number; who: 'ultimate' | 'you'; text: string }

export type SimCall = { decision: Decision; costUsd: number; ms: number; raw?: string }

/** Build one turn's prompt: the scenario, the conversation so far, open cards, and the situation. */
export function turnPrompt(input: {
  scenario: string
  said: Said[]
  cards: Card[]
  busy: boolean
  minutes: number
  quietMinutes: number
  opening: boolean
}) {
  const lines = [`# Scenario card\n\n${input.scenario}`, '# The conversation so far']
  if (!input.said.length) lines.push('(nothing yet)')
  for (const s of input.said) lines.push(`**${s.who === 'you' ? 'You' : 'Ultimate'}:** ${s.text}`)
  if (input.cards.length) {
    lines.push('# Open question cards waiting on you')
    for (const card of input.cards) lines.push(`Card ${card.id}: ${JSON.stringify(card.questions)}`)
  }
  lines.push(
    `# Now\n\n${input.minutes} minutes since you started; Ultimate is ${input.busy ? 'working' : 'idle'}; nothing new for ${input.quietMinutes} minutes.`,
  )
  lines.push(
    input.opening
      ? 'Send your opening message now (action "message").'
      : [
          'Decide your next step:',
          '- "answer" an open card (one card per turn; answer every question on it with exact option labels),',
          '- "message" to reply to something Ultimate said that needs you, or to nudge it once if it seems stuck,',
          '- "wait" while Ultimate works or nothing needs you,',
          '- "done" only when Ultimate has reported every goal improvement landed, nothing needs you, and you are satisfied.',
          'Do not repeat yourself, do not chat when nothing needs you.',
        ].join('\n'),
  )
  return lines.join('\n\n')
}

/** Ask the simulated user once. `cwd` is a unique per-run folder, so its Claude Code project path is known. */
export function decide(prompt: string, cwd: string, signal?: AbortSignal): Promise<SimCall> {
  mkdirSync(cwd, { recursive: true })
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model',
        SIM_MODEL,
        '--effort',
        SIM_EFFORT,
        '--no-session-persistence',
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--system-prompt',
        SYSTEM,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(SCHEMA),
      ],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
    const stop = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      try {
        const result = JSON.parse(out)
        if (result.is_error || !result.structured_output)
          throw new Error(`claude: ${result.subtype} ${result.result ?? ''}`.slice(0, 500))
        resolve({
          decision: normalize(result.structured_output),
          costUsd: result.total_cost_usd ?? 0,
          ms: Date.now() - started,
        })
      } catch (error) {
        reject(new Error(`sim call failed (exit ${code}): ${String(error)} ${err.slice(0, 500)} ${out.slice(0, 500)}`))
      }
    })
    child.stdin.end(prompt)
  })
}

function normalize(value: Record<string, unknown>): Decision {
  const why = String(value.why ?? '')
  const improvised = value.improvised === true
  switch (value.action) {
    case 'message':
      if (typeof value.text !== 'string' || !value.text.trim()) return { action: 'wait', why: `empty message: ${why}` }
      return { action: 'message', text: value.text, improvised, why }
    case 'answer':
      return {
        action: 'answer',
        messageId: Number(value.messageId),
        answers: (value.answers as { question: string; answer: string | string[] }[]) ?? [],
        ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note } : {}),
        improvised,
        why,
      }
    case 'done':
      return { action: 'done', why }
    default:
      return { action: 'wait', why }
  }
}

/**
 * Fit a decided answer to the card as the UI would send it: multi as a list of labels, single choices as one label.
 * `joinMulti` sends a multi joined with ", ", as the card did before ce22290.
 */
export function shapeAnswers(
  card: Card,
  answers: { question: string; answer: string | string[] }[],
  joinMulti: boolean,
) {
  return answers
    .filter((a) => card.questions.some((q) => q.text === a.question))
    .map((a) => {
      const q = card.questions.find((c) => c.text === a.question)!
      const list = [a.answer].flat().map(String).filter((s) => s.trim())
      if (q.kind === 'multi') return { question: a.question, answer: joinMulti ? list.join(', ') : list }
      return { question: a.question, answer: list.join(', ') }
    })
}
