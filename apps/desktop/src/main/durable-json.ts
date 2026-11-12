import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function renameWithSharingRetry(
  source: string,
  destination: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const remainingMs = deadline - Date.now();
      if (
        process.platform !== "win32" ||
        remainingMs <= 0 ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      await delay(Math.min(20 * (attempt + 1), 200, remainingMs));
    }
  }
}

/** Callers serialize writes. Flush the new state and retain the previous valid JSON. */
export async function writeDurableJson(
  file: string,
  text: string,
): Promise<void> {
  JSON.parse(text);
  await mkdir(dirname(file), { recursive: true });
  let previous: string | undefined;
  try {
    previous = await readFile(file, "utf8");
    JSON.parse(previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const backup = `${file}.previous`;
  const backupTemporary = `${backup}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (previous !== undefined) {
      await writeFile(backupTemporary, previous, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await renameWithSharingRetry(backupTemporary, backup);
    }
    await renameWithSharingRetry(temporary, file);
  } finally {
    await rm(temporary, { force: true });
    await rm(backupTemporary, { force: true });
  }
}
