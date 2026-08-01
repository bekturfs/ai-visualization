/**
 * Пост-обработка: bloom. Один проход, который и делает картинку «рилом».
 *
 * В референсе (кадры f_001, f_005) ни один источник света не выглядит точкой:
 * фары растекаются в полосы, приборка красным заливает руки, фонари над дорогой
 * висят в ореоле. Геометрия у нас уже светится (аддитивные квады, цвета ярче
 * единицы), но без bloom это остаётся плоскими пятнами — свечение появляется
 * именно здесь.
 *
 * Цепочка проходов классическая:
 *
 *   RenderPass  → сцена в HDR-буфер (HalfFloat, линейное пространство);
 *   UnrealBloom → всё ярче порога размывается и складывается обратно;
 *   OutputPass  → тонмаппинг и перевод в sRGB, уже на экран.
 *
 * Порядок важен: bloom обязан считаться до тонмаппинга, иначе порог режет уже
 * сжатые значения и ореол получается вялым.
 *
 * Чего здесь нет и почему:
 *
 * - Никакого React-состояния. Сила bloom берётся из `g` прямо в кадре и
 *   подтягивается через `damp`, поэтому ни нитро, ни авария не перерисовывают
 *   дерево компонентов.
 * - На пресете без bloom (`QUALITY[q].bloom === false`) компонент не рисует
 *   ничего и не создаёт composer: слабому железу лишний проход не нужен. Чтобы
 *   порядок хуков не менялся, решение принимает внешний `Effects`, у которого
 *   хуков нет вовсе, а вся работа живёт во вложенном `Bloom`.
 *
 * ВАЖНО про цикл рендера. `useFrame(..., 1)` с приоритетом больше нуля отключает
 * собственный рендер R3F — кадр рисуем мы, вызовом `composer.render(dt)`. Как
 * только компонент размонтируется, подписка снимается, приоритет падает обратно
 * в ноль и R3F снова рисует сцену сам; поэтому здесь достаточно освободить
 * composer и проходы, «включать рендер назад» руками не нужно.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { QUALITY } from "../config";
import { clamp, clamp01, damp } from "../num";
import type { Game, Quality } from "../types";

/* ---------- как игра двигает bloom ---------- */

/** Прибавка силы на активном нитро, доля от базовой. */
const NITRO_LIFT = 0.45;
/** Прибавка на вспышке аварии: кадр должен выбелиться, а не подмигнуть. */
const FLASH_LIFT = 1.55;
/** То же в спокойном режиме — заметно, но без удара по глазам. */
const FLASH_LIFT_CALM = 0.5;
/** Потолок суммарной прибавки, чтобы белизна не съела дорогу целиком. */
const LIFT_MAX = 2.2;

/** Скорость набора и спада прибавки, 1/с. Набор быстрее: удар должен читаться. */
const LIFT_RISE = 13;
const LIFT_FALL = 6;
const LIFT_RISE_CALM = 5;
const LIFT_FALL_CALM = 4;

/** Насколько на подъёме расплывается ореол (radius обязан остаться в 0…1). */
const RADIUS_LIFT = 0.12;
/** Насколько на подъёме опускается порог — в свечение попадает больше кадра. */
const THRESHOLD_DROP = 0.12;
const THRESHOLD_MIN = 0.04;

/** Ограничение шага времени: после сворачивания вкладки dt приходит огромным. */
const DT_MAX = 0.05;

/* ---------- сборка и освобождение цепочки ---------- */

interface BloomRig {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  /** Уже освобождён: переиспользовать нельзя, нужна новая цепочка. */
  dead: boolean;
}

function createRig(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: Quality,
  width: number,
  height: number,
  dpr: number,
): BloomRig {
  const preset = QUALITY[quality];

  // Холст на первом кадре может быть нулевым, а render-таргет 0×0 — это ошибки
  // GL и NaN в буферах. Поэтому снизу всегда единица; настоящий размер придёт
  // из эффекта ресайза.
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  const composer = new EffectComposer(gl);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    preset.bloomStrength,
    preset.bloomRadius,
    preset.bloomThreshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  composer.setPixelRatio(dpr > 0 ? dpr : 1);
  composer.setSize(w, h);

  return { composer, bloom, dead: false };
}

/**
 * Полное освобождение, идемпотентное. `composer.dispose()` знает только про
 * свои два буфера и copyPass, а `UnrealBloomPass` держит ещё десяток
 * render-таргетов и материалов — без обхода проходов они утекают при каждом
 * уходе со страницы, и память GPU растёт от захода к заходу.
 */
function disposeRig(rig: BloomRig): void {
  if (rig.dead) return;
  rig.dead = true;
  const passes = rig.composer.passes;
  for (let i = 0; i < passes.length; i++) passes[i].dispose();
  passes.length = 0;
  rig.composer.dispose();
}

/* ---------- проход ---------- */

