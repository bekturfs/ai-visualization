/**
 * Ввод: клавиатура, указатель и видимость страницы → `g.input`.
 *
 * Модуль намеренно «немой» для React: он ничего не рендерит и не хранит
 * состояния, которое React мог бы увидеть. Всё, что он делает, — мутирует
 * `g.input` в том же объекте `Game`, который читает шаг физики.
 *
 * Две независимые оси руля (клавиатурная и тач) живут раздельно и сводятся в
 * одну при каждой записи: клавиатура главнее, тач подхватывает, когда клавиши
 * отпущены. Иначе палец и стрелка дерутся за одно поле и руль дёргается.
 *
 * Коды клавиш берём из `e.code`, а не из `e.key`: `e.key` зависит от раскладки,
 * и на русской раскладке `W`/`A`/`S`/`D` приходят как `ц`/`ф`/`ы`/`в`. Интерфейс
 * игры русский, так что это не теоретическая проблема.
 */

import type { Game } from "./types";
import { clamp } from "./num";

/* ---------- разделяемое состояние ввода ---------- */

/**
 * Коды удерживаемых клавиш. Множество, а не счётчики: автоповтор keydown летит
 * десятками в секунду и не должен ничего «накапливать», а отпускание одной из
 * двух зажатых стрелок должно корректно возвращать руль на вторую.
 */
const held = new Set<string>();

/** Ось руля от клавиатуры, −1…+1. */
let keyAxis = 0;
/** Ось руля от тача/драга, −1…+1. */
let touchAxis = 0;

/** Состояние экранных кнопок HUD и тач-педалей. */
const touchButtons = { throttle: false, brake: false, nitro: false };

/** Колбэк «первый жест пользователя» и флаг, что он уже отработал. */
let gestureCb: (() => void) | null = null;
let gestureFired = false;

/** Доля ширины экрана, на которой драг выкручивает руль до упора. */
const TOUCH_SPAN = 0.22;

/* ---------- сведение осей в g.input ---------- */

/** Пересобрать `g.input` из текущих клавиш, тач-осей и кнопок. */
function applyTo(g: Game): void {
  const left = held.has("ArrowLeft") || held.has("KeyA");
  const right = held.has("ArrowRight") || held.has("KeyD");
  // Обе зажаты — руль по центру, а не «кто последний».
  keyAxis = (right ? 1 : 0) - (left ? 1 : 0);

  const inp = g.input;
  inp.steer = keyAxis !== 0 ? keyAxis : touchAxis;

  const braking = held.has("ArrowDown") || held.has("KeyS") || touchButtons.brake;
  const gas = held.has("ArrowUp") || held.has("KeyW") || touchButtons.throttle;

  inp.brake = braking ? 1 : 0;
  // Газ по умолчанию 1: игра разгоняется сама, клавиша газа только
  // «подтверждает» намерение и держит полку во время торможения.
  inp.throttle = braking && !gas ? 0 : 1;

  inp.nitro =
    touchButtons.nitro ||
    held.has("Space") ||
    held.has("ShiftLeft") ||
    held.has("ShiftRight");
}

/** Снять всё: ни одной «залипшей» клавиши и ни одной зажатой кнопки. */
function releaseAll(g: Game): void {
  held.clear();
  touchAxis = 0;
  touchButtons.throttle = false;
  touchButtons.brake = false;
  touchButtons.nitro = false;
  applyTo(g);
}

/** Первый жест за сессию — по нему вызывающий разблокирует WebAudio. */
function markGesture(): void {
  if (gestureFired || gestureCb === null) return;
  gestureFired = true;
  gestureCb();
}

/* ---------- какой элемент под фокусом ---------- */

function asElement(t: EventTarget | null): HTMLElement | null {
  return t !== null && typeof (t as HTMLElement).tagName === "string"
    ? (t as HTMLElement)
    : null;
}

