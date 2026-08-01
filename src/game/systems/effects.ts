/**
 * Пост-обработка: сглаживание, god rays, смаз на скорости, bloom, виньетка,
 * тональная компрессия. Это то, что делает картинку «рилом».
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
 *   GodRays     — лучи от звезды-блика. Считаются в свои таргеты (см. ниже) и
 *                 подмешиваются аддитивно, как bloom. Только на «красиво».
 *   ZoomBlur    — радиальный смаз к центру кадра. Свой маленький `Effect`,
 *                 blend SRC: он не добавляет свет, а подменяет цвет смесью
 *                 «резко/размыто». Стоит до bloom намеренно — bloom строит
 *                 пирамиду от `inputBuffer`, то есть от нетронутого кадра, и
 *                 свечение не расплывается вместе со смазом.
 *   Bloom       — считает свою пирамиду от входного HDR-буфера и подмешивается
 *                 аддитивно. Именно аддитивно, а не SCREEN (умолчание библиотеки):
 *                 SCREEN — оператор для диапазона 0…1, а у нас в буфере значения
 *                 заметно больше единицы, и он бы их не поднимал, а гасил.
 *   Vignette    — мягкое затемнение углов, множитель, без обрезки по единице.
 *   ToneMapping — последним, ACES, тот же оператор, что раньше делал OutputPass.
 *
 * Порядок в списке — не пожелание: `EffectPass` сортирует эффекты по убыванию
 * атрибутов (`CONVOLUTION|DEPTH` = 3 у SMAA, `DEPTH` = 1 у god rays, 0 у
 * остальных), сортировка устойчивая. Список выше уже записан в том порядке, в
 * котором сортировка его и оставит, — так читаемое и настоящее совпадают.
 *
 * ВАЖНО для `main.ts`: пока цепочка активна, тональная компрессия живёт здесь, и
 * `renderer.toneMapping` обязан быть `NoToneMapping`; на качестве 0, где цепочки
 * нет и сцена рисуется прямо на экран, — `ACESFilmicToneMapping`. Оставить ACES
 * рендереру при живом композере — это сжать кадр дважды и выбелить его.
 *
 * Кадр рисует композер, а не вызывающий: `main.ts` делает
 * `fx.active ? fx.render() : renderer.render(scene, camera)`.
 */

import {
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Texture,
  Uniform,
  type Scene,
} from "three";
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  Effect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  KernelSize,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  VignetteTechnique,
} from "postprocessing";

import { COLORS, PHYS, QUALITY, SKY } from "../config";
import type { RenderCtx, System } from "../ctx";
import { clamp, clamp01, damp, inv, lerp, smoothstep } from "../num";
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

/* ---------- god rays: где стоит звезда ----------
 *
 * ЭТО ЗЕРКАЛО `systems/sky.ts`, И ЕГО НАДО ДЕРЖАТЬ В СИНХРОНЕ.
 *
 * `GodRaysEffect` умеет считать лучи только от объекта, который он сам поместит
 * в свою сцену и сам отрисует поверх скопированной глубины кадра. Звезда-блик
 * принадлежит небу, а модули игры друг друга не импортируют (см. `CLAUDE.md`) —
 * значит источник у нас свой, маленький шар, невидимый основному проходу, и
 * поставить его надо ровно туда же, где небо рисует блик.
 *
 * Три числа ниже — копии из `sky.ts`: направление на блик, радиус его слоя и
 * закон общего дрейфа неба. Радиус берётся от `SKY.radius`, то есть из общего
 * конфига; направление и дрейф скопированы. Если в небе их поменяют, лучи
 * поедут — расхождение видно сразу, лучи просто пойдут не из звезды.
 *
 * Дрейф считаем по формуле цели, без `damp`, в отличие от неба. Небо тянется к
 * цели со скоростью 5 1/с, а сама цель меняется на 0.0022 рад/с на максималке —
 * отставание выходит порядка 0.0005 рад, это доли пикселя. Зато на рестарте,
 * где небо ставит дрейф мгновенно, мы совпадаем с ним точно и без своего
 * детектора «дистанция прыгнула назад».
 */
const R_FLARE = SKY.radius * 0.88;
/** `FLARE_DIR` из `sky.ts`, уже нормированный и умноженный на радиус слоя. */
const FLARE_LEN = Math.hypot(0.3, 0.6, 1);
const FLARE_PX = (0.3 / FLARE_LEN) * R_FLARE;
const FLARE_PY = (0.6 / FLARE_LEN) * R_FLARE;
const FLARE_PZ = (-1 / FLARE_LEN) * R_FLARE;
/** `SPIN_PER_M`, `SPIN_LIMIT`, `YAW_PARALLAX` из `sky.ts`. */
const SKY_SPIN_PER_M = 0.000028;
const SKY_SPIN_LIMIT = 0.24;
const SKY_YAW_PARALLAX = 0.05;
/** `W_FLARE` из `sky.ts`: в главах 1 и 2 звезда почти погашена, лучей быть не должно. */
const W_FLARE = [1, 0.3, 0.12, 1] as const;

