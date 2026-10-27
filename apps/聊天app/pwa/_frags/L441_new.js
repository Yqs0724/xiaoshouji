async function streamBotReply(write, priorIn, opts) {
  const { chatCompletionStream, parseThinkBody, resolveThinkText } = require(
    "../../共读app/gateway/llm"
  );
  const { readSettings, effectiveDialogue } = require("../../共读app/gateway/settings");
  const {
    MAX_TOOL_ROUNDS,
    runChatTool,
    resolveToolLabel,
    summarizeToolResult,
    getToolBundle,
  } = require("./chat-tools");
  const settings = readSettings();
  const dlg = effectiveDialogue(settings);
  const toolsOn = settings.chat_tools_enabled !== false;
  const toolLabels = settings.chat_tool_labels || {};
  let toolBundle = null;
  if (toolsOn) toolBundle = await getToolBundle(settings);
  const tools = toolBundle && toolBundle.defs.length ? toolBundle.defs : undefined;
  let system = DAILY_SYSTEM_BASE;
  system +=
    "对方可能发贴纸、图片、红包、转账或位置；用一两句口语接住即可。" +
    "不要每条都提表情包，也不要说「我发了贴纸/红包」（贴纸与红包由系统按气氛另发）。";
  if (!toolsOn) {
    system += "\n（工具已关闭：不要声称已查/已改日历，可请对方去日历 App 看。）";
  } else if (toolBundle && toolBundle.mcpMap.size) {
    system += "\n（另有外接 MCP 工具可用，名称见工具表。）";
  } else if (toolBundle && toolBundle.mcpError) {
    system += "\n（外接 MCP 暂不可用：" + String(toolBundle.mcpError).slice(0, 80) + "）";
  }
  const persona = String((dlg && dlg.persona) || "").trim();
  if (persona) system += "\n人设（请遵守语气与关系）：" + persona;
  const nameBot = String((dlg && dlg.name_bot) || "").trim();
  if (nameBot) system += "\n你的显示名：" + nameBot + "。";
  const moodPrompt = opts && opts.moodPrompt ? String(opts.moodPrompt).trim() : "";
  if (moodPrompt) system += "\n" + moodPrompt;