import { useState } from "react";
import {
  exportJson,
  importJson,
  patchSettings,
  useFit,
  wipeAll,
} from "../store";
import {
  Btn,
  Card,
  SectionTitle,
  Sheet,
  Toggle,
  plural,
} from "../ui";

type Msg = { kind: "ok" | "err"; text: string };

const MSG_CLASS: Record<Msg["kind"], string> = {
  ok: "rounded-xl border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok",
  err: "rounded-xl border border-hot/40 bg-hot/10 px-3 py-2 text-sm text-hot",
};

/** Имя файла выгрузки: trenirovki-2026-08-21.json — сортируется по дате сам. */
function fileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `trenirovki-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

export default function Settings() {
  const settings = useFit((s) => s.settings);
  const sessions = useFit((s) => s.sessions);
  const customEx = useFit((s) => s.customEx);

  const [text, setText] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [wipeOpen, setWipeOpen] = useState(false);

  function download() {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    // сразу после click() Safari иногда не успевает открыть поток — отпускаем чуть позже
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMsg({ kind: "ok", text: `файл ${a.download} ушёл в загрузки` });
  }

  async function copy() {
    try {
      // в http-контексте navigator.clipboard может вообще отсутствовать
      await navigator.clipboard.writeText(exportJson());
      setMsg({ kind: "ok", text: "выгрузка скопирована в буфер обмена" });
    } catch {
      setMsg({
        kind: "err",
        text: "браузер не дал доступ к буферу обмена — скачай файл кнопкой рядом",
      });
    }
  }

  function load() {
    if (!text.trim()) {
      setMsg({ kind: "err", text: "вставь содержимое файла в поле ниже" });
      return;
    }
    const err = importJson(text);
    if (err) {
      setMsg({ kind: "err", text: err });
      return;
    }
    setText("");
    setMsg({ kind: "ok", text: "данные загружены, текущие заменены" });
  }

  return (
    <div className="space-y-5">
      <SectionTitle>настройки</SectionTitle>

      <section>
        <Card className="p-3">
          <Toggle
            checked={settings.sound}
            onChange={(v) => patchSettings({ sound: v })}
            label="звук в конце отдыха"
            hint="короткий сигнал, когда таймер досчитал"
          />
          <Toggle
            checked={settings.vibrate}
            onChange={(v) => patchSettings({ vibrate: v })}
            label="вибрация"
            hint="телефон дёрнется вместе со звуком; на компьютере ни на что не влияет"
          />
          <Toggle
            checked={settings.photos}
            onChange={(v) => patchSettings({ photos: v })}
            label="подгружать фотографии из интернета"
            hint="без этого упражнения остаются схемами — они рисуются на месте и работают без сети"
          />
          <Toggle
            checked={settings.autoRest}
            onChange={(v) => patchSettings({ autoRest: v })}
            label="запускать таймер отдыха автоматически"
            hint="сразу после отметки подхода; выключи, если отдыхаешь по своим часам"
          />
        </Card>
      </section>

      <section>
        <SectionTitle>данные</SectionTitle>
        <Card className="space-y-3 p-3">
          <p className="text-sm text-muted">
            сейчас сохранено: {sessions.length}{" "}
            {plural(sessions.length, [
              "тренировка",
              "тренировки",
              "тренировок",
            ])}
            , {customEx.length}{" "}
            {plural(customEx.length, [
              "своё упражнение",
              "своих упражнения",
              "своих упражнений",
            ])}
            .
          </p>
          <p className="text-sm text-soft">
            всё лежит только в этом браузере, на сервер ничего не уходит и
            никуда не синхронизируется. очистка данных сайта, переустановка
            браузера или другой телефон — и записей нет. поэтому выгрузка.
          </p>
          <div className="flex flex-wrap gap-2">
            <Btn variant="primary" className="flex-1" onClick={download}>
              скачать файл
            </Btn>
            <Btn className="flex-1" onClick={() => void copy()}>
              скопировать в буфер
            </Btn>
          </div>
        </Card>
      </section>

      <section>
        <SectionTitle>загрузить выгрузку</SectionTitle>
        <Card className="space-y-3 p-3">
          <p className="text-sm text-amber">
            импорт заменяет текущие данные целиком: план, база своих упражнений
            и журнал станут теми, что в файле. сначала скачай то, что есть
            сейчас.
          </p>
          <div>
            <label htmlFor="import-json" className="mb-1 block text-xs text-muted">
              содержимое файла json
            </label>
            <textarea
              id="import-json"
              rows={4}
              value={text}
              placeholder='{"v":1,"plan":[…],"sessions":[…]}'
              onChange={(e) => setText(e.target.value)}
              className="w-full resize-y rounded-xl border border-edge bg-panel2 px-3 py-2 font-mono text-xs text-ink placeholder:text-faint outline-none focus-visible:border-accent"
            />
          </div>
          <Btn variant="ghost" className="w-full" onClick={load}>
            загрузить
          </Btn>
        </Card>
      </section>

      {msg && <p className={MSG_CLASS[msg.kind]}>{msg.text}</p>}

      <section>
        <SectionTitle>опасная зона</SectionTitle>
        <Card className="space-y-3 p-3">
          <p className="text-sm text-muted">
            вернуть план к исходному, стереть журнал и свои упражнения — всё
            станет как при первом открытии.
          </p>
          <Btn variant="danger" className="w-full" onClick={() => setWipeOpen(true)}>
            стереть всё
          </Btn>
        </Card>
      </section>

      <Sheet
        open={wipeOpen}
        onClose={() => setWipeOpen(false)}
        title="стереть все данные?"
      >
        <div className="space-y-4">
          <p className="text-sm text-soft">
            пропадут {sessions.length}{" "}
            {plural(sessions.length, [
              "тренировка",
              "тренировки",
              "тренировок",
            ])}{" "}
            и все правки плана. отменить будет нечем — если не уверен, сначала
            скачай файл.
          </p>
          <div className="flex gap-2">
            <Btn className="flex-1" onClick={() => setWipeOpen(false)}>
              отмена
            </Btn>
            <Btn
              variant="danger"
              className="flex-1"
              onClick={() => {
                wipeAll();
                setWipeOpen(false);
                setText("");
                setMsg({ kind: "ok", text: "данные стёрты, всё как при первом запуске" });
              }}
            >
              стереть
            </Btn>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
