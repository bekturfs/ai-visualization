/**
 * Пост-обработка: bloom, сглаживание, виньетка, тональная компрессия.
 * Это то, что делает картинку «рилом».
 *
 * В референсе (кадры f_001, f_005) ни один источник света не выглядит точкой:
 * фары растекаются в полосы, приборка красным заливает руки, фонари над дорогой
 * висят в ореоле. Геометрия у нас уже светится (аддитивные квады, цвета ярче
 * единицы), но без bloom это остаётся плоскими пятнами — свечение появляется
 * именно здесь.
 *
 * Раньше здесь была цепочка штатных проходов three: RenderPass → UnrealBloomPass
 * (на половинном разрешении, через подкласс) → OutputPass → SMAAPass. Четыре
 * прохода, около одиннадцати таргетов и по полноэкранной отрисовке на каждый шаг.
 * Теперь это `postprocessing`: один композер, `RenderPass` и один `EffectPass`,
 * в котором все четыре эффекта склеены в один фрагментный шейдер. Пинг-понга
 * между таргетами больше нет — есть один проход по кадру.
 *
 * Порядок эффектов внутри прохода не косметический:
 *
 *   SMAA        — первым и только первым. Его `mainImage` берёт соседние тексели
 *                 из `inputBuffer` (входа всего прохода) и с blend-режимом SRC
 *                 подменяет цвет целиком; поставь его после bloom — и на краях
 *                 он выбросит всё, что bloom добавил.
 *   Bloom       — считает свою пирамиду от входного HDR-буфера и подмешивается
 *                 аддитивно. Именно аддитивно, а не SCREEN (умолчание библиотеки):
 *                 SCREEN — оператор для диапазона 0…1, а у нас в буфере значения
 *                 заметно больше единицы, и он бы их не поднимал, а гасил.
 *   Vignette    — мягкое затемнение углов, множитель, без обрезки по единице.
 *   ToneMapping — последним, ACES, тот же оператор, что раньше делал OutputPass.
 *
 * ВАЖНО для `main.ts`: пока цепочка активна, тональная компрессия живёт здесь, и
 * `renderer.toneMapping` обязан быть `NoToneMapping`; на качестве 0, где цепочки
 * нет и сцена рисуется прямо на экран, — `ACESFilmicToneMapping`. Оставить ACES
 * рендереру при живом композере — это сжать кадр дважды и выбелить его.
 *
 * Кадр рисует композер, а не вызывающий: `main.ts` делает
 * `fx.active ? fx.render() : renderer.render(scene, camera)`.
 */

import { HalfFloatType, Texture } from "three";
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  VignetteTechnique,
} from "postprocessing";

import { QUALITY } from "../config";
import type { RenderCtx, System } from "../ctx";
import { clamp, clamp01, damp } from "../num";
import type { Game } from "../types";

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

/* ---------- перевод настроек bloom из UnrealBloomPass в BloomEffect ---------- */

/**
 * Пересчёт `bloomStrength` пресета в `intensity`.
 *
 * Параметризация у двух реализаций разная, и подставить старое число в новое
 * поле нельзя. Считаем по световой энергии, которую bloom добавляет к кадру, —
 * это линейный функционал, поэтому он одинаково верен и для большого светлого
 * пятна, и для точечной звезды.
 *
 * UnrealBloomPass: композит домножает сумму пяти размытий на `3.0 * strength`
 * («3.0 for backwards compatibility» прямо в его шейдере), а веса мипов
 * `mix(f, 1.2 - f, radius)` при f = 1, 0.8, 0.6, 0.4, 0.2 дают в сумме ровно 3.0
 * при любом радиусе. Каждое размытие нормировано, то есть энергию сохраняет.
 * Итого прибавка = 9 × strength × (энергия отсечённого по порогу кадра).
 *
 * BloomEffect с `mipmapBlur`: апсемплинг складывает уровни не суммой, а
 * `mix(уровень, размытие, radius)` — выпуклая комбинация, энергия сохраняется.
 * Итого прибавка = intensity × (та же энергия).
 *
 * Значит intensity = 9 × strength: 0.4 → 3.6 на «обычно», 0.46 → 4.14 на «красиво».
 */
