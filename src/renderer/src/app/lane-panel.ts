import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FeedView } from './feed-view';
import { OrbitStore } from './orbit-store';
import { AskActions } from './ask-actions';
import { QuestionCard } from './question-card';
import { sendsOnKey } from './pure/composer';
import { MAX_SCREENSHOTS, roomFor } from './pure/screenshots';
import { imageFiles, toScreenshot, type Screenshot } from './screenshots';
import { DecisionList } from './decision-list';
import { Odometer } from './odometer';
import { ReviewActions } from './review-actions';
import { postedText } from './pure/review-prompt';
import {
  agentGlyph,
  dotColor,
  formatAge,
  formatCost,
  liveAgents,
  statusColor,
} from './pure/layout';
import { moonFact, storyRests } from './story-moon';
import { latestSay, type Ask } from '../../../shared/ask';
import {
  AGENT_RETENTION_MS,
  type AgentNode,
  type FeedEntry,
  type Lane,
  type ModelOption,
  type Priority,
  type QuestionItem,
} from '../../../shared/types';

interface Satellite {
  agent: AgentNode;
  color: string;
  glyph: string;
  depth: number;
  age: string;
  done: boolean;
  title: string;
}

/** The right-hand panel for the focused lane: actions, satellites, and the composer. */
@Component({
  selector: 'orbit-lane-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, FeedView, ReviewActions, AskActions, Odometer, DecisionList, QuestionCard],
  styles: [
    `
      :host:empty {
        display: none;
      }
      :host {
        position: absolute;
        right: 1rem;
        top: 4.5rem;
        bottom: 4.5rem;
        width: min(26rem, 38vw);
        box-sizing: border-box;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.75rem;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        overflow: hidden;
        animation: slide-in 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      @keyframes slide-in {
        from {
          transform: translateX(1.5rem);
          opacity: 0;
        }
      }
      .body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-right: -0.6rem;
        padding-right: 0.6rem;
      }
      h2 {
        margin: 0 0 0.25rem;
        font-size: 1rem;
        padding-right: 2.5rem;
      }
      .meta {
        color: var(--muted);
        font-size: 0.8rem;
      }
      .model {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .model select {
        flex: 1;
        min-width: 0;
        font: inherit;
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        padding: 0.3rem 0.5rem;
      }
      .running {
        color: var(--faint);
        font-size: 0.75rem;
        margin-top: -0.4rem;
      }
      .prlink {
        font-size: 0.8rem;
        color: var(--muted);
      }
      .prlink button {
        background: transparent;
        border: 0;
        padding: 0;
        color: var(--link);
        text-decoration: underline;
        font: inherit;
      }
      .conversation {
        flex: 1;
        min-height: 6rem;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.6rem;
        background: var(--bg);
      }
      .satellites.compact {
        max-height: 7rem;
        overflow-y: auto;
      }
      .posted {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.82rem;
        color: #2fb344;
        border: 1px solid #2fb344;
        border-radius: 0.6rem;
        padding: 0.5rem 0.75rem;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }
      .summary {
        color: var(--text-2);
        font-size: 0.85rem;
        border-left: 2px solid var(--edge);
        padding-left: 0.6rem;
      }
      .says {
        flex: none;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.6rem;
        background: var(--bg);
      }
      .says.waiting {
        border-color: #f59e0b;
      }
      .decisions {
        flex: none;
      }
      .satellites {
        flex: none;
        overflow-x: clip;
      }
      .satellites h3,
      .stories h3 {
        margin: 0 0 0.4rem;
        font-size: 0.75rem;
        color: var(--muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .sat {
        display: grid;
        box-sizing: border-box;
        grid-template-columns: auto 1fr auto;
        gap: 0.5rem;
        align-items: start;
        width: 100%;
        text-align: left;
        background: transparent;
        border: 0;
        border-radius: 0.4rem;
        padding: 0.35rem 0.4rem;
      }
      .sat:hover {
        background: var(--surface);
      }
      .sat.done {
        opacity: 0.45;
      }
      .sat i {
        display: inline-block;
        min-width: 1.5rem;
        padding: 0 0.25rem;
        border-radius: 0.3rem;
        border: 1px solid;
        margin-top: 0.1rem;
        font: 600 0.65rem/1.5 var(--mono);
        font-style: normal;
        text-align: center;
      }
      .sat .what {
        font-size: 0.85rem;
      }
      .sat .what small {
        display: block;
        color: var(--muted);
      }
      .sat .age {
        color: var(--faint);
        font-size: 0.75rem;
      }
      .quiet {
        color: var(--faint);
        font-size: 0.8rem;
      }
      textarea {
        width: 100%;
        box-sizing: border-box;
        min-height: 3.5rem;
        background: var(--bg);
        color: inherit;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.5rem;
      }
      .unsent {
        color: #e44;
        font-size: 0.8rem;
      }
      .shots {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-bottom: 0.45rem;
      }
      .shot {
        position: relative;
      }
      .shot img {
        display: block;
        height: 3.5rem;
        max-width: 7rem;
        object-fit: cover;
        border-radius: 0.375rem;
        border: 1px solid var(--edge);
      }
      .shot button {
        position: absolute;
        top: -0.45rem;
        right: -0.45rem;
        width: 1.25rem;
        height: 1.25rem;
        padding: 0;
        border-radius: 50%;
        font-size: 0.8rem;
        line-height: 1;
      }
      .send .attach {
        margin-right: auto;
      }
      .send {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        justify-content: flex-end;
        margin-top: 0.4rem;
        font-size: 0.85rem;
      }
      .close {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        padding: 0.2rem 0.6rem;
      }
      .story {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem 0.6rem;
        align-items: center;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .story .stage {
        padding: 0.1rem 0.5rem;
        border-radius: 1rem;
        border: 1px solid var(--edge-strong);
        color: var(--text-2);
        font-size: 0.75rem;
      }
      .story button,
      .stories .open,
      .stories .dismiss {
        background: transparent;
        border: 0;
        padding: 0;
        color: var(--link);
        text-decoration: underline;
        font: inherit;
        font-size: 0.8rem;
      }
      .story .files {
        flex-basis: 100%;
        color: var(--faint);
        font-size: 0.75rem;
        overflow-wrap: anywhere;
      }
      .stories {
        flex: none;
      }
      .stories .row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto auto 1rem;
        gap: 0.5rem;
        align-items: center;
        padding: 0.3rem 0.4rem;
        border-radius: 0.4rem;
        font-size: 0.85rem;
      }
      .stories .row > span:first-of-type {
        min-width: 0;
      }
      .stories .row .title {
        display: block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stories .row:hover {
        background: var(--surface);
      }
      .stories .row i {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        display: inline-block;
        align-self: center;
      }
      .stories .row small {
        display: block;
        color: var(--muted);
      }
      .stories .row .cost {
        color: var(--faint);
        font: 0.75rem var(--mono);
      }
      .stories .dismiss {
        color: var(--muted);
        text-decoration: none;
      }
    `,
  ],
  template: `
    @if (store.selectedLane(); as lane) {
      <button class="close" type="button" aria-label="Close lane view" (click)="store.select(null)">
        ✕
      </button>
      <div>
        <h2>{{ lane.name }}</h2>
        <div class="meta" aria-label="Lane status" [title]="costTitle(lane)">
          {{ lane.status }} · <orbit-odometer [value]="cost(lane)" />
        </div>
      </div>
      <div class="body">
        @if (lane.story; as story) {
          <div class="story" aria-label="Story">
            <span class="stage">{{ story.stage }}</span>
            @if (story.pr) {
              <button type="button" (click)="story.prUrl && store.open(story.prUrl)">
                PR #{{ story.pr }}
              </button>
            }
            @if (story.branch) {
              <span>{{ story.branch }}</span>
            }
            @if (lane.parentId; as pm) {
              <button type="button" (click)="store.select(pm)">← {{ store.laneName(pm) }}</button>
            }
            @if (story.stage === 'waiting' && story.waitingOn?.length) {
              <span class="files">
                waiting on {{ story.waitingOn?.join(', ') }} to let go of its files; Orbit wakes it
                then
              </span>
            }
            @if (story.files.length) {
              <span class="files">
                {{ story.files.length }} file{{ story.files.length === 1 ? '' : 's' }} claimed ·
                {{ story.files.join(', ') }}
              </span>
            }
            @if (story.summary) {
              <span class="files">{{ story.summary }}</span>
            }
          </div>
        }
        <div class="model">
          <label for="lane-model">Model</label>
          <select
            id="lane-model"
            [ngModel]="lane.requestedModel ?? ''"
            (ngModelChange)="setModel(lane.id, $event)"
            (focus)="store.refreshModels()"
            name="model"
          >
            <option value="">CLI default</option>
            @for (m of modelOptions(lane); track m.value) {
              <option [value]="m.value">{{ m.label }}</option>
            }
          </select>
        </div>
        @if (lane.model) {
          <div class="running" aria-label="Running model">running {{ lane.model }}</div>
        }
        <div class="actions">
          @if (lane.status === 'stopped' || lane.status === 'error') {
            <button type="button" (click)="store.command({ type: 'start', laneId: lane.id })">
              Start
            </button>
            @if (lane.sessionId) {
              <button type="button" (click)="store.command({ type: 'resume', laneId: lane.id })">
                Resume
              </button>
            }
            @if (!storyRests(lane)) {
              <button type="button" (click)="remove(lane)">Remove orbit</button>
            }
          } @else {
            @if (lane.status === 'idle' && !talks(lane) && lane.kind !== 'story') {
              <button type="button" (click)="runBoard(lane)">
                {{ lane.kind === 'monitor' ? 'Tick now' : 'Run board' }}
              </button>
            }
            <button type="button" (click)="store.command({ type: 'stop', laneId: lane.id })">
              Stop
            </button>
          }
          @if (storyRests(lane)) {
            <button type="button" (click)="dismiss(lane)">Dismiss</button>
          }
          <button type="button" (click)="store.command({ type: 'fresh', laneId: lane.id })">
            Fresh start
          </button>
          @if (!talks(lane)) {
            @if (lane.kind !== 'story') {
              <button
                type="button"
                [attr.aria-pressed]="store.boardOpen()"
                (click)="store.boardOpen.set(!store.boardOpen())"
              >
                {{ store.boardOpen() ? 'Hide board' : 'Board' }}
              </button>
            }
            <button
              type="button"
              (click)="
                store.openDrawer({ laneId: lane.id, agentId: null, title: lane.name + ' · PM' })
              "
            >
              Transcript
            </button>
          }
        </div>
        @if (laneQuestion(); as q) {
          <orbit-question-card class="inline" [item]="q" />
        }
        @if (talks(lane)) {
          @if (lane.pr; as pr) {
            <div class="prlink">
              Reviewing
              <button type="button" (click)="store.open(pr.url)">#{{ pr.number }}</button> · the
              skill asks below when it needs you
            </div>
          }
          <orbit-feed-view
            class="conversation"
            role="log"
            [attr.aria-label]="'Conversation with ' + lane.name"
            aria-live="polite"
            [entries]="chat()"
            [note]="chatNote()"
            [conversation]="lane.id"
          />
          @if (reviewPrompt(); as prompt) {
            <orbit-review-actions
              [prompt]="prompt"
              [result]="lane.reviewResult ?? null"
              (send)="quickSend(lane.id, $event)"
              (post)="
                store.command({
                  type: 'postReview',
                  laneId: lane.id,
                  dropped: $event.dropped,
                  pick: $event.pick,
                })
              "
            />
          } @else if (posted(); as p) {
            <div class="posted" role="status" aria-label="Review posted">
              {{ p.text }}
              @if (p.url; as url) {
                <button type="button" (click)="store.open(url)">View on GitHub</button>
              }
            </div>
          } @else if (ask(); as a) {
            <orbit-ask-actions [ask]="a" (send)="quickSend(lane.id, $event)" />
          }
          @if (satellites().length) {
            <div class="satellites compact" role="list" aria-label="Agents">
              @for (s of satellites(); track s.agent.taskId) {
                <button
                  class="sat"
                  [class.done]="s.done"
                  type="button"
                  role="listitem"
                  [attr.aria-label]="'Open agent ' + s.title"
                  (click)="
                    store.openDrawer({ laneId: lane.id, agentId: s.agent.taskId, title: s.title })
                  "
                >
                  <i [style.color]="s.color" [style.border-color]="s.color">{{ s.glyph }}</i>
                  <span class="what">{{ s.title }}</span>
                  <span class="age">{{ s.age }}</span>
                </button>
              }
            </div>
          }
        } @else {
          @if (says(); as say) {
            <orbit-feed-view
              class="says"
              [class.waiting]="ask()"
              role="note"
              [attr.aria-label]="'What ' + lane.name + ' last said'"
              [entries]="say"
              [followTail]="false"
            />
          } @else if (lane.lastSummary) {
            <div class="summary">{{ lane.lastSummary }}</div>
          }
          @if (ask(); as a) {
            <orbit-ask-actions [ask]="a" (send)="quickSend(lane.id, $event)" />
          }
          @if (moons().length) {
            <div class="stories" role="list" aria-label="Stories">
              <h3>Stories · {{ moons().length }}</h3>
              @for (m of moons(); track m.lane.id) {
                <div class="row" role="listitem">
                  <i [style.background]="m.color" [attr.title]="m.lane.status"></i>
                  <span>
                    <span class="title" [attr.title]="m.lane.story?.title">
                      {{ m.lane.story?.storyId }} {{ m.lane.story?.title }}
                    </span>
                    <small>{{ m.fact }}</small>
                  </span>
                  <span class="cost">{{ m.cost }}</span>
                  <button class="open" type="button" (click)="store.select(m.lane.id)">Open</button>
                  @if (m.dismissable) {
                    <button
                      class="dismiss"
                      type="button"
                      title="Dismiss"
                      [attr.aria-label]="'Dismiss story ' + m.lane.story?.storyId"
                      (click)="dismiss(m.lane)"
                    >
                      ✕
                    </button>
                  }
                </div>
              }
            </div>
          }
          @if ((lane.kind === 'project' || lane.kind === 'story') && laneDecisions().length) {
            <orbit-decision-list class="decisions" [items]="laneDecisions()" />
          }
          <div class="satellites" role="list" aria-label="Agents">
            <h3>Agents</h3>
            @for (s of satellites(); track s.agent.taskId) {
              <button
                class="sat"
                [class.done]="s.done"
                type="button"
                role="listitem"
                [style.margin-left.rem]="(s.depth - 1) * 1"
                [attr.aria-label]="'Open agent ' + s.title"
                (click)="
                  store.openDrawer({ laneId: lane.id, agentId: s.agent.taskId, title: s.title })
                "
              >
                <i [style.color]="s.color" [style.border-color]="s.color">{{ s.glyph }}</i>
                <span class="what">
                  {{ s.title }}
                  @if (s.agent.summary) {
                    <small>{{ s.agent.summary }}</small>
                  }
                </span>
                <span class="age">{{ s.age }}</span>
              </button>
            } @empty {
              <div class="quiet">No agents yet.</div>
            }
          </div>
        }
      </div>
      <div class="composer" (dragover)="onDragOver($event)" (drop)="onDrop($event, lane)">
        @if (shotsFor(lane.id).length) {
          <div class="shots" aria-label="Screenshots to send">
            @for (s of shotsFor(lane.id); track s.id; let i = $index) {
              <span class="shot">
                <img [src]="preview(s)" [alt]="'Screenshot ' + (i + 1)" />
                <button
                  type="button"
                  [attr.aria-label]="'Remove screenshot ' + (i + 1)"
                  (click)="removeShot(lane.id, s.id)"
                >
                  ×
                </button>
              </span>
            }
          </div>
        }
        <label>
          <span class="visually-hidden">Message to {{ lane.name }}</span>
          <textarea
            [ngModel]="draftFor(lane.id)"
            (ngModelChange)="setDraft(lane.id, $event)"
            [placeholder]="
              (talks(lane) ? 'Say something…' : 'Tell the PM something…') +
              ' (Enter sends, Shift+Enter for a new line)'
            "
            [disabled]="!canSend(lane.status)"
            (keydown)="onKey($event, lane)"
            (paste)="onPaste($event, lane)"
          ></textarea>
        </label>
        @if (notSentFor(lane.id); as note) {
          <div class="unsent" role="alert">{{ note }}</div>
        }
        <div class="send">
          <button
            type="button"
            class="attach"
            [disabled]="!canSend(lane.status)"
            title="Attach a screenshot, or paste or drop one into the box"
            (click)="picker.click()"
          >
            Attach screenshot
          </button>
          <input
            #picker
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-label="Choose screenshots"
            (change)="onPick($event, lane)"
          />
          @if (!talks(lane)) {
            <label
              ><input
                type="checkbox"
                [ngModel]="nowFor(lane.id)"
                (ngModelChange)="setNow(lane.id, $event)"
              />
              deliver now (interrupts)</label
            >
          }
          <button
            type="button"
            [disabled]="!hasMessage(lane.id) || !canSend(lane.status)"
            (click)="send(lane)"
          >
            Send
          </button>
        </div>
      </div>
    }
  `,
})
export class LanePanel {
  readonly store = inject(OrbitStore);
  readonly #cdr = inject(ChangeDetectorRef);
  /** One panel serves every lane, so the interrupt box is kept per lane like the drafts in the store. */
  readonly interrupts = signal<Record<string, boolean>>({});
  /** Why the last message to a lane did not go, until you send again or edit the draft. */
  readonly notSent = signal<Record<string, string>>({});
  readonly chat = signal<FeedEntry[]>([]);
  readonly chatNote = signal<string | null>(null);
  #chatRequest = 0;