/** Поле ввода текста: такие события вообще не наши. */
function isTextEntry(t: EventTarget | null): boolean {
  const el = asElement(t);
  if (el === null) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * Кнопка/ссылка оверлея. На них нельзя ни глотать Space/Enter, ни звать
 * `preventDefault` — иначе интерфейс перестаёт управляться с клавиатуры.
 */
function isInteractive(t: EventTarget | null): boolean {
  const el = asElement(t);
  if (el === null) return false;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return true;
  const role = el.getAttribute("role");
  return role === "button" || role === "link" || role === "menuitem";
}

function isArrow(code: string): boolean {
  return (
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "ArrowLeft" ||
    code === "ArrowRight"
  );
}

/* ---------- клавиатура и видимость ---------- */

export interface InputHooks {
  onPause(): void;
  onRestart(): void;
  onMute(): void;
  onStart(): void;
  onFirstGesture(): void;
}

/**
 * Подписаться на клавиатуру, потерю фокуса и уход вкладки в фон.
 * Возвращает функцию, снимающую ровно те же слушатели.
 */
export function bindInput(g: Game, hooks: InputHooks): () => void {
  if (typeof window === "undefined") return () => {};

  gestureCb = hooks.onFirstGesture;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.target)) return;
    markGesture();

    const code = e.code;
    const uiFocused = isInteractive(e.target);

    // Space/Enter на кнопке оверлея принадлежат кнопке, не игре.
    if (uiFocused && (code === "Space" || code === "Enter" || code === "NumpadEnter")) {
      return;
    }
    // Гасим прокрутку страницы стрелками и пробелом — но только когда активная
    // поверхность действительно игра. Tab не трогаем никогда.
    if (!uiFocused && (code === "Space" || isArrow(code))) e.preventDefault();

    // Автоповтор не должен повторно дёргать действия-однократки.
    const fresh = !e.repeat && !held.has(code);
    held.add(code);

    if (fresh) {
      if (code === "Escape" || code === "KeyP") hooks.onPause();
      else if (code === "KeyR") hooks.onRestart();
      else if (code === "KeyM") hooks.onMute();
      else if (code === "Enter" || code === "NumpadEnter" || code === "Space") {
        if (g.phase === "menu") hooks.onStart();
      }
    }

    applyTo(g);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    held.delete(e.code);
    applyTo(g);
  };

  /** Фокус ушёл — руки с клавиатуры сняты, что бы там ни было зажато. */
  const onBlur = (): void => {
    releaseAll(g);
    if (g.phase === "playing") hooks.onPause();
  };

  const onVisibility = (): void => {
    if (document.hidden) onBlur();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    held.clear();
    applyTo(g);
    if (gestureCb === hooks.onFirstGesture) gestureCb = null;
  };
}

/* ---------- тач: экранные кнопки ---------- */

/** Руль от экранного элемента (драг, слайдер, геймпад-стик HUD). */
export function setTouchSteer(g: Game, v: number): void {
  touchAxis = Number.isFinite(v) ? clamp(v, -1, 1) : 0;
  applyTo(g);
}

/** Нажатие/отпускание экранной кнопки газа, тормоза или нитро. */
export function setTouchButton(
  g: Game,
  b: "throttle" | "brake" | "nitro",
  down: boolean,
): void {
  if (down) markGesture();
  touchButtons[b] = down;
  applyTo(g);
}

/* ---------- тач: рулевая поверхность ---------- */

/**
 * Сделать элемент (обычно обёртку канваса) рулевой поверхностью: горизонтальный
 * драг от точки касания = руль. Мультитач игнорируем — ведём только первый
 * активный `pointerId`, вторым пальцем в это время жмут кнопки HUD.
 *
 * `touch-action: none` на элементе — забота вызывающего (CSS), иначе браузер
 * заберёт горизонтальный драг себе под скролл.
 */
export function bindTouchSurface(g: Game, el: HTMLElement): () => void {
  let activeId = -1;
  let originX = 0;

  const release = (id: number): void => {
    if (activeId !== id) return;
    activeId = -1;
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    setTouchSteer(g, 0);
  };

  const onDown = (e: PointerEvent): void => {
    if (activeId !== -1) return;
    markGesture();
    // Захват указателя переадресует и mouseup, поэтому клик по кнопке внутри
    // поверхности до неё не доходит. Рулим только тем, что рулём и является:
    // палец, во время заезда, мимо интерфейса.
    if (e.pointerType === "mouse") return;
    if (g.phase !== "playing" && g.phase !== "crashed") return;
    const target = e.target;
    if (
      target instanceof Element &&
      target.closest("button, a, input, select, textarea, [role='button']")
    ) {
      return;
    }
    activeId = e.pointerId;
    originX = e.clientX;
    el.setPointerCapture(e.pointerId);
    setTouchSteer(g, 0);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== activeId) return;
    // Полный руль — на четверти ширины экрана: большой палец столько и проходит.
    const span = Math.max(1, el.clientWidth * TOUCH_SPAN);
    setTouchSteer(g, (e.clientX - originX) / span);
  };

  const onUp = (e: PointerEvent): void => release(e.pointerId);

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("pointerleave", onUp);

  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("pointerleave", onUp);
    activeId = -1;
    setTouchSteer(g, 0);
  };
}
