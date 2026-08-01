/**
 * Звук заезда. Полностью процедурный: ни одного сэмпла, ни одного запроса —
 * всё, что слышно, синтезируется в WebAudio прямо в браузере.
 *
 * Устройство:
 *   - непрерывные слои (двигатель, ветер, шины, реактивная струя нитро, пад)
 *     строятся один раз и потом только меняют параметры через `setTargetAtTime`;
 *   - разовые звуки (near-miss, звезда, удар) создают свои узлы, живут доли
 *     секунды и обязаны сами себя отключить в `onended`, иначе за десять минут
 *     заезда граф вырастает в тысячи мёртвых нод;
 *   - контекст не создаётся до первого `resume()` — политика автоплея. До этого
 *     `update()` стоит один `if` и выходит.
 *
 * Ощущение скорости даёт не громкость, а **коробка передач**: об/мин ползут
 * вверх внутри передачи и падают на переключении. Без этого разгон звучит как
 * сирена, а не как машина.
 */

import type { Game, GameEvent } from "./types";
import { PHYS, ROAD } from "./config";
import { offPavement } from "./road";
import { clamp, clamp01, damp, lerp } from "./num";
import { mulberry32 } from "./rng";

/* ---------- контракт ---------- */

export interface RideAudio {
  /** Создаёт/возобновляет AudioContext. Звать можно сколько угодно, но обязательно из жеста пользователя. */
  resume(): Promise<void>;
  setMuted(m: boolean): void;
  /** Кадровое обновление: следит за скоростью и разбирает события. */
  update(g: Game, dt: number): void;
  dispose(): void;
}

/* ---------- константы синтеза ---------- */

const MASTER = 0.85;
/** Длительность рампы при mute, с. Резкая запись .value даёт щелчок. */
const MUTE_RAMP = 0.08;

/** Параметры пишутся не каждый кадр, а 30 раз в секунду: слух разницы не слышит. */
const PARAM_TICK = 1 / 30;

/**
 * Границы передач по доле от максимальной скорости. Низшие короткие, высшие
 * длинные — как в настоящей коробке, поэтому на старте переключения частые.
 */
const GEAR_EDGES = [0, 0.1, 0.22, 0.37, 0.55, 0.76, 1] as const;
const GEAR_TOP = GEAR_EDGES.length - 2;
/** Гистерезис, чтобы на границе передача не дребезжала. */
const GEAR_HYST = 0.012;
/** Сколько длится «сброс газа» на переключении, с. */
const SHIFT_TIME = 0.13;

/** Am – F – C – G, по одному аккорду на 4 секунды. Ноты в MIDI. */
const CHORDS: readonly (readonly [number, number, number])[] = [
  [45, 60, 64],
  [41, 57, 60],
  [48, 55, 64],
  [43, 59, 62],
];
const CHORD_DUR = 4;
/** Насколько вперёд планируем пад. Больше 2 с планировать нельзя — расписание застынет. */
const PAD_LOOKAHEAD = 1.5;

/** Ступени арпеджио звезды, полутоны. */
const ARP = [0, 4, 7, 12] as const;

/* Слоты кэша последних записанных значений — чтобы не спамить автоматизацию. */
const P_ENG_F = 0;
const P_ENG_CUT = 1;
const P_ENG_G = 2;
const P_DETUNE = 3;
const P_WIND_F = 4;
const P_WIND_G = 5;
const P_TYRE_F = 6;
const P_TYRE_G = 7;
const P_JET_G = 8;
const P_PAD_G = 9;
const P_FX_G = 10;
const P_COUNT = 11;

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

type AudioCtor = new (options?: AudioContextOptions) => AudioContext;

/** Конструктор контекста или null, если браузер его не даёт (тогда просто тишина). */
function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Долгоживущие узлы графа. Собираются один раз в `build()`. */
interface Nodes {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** Шина разовых звуков: одна ручка, чтобы приглушить всё при reduced-motion. */
  fx: GainNode;
  noise: AudioBuffer;

  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sub: OscillatorNode;
  engFilter: BiquadFilterNode;
  engGain: GainNode;