  constructor() {
    // Opening a lane refreshes the model list so the picker is current.
    effect(() => {
      if (this.store.selectedLane()) void this.store.refreshModels();
    });
    // The lane's conversation feeds the panel: the whole thing for a chat or review, the closing
    // words for a PM. Refetch whenever the feed grows. Responses can land out of order, so only
    // the newest request may update the view.
    effect(() => {
      const lane = this.store.selectedLane();
      if (!lane) return;
      lane.feedCount;
      lane.status;
      const seq = ++this.#chatRequest;
      void this.store.feed(lane.id, null).then((r) => {
        if (seq !== this.#chatRequest || this.store.selectedLaneId() !== lane.id) return;
        this.chat.set(r.entries);
        this.chatNote.set(r.note);
      });
    });
  }

  /** This lane's product questions, open first; a PM's include the ones its story moons raised. */
  readonly laneDecisions = computed(() => {
    const lane = this.store.selectedLane();
    return lane ? this.store.decisionsAround(lane.id) : [];
  });

  /** A PM's stories on their moons, oldest first, as the Stories list shows them. */
  readonly moons = computed(() => {
    const lane = this.store.selectedLane();
    if (!lane || lane.kind !== 'project') return [];
    return this.store.moonsOf(lane.id).map((m) => ({
      lane: m,
      color: statusColor(m.status),
      fact: moonFact(m),
      cost: formatCost(m),
      dismissable: storyRests(m),
    }));
  });

  /** A PM's closing words, as one feed entry so they render like the rest of the conversation. */
  readonly says = computed<FeedEntry[] | null>(() => {
    const lane = this.store.selectedLane();
    if (!lane || this.talks(lane)) return null;
    const text = latestSay(this.chat());
    return text ? [{ kind: 'text', text, tool: null }] : null;
  });

  /**
   * What the lane raised with needs_you, if anything. Never while a question card is already up
   * for the lane.
   */
  readonly ask = computed<Ask | null>(() => {
    const lane = this.store.selectedLane();
    if (!lane) return null;
    const items = this.store.attention().filter((a) => a.laneId === lane.id);
    if (items.some((a) => a.kind === 'question')) return null;
    const blocked = items.find((a) => a.kind === 'blocked');
    return blocked?.kind === 'blocked' && blocked.text
      ? { text: blocked.text, options: blocked.options }
      : null;
  });

  modelOptions(lane: Lane): ModelOption[] {
    const list = [...this.store.models()];
    for (const v of [lane.requestedModel, lane.model]) {
      if (v && !list.some((m) => m.value === v)) list.push({ value: v, label: v });
    }
    return list;
  }

  setModel(laneId: string, value: string): void {
    void this.store.command({ type: 'setModel', laneId, model: value || null });
  }

  remove(lane: Lane): void {
    void this.store.command({ type: 'removeLane', laneId: lane.id });
    this.store.select(null);
  }

  readonly storyRests = storyRests;

  /** Take a finished story's moon off the stage; from the moon's own panel, go back to its PM. */
  dismiss(lane: Lane): void {
    void this.store.command({ type: 'dismissStory', laneId: lane.id });
    if (this.store.selectedLaneId() === lane.id) this.store.select(lane.parentId ?? null);
  }

  onKey(event: KeyboardEvent, lane: Lane): void {
    if (!sendsOnKey(event)) return;
    event.preventDefault();
    void this.send(lane);
  }

  draftFor(laneId: string): string {
    return this.store.drafts()[laneId] ?? '';
  }

  setDraft(laneId: string, text: string): void {
    this.store.drafts.update((d) => ({ ...d, [laneId]: text }));
    if (this.notSent()[laneId]) this.#clearNote(laneId);
  }

  nowFor(laneId: string): boolean {
    return this.interrupts()[laneId] ?? false;
  }

  /**
   * Rendered at once: if you tick the box and send before change detection runs, the binding
   * would see false then false and leave the box ticked for the next message.
   */
  setNow(laneId: string, on: boolean): void {
    this.interrupts.update((n) => ({ ...n, [laneId]: on }));
    this.#cdr.detectChanges();
  }

  notSentFor(laneId: string): string | null {
    return this.notSent()[laneId] ?? null;
  }

  /** The question card for this lane, when it has stopped on AskUserQuestion. */
  readonly laneQuestion = computed<QuestionItem | null>(() => {
    const lane = this.store.selectedLane();
    const item =
      lane && this.store.attention().find((a) => a.laneId === lane.id && a.kind === 'question');
    return item?.kind === 'question' ? item : null;
  });

  readonly satellites = computed<Satellite[]>(() => {
    const lane = this.store.selectedLane();
    if (!lane) return [];
    const now = this.store.now();
    const declared = this.store.agentColors();
    return liveAgents(lane, now, AGENT_RETENTION_MS)
      .sort(
        (a, b) =>
          Number(a.state !== 'working') - Number(b.state !== 'working') ||
          b.startedAt - a.startedAt,
      )
      .map((agent) => ({
        agent,
        color: dotColor(agent.agentType, declared),
        glyph: agentGlyph(agent.agentType),
        depth: Math.max(1, agent.depth),
        age: formatAge((agent.endedAt ?? now) - agent.startedAt),
        done: agent.state !== 'working',
        title: `${agent.agentType ?? 'agent'} · ${agent.description}`,
      }));
  });

  /** Chats and reviews are conversations: the feed is the body and Enter sends. */
  talks(lane: Lane): boolean {
    return lane.kind === 'chat' || lane.kind === 'review';
  }

  canSend(status: string): boolean {
    return status !== 'stopped' && status !== 'error';
  }

  runBoard(lane: Lane): void {
    const text =
      lane.kind === 'monitor'
        ? 'tick'
        : (this.store.config()?.projects.find((p) => p.id === lane.id)?.kickoff ??
          'Run the board.');
    void this.#deliver(lane.id, text, 'next');
  }

  /**
   * Send the lane's draft. The box clears at once so a second Enter cannot send it twice; if no
   * running session takes it, the words come back (unless you have started on new ones).
   */
  async send(lane: Lane): Promise<void> {
    const text = this.draftFor(lane.id).trim();
    const shots = this.shotsFor(lane.id);
    if (!text && !shots.length) return;
    const priority: Priority = this.nowFor(lane.id) ? 'now' : 'next';
    this.setDraft(lane.id, '');
    this.#setShots(lane.id, []);
    this.setNow(lane.id, false);
    if (await this.#deliver(lane.id, text, priority, shots)) return;
    // Straight into the store, not setDraft, so the note saying why stays up.
    if (!this.draftFor(lane.id).trim())
      this.store.drafts.update((d) => ({ ...d, [lane.id]: text }));
    if (!this.shotsFor(lane.id).length) this.#setShots(lane.id, shots);
    this.setNow(lane.id, priority === 'now');
  }

  quickSend(laneId: string, text: string): void {
    void this.#deliver(laneId, text, 'next');
  }

  /** Something to send: words, screenshots, or both. */
  hasMessage(laneId: string): boolean {
    return !!this.draftFor(laneId).trim() || this.shotsFor(laneId).length > 0;
  }

  shotsFor(laneId: string): Screenshot[] {
    return this.store.screenshots()[laneId] ?? [];
  }

  preview(s: Screenshot): string {
    return `data:${s.mediaType};base64,${s.data}`;
  }

  removeShot(laneId: string, id: string): void {
    this.#setShots(
      laneId,
      this.shotsFor(laneId).filter((s) => s.id !== id),
    );
  }

  /** A pasted screenshot attaches; pasted words paste as usual. */
  onPaste(event: ClipboardEvent, lane: Lane): void {
    const files = imageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void this.attach(lane.id, files);
  }

  onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  onDrop(event: DragEvent, lane: Lane): void {
    const files = imageFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    void this.attach(lane.id, files);
  }

  onPick(event: Event, lane: Lane): void {
    const input = event.target as HTMLInputElement;
    const files = imageFiles(input);
    input.value = '';
    if (files.length) void this.attach(lane.id, files);
  }

  /** Shrink each image to send and add it to the lane's draft, up to the cap; say what did not fit. */
  async attach(laneId: string, files: File[]): Promise<void> {
    const room = roomFor(this.shotsFor(laneId).length, files.length);
    const notes =
      room < files.length ? [`Only ${MAX_SCREENSHOTS} screenshots go with one message.`] : [];
    for (const file of files.slice(0, room)) {
      try {
        const shot = await toScreenshot(file);
        this.#setShots(laneId, [...this.shotsFor(laneId), shot].slice(0, MAX_SCREENSHOTS));
      } catch (e) {
        notes.push((e as Error).message);
      }
    }
    if (notes.length) this.notSent.update((n) => ({ ...n, [laneId]: notes.join(' ') }));
  }

  #setShots(laneId: string, shots: Screenshot[]): void {
    this.store.screenshots.update((m) => ({ ...m, [laneId]: shots }));
  }

