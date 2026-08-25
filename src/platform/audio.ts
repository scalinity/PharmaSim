// Synthesized soundscape (SPEC §29). Every cue is oscillators + filtered
// noise — no files, no samples, zero IP risk. This layer subscribes to the
// bus the way render/ does: the sim never learns audio exists. The two
// UI-timed moments (paper rustle, the receipt's stamp) come back out through
// the handle main.ts passes to the HUD.
//
// The context can't start without a user gesture, so the whole graph is
// built lazily on the first pointer or key press; every cue before that is
// a silent no-op. Volumes ride GameSettings (§24): master/SFX/ambience
// gains, squared for a perceptual taper. The window losing focus fades the
// master to zero (§29 mute-on-blur) without touching the stored volume.

import type { EventBus } from "../core/bus";
import type { SimEvent } from "../sim/events";
import type { GameSettings } from "../sim/state";

export interface UiCues {
  /** A sheet lands on the counter: dock panels and the printing receipt. */
  rustle(): void;
  /** The receipt's verdict lands — timed by the print animation, so the
   *  thunk collapses to "now" whenever the print does (skip, reduced motion). */
  stamp(): void;
}

/** §30: the ambience murmur tracks the crowd, but never per frame. */
const CROWD_POLL_MS = 400;
/** §7/§30 NPC cap — the murmur's "full room". */
const CROWD_FULL = 40;

/** Per-cue floor between plays, so a rush can't stack one cue into clipping. */
const THROTTLE_MS: Record<string, number> = {
  chime: 150,
  ding: 90,
  rustle: 90,
  rattle: 120,
  thunk: 200,
  alert: 400,
  hum: 1500,
};

