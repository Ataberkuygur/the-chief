export type SquadCli = 'claude' | 'codex' | 'devin' | 'cursor' | 'qoder' | 'gemini' | 'antigravity' | 'openrouter' | 'opencode-zen' | 'opencode-go' | 'opencode-ollama' | 'custom'

/** One lane: a task, the CLI and model that run it, the effort step and how many agents. */
export type SquadLane = {
  id: string
  task: string
  cli: SquadCli
  model: string
  /** 0..4 over low, medium, high, xhigh, max (clamped to what the CLI takes). */
  effort: number
  /** 1..12 agents. */
  count: number
}

export type SquadGoal = {
  id: string
  text: string
  status: 'open' | 'active' | 'done'
}

/** One agent the mod started as a headless CLI process. */
export type SquadWorker = {
  id: string
  name: string
  cli: SquadCli
  model: string
  effort: string | null
  brief: string
  /** queued = waiting for RAM or a free slot before it starts. */
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  /** The last lines it wrote. */
  tail: string[]
  /** A plain one-line status, written by a small model from the tail. */
  now: string
  /** The last thing the agent itself wrote (not a tool step), for the list. */
  said?: string
  /** Files its output mentions, newest last. */
  files: string[]
  /** The session id, so a follow-up resumes the same conversation (Claude: set at start; OpenCode: set after a dropped connection). */
  sessionId: string | null
  /** Messages that came in while it ran: sent in order as the next continue turn, never as a second process. */
  pendingMessages?: string[]
  /** OpenCode only: how many times it went on in the same session after a dropped connection. */
  dropResumes?: number
  /** How many times it was sent "devam" in the same session because it stopped without its report. */
  reportResumes?: number
  /** Consecutive report resumes that wrote nothing new (0 when the last one made progress). */
  reportStalls?: number
  /** The folder + last output signature when the last report resume started. */
  resumeMark?: string
  /** This run continues sessionId (a follow-up or a report "devam"), never a fresh session. */
  resumeSession?: boolean
  /** How many runs this agent has had (1 + follow-ups). */
  runs: number
  /** The folder its .squad/logs live under, fixed at spawn (the chat's cwd moves). */
  logRoot?: string
  /** The folder it runs in (its worktree). */
  dir?: string
  /** Environment for this agent only. */
  env?: Record<string, string>
  /** Done when this file exists; its text is the report. */
  doneFile?: string
  /** Resources it holds while it runs. */
  locks?: string[]
  /** What starts after it is done, by its report. */
  next?: unknown[]
  /** false: run as a child of the chat even where it could run outside the app. */
  detach?: boolean
  /** Claude workers: the permission mode it runs under. */
  permission?: string
  /** A tier-routed worker: its tier, the routes already tried (cli/model) and whether the job is private; a failed one moves to the next. */
  route?: { tier: string; tried: string[]; isPrivate: boolean; retried?: boolean }
  /** Where the prompt it was sent is saved. */
  promptPath?: string
  /** The report, once written. */
  report?: string
  /** The lane this worker serves, and the paths it must not touch. */
  lane?: string
  guard?: string[]
  /** The chat that started it: a real stop of it is told to this chief. */
  owner?: string
}

/** One of Claude Code's own subagents (the Agent tool), followed from its spawn to its answer. */
export type SquadSub = {
  id: string
  description: string
  /** The prompt it was started with, for Copy prompt / Save prompt. */
  prompt?: string
  type: string
  model: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  tools: number
  /** Its steps in plain words, newest last. */
  steps: string[]
  /** Files it read or changed, newest last. */
  files: string[]
  /** The turn it runs in, so it can be stopped. */
  turnId: string | null
  result: string
}

/** One overview Sonnet wrote: kept for good, listed by day. */
export type SquadReport = {
  id: string
  at: number
  /** Local date, YYYY-MM-DD. */
  day: string
  /** manual = asked for, auto = written when every agent finished, daily = the end-of-day summary. */
  kind: 'manual' | 'auto' | 'daily'
  /** today = from midnight, session = the whole session; absent on older reports (today). */
  scope?: 'today' | 'session'
  text: string
}

/** The band's subagent controls: a model id or 'auto', and effort 0 (auto) to 5 (max). */
export type SquadSubControl = { model: string; effort: number }

/** One rate-limit window as the band shows it. */
export type SquadLimit = { pct: number; resetsAt?: string }

/** The band's budget row: the 5h and weekly limits, and what The Chief saved this session (kept for the session's life). */
export type SquadBudget = {
  five: SquadLimit | null
  week: SquadLimit | null
  /** API-priced dollars this session did not spend because of The Chief's guards (net of the compactions' own cost). */
  savedUsd: number
  /** Context tokens not re-read, summed over every request since the session started. */
  savedTokens: number
  /** Percent of each limit one API-priced dollar uses (calibrated on this machine). */
  fivePerUsd: number
  weekPerUsd: number
  compacts: number
  reads: number
  /** Context tokens the guards' compactions took off, summed over every chat on this computer. */
  trimmedTokens?: number
  /** The chat's context now, and its window. */
  ctxTokens?: number
  ctxWindow?: number
  /** API-priced dollars and tokens this session's requests used (subagents included). */
  spentUsd?: number
  spentTokens?: number
}

export type SquadTab = 'agents' | 'skills' | 'overview' | 'squad' | 'settings' | 'leader' | 'goals' | 'spend' | 'startup' | 'consult' | 'prompts' | 'themes'

declare module 'claude-code' {
  interface PluginState {
    'the-chief': {
      lanes: SquadLane[]
      goals: SquadGoal[]
      workers: SquadWorker[]
      subs: SquadSub[]
      reports: SquadReport[]
      /** True while Sonnet is writing a report. */
      isSummarizing: boolean
      /** The report open in the Overview tab, or null for the latest. */
      openReport: string | null
      tab: SquadTab
      startup: { plugins: { id: string; enabled: boolean; scope: string }[]; skills: { name: string; value: string; source: string }[]; error: string; loaded: boolean }
      /** The agent whose detail is open (a worker or subagent id), or null for the list. */
      selected: string | null
      /** Bumped every few seconds while anything runs, so elapsed times stay live. */
      tick: number
      /** The provider open in Settings, or null for the list. */
      editingProvider: string | null
      /** Providers whose key was saved in this session (secrets are never read back). */
      savedKeys: string[]
      /** The Themes tab's choice, "<scene>:<kind>:<frost 1|0>:<auto seconds>" or "off". */
      themeChoice: string
      /** What every Claude subagent runs on, set from the band above the prompt. */
      subControl: SquadSubControl
      /** The band's budget row. */
      budget: SquadBudget
    }
  }
}