/* ---------- god rays: как они выглядят ---------- */

/**
 * Радиус шара-источника, м. На расстоянии `R_FLARE` это примерно 3.5° по
 * вертикали — размер яркого ядра блика вместе с ближним ореолом. Больше — лучи
 * становятся веером прожектора, меньше — рассыпаются в пунктир на сэмплах.
 */
const RAY_SOURCE_R = 70;

/**
 * Сэмплов на пиксель. У библиотеки умолчание 60; здесь 24 — при `density` 0.9
 * шаг между сэмплами выходит 3.75 % пути до звезды, а лучи и так уходят в
 * размытие. Это самая дорогая цифра во всём файле: 24 выборки на пиксель
 * половинного (точнее, 0.4) кадра.
 */
const RAY_SAMPLES = 24;
/** Какую долю пути до звезды проходит марш сэмплов. */
const RAY_DENSITY = 0.9;
/** Затухание вклада вдоль луча. */
const RAY_DECAY = 0.93;
const RAY_WEIGHT = 0.3;
/**
 * Общий множитель. Сумма весов на самой звезде — около 0.3 × 11.5 ≈ 3.4, так
 * что 0.11 даёт там ~0.37 в линейном HDR, а по краям лучей на порядок меньше.
 * Кадр и без того однажды признали слишком ярким: лучи должны читаться как
 * дымка в воздухе, а не как второй источник света.
 */
const RAY_EXPOSURE = 0.11;
/** Потолок вклада, чтобы ядро не выбелилось до тонального оператора. */
const RAY_CLAMP = 0.4;
/** Доля кадра, на которой считаются лучи. */
const RAY_SCALE = 0.4;

/** Базовая непрозрачность подмешивания и скорость её подтягивания, 1/с. */
const RAYS_OPACITY = 0.9;
/** Та же скорость, что у кроссфейда слоёв неба (`FADE_RATE` в `sky.ts`). */
const RAYS_RATE = 1.6;

/* ---------- смаз на скорости ---------- */

/**
 * Радиальный смаз к центру кадра — не полноценный motion blur.
 *
 * В референсе (f_001, f_007) деревья на обочине размазаны в полосы, а дорога в
 * середине кадра остаётся резкой: смаз идёт вдоль радиуса от центра и растёт к
 * краям. Ровно это и делает шейдер ниже, и ровно поэтому он не мажет середину:
 * там водитель читает дорогу.
 *
 * Своим проходом это было бы 1–2 полноэкранные отрисовки; как `Effect` оно
 * вклеивается в общий шейдер и стоит только своих выборок — и только там, где
 * `k` вообще больше нуля.
 */
const ZOOM_TAPS = 6;
/**
 * Максимальный сдвиг выборки, доля от вектора «пиксель → центр». В углу длина
 * этого вектора 0.707, поэтому предельный сдвиг там — около 2.4 % кадра.
 */
const ZOOM_SPREAD = 0.034;
/** Максимальная доля размытого в смеси. Половина — предел, за которым мутит. */
const ZOOM_MIX = 0.5;

/** С какой доли от потолка скорости смаз начинается и где выходит на полку. */
const BLUR_FROM = 0.5;
const BLUR_FULL = 1.05;
/** Вклад чистой скорости и добавка нитро. Сумма зажата единицей. */
const BLUR_CRUISE = 0.34;
const BLUR_NITRO = 0.5;
/** Скорость набора и спада, 1/с. Набор быстрее: нитро должно отзываться. */
const BLUR_RISE = 4;
const BLUR_FALL = 2.2;

/**
 * Фрагментная часть смаза.
 *
 * `inputBuffer` — вход всего прохода, то есть кадр до SMAA и до bloom; из него
 * берутся выборки. `inputColor` — цвет, накопленный предыдущими эффектами (у
 * нас это SMAA, то есть тот же кадр со сглаженными краями). Смешивать их можно:
 * численно это одно и то же изображение.
 *
 * `k` растёт квадратом расстояния от центра, поэтому середина кадра остаётся
 * нетронутой не «почти», а буквально — там срабатывает ранний выход, и ни одной
 * лишней выборки не делается.
 */
