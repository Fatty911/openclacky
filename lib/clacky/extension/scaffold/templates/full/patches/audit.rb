# frozen_string_literal: true

# Example monkey-patch. Prepends onto Clacky::Tools::Terminal#execute
# so we get one log line per shell tool invocation.
# In production a patch might enforce a denylist, rewrite arguments,
# or measure timing. Keep the body small and always call `super`.
module ExtSampleAuditPatch
  def execute(*args, **kwargs)
    cmd = kwargs[:command] || args.first
    Clacky::Logger.info("[ext-audit] terminal.execute", command: cmd.to_s[0, 200])
    super
  end
end

Clacky::Tools::Terminal.prepend(ExtSampleAuditPatch)
