import type { PluginModule } from "@opencode-ai/plugin"
import { createServerTools, defaultResetPermission } from "./server-tools"

const plugin: PluginModule = {
  id: "opencode-codex-usage",
  server: async () => {
    let permission: unknown
    return {
      tool: createServerTools(undefined, { permission: () => permission }),
      config: async (config) => {
        defaultResetPermission(config)
        permission = config.permission
      },
    }
  },
}

export default plugin