function Bloom({ g, quality }: { g: Game; quality: Quality }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  /**
   * Цепочки, созданные рендерами, которые React выбросил. В StrictMode тело
   * компонента (а с ним и `useMemo`) выполняется дважды, и первый composer
   * никуда не попадает — если его не подобрать, он останется на GPU навсегда.
   */
  const madeRef = useRef<BloomRig[]>([]);

  /**
   * Пересобираем только при смене рендерера, сцены, камеры или качества.
   * Размер и dpr намеренно не в зависимостях: их отрабатывает `setSize` в
   * эффекте ниже, пересоздавать ради ресайза всю цепочку буферов незачем.
   */
  const rig = useMemo<BloomRig>(() => {
    const made = createRig(gl, scene, camera, quality, size.width, size.height, dpr);
    madeRef.current.push(made);
    return made;
    // `size` и `dpr` читаются один раз, на сборке; дальше их держит эффект.
  }, [gl, scene, camera, quality]);

  /**
   * Та цепочка, которой реально рисуем. Обычно это `rig`, но StrictMode
   * монтирует компонент дважды и между монтированиями прогоняет cleanup, не
   * пересчитывая `useMemo`: к моменту второго монтирования `rig` уже освобождён,
   * а освобождённые render-таргеты переиспользовать нельзя.
   */
  const liveRef = useRef<BloomRig>(rig);

  useEffect(() => {
    const made = madeRef.current;
    for (let i = 0; i < made.length; i++) if (made[i] !== rig) disposeRig(made[i]);
    made.length = 0;

    const live = rig.dead
      ? createRig(gl, scene, camera, quality, size.width, size.height, dpr)
      : rig;
    liveRef.current = live;

    return () => disposeRig(live);
    // Размер и dpr здесь только как начальные значения — см. эффект ресайза.
  }, [gl, scene, camera, quality, rig]);

  /** Ресайз холста и смена dpr. Нулевой размер пропускаем. */
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const live = liveRef.current;
    live.composer.setPixelRatio(dpr > 0 ? dpr : 1);
    live.composer.setSize(Math.floor(size.width), Math.floor(size.height));
  }, [rig, size.width, size.height, dpr]);

  /** Сглаженная прибавка к силе bloom; живёт между кадрами. */
  const liftRef = useRef(0);
  const preset = QUALITY[quality];

  /**
   * Приоритет 1: рендер кадра теперь наш, и он идёт после всех обычных
   * подписок — сцена к этому моменту уже подвинута. Внутри ни одной
   * аллокации, только присваивания в поля прохода.
   */
  useFrame((state, rawDt) => {
    const live = liveRef.current;
    if (live.dead) return;
    if (state.size.width <= 0 || state.size.height <= 0) return;

    const dt = clamp(rawDt, 0, DT_MAX);
    const calm = g.reducedMotion;

    // Цель складывается из нитро (ровный подъём, пока держат кнопку) и вспышки
    // аварии (пик, который движок гасит сам). Обе идут через damp, поэтому
    // ступеньки не бывает даже когда `flash` прыгает с нуля в единицу.
    const flash = clamp01(g.flash) * (calm ? FLASH_LIFT_CALM : FLASH_LIFT);
    const target = clamp((g.nitroActive ? NITRO_LIFT : 0) + flash, 0, LIFT_MAX);
    const rate =
      target > liftRef.current
        ? calm
          ? LIFT_RISE_CALM
          : LIFT_RISE
        : calm
          ? LIFT_FALL_CALM
          : LIFT_FALL;

    const lift = damp(liftRef.current, target, rate, dt);
    liftRef.current = lift;

    // Ореол шире и порог ниже только на первой единице подъёма: дальше растёт
    // одна сила, иначе на аварии весь кадр уходит в молоко.
    const hot = lift > 1 ? 1 : lift;
    const bloom = live.bloom;
    bloom.strength = preset.bloomStrength * (1 + lift);
    bloom.radius = clamp(preset.bloomRadius + RADIUS_LIFT * hot, 0, 1);
    bloom.threshold = Math.max(
      THRESHOLD_MIN,
      preset.bloomThreshold - THRESHOLD_DROP * hot,
    );

    live.composer.render(dt);
  }, 1);

  return null;
}

/**
 * Bloom-проход поверх сцены. Ставится последним ребёнком Canvas.
 *
 * Хуков здесь нет намеренно: только так можно вернуть `null` на пресете без
 * bloom, не сломав порядок хуков при смене качества на лету. `key` по качеству
 * заставляет вложенный компонент перемонтироваться — старая цепочка проходов
 * освобождается целиком, новая собирается уже с другими параметрами.
 */
export function Effects({ g }: { g: Game }) {
  const quality = g.quality;
  if (!QUALITY[quality].bloom) return null;
  return <Bloom key={quality} g={g} quality={quality} />;
}
