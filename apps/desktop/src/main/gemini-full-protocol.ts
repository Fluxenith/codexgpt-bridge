/** Keep the live capability adjacent to the request, after historical context. */
export function geminiFullTransportReminder(
  connectorName: string,
  turnToken: string | undefined,
): string {
  if (!turnToken || !/^turn_[A-Za-z0-9_-]{35,251}$/u.test(turnToken))
    throw new Error(
      "Full Gemini requires a valid current Codex task capability. No prompt was submitted.",
    );
  return (
    "[Current Full MCP transport]\n" +
    "Use only the connected MCP app " +
    JSON.stringify(connectorName) +
    ". Codex executes its advertised tools with its native approvals.\n" +
    "These are the exact common arguments for EVERY connector call in THIS response:\n" +
    JSON.stringify({ turn_token: turnToken }) +
    "\n" +
    "Copy turn_token verbatim, including the turn_ prefix. Never invent, shorten, omit, or reuse a token from earlier messages or tool output. Previous task tokens are obsolete.\n" +
    "Prefer codex_exec, codex_write_stdin, codex_apply_patch and codex_view_image; use codex_tool_inventory and codex_tool_call for other advertised tools. A pending call is already running: when a tool returns status=pending and operation_id, call codex_wait_tool_result with the SAME turn_token and operation_id until the real result arrives. Never repeat the original action because it is slow or the outer Codex connection resumes. A pending receipt is NOT a final answer or an execution failure. After a successful result, continue from that result and perform only the remaining required work.\n" +
    "Do not print tool-call JSON or Simple protocol frames. Return the final answer as your normal reply after the required actions finish; never use codex_manual_complete for it. Never disclose the capability in an answer.\n" +
    "[/Current Full MCP transport]"
  );
}
