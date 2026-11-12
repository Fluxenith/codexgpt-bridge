/** Read only visible, native Gemini mode controls, never conversation text. */
export function geminiTemporaryChatState(
  elements: readonly Element[],
): "active" | "inactive" | "unavailable" | "ambiguous" {
  const visible = elements.filter(
    (element) =>
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0,
  );
  if (!visible.length) return "unavailable";
  const histories = visible.filter(
    (element) =>
      element.tagName === "INFINITE-SCROLLER" &&
      element.classList.contains("temporary-chat") &&
      !element.closest("model-response,user-query"),
  );
  const buttons = visible.filter((element) => element.tagName === "BUTTON");
  if (histories.length > 1 || buttons.length > 1) return "ambiguous";
  if (!buttons.length) return histories.length === 1 ? "active" : "ambiguous";
  const button = buttons[0]!;
  const active = !!button.closest(".temp-chat-on");
  const icon = button
    .querySelector("mat-icon[fonticon]")
    ?.getAttribute("fonticon");
  if (active && icon === "close") return "active";
  if (!active && icon === "gemini_chat_temp" && !histories.length)
    return "inactive";
  return "ambiguous";
}
