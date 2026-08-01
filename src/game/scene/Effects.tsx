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
 * сжатые значения и ореол получается вялым. Он и считается: three отключает
 * тонмаппинг в материалах, когда рисует в render-таргет, так что RenderPass
 * кладёт в буфер честный HDR, а сжимает его один OutputPass.
 *
 * Чего здесь нет и почему:
 *
 * - Никакого React-состояния. Сила bloom берётся из `g` прямо в кадре и
 *   подтягивается через `damp`, поэтому ни нитро, ни авария не перерисовывают
 *   дерево компонентов. `g` этот модуль только читает.
 * - На пресете без bloom (`QUALITY[q].bloom === false`) компонент не рисует
 *   ничего и не создаёт composer: слабому железу лишний проход не нужен. Чтобы
 *   порядок хуков не менялся, решение принимает внешний `Effects`, у которого
 *   хуков нет вовсе, а вся работа живёт во вложенном `Bloom`.
 *
 * ВАЖНО про цикл рендера. `useFrame(..., 1)` с приоритетом больше нуля отключает
 * собственный рендер R3F — кадр рисуем мы, вызовом `composer.render(dt)`. R3F
 * считает подписки с приоритетом: пока счётчик положителен, `gl.render` в цикле
 * не вызывается вовсе. Отписка (она идёт в layout-фазе размонтирования, то есть
 * до следующего кадра) счётчик уменьшает, и R3F в том же кадре снова рисует
 * сцену сам. Поэтому и уход со страницы, и переключение качества 2 → 0, на
 * котором внешний `Effects` возвращает `null`, чёрного холста не дают:
 * «включать рендер назад» руками не нужно, достаточно освободить цепочку.
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

/* ---------- разрешение пирамиды bloom ---------- */

/**
 * Доля от размера кадра, на которой живёт пирамида размытия.
 *
 * `UnrealBloomPass` строит пять мипов, начиная с половины того размера, который
 * ему дали, а даёт ему `EffectComposer` полное разрешение устройства (размер
 * холста × dpr, до 1.9 на пресете «красиво»). То есть самое дорогое, нулевое
 * размытие шло по буферу в четверть кадра — на мобильном GPU это заметная доля
 * всего кадра, и ровно её здесь и режем: половина по стороне — вчетверо меньше
 * текселей во всей пирамиде, а сам ореол размыт настолько, что разницы в нём
 * не видно. Полноразмерными остаются только HDR-буферы композера, куда рисуется
 * сцена, и финальное аддитивное подмешивание — их резать нельзя, поплывут края.
 *
 * Побочный эффект, о котором надо знать: ореол считается на вдвое более грубой
 * сетке, поэтому в экранных пикселях он становится примерно вдвое шире. Если
 * когда-нибудь понадобится ровно прежняя ширина — это `bloomRadius` в пресете
 * (0.62 → ≈0.56), но config не мой и трогать его здесь нечем.
 */
const BLOOM_SCALE = 0.5;
/** Нижняя граница стороны пирамиды: пять мипов ужимают её ещё в 32 раза. */
const BLOOM_MIN = 8;

/**
 * Целое число пикселей из размера, который может прийти нулём (холст на первом
 * монтировании) или, теоретически, NaN (замер контейнера ещё не состоялся).
 * `Math.max(1, Math.floor(NaN))` — это NaN, а render-таргет размера NaN — набор
 * ошибок GL и мусор в буфере, поэтому проверка именно на конечность.
 */
