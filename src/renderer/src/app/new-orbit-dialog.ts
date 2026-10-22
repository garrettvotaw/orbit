import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, from, of, switchMap } from 'rxjs';
import { OrbitStore } from './orbit-store';
import { newProjectBoard } from './pure/new-orbit';
import type { AgentOption, LaneConfig, ProjectConfig } from '../../../shared/types';

type Kind = 'project' | 'chat';

/** Create a new lane without editing config.json by hand. */
@Component({
  selector: 'orbit-new-orbit-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styles: [
    `
      :host:empty {
        display: none;
      }
      :host {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        background: rgba(15, 18, 24, 0.7);
        z-index: 5;
      }
      form {
        width: min(30rem, 90vw);
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.75rem;
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        box-sizing: border-box;
      }
      h2 {
        margin: 0;
        font-size: 1rem;
      }
      .kinds {
        display: flex;
        gap: 0.5rem;
      }
      .kinds label {
        flex: 1;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.6rem 0.75rem;
        cursor: pointer;
      }
      .kinds label.on {
        border-color: #7c5cff;
        background: var(--surface);
      }
      .kinds small {
        display: block;
        color: var(--muted);
        margin-top: 0.2rem;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
      }
      .field label {
        color: var(--muted);
      }
      input,
      select {
        font: inherit;
        color: inherit;
        background: var(--bg);
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        padding: 0.45rem 0.6rem;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 0.25rem;
      }
      .error {
        color: #ef4444;
        font-size: 0.8rem;
      }
      small.hint {
        color: var(--faint);
      }
    `,
  ],
  template: `
    @if (store.newOrbitOpen()) {
      <form (ngSubmit)="create()" aria-label="New orbit">
        <h2>New orbit</h2>
        <div class="kinds" role="radiogroup" aria-label="Kind">
          <label [class.on]="kind() === 'project'">
            <input
              type="radio"
              name="kind"
              value="project"
              [checked]="kind() === 'project'"
              (change)="kind.set('project')"
            />
            Project PM
            <small>Runs an agent's board on a kickoff</small>
          </label>
          <label [class.on]="kind() === 'chat'">
            <input
              type="radio"
              name="kind"
              value="chat"
              [checked]="kind() === 'chat'"
              (change)="kind.set('chat')"
            />
            Chat
            <small>Waits for you; talk to it when you need it</small>
          </label>
        </div>
        <div class="field">
          <label for="no-name">Name</label
          ><input
            id="no-name"
            type="text"
            [ngModel]="name()"
            (ngModelChange)="name.set($event)"
            name="name"
            placeholder="Storefront"
            required
          />
        </div>
        <div class="field">
          <label for="no-cwd">Folder</label
          ><input
            id="no-cwd"
            type="text"
            [ngModel]="cwd()"
            (ngModelChange)="cwd.set($event)"
            name="cwd"
            placeholder="~/src/storefront"
            required
          />
        </div>
        @if (kind() === 'project') {
          <div class="field">
            <label for="no-agent">Agent</label
            ><select
              id="no-agent"
              [ngModel]="agent()"
              (ngModelChange)="agent.set($event)"
              name="agent"
              required
            >
              <option value="" disabled>Pick an agent…</option>
              @for (a of agents(); track a.name) {
                <option [value]="a.name">
                  {{ a.name }}{{ a.description ? ' — ' + a.description : '' }}
                </option>
              }
            </select>
            @if (!agents().length) {
              <small class="hint"
                >No agents found in ~/.claude/agents or this folder's .claude/agents.</small
              >
            }
          </div>
          @if (domainFiles().length) {
            <div class="field">
              <label for="no-domain">Domain file</label
              ><select
                id="no-domain"
                [ngModel]="domain()"
                (ngModelChange)="domain.set($event)"
                name="domain"
              >
                <option value="">None</option>
                @for (f of domainFiles(); track f) {
                  <option [value]="f">{{ f }}</option>
                }
              </select>
            </div>
          }
          <div class="field">
            <label for="no-kickoff">Kickoff</label
            ><input
              id="no-kickoff"
              type="text"
              [ngModel]="kickoff()"
              (ngModelChange)="kickoff.set($event)"
              name="kickoff"
              placeholder="Run the board."
            />
          </div>
        }
        @if (kind() === 'chat' && boardProjects().length) {
          <div class="field">
            <label for="no-board">Board</label
            ><select
              id="no-board"
              [ngModel]="project()"
              (ngModelChange)="project.set($event)"
              name="board"
            >
              <option value="">None</option>
              @for (p of boardProjects(); track p.id) {
                <option [value]="p.id">{{ p.name }}</option>
              }
            </select>
            <small class="hint">The chat can read and move that project's stories.</small>
          </div>
        }
        <div class="field">
          <label for="no-model">Model</label
          ><select
            id="no-model"
            [ngModel]="model()"
            (ngModelChange)="model.set($event)"
            name="model"
          >
            <option value="">CLI default</option>
            @for (m of store.models(); track m.value) {
              <option [value]="m.value">{{ m.label }}</option>
            }
          </select>
        </div>
        @if (error(); as e) {
          <div class="error">{{ e }}</div>
        }
        <div class="actions">
          <button type="button" (click)="store.newOrbitOpen.set(false)">Cancel</button>
          <button type="submit" [disabled]="!valid() || busy()">Create</button>
        </div>
      </form>
    }
  `,
})
export class NewOrbitDialog {
  readonly store = inject(OrbitStore);
  readonly kind = signal<Kind>('chat');
  readonly name = signal('');
  readonly cwd = signal('');
  readonly agent = signal('');
  readonly kickoff = signal('Run the board.');
  readonly model = signal('');
  readonly agents = signal<AgentOption[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  /** The Project PM folder's domain files, read again as the folder changes. */
  readonly domainFiles = toSignal(
    toObservable(
      computed(() =>
        this.store.newOrbitOpen() && this.kind() === 'project' ? this.cwd().trim() : '',
      ),
    ).pipe(
      switchMap((cwd) =>
        cwd ? from(this.store.domainFiles(cwd)).pipe(catchError(() => of([]))) : of([]),
      ),
    ),
    { initialValue: [] as string[], equal: sameFiles },
  );
  /** The domain file picked, kept while the folder still has it. */
  readonly domain = linkedSignal<string[], string>({
    source: this.domainFiles,
    computation: (files, prev) => (prev && files.includes(prev.value) ? prev.value : ''),
  });

  /** The projects with a tracker, whose board a Chat may borrow. */
  readonly boardProjects = computed(() =>
    (this.store.config()?.projects ?? []).filter((p) => p.tracker || p.ado),
  );
  /** The project picked for a Chat's board, kept while it still has one. */
  readonly project = linkedSignal<ProjectConfig[], string>({
    source: this.boardProjects,
    computation: (projects, prev) =>
      prev && projects.some((p) => p.id === prev.value) ? prev.value : '',
  });

  readonly valid = computed(
    () =>
      this.name().trim().length > 0 &&
      this.cwd().trim().length > 0 &&
      (this.kind() === 'chat' || this.agent().length > 0),
  );

  constructor() {
    effect(() => {
      if (!this.store.newOrbitOpen()) return;
      this.error.set(null);
      if (!this.cwd()) {
        const first =
          this.store.config()?.projects[0]?.cwd ?? this.store.config()?.chats[0]?.cwd ?? '';
        this.cwd.set(first);
      }
      void this.store.refreshModels();
    });
    effect(() => {
      if (!this.store.newOrbitOpen() || this.kind() !== 'project') return;
      const cwd = this.cwd().trim();
      if (!cwd) return;
      void this.store.agents(cwd).then((r) => this.agents.set(r.agents));
    });
  }

  async create(): Promise<void> {
    if (!this.valid()) return;
    const name = this.name().trim();
    const id = slug(name, new Set(this.store.lanes().map((l) => l.id)));
    const cwd = this.cwd().trim();
    const model = this.model() || undefined;
    const lane: LaneConfig =
      this.kind() === 'chat'
        ? {
            kind: 'chat',
            id,
            name,
            cwd,
            model,
            ...(this.project() ? { project: this.project() } : {}),
          }
        : {
            kind: 'project',
            id,
            name,
            cwd,
            agent: this.agent(),
            kickoff: this.kickoff().trim() || 'Run the board.',
            ...newProjectBoard(this.store.config()?.projects ?? []),
            model,
            ...(this.domain() ? { domain: this.domain() } : {}),
          };
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.command({ type: 'addLane', lane });
      this.store.newOrbitOpen.set(false);
      this.name.set('');
      this.store.select(id);
    } catch (e) {
      this.error.set(
        (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''),
      );
    } finally {
      this.busy.set(false);
    }
  }
}

const sameFiles = (a: string[], b: string[]) =>
  a.length === b.length && a.every((f, i) => f === b[i]);

function slug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'lane';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