const UNREAL_GAIN = 9;

/**
 * Ширина порога отсечки. У `UnrealBloomPass` `smoothWidth` зашит в 0.01, у
 * `BloomEffect` умолчание 0.03 — берём старое значение, иначе в свечение начнёт
 * подтекать всё, что стоит чуть ниже порога, а порог здесь выстрадан: он меряется
 * в линейном HDR-буфере, и именно из-за этого его когда-то подняли до 0.8.
 */
const HIGHPASS_SMOOTHING = 0.01;

/**
 * Число уровней пирамиды размытия.
 *
 * Старая цепочка отдавала `UnrealBloomPass` половину кадра (`BLOOM_SCALE = 0.5`),
 * он внутри делил ещё пополам и строил пять мипов: 1/4, 1/8, 1/16, 1/32, 1/64
 * стороны кадра. Здесь мипы идут от 1/2, поэтому шесть уровней дают тот же самый
 * самый грубый масштаб 1/64 — то есть ту же ширину ореола, к которой привыкли.
 */
const BLOOM_LEVELS = 6;

/**
 * Радиус (доля коэффициента смешивания при апсемплинге, 0…1).
 *
 * Он же распределяет энергию по уровням: вес уровня i равен (1 − r)·rⁱ. При 0.8
 * на самый мелкий уровень приходится 20 % — почти столько же, сколько давал
 * старый `bloomRadius` 0.26 своему самому мелкому мипу (26 %), — а остальное
 * уходит в широкие уровни, ровно как у половинной пирамиды прошлой цепочки.
 * С параметром `bloomRadius` из пресета не совпадает и совпасть не может:
 * там это интерполяция пяти фиксированных весов, здесь — коэффициент `mix`.
 */
const BLOOM_RADIUS = 0.8;

/* ---------- сглаживание ---------- */

/**
 * Порог детектора границ SMAA.
 *
 * Умолчание 0.1 подобрано для картинки, уже переведённой в sRGB, — так оно и
 * работало раньше, когда `SMAAPass` стоял после `OutputPass`. Здесь всё слито в
 * один шейдер, и SMAA неизбежно смотрит на линейный HDR-буфер, где те же самые
 * средние по яркости перепады численно меньше примерно вдвое. Порог опущен,
 * чтобы детектор ловил те же границы, что и раньше, а не только самые яркие.
 */
const SMAA_THRESHOLD = 0.05;

/* ---------- виньетка ---------- */

/**
 * Затемнение углов. В референсе верхние углы кадра заметно темнее середины неба.
 * Эффект намеренно слабый: множитель падает до ~0.78 в самом углу и почти не
 * трогает середину сторон (~0.98). В шейдере это `smoothstep(0.8, offset·0.799,
 * d·(darkness + offset))`, обрезки по единице там нет — HDR не портит.
 */
const VIGNETTE_OFFSET = 0.3;
const VIGNETTE_DARKNESS = 0.28;

/* ---------- размеры ---------- */

/**
 * Целое число пикселей из размера, который может прийти нулём (холст на первом
 * монтировании) или, теоретически, NaN (замер контейнера ещё не состоялся).
 * `Math.max(1, Math.floor(NaN))` — это NaN, а render-таргет размера NaN — набор
 * ошибок GL и мусор в буфере, поэтому проверка именно на конечность.
 */
