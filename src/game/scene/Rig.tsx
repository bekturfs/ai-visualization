/**
 * Камера и атмосфера. Компонент не рисует ничего видимого, но именно он
 * определяет ощущение заезда: покачивание кабины, тряска от удара, крен в
 * повороте, раскрытие объектива на нитро и цвет тумана, в котором тонет
 * дальний план.
 *
 * Камера стоит в начале координат и смотрит в −Z, мир проезжает мимо неё
 * (см. `road.ts`), поэтому здесь нет ни одной абсолютной координаты: только
 * малые смещения от точки (0, CAM.height, 0). Боковое положение машины `g.x`
 * камере тоже не нужно — его уже вычитает `localX`.
 */

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import type { Game } from "../types";
import { CAM, COLORS, FOG, SKY } from "../config";
import { roadPitch } from "../road";
import { clamp01, damp, lerp, smoothstep } from "../num";

/* ---------- настройки, которые нужны только камере ---------- */

/**
 * Доля уклона дороги, которую камера отрабатывает тангажом.
 *
 * Уклон трассы маленький — `roadDY` не превышает 0.038, то есть ~2.2°. Но в
 * кадре он читается сильно: полотно впереди проецируется через
 * `roadY(s) − roadY(camS)` и на подъёме уезжает вверх, закрывая небо. Камера
 * тянется за уклоном (на подъёме — вверх, значит `rotation.x` отрицательный),
 * и дорога остаётся в кадре: выезжая на горку, видишь небо над гребнем, ныряя
 * в ложбину — асфальт. Остаток в четверть уклона намеренно не компенсируется,
 * иначе рельеф перестанет чувствоваться вовсе.
 */
const PITCH_FOLLOW = 0.75;
/** Скорость подтягивания тангажа, 1/с. Небольшой ход «подвески», не жёсткая сцепка. */
const PITCH_RATE = 5.5;

/** Скорость раскрытия объектива на нитро, 1/с. */
const FOV_RATE = 3.4;
/** Меньшую разницу FOV игнорируем: `updateProjectionMatrix` не бесплатен. */
const FOV_EPS = 0.004;
/** Ближе этого к цели — защёлкиваем, иначе damp никогда не сойдётся точно. */
const FOV_SNAP = 0.01;

/**
 * Частоты тряски, рад/с (≈7…16 Гц). Попарно несоизмеримые, поэтому сумма не
 * зацикливается и удар читается как физический джаддер, а не как шум. Именно
 * поэтому здесь синусы от `g.t`, а не `Math.random`: случайность в кадре даёт
 * «песок», а не удар, и вдобавок ломает воспроизводимость.
 */
const SHAKE_FX0 = 47.3;
const SHAKE_FX1 = 71.9;
const SHAKE_FY0 = 59.1;
const SHAKE_FY1 = 97.7;

/**
 * Подмес `COLORS.night2` в туман по главам неба. Купол уводит горизонт как раз
 * в night2, так что земля и небо остаются в одной тональности: под огромной
 * туманностью низ кадра голубеет, на чистом звёздном поле — гаснет почти в ноль.
 * Длина таблицы своя; номер главы берётся по модулю, как в `Sky`.
 */
const FOG_TINT = [0.3, 0.58, 0.4, 0.18] as const;
/** Скорость перекраски тумана, 1/с. Медленно: смена главы не должна «щёлкать». */
const FOG_RATE = 0.9;
/** Меньшее изменение подмеса не трогает цвет тумана. */
const FOG_EPS = 0.002;

/* ---------- рабочие объекты (ни одной аллокации в кадре) ---------- */

const C_FOG_BASE = new THREE.Color(COLORS.night0);
const C_FOG_TINT = new THREE.Color(COLORS.night2);

interface RigState {
  /** Сглаженный тангаж камеры, рад. */
  pitch: number;
  /** Текущий подмес night2 в туман. */
  tint: number;
  /** Подмес, который уже записан в цвет тумана (−1 — ещё ни разу). */
  tintApplied: number;
}

