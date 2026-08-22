// Save I/O (SPEC §23). Every byte in or out of the game lives in this file:
// `sim/save.ts` makes plain objects and validates them, this moves them.
//
// One autosave profile, two backends chosen at startup: the Tauri app writes
// app-data `saves/profile.json` and uses native file dialogs; the browser dev
// loop uses localStorage plus a blob download and a file input. The Tauri
// modules are lazy-imported so the browser bundle never loads them.
//
// The parsed-JSON side of the interface is typed `unknown` rather than §23's
// `SaveFile`: nothing here has looked at the contents. Run it through
// `migrate()` before you believe a word of it.

import type { SaveFile } from "../sim/save";

export interface Storage {
  /** Stored profile as parsed JSON, or null when there is no save yet. */
  load(): Promise<unknown>;
  save(file: SaveFile): Promise<void>;
  /** Write the stored profile out for the player to keep. Resolves false when
   *  they backed out of the dialog, so the toast can't claim a file exists. */
  exportFile(): Promise<boolean>;
  /** Ask for a save file; null when the player cancelled. */
  importFile(): Promise<unknown>;
}

const STORAGE_KEY = "pharmasim.save.v1";
const TAURI_PATH = "saves/profile.json";
const TAURI_DIR = "saves";

const NOTHING_TO_EXPORT = "There's no save to export yet — start a store first.";
const NOT_JSON = "That file isn't a PharmaSim save — it isn't even JSON.";
const SAVE_FILTER = { name: "PharmaSim save", extensions: ["json"] };

/** `pharmasim-day-3.json`, so a folder of exports sorts into a run history. */
function exportName(text: string): string {
  let day = 0;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as Record<string, unknown>).day;
      if (typeof value === "number") day = value;
    }
  } catch {
    // A corrupt save can still be exported — that is how you get it looked at.
  }
  return day > 0 ? `pharmasim-day-${day}.json` : "pharmasim-save.json";
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(NOT_JSON);
  }
}

class LocalStorageStorage implements Storage {
  async load(): Promise<unknown> {
    const text = window.localStorage.getItem(STORAGE_KEY);
    return text === null ? null : parse(text);
  }

  async save(file: SaveFile): Promise<void> {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  }

  async exportFile(): Promise<boolean> {
    const text = window.localStorage.getItem(STORAGE_KEY);
    if (text === null) throw new Error(NOTHING_TO_EXPORT);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportName(text);
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  importFile(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("cancel", () => resolve(null));
      input.addEventListener("change", () => {
        const chosen = input.files?.[0];
        if (!chosen) {
          resolve(null);
          return;
        }
        chosen
          .text()
          .then((text) => resolve(parse(text)))
          .catch(reject);
      });
      input.click();
    });
  }
}

class TauriFsStorage implements Storage {
  async load(): Promise<unknown> {
    const { BaseDirectory, exists, readTextFile } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(TAURI_PATH, { baseDir: BaseDirectory.AppData }))) return null;
    return parse(await readTextFile(TAURI_PATH, { baseDir: BaseDirectory.AppData }));
  }

  async save(file: SaveFile): Promise<void> {
    const { BaseDirectory, mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
    await mkdir(TAURI_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeTextFile(TAURI_PATH, JSON.stringify(file), { baseDir: BaseDirectory.AppData });
  }

  async exportFile(): Promise<boolean> {
    const { BaseDirectory, exists, readTextFile, writeTextFile } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists(TAURI_PATH, { baseDir: BaseDirectory.AppData }))) {
      throw new Error(NOTHING_TO_EXPORT);
    }
    const text = await readTextFile(TAURI_PATH, { baseDir: BaseDirectory.AppData });
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: exportName(text), filters: [SAVE_FILTER] });
    if (path === null) return false;
    await writeTextFile(path, text);
    return true;
  }

  async importFile(): Promise<unknown> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters: [SAVE_FILTER] });
    if (typeof path !== "string") return null;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return parse(await readTextFile(path));
  }
}

/** Tauri v2 injects `__TAURI_INTERNALS__`; `__TAURI__` appears with the
 *  global-API option. Either means we are inside the app shell (§23). */
function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

export function createStorage(): Storage {
  return inTauri() ? new TauriFsStorage() : new LocalStorageStorage();
}
