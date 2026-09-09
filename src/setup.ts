import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL, fileURLToPath } from "node:url"
import { xdgConfig } from "xdg-basedir"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

export function defaultConfigDirectory() {
  return process.env.OPENCODE_CONFIG_DIR ?? path.join(xdgConfig ?? path.join(os.homedir(), ".config"), "opencode")
}

export function parseConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid OpenCode JSON/JSONC configuration. Fix it before running setup.")
  if (value.plugin !== undefined && !Array.isArray(value.plugin))
    throw new Error("The plugin setting must be an array. Configuration was not changed.")
  return value
}

export async function readOptional(file: string) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Configuration could not be read. Check file permissions.")
  }
}

export function isOurEntry(entry: unknown, kind: "tui" | "server", exact?: string) {
  const spec = Array.isArray(entry) ? entry[0] : entry
  if (typeof spec !== "string") return false
  if (spec === exact) return true
  return kind === "tui"
    ? /^opencode-codex-usage(?:@[^/]+)?\/tui$/.test(spec)
    : /^opencode-codex-usage(?:@[^/]+)?(?:\/server)?$/.test(spec)
}

export const localEntry = (kind: "tui" | "server") =>
  pathToFileURL(fileURLToPath(new URL(kind === "tui" ? "./tui.tsx" : "./server.ts", import.meta.url))).href

/** Plan every change first; comments, explicit permissions and unrelated plugins stay intact. */
export async function setup(options: { directory?: string; tui: boolean; server: boolean; dryRun?: boolean }) {
  if (!options.tui && !options.server) throw new Error("Choose --tui, --server, or --both.")
  const directory = path.resolve(options.directory ?? defaultConfigDirectory())
  const plans: { file: string; original?: string; text: string; changed: boolean; backup?: string }[] = []
  for (const kind of ["tui", "server"] as const) {
    if (!options[kind]) continue
    const name = kind === "tui" ? "tui" : "opencode"
    const json = path.join(directory, `${name}.json`)
    const jsonc = path.join(directory, `${name}.jsonc`)
    const [plain, commented] = await Promise.all([readOptional(json), readOptional(jsonc)])
    if (plain !== undefined && commented !== undefined)
      throw new Error(
        `Both ${name}.json and ${name}.jsonc exist. Consolidate them before setup to avoid ambiguous changes.`,
      )
    const file = commented !== undefined ? jsonc : json
    const original = commented ?? plain
    const text = original ?? "{\n}\n"
    const config = parseConfig(text)
    const plugins = config.plugin as unknown[] | undefined
    const entry = localEntry(kind)
    const changed = !plugins?.some((item) => isOurEntry(item, kind, entry))
    const next = changed
      ? applyEdits(
          text,
          modify(text, ["plugin"], [...(plugins ?? []), entry], {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
          }),
        )
      : text
    plans.push({ file, original, text: next, changed })
  }
  if (!options.dryRun) {
    await mkdir(directory, { recursive: true })
    for (const plan of plans.filter((item) => item.changed)) {
      if ((await readOptional(plan.file)) !== plan.original)
        throw new Error("Configuration changed during setup. Run setup again.")
      if (plan.original !== undefined) {
        plan.backup = `${plan.file}.codex-usage-${Date.now()}-${crypto.randomUUID()}.bak`
        await writeFile(plan.backup, plan.original, { flag: "wx", mode: 0o600 })
      }
      const temporary = `${plan.file}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, plan.text, { flag: "wx", mode: 0o600 })
        await rename(temporary, plan.file)
      } finally {
        await unlink(temporary).catch(() => {})
      }
    }
  }
  return plans.map(({ file, changed, backup }) => ({ file, changed, ...(backup ? { backup } : {}) }))
}
