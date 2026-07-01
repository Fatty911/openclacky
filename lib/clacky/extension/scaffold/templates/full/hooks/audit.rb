# frozen_string_literal: true

# Hook callbacks contributed by this extension. The block is copied
# onto each agent's HookManager at agent init time. The event name
# comes from ext.yml — no need to repeat it here.
Clacky::ExtensionHookRegistry.add do |tool_name, args|
  Clacky::Logger.debug("[ext-hook] before_tool_use", tool: tool_name)
  { action: :allow }
end
