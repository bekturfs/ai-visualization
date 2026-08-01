/// <reference types="vite/client" />
/**
 * Панель настройки и счётчик кадров. Только для разработки.
 *
 * Появилась не от любви к инструментам. Яркость линий и огней однажды правилась
 * вслепую — по фразе «горит слишком ярко» с чужого экрана, которого я не вижу, —
 * и это стоило двух лишних кругов правок. Панель переворачивает петлю обратной
 * связи: числа крутит тот, кто смотрит на картинку, а найденные значения потом
 * переносятся в `TUNE` как новые умолчания. Кнопка «скопировать TUNE» отдаёт их
 * готовым куском кода.
 *
 * В прод-сборку не попадает: и вызов, и сам модуль стоят под `import.meta.env.DEV`,
 * а `lil-gui` со `stats.js` подтягиваются динамическим импортом внутри — Vite
 * выбрасывает всю ветку целиком.
 */

import { QUALITY, TUNE } from "./config";
import type { Game, Quality } from "./types";

export interface DevTools {
  /** Начало кадра — до всей работы. */
  begin(): void;
  /** Конец кадра — после отрисовки. */
  end(): void;
  dispose(): void;
}

export interface DevToolsOpts {
  /** Пересобрать сцену: почти все ручки читаются при сборке систем. */
  rebuild(): void;
}

/** Собрать панель. Возвращает `null`, если что-то пошло не так, — это не повод падать. */
export async function createDevTools(g: Game, opts: DevToolsOpts): Promise<DevTools | null> {
  try {
    const [{ default: GUI }, statsMod] = await Promise.all([
      import("lil-gui"),
      import("stats.js"),
    ]);
    const Stats = statsMod.default;

    /* --- счётчик кадров --- */
    const stats = new Stats();
    stats.showPanel(0);
    const sd = stats.dom;
    sd.style.cssText = "position:fixed;top:0;left:0;z-index:9999;cursor:pointer;opacity:0.9";
    document.body.appendChild(sd);

    /* --- панель --- */
    // В `body`, а не в контейнер оверлеев. Причин две, и обе кусаются: со своим
    // контейнером lil-gui не включает автопозиционирование и остаётся
    // непозиционированным, а на таком элементе z-index не действует — панель
    // уезжала под размытую подложку меню. И контейнер оверлеев вдобавок
    // `pointer-events: none`, что пришлось бы отменять вручную.
    const gui = new GUI({ title: "Starry Ride — настройка" });
    gui.domElement.style.zIndex = "9999";

    // Пересборка на каждое движение ползунка была бы рывками: почти всё
    // читается при сборке систем, а сборка не бесплатна. Копим и делаем одну.
    let pending = 0;
    const rebuild = (): void => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = 0;
        opts.rebuild();
      }, 120);
    };

    const road = gui.addFolder("Разметка");
    road.add(TUNE.road, "centerNear", 0, 2, 0.02).name("осевая, вблизи").onChange(rebuild);
    road.add(TUNE.road, "centerFar", 0, 2, 0.02).name("осевая, вдали").onChange(rebuild);
    road.add(TUNE.road, "sideNear", 0, 2, 0.02).name("край, вблизи").onChange(rebuild);
    road.add(TUNE.road, "sideFar", 0, 2, 0.02).name("край, вдали").onChange(rebuild);

    const lights = gui.addFolder("Огни");
    lights.add(TUNE.lights, "glow", 0, 4, 0.05).name("головы фонарей").onChange(rebuild);
    lights.add(TUNE.lights, "pool", 0, 3, 0.05).name("пятно на асфальте").onChange(rebuild);
    lights.add(TUNE.lights, "town", 0, 3, 0.05).name("огни городка").onChange(rebuild);

    const sky = gui.addFolder("Небо");
    // Мерцание читается каждый кадр из TUNE — единственная ручка без пересборки.
    sky.add(TUNE.sky, "twinkle", 0, 1, 0.02).name("мерцание звёзд");

    const bloomF = gui.addFolder("Свечение (текущее качество)");
    const bloomKnobs = { strength: 0, radius: 0, threshold: 0 };
    const syncBloom = (): void => {
      const p = QUALITY[g.quality];
      bloomKnobs.strength = p.bloomStrength;
      bloomKnobs.radius = p.bloomRadius;
      bloomKnobs.threshold = p.bloomThreshold;
      bloomF.controllers.forEach((c) => c.updateDisplay());
    };
    const applyBloom = (): void => {
      const p = QUALITY[g.quality];
      p.bloomStrength = bloomKnobs.strength;
      p.bloomRadius = bloomKnobs.radius;
      p.bloomThreshold = bloomKnobs.threshold;
      rebuild();
    };
    bloomF.add(bloomKnobs, "strength", 0, 3, 0.02).name("сила").onChange(applyBloom);
    bloomF.add(bloomKnobs, "radius", 0, 1, 0.01).name("радиус").onChange(applyBloom);
    bloomF.add(bloomKnobs, "threshold", 0, 1, 0.01).name("порог").onChange(applyBloom);
    syncBloom();

    const actions = {
      качество: String(g.quality),
      "скопировать TUNE": () => {
        const text =
          "export const TUNE = " +
          JSON.stringify(TUNE, null, 2) +
          ";\n\n// свечение текущего пресета: " +
          JSON.stringify({
            bloomStrength: QUALITY[g.quality].bloomStrength,
            bloomRadius: QUALITY[g.quality].bloomRadius,
            bloomThreshold: QUALITY[g.quality].bloomThreshold,
          });
        void navigator.clipboard?.writeText(text).catch(() => {});
        // Консоль — запасной путь: буфер обмена требует защищённого контекста.
        console.log(text);
      },
    };
    gui
      .add(actions, "качество", { экономно: "0", обычно: "1", красиво: "2" })
      .onChange((v: string) => {
        g.quality = Number(v) as Quality;
        syncBloom();
        opts.rebuild();
      });
    gui.add(actions, "скопировать TUNE").name("скопировать TUNE в консоль");

    return {
      begin: () => stats.begin(),
      end: () => stats.end(),
      dispose: () => {
        if (pending) clearTimeout(pending);
        gui.destroy();
        sd.remove();
      },
    };
  } catch (e) {
    console.warn("панель настройки не поднялась:", e);
    return null;
  }
}
