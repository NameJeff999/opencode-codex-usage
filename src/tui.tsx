/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, Show } from "solid-js"
import { formatCompactWindow, remainingPercent, resetCountLabel } from "./format"
import { createResetDialog } from "./reset-dialog"
import { createUsageController, type UsageController } from "./usage"

function UsageStatus(props: {
  ctx: TuiSlotContext
  controller: UsageController
  openUsage: () => void
  openResets: () => void
}) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))
  const snapshot = () => props.controller.snapshot()
  const color = () => {
    if (props.controller.error()) return props.ctx.theme.current.warning
    const windows =
      snapshot()
        ?.usage.buckets.flatMap((bucket) => [bucket.primary, bucket.secondary])
        .filter((value) => !!value) ?? []
    return windows.some((window) => remainingPercent(window!) <= 10)
      ? props.ctx.theme.current.error
      : props.ctx.theme.current.textMuted
  }
  const label = () => {
    if (props.controller.account().status === "expired") return "Codex account · login refresh needed"
    if (props.controller.stale()) return "Codex account · stale — refresh failed"
    const value = snapshot()
    if (!value) return props.controller.error() ? "Codex account · usage unavailable" : "Codex account · loading…"
    const main = value.usage.buckets.find((bucket) => bucket.id === "codex")
    const windows = [main?.primary, main?.secondary]
      .filter((window) => !!window)
      .map((window, index) => formatCompactWindow(window!, index ? "secondary" : "primary", now()))
    const extra = value.usage.buckets.filter((bucket) => bucket.id !== "codex").length
    return `Codex account · ${windows.join(" · ") || "usage details"}${extra ? ` · +${extra} quota${extra === 1 ? "" : "s"}` : ""}`
  }
  return (
    <Show when={props.controller.hasOAuth()}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={color()} onMouseUp={() => props.openUsage()}>
          {label()}
        </text>
        <Show when={!props.controller.stale() && snapshot()}>
          <text fg={props.ctx.theme.current.accent} onMouseUp={() => props.openResets()}>
            {snapshot()?.resets ? resetCountLabel(snapshot()!.resets!.availableCount) : "resets unavailable"}
          </text>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const controller = createUsageController(api)
  const dialogs = createResetDialog(api, controller)
  api.lifecycle.onDispose(() => {
    dialogs.dispose()
    controller.dispose()
  })
  api.keymap.registerLayer({
    commands: [
      {
        name: "codex.doctor",
        title: "Diagnose Codex usage setup",
        category: "Codex",
        namespace: "palette",
        slashName: "codex-doctor",
        run: () => {
          void dialogs.openDoctor()
        },
      },
      {
        name: "codex.reset",
        title: "Use a banked Codex reset",
        category: "Codex",
        namespace: "palette",
        slashName: "codex-reset",
        run: () => {
          void dialogs.open()
        },
      },
      {
        name: "codex.usage",
        title: "Show Codex account usage",
        category: "Codex",
        namespace: "palette",
        slashName: "codex-usage",
        run: () => {
          void dialogs.openUsage()
        },
      },
    ],
  })
  const render = (ctx: TuiSlotContext) => (
    <UsageStatus ctx={ctx} controller={controller} openUsage={dialogs.openUsage} openResets={dialogs.open} />
  )
  api.slots.register({ order: 100, slots: { home_prompt_right: render, session_prompt_right: render } })
  // Registration does not wait on the network; lifecycle cleanup is installed immediately.
}

const plugin: TuiPluginModule = { id: "opencode-codex-usage", tui }
export default plugin