const ZOOM_FRAG = `
uniform float amount;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
	vec2 off = uv - vec2(0.5);
	// 1.4142 — нормировка: длина off в углу кадра равна 0.7071.
	float d = min(length(off) * 1.4142, 1.0);
	float k = amount * d * d;

	if (k < 0.004) {
		outputColor = inputColor;
		return;
	}

	vec3 acc = vec3(0.0);

	for (int i = 1; i <= ZOOM_TAPS; ++i) {
		float t = float(i) * ZOOM_STEP;
		acc += texture2D(inputBuffer, uv - off * (t * k * ZOOM_SPREAD)).rgb;
	}

	outputColor = vec4(mix(inputColor.rgb, acc * ZOOM_STEP, k * ZOOM_MIX), inputColor.a);
}
`;

/**
 * Смаз как эффект общего прохода.
 *
 * Атрибуты намеренно `NONE`, хотя шейдер и читает соседние тексели: `CONVOLUTION`
 * у двух эффектов в одном проходе — исключение при сборке материала, а этот
 * атрибут уже занят SMAA. Ничего, кроме сортировки и проверки на склейку, он не
 * решает: доступ к `inputBuffer` есть у любого эффекта.
 */
class ZoomBlurEffect extends Effect {
  private readonly uAmount: Uniform;

  constructor() {
    const amount: Uniform = new Uniform(0);
    super("ZoomBlurEffect", ZOOM_FRAG, {
      // SRC, а не ADD: эффект не добавляет света, он подменяет цвет смесью.
      blendFunction: BlendFunction.SRC,
      defines: new Map<string, string>([
        ["ZOOM_TAPS", ZOOM_TAPS.toFixed(0)],
        ["ZOOM_STEP", (1 / ZOOM_TAPS).toFixed(8)],
        ["ZOOM_SPREAD", ZOOM_SPREAD.toFixed(5)],
        ["ZOOM_MIX", ZOOM_MIX.toFixed(5)],
      ]),
      uniforms: new Map<string, Uniform>([["amount", amount]]),
    });
    this.uAmount = amount;
  }

