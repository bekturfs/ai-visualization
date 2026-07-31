# PROGRESS — Starry Ride

Живой чек-лист и точка передачи между сессиями. Если контекст сбросился — читай этот
файл, `CLAUDE.md` и `docs/GAME.md`, и продолжай с первого незакрытого пункта.

**Ветка:** `claude/instagram-reel-review-plcthz` · **маршрут игры:** `/#/ride`

## Как продолжить с нуля

```bash
cd /home/user/ai-visualization
git status && git log --oneline -5     # где остановились
npm install                            # если node_modules пуст
npm run build                          # должно проходить чисто; если нет — это и есть первая задача
```

Дальше: найти в чек-листе ниже первый пункт без `[x]`, посмотреть в «Журнал» причину, если
пункт помечен `[~]` (начат, но не закончен), и добить его. Обновлять этот файл тем же
коммитом, что и код.

## Правила, которые нельзя нарушать

1. `npm run build` (`tsc -b && vite build`) проходит чисто **до** каждого коммита.
   `noUnusedLocals` / `noUnusedParameters` включены — неиспользованный параметр ломает сборку.
2. Существующие визуализации (`BigPicture`, `Roles`, `Neuron`, `ForwardPass`,
   `GradientDescent`, `Backprop`, `Tokenization`, `Embeddings`) не трогаем и не ломаем.
3. Новых runtime-зависимостей не добавляем. Bloom — `three/addons/postprocessing/*`.
4. Модули игры импортируют только из `types.ts` / `config.ts` / `rng.ts` / `road.ts`.
5. Пуш только в `claude/instagram-reel-review-plcthz`, через `git push -u origin <branch>`.

## Чек-лист

- [x] 0. Разобрать референс (кадры рила, палитра, что именно цитируем)
- [x] 1. Документы-хендофф: `CLAUDE.md`, `docs/GAME.md`, `PROGRESS.md`
- [ ] 2. Ядро-контракт: `src/game/types.ts`, `config.ts`, `rng.ts`, `road.ts`
- [ ] 3. Логика: `worldGen.ts`, `engine.ts`, `input.ts`, `audio.ts`
- [ ] 4. Сцена: `scene/Sky.tsx`, `Road.tsx`, `Terrain.tsx`, `Traffic.tsx`, `Pickups.tsx`,
      `Effects.tsx`, `Rig.tsx`
- [ ] 5. Оверлеи: `ui/Dashboard.tsx` (SVG-кабина), `ui/Hud.tsx`, `ui/Screens.tsx`
- [ ] 6. Сборка страницы: `src/pages/Ride.tsx`, роут в `App.tsx`, карточка на `Home.tsx`
- [ ] 7. `npm run build` чисто + `scripts/ride-shoot.mjs` (Playwright: заезд, кадры,
      ошибки консоли)
- [ ] 8. Ревью и полировка: утечки/dispose, кадронезависимая физика, тач, низкое
      качество, `prefers-reduced-motion`, доступность экранов
- [ ] 9. README: секция про игру; финальный пуш

## Журнал

### 2026-07-31
- Рил разобран покадрово (ffmpeg 1 fps): вид от водителя, Mercedes W124, красная приборка,
  неоновые полосы, небо меняется каждые ~2 с → «главы неба». Это ИИ-генерация, не съёмка.
- Решения: проект **не** удаляем, игра — отдельный роут; bloom без новых зависимостей;
  состояние игры — один мутируемый объект в ref, React не перерисовывается в кадре.
- Написаны `CLAUDE.md`, `docs/GAME.md`, `PROGRESS.md`.
