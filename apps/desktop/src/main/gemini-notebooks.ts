/** Gemini notebooks group conversations under /notebook/<uuid>. */
const NOTEBOOK_PATH =
  /^\/notebook\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

export function geminiNotebookId(value: string): string | undefined {
  try {
    const url = new URL(value, "https://gemini.google.com");
    return url.origin === "https://gemini.google.com"
      ? NOTEBOOK_PATH.exec(url.pathname)?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}

export function geminiNotebookUrl(id: string): string {
  if (!geminiNotebookId(`/notebook/${id}`))
    throw new Error("Invalid Gemini notebook id.");
  return `https://gemini.google.com/notebook/${id}?hl=en`;
}

const sameName = (a: string, b: string): boolean =>
  a.replace(/\s+/gu, " ").trim() === b.replace(/\s+/gu, " ").trim();

/** Pick the one sidebar notebook with this exact name; never guess between two. */
export function matchGeminiNotebook(
  links: readonly { readonly href: string; readonly name: string }[],
  name: string,
): string | undefined {
  const ids = new Set(
    links.flatMap((link) => {
      const id = geminiNotebookId(link.href);
      return id && sameName(link.name, name) ? [id] : [];
    }),
  );
  if (ids.size > 1)
    throw new Error(
      `Gemini has more than one notebook named "${name}". Rename one so Bridge can choose safely. No prompt was submitted.`,
    );
  return [...ids][0];
}

/** Codex project names become notebook names; keep them within Gemini's field. */
export function geminiNotebookName(projectName: string): string {
  const name = projectName.replace(/\s+/gu, " ").trim();
  if (!name || name.length > 100)
    throw new Error(
      "The Codex project name cannot be used as a Gemini notebook name. No prompt was submitted.",
    );
  return name;
}