  windFilter: BiquadFilterNode;
  windGain: GainNode;
  tyreFilter: BiquadFilterNode;
  tyreGain: GainNode;
  jetGain: GainNode;

  padBus: GainNode;
  padFilter: BiquadFilterNode;
  padGain: GainNode;
}

export function createAudio(): RideAudio {
  let nx: Nodes | null = null;
  /** Контекст недоступен или упал при сборке — деградируем в тишину, а не в исключение. */
  let dead = false;
  let disposed = false;
  let muted = false;

  /* --- бюджет разовых голосов --- */
  let voices = 0;
  let maxVoices = 8;
  /** Всё, что было запущено: и петли, и разовые. Нужно, чтобы `dispose()` всё остановил. */
  const live = new Set<AudioScheduledSourceNode>();

  /* --- состояние симуляции --- */
  let gear = 0;
  let rpm = 0.2;
  let shiftT = 0;
  let paramAcc = 0;
  let nextChord = 0;
  let chordIx = 0;
  let lastScrape = -1;

  const last = new Float64Array(P_COUNT).fill(Number.NaN);

  /** Значение изменилось настолько, что его стоит записать в автоматизацию? */
  function changed(slot: number, v: number, eps: number): boolean {
    if (Math.abs(v - last[slot]) < eps) return false;
    last[slot] = v;
    return true;
  }

  /* ---------- сборка графа ---------- */

  function build(): Nodes | null {
    if (dead || disposed) return null;
    const Ctor = audioCtor();
    if (!Ctor) {
      dead = true;
      return null;
    }
    try {
      const ctx = new Ctor();

      // Мастер → мягкий лимитер → выход. Лимитер держит сумму слоёв в рамках,
      // когда на удар накладываются арпеджио и пад.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -9;
      limiter.knee.value = 8;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      limiter.connect(ctx.destination);

      const master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER;
      master.connect(limiter);

      const fx = ctx.createGain();
      fx.gain.value = 1;
      fx.connect(master);

      // Две секунды белого шума — общий источник для ветра, шин, струи и всех
      // всплесков. Детерминированный поток, чтобы шум был один и тот же всегда.
      const len = Math.max(1, Math.floor(ctx.sampleRate * 2));
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      const rnd = mulberry32(0x51ee12);
      for (let i = 0; i < len; i++) data[i] = rnd() * 2 - 1;

      /* --- двигатель: две расстроенные пилы + суб-синус через lowpass --- */
      const engGain = ctx.createGain();
      engGain.gain.value = 0.0001;
      engGain.connect(master);

      const engFilter = ctx.createBiquadFilter();
      engFilter.type = "lowpass";
      engFilter.frequency.value = 300;
      engFilter.Q.value = 3.2;
      engFilter.connect(engGain);

      const oscA = ctx.createOscillator();
      oscA.type = "sawtooth";
      oscA.frequency.value = 60;
      const gA = ctx.createGain();
      gA.gain.value = 0.5;
      oscA.connect(gA).connect(engFilter);

      const oscB = ctx.createOscillator();
      oscB.type = "sawtooth";
      oscB.frequency.value = 60;
      oscB.detune.value = 12;
      const gB = ctx.createGain();
      gB.gain.value = 0.42;
      oscB.connect(gB).connect(engFilter);

      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.value = 30;
      const gS = ctx.createGain();
      gS.gain.value = 0.6;
      sub.connect(gS).connect(engFilter);

      /* --- ветер --- */
      const windGain = ctx.createGain();
      windGain.gain.value = 0.0001;
      windGain.connect(master);
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = "bandpass";
      windFilter.frequency.value = 700;
      windFilter.Q.value = 0.6;
      windFilter.connect(windGain);
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = noise;
      windSrc.loop = true;
      windSrc.connect(windFilter);

      /* --- шины: lowpass открывается, когда съехали с полотна --- */
      const tyreGain = ctx.createGain();
      tyreGain.gain.value = 0.0001;
      tyreGain.connect(master);
      const tyreFilter = ctx.createBiquadFilter();
      tyreFilter.type = "lowpass";
      tyreFilter.frequency.value = 420;
      tyreFilter.Q.value = 0.9;
      tyreFilter.connect(tyreGain);
      const tyreSrc = ctx.createBufferSource();
      tyreSrc.buffer = noise;
      tyreSrc.loop = true;
      // Другая скорость чтения — иначе шины и ветер сливаются в один коррелированный шум.
      tyreSrc.playbackRate.value = 0.83;
      tyreSrc.connect(tyreFilter);

      /* --- реактивная струя нитро --- */
      const jetGain = ctx.createGain();
      jetGain.gain.value = 0.0001;
      jetGain.connect(master);
      const jetFilter = ctx.createBiquadFilter();
      jetFilter.type = "bandpass";
      jetFilter.frequency.value = 2300;
      jetFilter.Q.value = 0.85;
      jetFilter.connect(jetGain);
      const jetSrc = ctx.createBufferSource();
      jetSrc.buffer = noise;
      jetSrc.loop = true;
      jetSrc.playbackRate.value = 1.37;
      jetSrc.connect(jetFilter);

      /* --- synthwave-пад: общий lowpass с медленным LFO --- */
      const padGain = ctx.createGain();
      padGain.gain.value = 0.0001;
      padGain.connect(master);
      const padFilter = ctx.createBiquadFilter();
      padFilter.type = "lowpass";
      padFilter.frequency.value = 720;
      padFilter.Q.value = 1.4;
      padFilter.connect(padGain);
      const padBus = ctx.createGain();
      padBus.gain.value = 0.34;
      padBus.connect(padFilter);

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.085;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = 340;
      lfo.connect(lfoAmt).connect(padFilter.frequency);

      const t0 = ctx.currentTime;
      oscA.start(t0);
      oscB.start(t0);
      sub.start(t0);
      lfo.start(t0);
      windSrc.start(t0, 0);
      tyreSrc.start(t0, 0.41);
      jetSrc.start(t0, 1.13);
      live.add(oscA);
      live.add(oscB);
      live.add(sub);
      live.add(lfo);
      live.add(windSrc);
      live.add(tyreSrc);
      live.add(jetSrc);

      nextChord = t0 + 0.25;
      chordIx = 0;

      nx = {
        ctx,
        master,
        limiter,
        fx,
        noise,
        oscA,
        oscB,
        sub,
        engFilter,
        engGain,
        windFilter,
        windGain,
        tyreFilter,
        tyreGain,
        jetGain,
        padBus,
        padFilter,
        padGain,
      };
      return nx;
    } catch {
      // Контекст не поднялся (нет устройства вывода, политика браузера) — играем молча.
      dead = true;
      return null;
    }
  }

  /* ---------- учёт голосов и уборка узлов ---------- */

  /** Занять слот разового звука. `force` — для редких важных событий (удар, глава). */
  function grab(force: boolean): boolean {
    if (!force && voices >= maxVoices) return false;
    voices += 1;
    return true;
  }

  /**
   * Повесить уборку на конец источника. `owner` — этот источник держит слот
   * голоса (у составного звука владелец ровно один).
   */
  function track(src: AudioScheduledSourceNode, owner: boolean, cleanup: () => void): void {
    live.add(src);
    src.onended = () => {
      live.delete(src);
      if (owner) voices = voices > 0 ? voices - 1 : 0;
      src.disconnect();
      cleanup();
    };
  }

  /** Случайное окно в шумовом буфере — чтобы всплески не звучали одинаково. */
  function noiseAt(n: Nodes, dur: number): number {
    const room = n.noise.duration - dur - 0.02;
    return room > 0 ? Math.random() * room : 0;
  }

  /** Панорама, если браузер её умеет; иначе звук просто по центру. */
  function makePan(ctx: AudioContext, pan: number): StereoPannerNode | null {
    if (typeof ctx.createStereoPanner !== "function") return null;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }

  /* ---------- разовые звуки ---------- */

  /** Near-miss: доплеровский всплеск 1800 → 300 Гц с переносом панорамы через центр. */
  function playWhoosh(n: Nodes, side: number, combo: number): void {
    if (!grab(false)) return;
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const dur = 0.32;

    const src = ctx.createBufferSource();
    src.buffer = n.noise;
    src.playbackRate.value = 1.1;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3.4;
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.25);

    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.85, t + 0.035);
    gn.gain.linearRampToValueAtTime(0, t + dur);

    const pn = makePan(ctx, side * 0.85);
    src.connect(bp).connect(gn);
    if (pn) {
      pn.pan.setValueAtTime(side * 0.85, t);
      pn.pan.linearRampToValueAtTime(-side * 0.85, t + dur);
      gn.connect(pn).connect(n.fx);
    } else {
      gn.connect(n.fx);
    }
    src.start(t, noiseAt(n, dur), dur);
    track(src, true, () => {
      bp.disconnect();
      gn.disconnect();
      if (pn) pn.disconnect();
    });

    // Блип поверх: чем длиннее комбо, тем выше — рискнул и слышишь, что зачлось.
    const blip = ctx.createOscillator();
    blip.type = "triangle";
    const f0 = 520 * Math.pow(2, Math.min(combo, 9) / 12);
    blip.frequency.setValueAtTime(f0 * 0.75, t);
    blip.frequency.exponentialRampToValueAtTime(f0, t + 0.09);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    blip.connect(bg).connect(n.fx);
    blip.start(t);
    blip.stop(t + 0.18);
    track(blip, false, () => bg.disconnect());
  }

  /** Звезда: короткое арпеджио на треугольнике, шаг вверх по комбо. */
  function playStar(n: Nodes, combo: number): void {
    if (!grab(false)) return;
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const base = 72 + Math.min(combo, 7);
    for (let i = 0; i < ARP.length; i++) {
      const at = t + i * 0.055;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = mtof(base + ARP[i]);
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.0001, at);
      gn.gain.exponentialRampToValueAtTime(0.17, at + 0.012);
      gn.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
      osc.connect(gn).connect(n.fx);
      osc.start(at);
      osc.stop(at + 0.26);
      track(osc, i === ARP.length - 1, () => gn.disconnect());
    }
  }

  /** Канистра нитро: восходящий свип. */
  function playSweep(n: Nodes): void {
    if (!grab(false)) return;
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const dur = 0.5;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.exponentialRampToValueAtTime(4200, t + dur);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    osc.connect(lp).connect(gn).connect(n.fx);
    osc.start(t);
    osc.stop(t + dur + 0.1);
    track(osc, true, () => {
      lp.disconnect();
      gn.disconnect();
    });
  }

  /** Удар: всплеск шума плюс низкий синус около 60 Гц, громкость от силы удара. */
  function playCrash(n: Nodes, impact: number): void {
    // Удар редкий и важный — пропускаем мимо лимита голосов.
    grab(true);
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const amp = clamp(0.35 + impact / 90, 0.35, 1.1);

    const src = ctx.createBufferSource();
    src.buffer = n.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.1;
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.45);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.7 * amp, t + 0.01);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    src.connect(lp).connect(gn).connect(n.fx);
    src.start(t, noiseAt(n, 0.6), 0.6);
    track(src, true, () => {
      lp.disconnect();
      gn.disconnect();
    });

    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(68, t);
    thump.frequency.exponentialRampToValueAtTime(38, t + 0.4);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.linearRampToValueAtTime(0.85 * amp, t + 0.015);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    thump.connect(tg).connect(n.fx);
    thump.start(t);
    thump.stop(t + 0.52);
    track(thump, false, () => tg.disconnect());
  }

  /** Задир об отбойник. Может сыпаться пачками, поэтому дешёвый: три узла и всё. */
  function playScrape(n: Nodes, v: number): void {
    const ctx = n.ctx;
    const t = ctx.currentTime;
    if (t - lastScrape < 0.05) return;
    lastScrape = t;
    if (!grab(false)) return;
    const dur = 0.11;
    const src = ctx.createBufferSource();
    src.buffer = n.noise;
    src.playbackRate.value = 1.6;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 9;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.1 + 0.22 * clamp01(v), t + 0.012);
    gn.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp).connect(gn).connect(n.fx);
    src.start(t, noiseAt(n, dur), dur);
    track(src, true, () => {
      bp.disconnect();
      gn.disconnect();
    });
  }

  /** Толчок при включении нитро — струя поверх постоянного слоя. */
  function playJetKick(n: Nodes): void {
    if (!grab(false)) return;
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const dur = 0.42;
    const src = ctx.createBufferSource();
    src.buffer = n.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.Q.value = 1.2;
    hp.frequency.setValueAtTime(300, t);
    hp.frequency.exponentialRampToValueAtTime(3200, t + dur);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.3, t + 0.06);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp).connect(gn).connect(n.fx);
    src.start(t, noiseAt(n, dur + 0.05), dur + 0.05);
    track(src, true, () => {
      hp.disconnect();
      gn.disconnect();
    });
  }

  /** Смена главы неба: тихий мерцающий наплыв, три голоса с долгой атакой. */
  function playChapter(n: Nodes): void {
    grab(true);
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const notes = 3;
    for (let i = 0; i < notes; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.value = mtof(76 + i * 7);
      osc.detune.value = (i - 1) * 9;
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.linearRampToValueAtTime(0.075 / (1 + i * 0.4), t + 0.9);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      osc.connect(gn).connect(n.fx);
      osc.start(t);
      osc.stop(t + 2.7);
      track(osc, i === notes - 1, () => gn.disconnect());
    }
  }

  /** Конец заезда: нисходящий свип, глушит собой затухающий двигатель. */
  function playOver(n: Nodes): void {
    grab(true);
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const dur = 1.3;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(210, t);
    osc.frequency.exponentialRampToValueAtTime(52, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 4;
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(280, t + dur);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(0.26, t + 0.08);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    osc.connect(lp).connect(gn).connect(n.fx);
    osc.start(t);
    osc.stop(t + dur + 0.12);
    track(osc, true, () => {
      lp.disconnect();
      gn.disconnect();
    });
  }

  /* ---------- пад ---------- */

  /** Один аккорд: три голоса с долгой атакой, уходят в общий фильтр пада. */
  function scheduleChord(n: Nodes, t: number, ix: number): void {
    const ctx = n.ctx;
    const ch = CHORDS[ix % CHORDS.length];
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 2 ? "triangle" : "sawtooth";
      osc.frequency.value = mtof(ch[i]);
      osc.detune.value = (i - 1) * 7;
      const peak = i === 0 ? 0.26 : 0.17;
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.linearRampToValueAtTime(peak, t + 1.3);
      gn.gain.setValueAtTime(peak, t + CHORD_DUR - 0.6);
      gn.gain.linearRampToValueAtTime(0.0001, t + CHORD_DUR + 0.7);
      osc.connect(gn).connect(n.padBus);
      osc.start(t);
      osc.stop(t + CHORD_DUR + 0.8);
      track(osc, false, () => gn.disconnect());
    }
  }

  /* ---------- события ---------- */

  /**
   * С какой стороны прошла машина: событие несёт только длину комбо, поэтому
   * сторону ищем сами — по ближайшей активной машине в пуле.
   */
  function missSide(g: Game): number {
    let bestD = Infinity;
    let dx = 0;
    for (let i = 0; i < g.cars.length; i++) {
      const c = g.cars[i];
      if (!c.active) continue;
      const d = Math.abs(c.s - g.s);
      if (d < bestD) {
        bestD = d;
        dx = c.lane - g.x;
      }
    }
    return dx > 0 ? 1 : dx < 0 ? -1 : 0;
  }

  function handle(n: Nodes, g: Game, ev: GameEvent): void {
    switch (ev.type) {
      case "nearmiss":
        playWhoosh(n, missSide(g), ev.value ?? g.combo);
        break;
      case "pickup-star":
        playStar(n, g.combo);
        break;
      case "pickup-nitro":
        playSweep(n);
        break;
      case "crash":
        playCrash(n, ev.value ?? 30);
        break;
      case "scrape":
        playScrape(n, ev.value ?? 0.3);
        break;
      case "nitro-on":
        playJetKick(n);
        break;
      case "nitro-off":
        // Струя гаснет в кадровом обновлении по `g.nitroActive` — отдельный звук не нужен.
        break;
      case "chapter":
        playChapter(n);
        break;
      case "start":
        // Новый заезд — коробка с нуля, иначе первый кадр звучит на верхней передаче.
        gear = 0;
        rpm = 0.2;
        shiftT = 0;
        break;
      case "over":
        playOver(n);
        break;
    }
  }

  /* ---------- публичное API ---------- */

  async function resume(): Promise<void> {
    if (dead || disposed) return;
    const n = nx ?? build();
    if (!n) return;
    if (n.ctx.state !== "running") {
      try {
        await n.ctx.resume();
      } catch {
        // Браузер не отдал контекст (жест не засчитан) — попробуем в следующий раз.
      }
    }
    if (disposed) return;
    const t = n.ctx.currentTime;
    // После паузы или разблокировки часы уехали — перепривязываем расписание пада.
    if (nextChord < t || nextChord > t + CHORD_DUR + PAD_LOOKAHEAD) nextChord = t + 0.25;
    setMuted(muted);
  }

  function setMuted(m: boolean): void {
    muted = m;
    const n = nx;
    if (!n) return;
    const t = n.ctx.currentTime;
    const p = n.master.gain;
    // Никогда не пишем .value на живом графе — только рампа, иначе щелчок.
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(m ? 0 : MASTER, t + MUTE_RAMP);
  }

  function update(g: Game, dt: number): void {
    const n = nx;
    if (!n || disposed) return;
    const ctx = n.ctx;
    if (ctx.state !== "running") return;

    maxVoices = g.quality === 0 ? 5 : 8;

    // 1. События: читаем, но НЕ чистим — очередью владеет страница.
    const evs = g.events;
    for (let i = 0; i < evs.length; i++) handle(n, g, evs[i]);

    // 2. Коробка передач. Об/мин ползут вверх внутри передачи и падают на
    //    переключении — именно этот провал и читается ухом как «разгоняется».
    const top = PHYS.speedMax + PHYS.nitroBoost;
    const frac = clamp01(g.speed / top);
    while (gear < GEAR_TOP && frac > GEAR_EDGES[gear + 1] + GEAR_HYST) {
      gear += 1;
      shiftT = SHIFT_TIME;
    }
    while (gear > 0 && frac < GEAR_EDGES[gear] - GEAR_HYST) {
      gear -= 1;
      shiftT = SHIFT_TIME * 0.6;
    }
    const lo = GEAR_EDGES[gear];
    const hi = GEAR_EDGES[gear + 1];
    const within = clamp01((frac - lo) / (hi - lo));
    const driving = g.phase === "playing";
    let rpmTarget = 0.2 + 0.78 * within + (driving ? 0.06 * g.input.throttle : 0);
    if (shiftT > 0) {
      shiftT -= dt;
      rpmTarget *= 0.72;
    }
    rpm = damp(rpm, rpmTarget, shiftT > 0 ? 26 : 9, dt);

    // 3. Параметры пишем 30 раз в секунду, а не каждый кадр: слух разницы не
    //    услышит, а автоматизация не захлебнётся.
    paramAcc += dt;
    if (paramAcc < PARAM_TICK) return;
    paramAcc = 0;

    const now = ctx.currentTime;
    const rc = clamp01(rpm);
    const sf = clamp01(g.speed / PHYS.speedMax);
    // На паузе и в меню мир не едет — ветер и шины замолкают, двигатель уходит на холостые.
    const moving = g.phase === "playing" || g.phase === "crashed" ? 1 : 0;
    const nitro = g.nitroActive ? 1 : 0;

    const f = 34 + 152 * Math.pow(rc, 1.12);
    if (changed(P_ENG_F, f, 0.3)) {
      n.oscA.frequency.setTargetAtTime(f, now, 0.05);
      n.oscB.frequency.setTargetAtTime(f * 1.004, now, 0.05);
      n.sub.frequency.setTargetAtTime(f * 0.5, now, 0.06);
    }

    const cut = clamp(240 + 3600 * Math.pow(rc, 1.35) + nitro * 1400, 60, 12000);
    if (changed(P_ENG_CUT, cut, 12)) n.engFilter.frequency.setTargetAtTime(cut, now, 0.06);

    const det = 10 + 18 * rc;
    if (changed(P_DETUNE, det, 0.4)) n.oscB.detune.setTargetAtTime(det, now, 0.08);

    const phaseGain =
      g.phase === "playing"
        ? 1
        : g.phase === "crashed"
          ? 0.4
          : g.phase === "menu"
            ? 0.42
            : g.phase === "paused"
              ? 0.1
              : 0.14;
    const engG =
      0.16 * phaseGain * (0.55 + 0.45 * rc) * (shiftT > 0 ? 0.5 : 1) * (1 + 0.22 * nitro);
    if (changed(P_ENG_G, engG, 0.0015)) n.engGain.gain.setTargetAtTime(engG, now, 0.05);

    const windF = lerp(520, 1500, sf);
    if (changed(P_WIND_F, windF, 6)) n.windFilter.frequency.setTargetAtTime(windF, now, 0.12);
    const windG = 0.3 * Math.pow(sf, 1.5) * moving;
    if (changed(P_WIND_G, windG, 0.0015)) n.windGain.gain.setTargetAtTime(windG, now, 0.1);

    // Съезд на обочину: фильтр открывается, шум становится грубым и громким.
    const off = clamp01(offPavement(g.x) / (ROAD.shoulder + 0.6));
    const tyreF = lerp(420, 2600, off);
    if (changed(P_TYRE_F, tyreF, 8)) n.tyreFilter.frequency.setTargetAtTime(tyreF, now, 0.07);
    const tyreG = (0.05 + 0.2 * off) * (0.3 + 0.7 * sf) * moving;
    if (changed(P_TYRE_G, tyreG, 0.0015)) n.tyreGain.gain.setTargetAtTime(tyreG, now, 0.07);

    const jetG = nitro * 0.22 * (g.reducedMotion ? 0.75 : 1);
    if (changed(P_JET_G, jetG, 0.002)) n.jetGain.gain.setTargetAtTime(jetG, now, 0.15);

    // Пад приседает под нитро, чтобы струя и двигатель вышли вперёд.
    const padG = (nitro ? 0.045 : 0.1) * (g.phase === "paused" ? 0.55 : 1);
    if (changed(P_PAD_G, padG, 0.002)) n.padGain.gain.setTargetAtTime(padG, now, 0.4);

    const fxG = g.reducedMotion ? 0.68 : 1;
    if (changed(P_FX_G, fxG, 0.01)) n.fx.gain.setTargetAtTime(fxG, now, 0.1);

    // 4. Планировщик пада с упреждением. Без setInterval: сравниваем часы
    //    контекста и планируем не дальше, чем на PAD_LOOKAHEAD вперёд.
    if (nextChord < now - 0.5) nextChord = now + 0.05;
    while (nextChord < now + PAD_LOOKAHEAD) {
      scheduleChord(n, nextChord, chordIx);
      chordIx = (chordIx + 1) % CHORDS.length;
      nextChord += CHORD_DUR;
    }
  }

  function dispose(): void {
    disposed = true;
    const n = nx;
    nx = null;
    voices = 0;
    live.forEach((src) => {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Источник мог не стартовать — тогда и останавливать нечего.
      }
      src.disconnect();
    });
    live.clear();
    if (!n) return;
    n.master.disconnect();
    n.limiter.disconnect();
    void n.ctx.close().catch(() => {
      // Контекст уже закрыт — это не ошибка.
    });
  }

  return { resume, setMuted, update, dispose };
}
