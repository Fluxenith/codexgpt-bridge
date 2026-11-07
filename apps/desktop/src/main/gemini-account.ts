/** Runs in the page realm; account roles and hidden menu copies vary. */
export function geminiAccountEmails(
  elements: Element[],
  includeHidden = false,
): string[] {
  const emails = new Set<string>();
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    if (!includeHidden && (bounds.width <= 0 || bounds.height <= 0)) continue;
    const href = element.getAttribute("href");
    if (!href) continue;
    let destination: URL;
    try {
      destination = new URL(href);
    } catch {
      continue;
    }
    if (
      destination.origin !== "https://accounts.google.com" ||
      destination.pathname !== "/SignOutOptions"
    )
      continue;
    const email = element
      .getAttribute("aria-label")
      ?.match(/[^\s()]+@[^\s()]+/u)?.[0];
    if (email) emails.add(email.toLowerCase());
  }
  return [...emails];
}
