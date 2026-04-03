/**
 * opencode-notifier
 * Run custom shell commands on OpenCode events.
 *
 * Config: ~/.config/opencode/dgronskiy-events-hook.jsonc
 *
 * Supported events:
 *   idle       → session.idle / session.status{idle}
 *   error      → session.error
 *   permission → permission.asked / permission.updated
 *   question   → question.asked / tool.execute.before(question)
 *
 * Commands are spawned fire-and-forget via Bun.spawn().
 * Event data is passed as environment variables:
 *   OPENCODE_EVENT          - event type string
 *   OPENCODE_SESSION_ID     - session ID (session events)
 *   OPENCODE_SESSION_TITLE  - session title (idle only)
 *   OPENCODE_ERROR          - error message (error only)
 *   OPENCODE_PERMISSION_ID  - permission request ID (permission only)
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event, createOpencodeClient } from "@opencode-ai/sdk"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

// ==========================================
// CONFIG
// ==========================================

interface HookConfig {
	/** Also run commands for child/sub-sessions (default: false) */
	notifyChildSessions: boolean
	/** Shell commands to run per event. Omit a key to skip that event. */
	commands: {
		idle?: string
		error?: string
		permission?: string
		question?: string
	}
	/** Suppress all hooks during these hours */
	quietHours: {
		enabled: boolean
		start: string // "HH:MM"
		end: string // "HH:MM"
	}
}

const DEFAULT_CONFIG: HookConfig = {
	notifyChildSessions: false,
	commands: {},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
}

/** Strip // line comments that are not inside strings. */
function stripJsoncComments(text: string): string {
	let result = ""
	let inString = false
	let i = 0

	while (i < text.length) {
		const ch = text[i]

		if (inString) {
			result += ch
			if (ch === "\\" && i + 1 < text.length) {
				i++
				result += text[i]
			} else if (ch === '"') {
				inString = false
			}
			i++
			continue
		}

		if (ch === '"') {
			inString = true
			result += ch
			i++
			continue
		}

		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++
			continue
		}

		result += ch
		i++
	}

	return result
}

async function loadConfig(): Promise<HookConfig> {
	const configPath = path.join(
		os.homedir(),
		".config",
		"opencode",
		"dgronskiy-events-hook.jsonc",
	)

	try {
		const raw = await fs.readFile(configPath, "utf8")
		const userConfig = JSON.parse(stripJsoncComments(raw)) as Partial<HookConfig>

		return {
			...DEFAULT_CONFIG,
			...userConfig,
			commands: { ...DEFAULT_CONFIG.commands, ...userConfig.commands },
			quietHours: { ...DEFAULT_CONFIG.quietHours, ...userConfig.quietHours },
		}
	} catch {
		return DEFAULT_CONFIG
	}
}

// ==========================================
// HELPERS
// ==========================================

function expandHome(cmd: string): string {
	if (cmd.startsWith("~/") || cmd === "~") {
		return path.join(os.homedir(), cmd.slice(2))
	}
	return cmd
}

function isQuietHours(config: HookConfig): boolean {
	if (!config.quietHours.enabled) return false

	const now = new Date()
	const cur = now.getHours() * 60 + now.getMinutes()
	const [sh, sm] = config.quietHours.start.split(":").map(Number)
	const [eh, em] = config.quietHours.end.split(":").map(Number)
	const start = sh * 60 + sm
	const end = eh * 60 + em

	// Handle overnight ranges e.g. 22:00–08:00
	return start > end ? cur >= start || cur < end : cur >= start && cur < end
}

function toStr(value: unknown): string | null {
	if (typeof value !== "string") return null
	const t = value.trim()
	return t || null
}

async function isParentSession(client: OpencodeClient, sessionID: string): Promise<boolean> {
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		return !session.data?.parentID
	} catch {
		return true // safe default: run the command rather than silently skip
	}
}

// ==========================================
// COMMAND RUNNER
// ==========================================

function spawnCommand(cmd: string, extraEnv: Record<string, string>): void {
	const fullEnv: Record<string, string> = {}
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) fullEnv[k] = v
	}
	Object.assign(fullEnv, extraEnv)

	Bun.spawn(["sh", "-c", expandHome(cmd)], {
		env: fullEnv,
		stdout: "ignore",
		stderr: "ignore",
	})
}

// ==========================================
// DEDUPLICATION
// ==========================================

type RecentMap = Map<string, number>
const DEDUPE_MS = 1500