function px(v: number): number {
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** Сторона пирамиды bloom по стороне кадра. */
function bloomPx(v: number): number {
  const n = Math.floor(px(v) * BLOOM_SCALE);
  return n > BLOOM_MIN ? n : BLOOM_MIN;
}

/** Кратность пикселей: тоже может прийти нулём или NaN. */
function ratio(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Тот же проход, но пирамида считается на `BLOOM_SCALE` от кадра.
 * `EffectComposer.setSize` зовёт `setSize` у всех проходов полным размером —
 * перехватываем именно здесь, чтобы масштаб не зависел от того, кто и в каком
 * порядке дёргает композер.
 */
class BloomPass extends UnrealBloomPass {
  override setSize(width: number, height: number): void {
    super.setSize(bloomPx(width), bloomPx(height));
  }
}

/* ---------- сборка и освобождение цепочки ---------- */

interface BloomRig {
  composer: EffectComposer;
  bloom: BloomPass;
  /** Уже применённые размер и dpr: лишний `setSize` перевыделяет все буферы. */
  w: number;
  h: number;
  dpr: number;
  /** Уже освобождён: переиспользовать нельзя, нужна новая цепочка. */
  dead: boolean;
}

function resizeRig(rig: BloomRig, width: number, height: number, rawDpr: number): void {
  if (rig.dead) return;
  const w = px(width);
  const h = px(height);
  const dpr = ratio(rawDpr);
  if (w !== rig.w || h !== rig.h) {
    rig.w = w;
    rig.h = h;
    rig.composer.setSize(w, h);
  }
  if (dpr !== rig.dpr) {
    rig.dpr = dpr;
    // setPixelRatio сам перевызывает setSize уже сохранёнными размерами.
    rig.composer.setPixelRatio(dpr);
  }
}

function createRig(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: Quality,
  width: number,
  height: number,
  rawDpr: number,
): BloomRig {
  const preset = QUALITY[quality];
  const w = px(width);
  const h = px(height);
  const dpr = ratio(rawDpr);

  const composer = new EffectComposer(gl);
  composer.addPass(new RenderPass(scene, camera));

  // Стартовое разрешение даём уже уменьшенным, чтобы конструктор не выделил
  // одиннадцать таргетов полного кадра. Настоящий размер всё равно придёт
  // следом из `resizeRig`, но эти буферы хотя бы не будут пиковыми.
  const bloom = new BloomPass(
    new THREE.Vector2(bloomPx(w * dpr), bloomPx(h * dpr)),
    preset.bloomStrength,
    preset.bloomRadius,
    preset.bloomThreshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // −1 во всех трёх полях — «ещё ничего не применяли»: `resizeRig` обязан
  // отработать хотя бы раз. Это же и защита от нулевого холста: композер взял
  // размер у рендерера, а тот на первом монтировании может быть 0×0, то есть
  // его собственные буферы уже вырождены. `px` подставляет единицу, и после
  // первого настоящего замера цепочка перестраивается на нормальный размер.
  const rig: BloomRig = { composer, bloom, w: -1, h: -1, dpr: -1, dead: false };
  resizeRig(rig, width, height, rawDpr);
  return rig;
}

/**
 * Полное освобождение, идемпотентное. Кто что забирает:
 *
 * - `UnrealBloomPass.dispose()` (three r182) — пять горизонтальных и пять
 *   вертикальных таргетов мипов, `renderTargetBright`, пять материалов
 *   размытия, `compositeMaterial`, `blendMaterial`, служебный `_basic` и
 *   геометрию полноэкранного квада;
 * - `OutputPass.dispose()` — свой материал и квад;
 * - `RenderPass` не держит ресурсов GPU вовсе (`Pass.dispose()` пустой);
 * - `composer.dispose()` — два HDR-буфера композера и его собственный copyPass.
 *
 * Мимо всего этого проходит ровно одна вещь: `materialHighPassFilter`, тот
 * самый ShaderMaterial, который режет кадр по порогу. Его `dispose()` прохода
 * не трогает, а значит его программа GL оставалась бы жить при каждой
 * пересборке цепочки — то есть при каждой смене качества и каждом заходе на
 * страницу. Снимаем руками, до общего обхода.
 */
function disposeRig(rig: BloomRig): void {
  if (rig.dead) return;
  rig.dead = true;
  rig.bloom.materialHighPassFilter.dispose();
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
   * Размер и dpr намеренно не в зависимостях: их отрабатывает `resizeRig` в
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
    resizeRig(liveRef.current, size.width, size.height, dpr);
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
