# frozen_string_literal: true

module Clacky
  class Agent
    module FakeToolCallDetector
      FAKE_TOOL_CALL_PATTERNS = [
        /<\s*invoke\s+name\s*=\s*["'][\w\-]+["']/i,
        /<\s*function_calls\s*>/i,
        /<\s*tool_use\s*[\s>]/i,
        /<\s*antml:invoke\s+name\s*=/i,
        /<\s*antml:function_calls\s*>/i
      ].freeze

      MAX_FAKE_TOOL_CALL_RETRIES = 2

      private def fake_tool_call_in_content?(content)
        return false if content.nil? || content.empty?
        FAKE_TOOL_CALL_PATTERNS.any? { |re| content.match?(re) }
      end

      private def handle_fake_tool_call(response)
        @task_fake_tool_call_count = (@task_fake_tool_call_count || 0) + 1

        Clacky::Logger.warn("agent.fake_tool_call_detected",
          session_id: @session_id,
          iteration: @iterations,
          retry_count: @task_fake_tool_call_count,
          content_head: response[:content].to_s[0, 200],
          finish_reason: response[:finish_reason].to_s
        )

        if @task_fake_tool_call_count > MAX_FAKE_TOOL_CALL_RETRIES
          @ui&.show_error("Model repeatedly emitted text-formatted tool calls instead of using the tool_calls API. Stopping.")
          emit_assistant_message(response[:content], reasoning_content: response[:reasoning_content]) if response[:content] && !response[:content].empty?
          return :stop
        end

        @history.append({ role: "assistant", content: response[:content].to_s })
        @history.append({
          role: "user",
          content: "Your previous reply contained tool-call XML written as text " \
                   "(e.g. `<invoke name=\"...\">`). That syntax is NOT executed — " \
                   "it was rendered to the user as raw text. " \
                   "Re-issue the call using the structured tool_calls field provided by the runtime, " \
                   "or, if no tool is needed, just answer normally.",
          system_injected: true
        })
        :retry
      end
    end
  end
end