function shouldFire(recent: RecentMap, key: string, now = Date.now()): boolean {
	for (const [k, ts] of recent) {
		if (now - ts >= DEDUPE_MS) recent.delete(k)
	}
	const last = recent.get(key)
	if (last !== undefined && now - last < DEDUPE_MS) return false
	recent.set(key, now)
	return true
}

// ==========================================
// EVENT HANDLERS
// ==========================================

async function handleIdle(
	client: OpencodeClient,
	sessionID: string,
	config: HookConfig,
): Promise<void> {
	const cmd = config.commands.idle
	if (!cmd || isQuietHours(config)) return

	if (!config.notifyChildSessions && !(await isParentSession(client, sessionID))) return

	let title = ""
	try {
		const s = await client.session.get({ path: { id: sessionID } })
		title = s.data?.title ?? ""
	} catch {}

	spawnCommand(cmd, {
		OPENCODE_EVENT: "session.idle",
		OPENCODE_SESSION_ID: sessionID,
		OPENCODE_SESSION_TITLE: title,
	})
}

async function handleError(
	client: OpencodeClient,
	sessionID: string,
	error: string | undefined,
	config: HookConfig,
): Promise<void> {
	const cmd = config.commands.error
	if (!cmd || isQuietHours(config)) return

	if (!config.notifyChildSessions && !(await isParentSession(client, sessionID))) return

	spawnCommand(cmd, {
		OPENCODE_EVENT: "session.error",
		OPENCODE_SESSION_ID: sessionID,
		OPENCODE_ERROR: error ?? "",
	})
}

async function handlePermission(config: HookConfig, permissionID: string): Promise<void> {
	const cmd = config.commands.permission
	if (!cmd || isQuietHours(config)) return

	spawnCommand(cmd, {
		OPENCODE_EVENT: "permission.asked",
		OPENCODE_PERMISSION_ID: permissionID,
	})
}

async function handleQuestion(config: HookConfig): Promise<void> {
	const cmd = config.commands.question
	if (!cmd || isQuietHours(config)) return

	spawnCommand(cmd, { OPENCODE_EVENT: "question.asked" })
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

export const EventsHookPlugin: Plugin = async (ctx) => {
	const { client } = ctx
	const config = await loadConfig()

	const recentIdle: RecentMap = new Map()
	const recentQuestion: RecentMap = new Map()
	const recentPermission: RecentMap = new Map()

	return {
		"tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
			if (input.tool === "question") {
				const key = `question:${input.sessionID}:${input.callID}`
				if (shouldFire(recentQuestion, key)) await handleQuestion(config)
			}
		},

		event: async ({ event }: { event: Event }): Promise<void> => {
			const e = event as { type: string; properties: Record<string, unknown> }

			switch (e.type) {
				case "session.status": {
					const statusObj = e.properties.status
					const statusType =
						statusObj && typeof statusObj === "object"
							? ((statusObj as { type?: string }).type ?? undefined)
							: undefined
					if (statusType === "idle") {
						const id = toStr(e.properties.sessionID)
						if (id && shouldFire(recentIdle, `idle:${id}`))
							await handleIdle(client as OpencodeClient, id, config)
					}
					break
				}

				case "session.idle": {
					const id = toStr(e.properties.sessionID)
					if (id && shouldFire(recentIdle, `idle:${id}`))
						await handleIdle(client as OpencodeClient, id, config)
					break
				}

				case "session.error": {
					const id = toStr(e.properties.sessionID)
					const err = e.properties.error
					const errMsg = typeof err === "string" ? err : err ? String(err) : undefined
					if (id) await handleError(client as OpencodeClient, id, errMsg, config)
					break
				}

				case "permission.asked":
				case "permission.updated": {
					const pid = toStr(e.properties.id) ?? "unknown"
					if (shouldFire(recentPermission, `permission:${pid}`))
						await handlePermission(config, pid)
					break
				}

				case "question.asked": {
					const sid = toStr(e.properties.sessionID) ?? ""
					const tool = e.properties.tool
					const callID = toStr(
						tool && typeof tool === "object" ? (tool as Record<string, unknown>).callID : null,
					)
					const reqID = toStr(e.properties.id)
					const suffix = callID ?? (reqID ? `req:${reqID}` : "unknown")
					const key = `question:${sid}:${suffix}`
					if (shouldFire(recentQuestion, key)) await handleQuestion(config)
					break
				}
			}
		},
	}
}

export default EventsHookPlugin
