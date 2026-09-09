import { ResetJournal } from "../src/journal"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TuiDialogAlertProps, TuiDialogSelectProps, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { runtimeModules } from "@opentui/keymap/runtime-modules"
import { CodexClient } from "../src/api"
import { accountRef } from "../src/auth"
import { createUsageController } from "../src/usage"
import { credential, deferred, events, inventoryPayload, until, usagePayload } from "./fixtures"

ensureRuntimePluginSupport({ additional: runtimeModules })
const { createResetDialog } = await import("../src/reset-dialog")

test("new TUI instance offers the saved retry even if the current banked balance is zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-dialog-"))
  const filename = path.join(directory, "resets.sqlite")
  let journal = new ResetJournal(filename)
  let screen = ui()
  let count = 2
  const bodies: string[] = []
  const client = () =>
    new CodexClient({
      journal,
      loadAuth: async () => credential(),
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          bodies.push(String(init.body))
          if (bodies.length === 1) throw new Error("response lost")
          return Response.json({ code: "already_redeemed" })
        }
        return Response.json(String(url).endsWith("/usage") ? usagePayload(40, count) : inventoryPayload(count))
      },
    })
  let controller = createUsageController(screen.api, { client: client(), background: false })
  let dialogs = createResetDialog(screen.api, controller)
  try {
    await controller.ready
    await dialogs.open()
    screen.choose("Full reset")
    screen.choose("Yes, use reset")
    await until(() => screen.view()?.props.title === "Could not confirm the reset outcome")
    dialogs.dispose()
    controller.dispose()
    journal.close()
    count = 0
    journal = new ResetJournal(filename)
    screen = ui()
    controller = createUsageController(screen.api, { client: client(), background: false })
    dialogs = createResetDialog(screen.api, controller)
    await controller.ready
    await dialogs.open()
    expect(screen.view()?.props.title).toBe("Could not confirm the reset outcome")
    expect(bodies.length).toBe(1)
    screen.choose("Retry the same attempt")
    await until(() => screen.view()?.kind === "alert")
    expect(bodies[1]).toBe(bodies[0])
  } finally {
    dialogs.dispose()
    controller.dispose()
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

function ui() {
  let view:
    | { kind: "select"; props: TuiDialogSelectProps<unknown> }
    | { kind: "alert"; props: TuiDialogAlertProps }
    | undefined
  let onClose: (() => void) | undefined
  const api = {
    event: events,
    ui: {
      DialogSelect: (props: TuiDialogSelectProps<unknown>) => {
        view = { kind: "select", props }
        return null
      },
      DialogAlert: (props: TuiDialogAlertProps) => {
        view = { kind: "alert", props }
        return null
      },
      toast: () => {},
      dialog: {
        replace(render: () => unknown, close?: () => void) {
          onClose?.()
          onClose = close
          render()
        },
        clear() {
          const close = onClose
          onClose = undefined
          view = undefined
          close?.()
        },
      },
    },
  } as unknown as TuiPluginApi
  return {
    api,
    view: () => view,
    choose(title: string) {
      if (view?.kind !== "select") throw new Error("Expected selection view")
      const option = view.props.options.find((item) => item.title === title)
      if (!option) throw new Error(`Missing option: ${title}`)
      view.props.onSelect?.(option)
    },
  }
}

test("TUI confirmation defaults to cancel and rejects a login change before posting", async () => {
  let auth = credential("A")
  let posts = 0
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        posts++
        return Response.json({ code: "reset" })
      }
      return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
    },
  })
  const screen = ui()
  const controller = createUsageController(screen.api, { client, background: false })
  const dialogs = createResetDialog(screen.api, controller)
  try {
    await controller.ready
    await dialogs.open()
    screen.choose("Full reset")
    const view = screen.view()
    expect(view?.kind === "select" && view.props.current).toBe("cancel")
    auth = credential("B")
    screen.choose("Yes, use reset")
    await until(() => controller.accountKey() === accountRef(auth).key)
    expect(posts).toBe(0)
    expect(screen.view()).toBeUndefined()
  } finally {
    dialogs.dispose()
    controller.dispose()
  }
})

test("TUI retries preserve the exact request and idempotent success does not claim another credit", async () => {
  const bodies: string[] = []
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        bodies.push(String(init.body))
        if (bodies.length === 1) throw new Error("connection lost")
        return Response.json({ code: "already_redeemed" })
      }
      return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
    },
  })
  const screen = ui()
  const controller = createUsageController(screen.api, { client, background: false })
  const dialogs = createResetDialog(screen.api, controller)
  try {
    await controller.ready
    await dialogs.open()
    screen.choose("Full reset")
    screen.choose("Yes, use reset")
    await until(() => screen.view()?.props.title === "Could not confirm the reset outcome")
    screen.choose("Close")
    await dialogs.open()
    expect(screen.view()?.props.title).toBe("Could not confirm the reset outcome")
    screen.choose("Retry the same attempt")
    await until(() => screen.view()?.kind === "alert")
    expect(bodies.length).toBe(2)
    expect(bodies[1]).toBe(bodies[0])
    const result = screen.view()
    expect(result?.kind === "alert" && result.props.message).toContain("No additional credit was consumed")
  } finally {
    dialogs.dispose()
    controller.dispose()
  }
})

test("TUI failed inventory stays unknown and offers refresh instead of claiming zero", async () => {
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url) =>
      String(url).endsWith("/usage")
        ? Response.json({ plan_type: "plus", rate_limit: null })
        : new Response(null, { status: 503 }),
  })
  const screen = ui()
  const controller = createUsageController(screen.api, { client, background: false })
  const dialogs = createResetDialog(screen.api, controller)
  try {
    await controller.ready
    await dialogs.open()
    expect(screen.view()?.props.title).toBe("Could not check Codex usage")
    expect(JSON.stringify(screen.view())).not.toContain("No banked")
  } finally {
    dialogs.dispose()
    controller.dispose()
  }
})

test("closing a loading dialog prevents an old response from reopening it", async () => {
  const response = deferred<Response>()
  let gets = 0
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url) => {
      if (!String(url).endsWith("/usage")) return Response.json(inventoryPayload())
      gets++
      return gets === 2 ? response.promise : Response.json(usagePayload())
    },
  })
  const screen = ui()
  const controller = createUsageController(screen.api, { client, background: false })
  const dialogs = createResetDialog(screen.api, controller)
  try {
    await controller.ready
    const opening = dialogs.open()
    await until(() => gets === 2)
    screen.api.ui.dialog.clear()
    response.resolve(Response.json(usagePayload()))
    await opening
    expect(screen.view()).toBeUndefined()
  } finally {
    response.resolve(Response.json(usagePayload()))
    dialogs.dispose()
    controller.dispose()
  }
})

test("usage dialog exposes each additional bucket with its own windows", async () => {
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url) =>
      Response.json(
        String(url).endsWith("/usage")
          ? {
              ...usagePayload(),
              additional_rate_limits: [
                { metered_feature: "separate", limit_name: "Separate quota", rate_limit: usagePayload(75).rate_limit },
              ],
            }
          : inventoryPayload(),
      ),
  })
  const screen = ui()
  const controller = createUsageController(screen.api, { client, background: false })
  const dialogs = createResetDialog(screen.api, controller)
  try {
    await controller.ready
    await dialogs.openUsage()
    const view = screen.view()
    expect(view?.kind === "alert" && view.props.message).toContain("Separate quota: 5h 25% left")
  } finally {
    dialogs.dispose()
    controller.dispose()
  }
})