export function createGameAudio(
  bus: EventBus<SimEvent>,
  hooks: { crowd(): number; settings(): GameSettings },
): UiCues {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let ambBus: GainNode | null = null;
  let murmurGain: GainNode | null = null;
  let rainGain: GainNode | null = null;
  let whiteBuffer: AudioBuffer | null = null;
  let blurred = !document.hasFocus();
  let rainOn = false;
  const lastPlayed: Record<string, number> = {};

  /** Squared taper: half the slider reads as roughly half the loudness. */
  const taper = (v: number): number => v * v;

  function applyVolumes(settings: GameSettings): void {
    if (!ctx || !master || !sfxBus || !ambBus) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(blurred ? 0 : taper(settings.volume), t, 0.05);
    sfxBus.gain.setTargetAtTime(taper(settings.sfx), t, 0.05);
    ambBus.gain.setTargetAtTime(taper(settings.ambience), t, 0.05);
  }

  function noiseBuffer(context: AudioContext, brown: boolean): AudioBuffer {
    const length = context.sampleRate * 2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        data[i] = white;
      }
    }
    return buffer;
  }

  function loopSource(context: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
    const src = context.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  /** Build the graph and the ambience beds. Runs once, on the first gesture. */
  function unlock(): void {
    if (ctx !== null) {
      if (ctx.state === "suspended") void ctx.resume();
      return;
    }
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.connect(master);
    ambBus = ctx.createGain();
    ambBus.connect(master);

    whiteBuffer = noiseBuffer(ctx, false);
    const brownBuffer = noiseBuffer(ctx, true);

    // Room tone: brown noise low-passed to a faint HVAC-and-street floor.
    const roomFilter = ctx.createBiquadFilter();
    roomFilter.type = "lowpass";
    roomFilter.frequency.value = 300;
    const roomGain = ctx.createGain();
    roomGain.gain.value = 0.05;
    loopSource(ctx, brownBuffer).connect(roomFilter);
    roomFilter.connect(roomGain);
    roomGain.connect(ambBus);

    // Murmur: the same noise band-passed into a voice-ish blur, its level
    // tracking the crowd (poll below) with a slow LFO breathing on top.
    const murmurFilter = ctx.createBiquadFilter();
    murmurFilter.type = "bandpass";
    murmurFilter.frequency.value = 500;
    murmurFilter.Q.value = 0.6;
    murmurGain = ctx.createGain();
    murmurGain.gain.value = 0;
    loopSource(ctx, brownBuffer).connect(murmurFilter);
    murmurFilter.connect(murmurGain);
    murmurGain.connect(ambBus);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.02;
    lfo.connect(lfoDepth);
    lfoDepth.connect(murmurGain.gain);
    lfo.start();

    // Rain bed (§16 storms): white noise shaped into a steady wash, gain 0
    // until the sim says a storm shift opened.
    const rainLow = ctx.createBiquadFilter();
    rainLow.type = "lowpass";
    rainLow.frequency.value = 1800;
    const rainHigh = ctx.createBiquadFilter();
    rainHigh.type = "highpass";
    rainHigh.frequency.value = 300;
    rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    loopSource(ctx, whiteBuffer).connect(rainHigh);
    rainHigh.connect(rainLow);
    rainLow.connect(rainGain);
    rainGain.connect(ambBus);
    if (rainOn) rainGain.gain.setTargetAtTime(0.14, ctx.currentTime, 2);

    applyVolumes(hooks.settings());

    window.setInterval(() => {
      if (!ctx || !murmurGain) return;
      const fill = Math.min(hooks.crowd(), CROWD_FULL) / CROWD_FULL;
      murmurGain.gain.setTargetAtTime(0.16 * Math.sqrt(fill), ctx.currentTime, 0.5);
    }, CROWD_POLL_MS);
  }

  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });

  // §29 mute when the window is unfocused — a fade on the master, so the
  // stored volume and the running beds are untouched.
  window.addEventListener("blur", () => {
    blurred = true;
    applyVolumes(hooks.settings());
  });
  window.addEventListener("focus", () => {
    blurred = false;
    applyVolumes(hooks.settings());
  });

  /** Gate: the context exists, and this cue hasn't just played. */
  function ready(cue: string): boolean {
    if (!ctx || !sfxBus) return false;
    const now = performance.now();
    if (now - (lastPlayed[cue] ?? -Infinity) < (THROTTLE_MS[cue] ?? 0)) return false;
    lastPlayed[cue] = now;
    return true;
  }

  /** One enveloped oscillator note into the SFX bus. */
  function note(
    type: OscillatorType,
    freq: number,
    at: number,
    peak: number,
    attack: number,
    decay: number,
    freqEnd?: number,
  ): void {
    if (!ctx || !sfxBus) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(freqEnd, at + decay);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, at + attack + decay);
    osc.connect(gain);
    gain.connect(sfxBus);
    osc.start(at);
    osc.stop(at + attack + decay + 0.05);
  }

  /** One enveloped, filtered noise burst into the SFX bus. */
  function noiseBurst(
    at: number,
    duration: number,
    peak: number,
    filterType: BiquadFilterType,
    freq: number,
    q = 0.7,
  ): void {
    if (!ctx || !sfxBus || !whiteBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = whiteBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(sfxBus);
    src.start(at, Math.random() * 1.5, duration + 0.05);
    src.stop(at + duration + 0.05);
  }

  // --- The cues (§29) ---

  /** Door chime: two-tone sine, the shop bell over the door. */
  function chime(): void {
    if (!ready("chime") || !ctx) return;
    const t = ctx.currentTime;
    note("sine", 659, t, 0.14, 0.01, 0.3);
    note("sine", 523, t + 0.16, 0.12, 0.01, 0.4);
  }

  /** Register ding: one bright triangle with a short decay. */
  function ding(): void {
    if (!ready("ding") || !ctx) return;
    note("triangle", 1175, ctx.currentTime, 0.16, 0.005, 0.28);
  }

  /** Paper rustle: a filtered noise burst — a sheet laid on the counter. */
  function rustle(): void {
    if (!ready("rustle") || !ctx) return;
    noiseBurst(ctx.currentTime, 0.13, 0.1, "bandpass", 3200, 0.5);
  }

  /** Pill rattle: granular ticks, a bottle shaken over the counting tray. */
  function rattle(): void {
    if (!ready("rattle") || !ctx) return;
    let at = ctx.currentTime;
    for (let i = 0; i < 7; i++) {
      noiseBurst(at, 0.025, 0.09, "highpass", 2500);
      at += 0.028 + Math.random() * 0.022;
    }
  }

  /** Stamp thunk: low sine drop + a felt-pad noise tap. */
  function stamp(): void {
    if (!ready("thunk") || !ctx) return;
    const t = ctx.currentTime;
    note("sine", 110, t, 0.5, 0.005, 0.18, 45);
    noiseBurst(t, 0.06, 0.22, "lowpass", 900);
  }

  /** Soft alert: two gentle descending triangle notes — amber, not alarm. */
  function alert(): void {
    if (!ready("alert") || !ctx) return;
    const t = ctx.currentTime;
    note("triangle", 622, t, 0.09, 0.01, 0.16);
    note("triangle", 466, t + 0.14, 0.09, 0.01, 0.26);
  }

  /** Truck hum: detuned saws under a heavy lowpass, swelling past the door. */
  function hum(): void {
    if (!ready("hum") || !ctx || !sfxBus) return;
    const t = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 140;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.5);
    gain.gain.setValueAtTime(0.12, t + 1.3);
    gain.gain.linearRampToValueAtTime(0, t + 2.5);
    for (const freq of [46, 46.6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + 2.6);
    }
    filter.connect(gain);
    gain.connect(sfxBus);
  }

  // --- The sim side of §29: cues ride the bus, ambience rides state ---

  bus.on("customer.spawned", chime);
  bus.on("sale.completed", ding);
  bus.on("rx.pickedUp", ding);
  bus.on("rx.binPicked", rattle);
  bus.on("rx.stageChanged", (e) => {
    if (e.stage === "filling") rattle(); // staff and dispenser fills churn too
  });
  bus.on("truck.arrived", hum);
  bus.on("shortage.started", alert);
  bus.on("reorder.unlocked", alert);
  bus.on("vaccine.noDose", alert);
  bus.on("coldchain.spoiled", alert);
  bus.on("rx.errorDispensed", alert);
  bus.on("rx.refused", alert);
  bus.on("outage.changed", (e) => {
    if (e.on) alert();
  });
  bus.on("ambience.rain", (e) => {
    rainOn = e.on;
    if (ctx && rainGain) rainGain.gain.setTargetAtTime(e.on ? 0.14 : 0, ctx.currentTime, 2);
  });
  bus.on("settings.changed", (e) => applyVolumes(e.settings));

  return { rustle, stamp };
}