export function Rig({ g }: { g: Game }) {
  const scene = useThree((s) => s.scene);
  const fogRef = useRef<THREE.Fog | null>(null);
  const st = useRef<RigState>({ pitch: 0, tint: FOG_TINT[0], tintApplied: -1 }).current;

  /* --- туман ставится один раз и снимается вместе с компонентом --- */
  useEffect(() => {
    const fog = new THREE.Fog(0x000000, FOG.near, FOG.far);
    fog.color.copy(C_FOG_BASE);

    const prevFog = scene.fog;
    const prevBackground = scene.background;
    scene.fog = fog;
    // Купол неба — полная сфера с BackSide, фон из-под неё не виден никогда;
    // на всякий случай (первый кадр, потеря контекста) за ним стоит clearColor,
    // который выставляет Ride.tsx тем же COLORS.night0.
    scene.background = null;
    fogRef.current = fog;
    st.tintApplied = -1;

    return () => {
      // THREE.Fog не держит ресурсов GPU, освобождать нечего — только вернуть
      // сцене то, что было до нас.
      if (scene.fog === fog) scene.fog = prevFog;
      scene.background = prevBackground;
      fogRef.current = null;
    };
  }, [scene, st]);

  useFrame((state, rawDt) => {
    // Вкладка была в фоне — dt приходит огромным; кадронезависимость от этого
    // не спасает, спасает потолок.
    const dt = rawDt > 0.05 ? 0.05 : rawDt;
    const cam = state.camera;
    const calm = g.reducedMotion;

    /* --- 1. положение: покачивание кабины и тряска --- */

    const bobAmp = calm ? CAM.bobAmp * 0.5 : CAM.bobAmp;
    const bob = Math.sin(g.bob) * bobAmp;
    let ox = bob * 0.5;
    let oy = bob;

    if (!calm && g.shake > 0) {
      // Квадрат — чтобы удар был резким на входе и тихо сходил на нет.
      const amp = g.shake * g.shake * CAM.shakeAmp;
      const t = g.t;
      // Веса дают в сумме единицу: размах не выходит за CAM.shakeAmp.
      ox += (Math.sin(t * SHAKE_FX0) * 0.62 + Math.sin(t * SHAKE_FX1 + 2.1) * 0.38) * amp;
      oy += (Math.sin(t * SHAKE_FY0 + 0.9) * 0.58 + Math.sin(t * SHAKE_FY1 + 4.2) * 0.42) * amp;
    }

    cam.position.set(ox, CAM.height + oy, 0);

    /* --- 2. ориентация: yaw → pitch → roll --- */

    st.pitch = damp(st.pitch, -roadPitch(g.s) * PITCH_FOLLOW, PITCH_RATE, dt);
    // Порядок YXZ обязателен: крен применяется последним, вокруг уже
    // повёрнутой оси взгляда, и не утаскивает курс вбок. При XYZ поворот на
    // курс начал бы подмешиваться в тангаж, и горизонт «поплыл» бы в поворотах.
    cam.rotation.set(st.pitch, g.yaw, g.roll, "YXZ");

    /* --- 3. объектив: нитро раскрывает кадр --- */

    if (cam instanceof THREE.PerspectiveCamera) {
      // На спокойном режиме сюрприз в 14° — слишком резкое движение, отдаём половину.
      const wide = calm ? (CAM.fov + CAM.fovNitro) * 0.5 : CAM.fovNitro;
      const to = g.nitroActive ? wide : CAM.fov;
      let fov = damp(cam.fov, to, FOV_RATE, dt);
      if (Math.abs(fov - to) < FOV_SNAP) fov = to;
      if (Math.abs(fov - cam.fov) > FOV_EPS) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }

    /* --- 4. туман: та же глава, что и у неба --- */

    const fog = fogRef.current;
    if (fog) {
      const n = FOG_TINT.length;
      const ch = ((g.chapter % n) + n) % n;
      const nx = (ch + 1) % n;
      // Тот же кроссфейд, что в Sky: последняя доля SKY.fade подмешивает следующую.
      const f = SKY.fade > 0 ? smoothstep(1 - SKY.fade, 1, clamp01(g.chapterT)) : 0;
      st.tint = damp(st.tint, lerp(FOG_TINT[ch], FOG_TINT[nx], f), FOG_RATE, dt);
      if (Math.abs(st.tint - st.tintApplied) > FOG_EPS) {
        st.tintApplied = st.tint;
        fog.color.copy(C_FOG_BASE).lerp(C_FOG_TINT, st.tint);
      }
    }
  });

  return null;
}
