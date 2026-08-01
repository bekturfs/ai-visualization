/**
 * Контракт слоя отрисовки после отказа от React.
 *
 * Раньше сцену держал react-three-fiber: он вызывал `useFrame`, освобождал
 * ресурсы при размонтировании и следил за размером холста. Теперь это делает
 * `main.ts`, а каждый кусок сцены — обычная фабрика, возвращающая `System`.
 *
 * Свойство, ради которого контракт вообще существует: системы ничего не знают
 * друг о друге и общаются только через `Game` и `RenderCtx`. Именно оно
 * позволяет писать их по одной на модуль, независимо и параллельно, — и оно же
 * не даёт вернуться к общей императивной `init()`, в которой всё связано со всем.
 */

import type * as THREE from "three";
import type { Game, HudSnapshot, Quality } from "./types";

/** Всё, что система знает о внешнем мире отрисовки. */
export interface RenderCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Размер холста в CSS-пикселях и текущий dpr. */
  size: { w: number; h: number; dpr: number };
  quality: Quality;
}

/**
 * Кусок сцены: своя геометрия, своё обновление в кадре, своё освобождение.
 *
 * Правила те же, что были у компонентов, и они не смягчились от ухода React:
 * ноль аллокаций в `update`, всё сглаживание через `damp` из `num.ts`, каждый
 * созданный ресурс освобождается в `dispose`.
 */
export interface System {
  /**
   * Корневой объект. `main.ts` добавит его в сцену при создании и уберёт при
   * `dispose`. Системе, которая ничего не рисует (камера, постобработка),
   * возвращать нечего.
   */
  readonly object?: THREE.Object3D;
  /** Кадр. `dt` уже ограничен сверху вызывающим. */
  update(g: Game, dt: number, ctx: RenderCtx): void;
  /** Холст изменил размер. Не вызывается до первого кадра. */
  resize?(ctx: RenderCtx): void;
  dispose(): void;
}

export type SystemFactory = (ctx: RenderCtx) => System;

/**
 * Оверлей над холстом: приборка, HUD, экраны.
 *
 * Разделение на `sync` и `frame` — не украшательство, а то самое разделение,
 * которое раньше держалось на связке «снимок 12 Гц плюс rAF по refs». Цифры,
 * меняющиеся редко, обновляются по снимку; стрелки и полосы, которые должны
 * течь плавно, — каждый кадр и напрямую из `Game`.
 */
export interface Overlay {
  readonly el: HTMLElement;
  /** Редкое обновление по снимку, примерно двенадцать раз в секунду. */
  sync(snap: HudSnapshot): void;
  /** Каждый кадр. Только для того, что обязано быть плавным. */
  frame?(g: Game, dt: number): void;
  dispose(): void;
}

export type OverlayFactory = (host: HTMLElement) => Overlay;