function px(v: number): number {
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** Кратность пикселей: тоже может прийти нулём или NaN. */
function ratio(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/* ---------- контракт ---------- */

/**
 * Система постобработки. Отличается от обычной тем, что владеет отрисовкой кадра:
 * пока `active`, рисует она, и `main.ts` не должен звать `renderer.render`.
 */
export interface EffectsSystem extends System {
  /** Нарисовать кадр цепочкой. Звать только когда `active`. */
  render(): void;
  /** Есть ли постобработка. На качестве 0 её нет вовсе — композер не создаётся. */
  readonly active: boolean;
}

/* ---------- сборка ---------- */

export function createEffects(ctx: RenderCtx): EffectsSystem {
  const preset = QUALITY[ctx.quality];

  // Слабому железу лишний проход не нужен: ни композера, ни таргетов, ни
  // шейдеров — кадр рисует вызывающий, как будто этой системы нет.
  if (!preset.bloom) {
    return {
      active: false,
      update() {},
      render() {},
      dispose() {},
    };
  }

  const renderer = ctx.renderer;
  /** Композер выключает автоочистку рендерера; вернём как было при dispose. */
  const autoClearWas = renderer.autoClear;

  const composer = new EffectComposer(renderer, {
    // HDR обязателен: порог bloom меряется до тональной компрессии, и в
    // восьмибитном буфере всё ярче единицы схлопнулось бы ещё до отсечки.
    frameBufferType: HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    // Сглаживание делает SMAA внутри общего прохода, MSAA здесь не нужен.
    multisampling: 0,
  });

  composer.addPass(new RenderPass(ctx.scene, ctx.camera));

  const baseIntensity = preset.bloomStrength * UNREAL_GAIN;

  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD,
    luminanceThreshold: preset.bloomThreshold,
    luminanceSmoothing: HIGHPASS_SMOOTHING,
    mipmapBlur: true,
    intensity: baseIntensity,
    radius: BLOOM_RADIUS,
    levels: BLOOM_LEVELS,
  });

  // MEDIUM — то же, что делал `SMAAPass` из three: порог по цвету, восемь шагов
  // поиска, без диагоналей и углов. SMAA, а не FXAA: FXAA размывает мелкие яркие
  // точки, а из них состоит всё небо.
  const smaa = new SMAAEffect({
    preset: SMAAPreset.MEDIUM,
    edgeDetectionMode: EdgeDetectionMode.COLOR,
  });
  smaa.edgeDetectionMaterial.edgeDetectionThreshold = SMAA_THRESHOLD;

  const vignette = new VignetteEffect({
    technique: VignetteTechnique.DEFAULT,
    offset: VIGNETTE_OFFSET,
    darkness: VIGNETTE_DARKNESS,
  });

  // Тот же ACES, что раньше применял `OutputPass`, читая `renderer.toneMapping`.
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

  const merged = new EffectPass(ctx.camera, smaa, bloom, vignette, tone);

  /**
   * Заглушка вместо буфера глубины.
   *
   * SMAA объявляет атрибут DEPTH ради предикации по глубине, а она выключена
   * (`PredicationMode.DISABLED` — умолчание, и в собранном шейдере ни один
   * `mainImage` глубину не принимает, то есть чтения из неё там просто нет).
   * Композер этого не знает: увидев проход, которому «нужна глубина», он заведёт
   * три полноразмерных буфера глубины и станет копировать её каждый кадр в
   * никуда. Проверяет он `needsDepthTexture`, а тот выставляется как «глубины у
   * прохода ещё нет» — так что достаточно дать проходу любую непустую текстуру
   * до добавления в композер. Пустая `Texture` не занимает на GPU ничего:
   * униформа неактивна, до загрузки дело не доходит.
   */
  const depthStub = new Texture();
  depthStub.name = "Effects.DepthStub";
  merged.setDepthTexture(depthStub);
  composer.addPass(merged);

  /* --- размер --- */

  // −1 во всех трёх полях: «ещё ничего не применяли». Композер взял размер у
  // рендерера сам, а тот на первом монтировании может быть нулевым, поэтому
  // первый настоящий `resize` обязан пройти до конца.
  let curW = -1;
  let curH = -1;
  let curDpr = -1;

  function applySize(size: RenderCtx["size"]): void {
    const w = px(size.w);
    const h = px(size.h);
    const dpr = ratio(size.dpr);
    if (w === curW && h === curH && dpr === curDpr) return;
    curW = w;
    curH = h;
    curDpr = dpr;
    // Размер таргетов композер берёт из drawing buffer, то есть уже с учётом
    // dpr, который `main.ts` выставляет рендереру до вызова `resize`. Третий
    // аргумент — не трогать инлайновый стиль холста: он растянут по CSS.
    composer.setSize(w, h, false);
  }

  // Свой стартовый размер композер взял у рендерера, а холст на первом
  // монтировании бывает нулевым — тогда у него уже таргеты 0×0. Чиним сразу:
  // `px` и `ratio` не пропустят ни нуля, ни NaN, а настоящий размер придёт
  // следом первым же `resize`.
  if (composer.inputBuffer.width < 1 || composer.inputBuffer.height < 1) {
    applySize(ctx.size);
  }

  /* --- освобождение --- */

  let disposed = false;

  /**
   * Справочные текстуры SMAA (search и area) живут в униформах
   * `weightsMaterial`, а не в полях эффекта, поэтому рефлексивный
   * `Effect.dispose` их не находит. Снимаем руками.
   */
  function disposeSmaaLuts(): void {
    const m = smaa.weightsMaterial;
    if (m.searchTexture) m.searchTexture.dispose();
    if (m.areaTexture) m.areaTexture.dispose();
  }

  // Обе текстуры декодируются из base64 асинхронно (никакой сети, всё внутри
  // библиотеки). Если качество переключат в первые же миллисекунды, они
  // родятся уже после dispose — тогда освобождаем их прямо в обработчике.
  // Тип события в d.ts не описан, отсюда приведение.
  (
    smaa as unknown as { addEventListener(type: string, listener: () => void): void }
  ).addEventListener("load", () => {
    if (disposed) disposeSmaaLuts();
  });

  /* --- кадр --- */

  /** Сглаженная прибавка к силе bloom; живёт между кадрами. */
  let lift = 0;
  /** Шаг времени последнего `update`: `render` вызывается отдельно и без него. */
  let lastDt = 0;

  return {
    active: true,

    update(g: Game, rawDt: number): void {
      if (disposed) return;

      const dt = clamp(rawDt, 0, DT_MAX);
      lastDt = dt;
      const calm = g.reducedMotion;

      // Цель складывается из нитро (ровный подъём, пока держат кнопку) и вспышки
      // аварии (пик, который движок гасит сам). Обе идут через damp, поэтому
      // ступеньки не бывает даже когда `flash` прыгает с нуля в единицу.
      const flash = clamp01(g.flash) * (calm ? FLASH_LIFT_CALM : FLASH_LIFT);
      const target = clamp((g.nitroActive ? NITRO_LIFT : 0) + flash, 0, LIFT_MAX);
      const rate =
        target > lift
          ? calm
            ? LIFT_RISE_CALM
            : LIFT_RISE
          : calm
            ? LIFT_FALL_CALM
            : LIFT_FALL;

      lift = damp(lift, target, rate, dt);

      // Ореол шире и порог ниже только на первой единице подъёма: дальше растёт
      // одна сила, иначе на аварии весь кадр уходит в молоко.
      const hot = lift > 1 ? 1 : lift;
      bloom.intensity = baseIntensity * (1 + lift);
      bloom.mipmapBlurPass.radius = clamp(BLOOM_RADIUS + RADIUS_LIFT * hot, 0, 1);
      bloom.luminanceMaterial.threshold = Math.max(
        THRESHOLD_MIN,
        preset.bloomThreshold - THRESHOLD_DROP * hot,
      );
    },

    resize(next: RenderCtx): void {
      if (disposed) return;
      applySize(next.size);
    },

    render(): void {
      if (disposed) return;
      composer.render(lastDt);
    },

    /**
     * Полное освобождение, идемпотентное. Кто что забирает:
     *
     * - `composer.dispose()` — оба HDR-буфера, свой copyPass, таймер, общую
     *   геометрию полноэкранного треугольника и все проходы;
     * - `EffectPass.dispose()` — скомпилированный материал и все свои эффекты;
     * - `Effect.dispose()` у каждого эффекта обходит собственные поля и
     *   освобождает всё, что оказалось таргетом, материалом, текстурой или
     *   проходом: у bloom это пирамида мипов, highpass и его таргет, у SMAA —
     *   таргеты границ и весов со своими проходами, у тонмаппинга — таргет
     *   яркости и оба его прохода;
     * - `RenderPass` держит только свой ClearPass, он же его и освобождает.
     *
     * Мимо обхода проходят ровно две вещи: справочные текстуры SMAA (лежат в
     * униформах материала весов) и наша заглушка глубины (её никто не считает
     * своей). Снимаем сами, до общего обхода.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeSmaaLuts();
      depthStub.dispose();
      composer.dispose();
      renderer.autoClear = autoClearWas;
    },
  };
}
