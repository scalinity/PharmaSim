// App shell (SPEC §23): which screen is on top of the game, and the flow
// between them — boot → title → play, Esc → pause → settings → back, and the
// two paths that leave a run (start over, save and quit).
//
// The shell owns the Escape key. While one of its screens is up the game's
// own bindings are inert; when nothing is up, Escape pauses — unless the HUD
// still has a sheet or a build ghost to put away first.

import type { Sim } from "../sim/sim";
import { Modal, type ModalHandle } from "./components/Modal";
import { createToastHost } from "./components/Toast";
import { money } from "./format";
import { createPauseScreen } from "./screens/pause";
import { createSettingsScreen } from "./screens/settings";
import { createTitleScreen, type SaveSummary } from "./screens/title";

/** Every path that touches the stored profile. Each may throw an Error whose
 *  message is written for the player; the shell toasts it as-is. */
export interface ShellPersistence {
  /** True when a file was written, false when the player backed out. */
  exportSave(): Promise<boolean>;
  /** Loads the chosen save into a new session; false when cancelled. */
  importSave(): Promise<boolean>;
  /** Writes over the profile with a fresh run and starts it. */
  startNewGame(): Promise<void>;
  /** Persists the morning snapshot and returns to the title. */
  saveAndQuit(): Promise<void>;
}

export interface ShellDeps {
  sim: Sim;
  persistence: ShellPersistence;
  /** Summary of the save Continue would load, or null when there is none. */
  summary: SaveSummary | null;
  /** Leave the title: hand the HUD back and start playing this state. */
  onPlay(): void;
  /** The HUD closes its own sheets first; true when it consumed Escape. */
  hudDismiss(): boolean;
}

export interface ShellHandle {
  /** Show the title. `notice` toasts a problem found while booting. */
  showTitle(notice?: string | null): void;
  isOpen(): boolean;
}

type ScreenName = "title" | "pause" | "settings";

export function createShell(root: HTMLElement, deps: ShellDeps): ShellHandle {
  const { sim, persistence } = deps;
  const toast = createToastHost(root);

  let current: ScreenName | null = null;
  let settingsFrom: ScreenName = "title";
  let modal: ModalHandle | null = null;
  /** Speed to restore when the pause sheet closes. */
  let resumeSpeed = sim.snapshot.speed;

  const title = createTitleScreen(sim, {
    summary: deps.summary,
    onContinue: () => play(),
    onNewGame: () => askNewGame(),
    onSettings: () => show("settings", "title"),
  });
  const pause = createPauseScreen(sim, {
    onResume: () => resume(),
    onSettings: () => show("settings", "pause"),
    onQuit: () => run(persistence.saveAndQuit()),
  });
  const settings = createSettingsScreen(sim, {
    onExport: () => exportSave(),
    onImport: () => importSave(),
    onDone: () => show(settingsFrom),
  });

  const screens: Record<ScreenName, { root: HTMLElement; focus(): void; sync?(): void }> = {
    title,
    pause,
    settings,
  };
  for (const screen of Object.values(screens)) {
    screen.root.hidden = true;
    root.append(screen.root);
  }

  function show(name: ScreenName, from?: ScreenName): void {
    if (from) settingsFrom = from;
    closeModal();
    for (const [key, screen] of Object.entries(screens)) {
      screen.root.hidden = key !== name;
    }
    const screen = screens[name];
    screen.sync?.();
    current = name;
    screen.focus();
  }

  function hideAll(): void {
    closeModal();
    for (const screen of Object.values(screens)) screen.root.hidden = true;
    current = null;
  }

  function play(): void {
    hideAll();
    deps.onPlay();
  }

  /** Esc pauses for real: the clock stops behind the sheet (§5). */
  function showPause(): void {
    resumeSpeed = sim.snapshot.speed;
    sim.dispatch({ type: "speed.set", speed: 0 });
    show("pause");
  }

  function resume(): void {
    hideAll();
    sim.dispatch({ type: "speed.set", speed: resumeSpeed });
  }

  function closeModal(): void {
    modal?.root.remove();
    modal = null;
  }

  function openModal(next: ModalHandle): void {
    closeModal();
    modal = next;
    root.append(next.root);
    next.focus();
  }

  function askNewGame(): void {
    if (!deps.summary) {
      run(persistence.startNewGame());
      return;
    }
    const { day, cash } = deps.summary;
    openModal(
      Modal({
        title: "Start a new store?",
        body: [
          `Your Old Town run — day ${day}, ${money(cash)} in the till — is written over. There's one save.`,
          "Export it from Settings first if you want to keep it.",
        ],
        confirmLabel: "Start a new store",
        cancelLabel: "Keep my run",
        onConfirm: () => {
          closeModal();
          run(persistence.startNewGame());
        },
        onCancel: () => closeModal(),
      }),
    );
  }

  // Storage failures arrive in three shapes: our own Error from sim/save.ts, a
  // DOMException from a browser that won't hand out localStorage, and a bare
  // string from a Tauri command. All three have something to say.
  function message(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (error !== null && typeof error === "object" && "message" in error) {
      return String((error as { message: unknown }).message);
    }
    return "That didn't work.";
  }

  /** Fire a persistence path and report failures where the player is looking. */
  function run(action: Promise<unknown>): void {
    action.catch((error: unknown) => {
      console.error("[shell] a save action failed", error);
      toast(message(error), "error");
    });
  }

  function exportSave(): void {
    persistence
      .exportSave()
      .then((written) => {
        if (written) toast("Save exported.");
      })
      .catch((error: unknown) => toast(message(error), "error"));
  }

  function importSave(): void {
    run(persistence.importSave());
  }

  function escape(): void {
    if (modal) {
      closeModal();
      return;
    }
    if (current === "settings") {
      show(settingsFrom);
      return;
    }
    if (current === "pause") resume();
  }

  // Capture phase, so this runs before the HUD, picking and the camera rig:
  // while a screen is up their keys never reach them.
  window.addEventListener(
    "keydown",
    (event) => {
      if (current === null) {
        if (event.code === "Escape" && !deps.hudDismiss()) showPause();
        return;
      }
      if (event.code === "Escape") escape();
      event.stopPropagation();
    },
    { capture: true },
  );

  return {
    showTitle: (notice) => {
      show("title");
      if (notice) toast(notice, "error");
    },
    isOpen: () => current !== null,
  };
}