  async #deliver(
    laneId: string,
    text: string,
    priority: Priority,
    shots: Screenshot[] = [],
  ): Promise<boolean> {
    this.#clearNote(laneId);
    const delivered = await this.store.send(laneId, text, priority, shots);
    if (!delivered)
      this.notSent.update((n) => ({
        ...n,
        [laneId]: `Not sent: ${this.store.laneName(laneId)} isn't running.`,
      }));
    return delivered;
  }

  #clearNote(laneId: string): void {
    this.notSent.update(({ [laneId]: _, ...rest }) => rest);
  }

  cost(lane: Lane): string {
    return formatCost(lane);
  }

  costTitle(lane: Lane): string {
    const base =
      lane.costBasis === 'unknown'
        ? 'Claude Code has no price for this model and guessed at the default rate.'
        : 'Session total as Claude Code prices it, exact as of the last finished turn.';
    return lane.costInflightUsd >= 0.005
      ? `${base} The +~ part is a guess at the turn still running, from the rates earlier turns revealed.`
      : base;
  }

  /** The preview the review skill sent with review_preview, unless a question card is up for it. */
  readonly reviewPrompt = computed(() => {
    const lane = this.store.selectedLane();
    if (!lane?.reviewPrompt) return null;
    if (this.store.attention().some((a) => a.laneId === lane.id && a.kind === 'question'))
      return null;
    return lane.reviewPrompt;
  });

  /** The review Orbit posted for this lane, once it reached GitHub. */
  readonly posted = computed(() => {
    const result = this.store.selectedLane()?.reviewResult;
    return result?.ok ? { text: postedText(result), url: result.url } : null;
  });
}