  /** Сила смаза 0…1. Ноль — ранний выход в шейдере, эффекта нет совсем. */
  set amount(v: number) {
    this.uAmount.value = v;
  }
}

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

  // Смаз есть на «обычно» и на «красиво». На «экономно» цепочки нет вовсе, так
  // что отдельной проверки качества ему не нужно.
  const zoom = new ZoomBlurEffect();

  /* --- god rays, только «красиво» --- */

  /**
   * Источник лучей.
   *
   * Он живёт не в сцене игры, а в собственной сцене эффекта (`lightScene`), и
   * поэтому невидим основному проходу — второго ядра поверх звезды неба не
   * появляется. `GodRaysEffect.update` каждый кадр перекладывает источник в эту
   * же сцену и возвращает его родителю; родитель у нас и есть `lightScene`, так
   * что перекладывание вырождается в две проверки.
   *
   * Порядок в кадре: композер сперва рисует сцену (RenderPass), затем блитует её
   * глубину в стабильный таргет, и только потом эффект копирует эту глубину в
   * свой буфер и рисует поверх неё шар. Оттого лес, горы и фуры честно режут
   * лучи — ровно то, ради чего всё это и делается.
   *
   * `lightScene` нет в d.ts библиотеки — отсюда приведение.
   */
  const raysOn = ctx.quality === 2;
  const raySourceGeom = raysOn ? new SphereGeometry(1, 12, 8) : null;
  const raySourceMat = raysOn
    ? new MeshBasicMaterial({
        color: new Color(COLORS.star),
        // Тонмаппинг и туман источнику не нужны: он не попадает в кадр, его
        // рисуют только в чёрный вспомогательный таргет.
        toneMapped: false,
        fog: false,
        // Оба поля эффект всё равно выставит сам; ставим сразу, чтобы материал
        // не пересобирался на первом кадре.
        depthWrite: false,
        transparent: true,
      })
    : null;
  const raySource =
    raySourceGeom && raySourceMat ? new Mesh(raySourceGeom, raySourceMat) : null;
  const godRays =
    raySource !== null
      ? new GodRaysEffect(ctx.camera, raySource, {
          // ADD, а не SCREEN (умолчание библиотеки): по тем же причинам, что и
          // у bloom — в буфере значения больше единицы, и SCREEN их бы гасил.
          blendFunction: BlendFunction.ADD,
          samples: RAY_SAMPLES,
          density: RAY_DENSITY,
          decay: RAY_DECAY,
          weight: RAY_WEIGHT,
          exposure: RAY_EXPOSURE,
          clampMax: RAY_CLAMP,
          resolutionScale: RAY_SCALE,
          // Размытие сглаживает ступеньки на краю источника. Шар и так гладкий,
          // поэтому самое дешёвое ядро.
          blur: true,
          kernelSize: KernelSize.VERY_SMALL,
        })
      : null;
  if (godRays !== null && raySource !== null) {
    raySource.name = "Effects.RaySource";
    raySource.scale.setScalar(RAY_SOURCE_R);
    // Звезда стоит у верхней кромки кадра и часто выходит за неё наполовину.
    // С отсечением по пирамиде она бы пропадала целиком и лучи гасли скачком.
    raySource.frustumCulled = false;
    (godRays as unknown as { lightScene: Scene }).lightScene.add(raySource);
    // Первый кадр — без лучей: силу подтянет `damp` в `update`.
    godRays.blendMode.opacity.value = 0;
  }

  const passEffects: Effect[] = [smaa];
  if (godRays !== null) passEffects.push(godRays);
  passEffects.push(zoom, bloom, vignette, tone);

  const merged = new EffectPass(ctx.camera, ...passEffects);

  /**
   * Заглушка вместо буфера глубины — только когда god rays выключены.
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
   *
   * А вот god rays глубину читают по-настоящему: без неё их `copyPass` не
   * перенесёт силуэты леса в свой буфер, и лучи пойдут сквозь деревья. Поэтому
   * на «красиво» заглушки нет, и три буфера глубины заводятся осознанно — это
   * и есть цена окклюзии.
   */
  const depthStub = godRays === null ? new Texture() : null;
  if (depthStub !== null) {
    depthStub.name = "Effects.DepthStub";
    merged.setDepthTexture(depthStub);
  }
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
  /** Сглаженная сила радиального смаза, 0…1. */
  let blur = 0;
  /** Сглаженная непрозрачность лучей, 0…1. */
  let rays = 0;
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

      /* --- радиальный смаз --- */

      // Порог меряется в долях от потолка, а не в м/с: потолок растёт с
      // дистанцией, и «быстро» в начале заезда и на пятом километре — разные
      // числа. Нитро добавляет сверху и заодно уводит долю за единицу, поэтому
      // на нитро смаз всегда сильнее собственного максимума крейсера.
      const blurTo = calm
        ? 0
        : clamp01(
            inv(BLUR_FROM, BLUR_FULL, g.speed / PHYS.speedMax) * BLUR_CRUISE +
              (g.nitroActive ? BLUR_NITRO : 0),
          );
      blur = damp(blur, blurTo, blurTo > blur ? BLUR_RISE : BLUR_FALL, dt);
      zoom.amount = blur;

      /* --- god rays --- */

      if (godRays !== null && raySource !== null) {
        // Дрейф неба вокруг Y — та же формула, что в `sky.ts` (см. блок
        // констант выше). Поворот точки: x' = x·cos + z·sin, z' = −x·sin + z·cos.
        const spin =
          -SKY_SPIN_LIMIT * Math.sin((g.s * SKY_SPIN_PER_M) / SKY_SPIN_LIMIT) -
          g.yaw * SKY_YAW_PARALLAX;
        const cs = Math.cos(spin);
        const sn = Math.sin(spin);
        raySource.position.set(
          FLARE_PX * cs + FLARE_PZ * sn,
          FLARE_PY,
          -FLARE_PX * sn + FLARE_PZ * cs,
        );
        // Источник лежит в чужой сцене, и никто, кроме нас, его матрицу не
        // пересчитает: `GodRaysEffect.update` перед отрисовкой снимает
        // `matrixAutoUpdate`, то есть читает `matrix` как есть.
        raySource.updateMatrix();

        // Вес блика по главе — копия таблицы из `sky.ts`. В главах, где звезда
        // почти погашена, лучи обязаны погаснуть вместе с ней, иначе они висят
        // в небе сами по себе.
        const n = W_FLARE.length;
        const ch = ((g.chapter % n) + n) % n;
        const nx = (ch + 1) % n;
        const f = SKY.fade > 0 ? smoothstep(1 - SKY.fade, 1, clamp01(g.chapterT)) : 0;
        const raysTo = RAYS_OPACITY * lerp(W_FLARE[ch], W_FLARE[nx], f);
        rays = damp(rays, raysTo, RAYS_RATE, dt);
        godRays.blendMode.opacity.value = rays;
      }
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
     * - `RenderPass` держит только свой ClearPass, он же его и освобождает;
     * - у god rays тем же обходом уходят три таргета (световой, A и B), проход
     *   света со своим ClearPass, размытие, copyPass и материал лучей;
     * - три буфера глубины, если они заводились, снимает `composer.dispose`.
     *
     * Мимо обхода проходят четыре вещи: справочные текстуры SMAA (лежат в
     * униформах материала весов), заглушка глубины (её никто не считает своей)
     * и геометрия с материалом шара-источника — `Effect.dispose` смотрит только
     * на собственные поля эффекта, а меш лежит в его вспомогательной сцене.
     * Снимаем сами, до общего обхода.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeSmaaLuts();
      depthStub?.dispose();
      raySource?.removeFromParent();
      raySourceGeom?.dispose();
      raySourceMat?.dispose();
      composer.dispose();
      renderer.autoClear = autoClearWas;
    },
  };
}
