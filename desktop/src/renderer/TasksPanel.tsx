import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { PanelAction, TasksView } from '../shared/tasks.ts';

const api = window.companion;
const OPEN_KEY = 'sudo-chan.tasksPanelOpen';

function readOpen(): boolean {
  try { return window.localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
function saveOpen(open: boolean) {
  try { window.localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* the panel works without storage */ }
}

/**
 * "Aaj ka kaam": today's short plan in the chat window. It works with the assistant's tools OFF (manual use) and shows the
 * same list the tools use. The window only asks the main process (chat-window IPC); it never reads the tasks file.
 */
export function TasksPanel() {
  const [open, setOpen] = useState(readOpen);
  const [view, setView] = useState<TasksView | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    void api?.getTasks().then(next => { if (alive) setView(next); }).catch(() => {});
    const off = api?.onTasks(next => { if (alive) setView(next); });
    return () => { alive = false; off?.(); };
  }, []);

  const toggle = () => { const next = !open; setOpen(next); saveOpen(next); };

  const act = useCallback(async (id: string, action: PanelAction) => {
    const result = await api?.taskAction(id, action).catch(() => undefined);
    if (!result) return;
    setView(result.view);
    setNote(result.ok ? '' : (result.error ?? 'Kaam nahi hua.'));
  }, []);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const result = await api?.addTaskText(text).catch(() => undefined);
    if (!result) return;
    setView(result.view);
    if (result.ok) { setDraft(''); setNote(''); } else setNote(result.error ?? 'Kaam add nahi hua.');
  };

  const openCount = view?.openCount ?? 0;
  const late = view?.overdueCount ?? 0;
  return <section className="tasks-panel" aria-label="Aaj ka kaam">
    <button type="button" className="tasks-head" aria-expanded={open} onClick={toggle}>
      <span className="tasks-title">Aaj ka kaam</span>
      <span className="tasks-count">{openCount ? `${openCount} baqi` : 'koi nahi'}{late ? ` · ${late} late` : ''}</span>
      <span className="tasks-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
    {open && <div className="tasks-body">
      {view && view.plan.length > 0 ? <ul className="tasks-list">
        {view.plan.map(task => <li key={task.id} className={`task-row ${task.overdue ? 'is-late' : ''} ${task.status === 'doing' ? 'is-doing' : ''}`}>
          <button type="button" className="task-check" aria-label={`Khatam: ${task.title}`} title="Khatam" onClick={() => void act(task.id, 'done')}/>
          <span className="task-text">{task.title}</span>
          {task.status === 'doing' && <span className="task-tag">chal raha hai</span>}
          {task.dueLabel && <span className={`task-due ${task.overdue ? 'is-late' : ''}`}>{task.dueLabel}</span>}
          <button type="button" className="task-remove" aria-label={`Hata do: ${task.title}`} title="Hata do" onClick={() => void act(task.id, 'remove')}>×</button>
        </li>)}
      </ul> : <p className="tasks-empty">Abhi koi kaam baqi nahi. Neeche likh kar add karein.</p>}
      {view && view.doneToday.length > 0 && <ul className="tasks-list tasks-done">
        {view.doneToday.map(task => <li key={task.id} className="task-row is-done">
          <button type="button" className="task-check is-checked" aria-label={`Wapas kholo: ${task.title}`} title="Wapas kholo" onClick={() => void act(task.id, 'undo')}/>
          <span className="task-text">{task.title}</span>
        </li>)}
      </ul>}
      <form className="tasks-add" onSubmit={event => void add(event)}>
        <input value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} placeholder='Naya kaam, jaise "kal client ko email bhejna"' aria-label="Naya kaam"/>
        <button type="submit" disabled={!draft.trim()}>Add</button>
      </form>
      {note && <p className="tasks-note" role="status">{note}</p>}
    </div>}
  </section>;
}
