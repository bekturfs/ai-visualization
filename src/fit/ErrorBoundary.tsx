import { Component, type ErrorInfo, type ReactNode } from "react";
import { wipeAll } from "./store";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Без этого любая ошибка рендера оставляет пустую страницу, из которой нельзя
 * выбраться: битые данные лежат в localStorage и роняют приложение снова
 * после каждой перезагрузки.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Трекер упал:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-lg space-y-4 px-4 py-10">
        <h1 className="text-lg font-semibold text-ink">Что-то сломалось</h1>
        <p className="text-sm text-soft">
          Экран не отрисовался. Скорее всего виноваты сохранённые данные —
          например, загруженный файл выгрузки.
        </p>
        <pre className="overflow-x-auto rounded-xl border border-edge bg-panel2 p-3 text-xs text-muted">
          {error.message}
        </pre>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="min-h-11 rounded-xl border border-edge px-4 text-[15px] text-soft transition hover:border-accent/60 hover:text-ink"
          >
            Попробовать ещё раз
          </button>
          <button
            type="button"
            onClick={() => {
              wipeAll();
              this.setState({ error: null });
            }}
            className="min-h-11 rounded-xl border border-hot/60 px-4 text-[15px] text-hot transition hover:bg-hot/10"
          >
            Стереть данные трекера и начать заново
          </button>
        </div>
        <p className="text-xs text-faint">
          Стирание затрагивает только тренировки — остальной сайт не тронут.
        </p>
      </div>
    );
  }
}
