import { useEffect, useState } from "react";
import type { Exercise } from "../types";
import { MOTIONS, DEFAULT_MOTION } from "./motions";
import { Figure, useCycle } from "./Figure";
import { photoUrls, videoSearchUrl } from "../data/exercises";
import { setVideo, useFit } from "../store";
import { Btn } from "../ui";

/** Схема движения: две фазы, плавный цикл между ними. */
export function ExerciseArt({
  ex,
  animate = false,
  showPhase = false,
  className = "",
}: {
  ex: Exercise;
  animate?: boolean;
  showPhase?: boolean;
  className?: string;
}) {
  const motion = MOTIONS[ex.motion] ?? DEFAULT_MOTION;
  const t = useCycle(motion.period ?? 2.6, animate);
  return (
    <div className={className}>
      <Figure motion={motion} t={t} className="w-full" />
      {showPhase && (
        <div className="mt-1 text-center text-xs text-muted">
          {motion.phases[t < 0.5 ? 0 : 1]}
        </div>
      )}
    </div>
  );
}

/** Фотографии старта и финиша. Нет сети или картинки нет — блок молча исчезает. */
function Photos({ ex }: { ex: Exercise }) {
  const urls = photoUrls(ex.photo);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [ex.id]);
  if (!urls || failed) {
    return (
      <p className="text-sm text-muted">
        Фотографий нет — смотри схему движения или видео.
      </p>
    );
  }
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {urls.map((u, i) => (
          <figure key={u} className="overflow-hidden rounded-xl border border-edge">
            <img
              src={u}
              alt={`${ex.name}: ${i === 0 ? "начало" : "конец"} движения`}
              loading="lazy"
              onError={() => setFailed(true)}
              referrerPolicy="no-referrer"
              className="aspect-4/3 w-full bg-panel2 object-cover"
            />
            <figcaption className="px-2 py-1 text-center text-xs text-muted">
              {i === 0 ? "начало" : "конец"}
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">
        Фото из открытой базы free-exercise-db (CC0), грузятся из интернета.
      </p>
    </div>
  );
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Достаёт id ролика YouTube. Всё, что не проходит проверку, плеером не станет. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (u.pathname.startsWith("/embed/")) id = u.pathname.slice(7);
    else if (u.pathname.startsWith("/shorts/")) id = u.pathname.slice(8);
  }
  if (!id) return null;
  id = id.split("/")[0];
  return YT_ID.test(id) ? id : null;
}

/** Кликабельной делаем только https: ни javascript:, ни data:, ни голый http. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function Video({ ex }: { ex: Exercise }) {
  const saved = useFit((s) => s.videos[ex.id] ?? "");
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved, ex.id]);

  const id = saved ? youtubeId(saved) : null;
  const href = saved ? safeHref(saved) : null;

  return (
    <div className="space-y-3">
      {id ? (
        <div className="aspect-video overflow-hidden rounded-xl border border-edge">
          <iframe
            className="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${id}`}
            title={`Видео: ${ex.name}`}
            allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            referrerPolicy="strict-origin-when-cross-origin"
            loading="lazy"
            allowFullScreen
          />
        </div>
      ) : href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate rounded-xl border border-edge bg-panel2 px-3 py-2 text-sm text-accent"
        >
          {href}
        </a>
      ) : (
        <p className="text-sm text-muted">
          Своего ролика ещё нет. Можно открыть поиск техники на YouTube и
          сохранить сюда ссылку — она встроится плеером.
        </p>
      )}

      <a
        href={videoSearchUrl(ex)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center rounded-xl border border-edge px-4 text-[15px] text-soft transition hover:border-accent/60 hover:text-ink"
      >
        Найти технику на YouTube ↗
      </a>

      <div>
        <label className="mb-1 block text-xs text-muted" htmlFor={`vid-${ex.id}`}>
          Своя ссылка на видео
        </label>
        <div className="flex gap-2">
          <input
            id={`vid-${ex.id}`}
            type="url"
            inputMode="url"
            placeholder="https://youtu.be/…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-edge bg-panel2 px-3 text-sm text-ink outline-none focus-visible:border-accent"
          />
          <Btn onClick={() => setVideo(ex.id, draft)} variant="primary">
            Сохранить
          </Btn>
        </div>
        {saved && !id && href && (
          <p className="mt-1 text-xs text-amber">
            Это не YouTube — плеер не встроится, останется ссылкой.
          </p>
        )}
        {saved && !href && (
          <p className="mt-1 text-xs text-hot">
            Ссылка не похожа на адрес https:// — открывать её не будем.
          </p>
        )}
      </div>
    </div>
  );
}

type Tab = "draw" | "photo" | "video";

/** Схема / фото / видео — вкладками, чтобы не грузить лишнего. */
export function ExerciseMedia({ ex }: { ex: Exercise }) {
  const photosOn = useFit((s) => s.settings.photos);
  const [tab, setTab] = useState<Tab>("draw");
  useEffect(() => setTab("draw"), [ex.id]);

  const tabs: [Tab, string][] = [
    ["draw", "схема"],
    ...((photosOn ? [["photo", "фото"]] : []) as [Tab, string][]),
    ["video", "видео"],
  ];

  return (
    <div>
      <div role="tablist" aria-label="Как посмотреть упражнение" className="mb-3 flex gap-1">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`min-h-9 rounded-lg px-3 text-sm transition ${
              tab === k
                ? "bg-accent/15 text-accent"
                : "text-muted hover:bg-panel2 hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "draw" && (
        <div className="rounded-xl border border-edge bg-panel2/60 p-2">
          <ExerciseArt ex={ex} animate showPhase className="mx-auto max-w-64" />
        </div>
      )}
      {tab === "photo" && <Photos ex={ex} />}
      {tab === "video" && <Video ex={ex} />}
    </div>
  );
}
