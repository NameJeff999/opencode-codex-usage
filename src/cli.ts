#!/usr/bin/env bun
import { setup } from "./setup"
import { doctor, doctorText } from "./doctor"

const args = process.argv.slice(2).filter((arg) => arg !== "--")
const command = args.shift()
function value(flag: string) {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const result = args[index + 1]
  if (!result || result.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  args.splice(index, 2)
  return result
}
try {
  const directory = value("--config-dir")
  const version = value("--opencode-version")
  const allowed = command === "setup" ? ["--tui", "--server", "--both", "--dry-run"] : ["--offline", "--json"]
  if (args.some((arg) => !allowed.includes(arg))) throw new Error("Unknown option. Run without arguments for usage.")
  if (command === "setup") {
    const plans = await setup({
      directory,
      tui: args.includes("--tui") || args.includes("--both"),
      server: args.includes("--server") || args.includes("--both"),
      dryRun: args.includes("--dry-run"),
    })
    for (const plan of plans)
      console.log(
        `${plan.changed ? (args.includes("--dry-run") ? "Would update" : "Updated") : "Already configured"}: ${plan.file}${plan.backup ? `\nBackup: ${plan.backup}` : ""}`,
      )
    console.log("Restart OpenCode to load configuration changes. Explicit permission policies were preserved.")
  } else if (command === "doctor") {
    const report = await doctor({ configDirectory: directory, offline: args.includes("--offline"), version })
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : doctorText(report))
    process.exitCode = report.ok ? 0 : 1
  } else {
    console.log(
      "Usage: bun src/cli.ts setup --tui|--server|--both [--config-dir DIR] [--dry-run]\n       bun src/cli.ts doctor [--offline] [--json] [--config-dir DIR] [--opencode-version VERSION]",
    )
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed.")
  process.exitCode = 1
}
