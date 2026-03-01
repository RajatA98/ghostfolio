import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { HEADER_KEY_TOKEN } from '@ghostfolio/common/config';
import { User } from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';
import {
  AgentChatResponse,
  AgentChatResponseData,
  AgentToolTraceRow,
  DataService
} from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MarkdownModule } from 'ngx-markdown';
import { Subject, EMPTY, Subscription } from 'rxjs';
import { catchError, finalize, takeUntil } from 'rxjs/operators';

type AgentStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'thinking'; iteration: number }
  | { type: 'tool_start'; tool: string; iteration: number }
  | {
      type: 'tool_end';
      tool: string;
      ok: boolean;
      ms: number;
      iteration: number;
      detail?: string;
    }
  | {
      type: 'done';
      answer: string;
      confidence: number;
      warnings: string[];
      toolTrace: AgentToolTraceRow[];
      data?: AgentChatResponseData;
    }
  | { type: 'error'; message: string };

interface StreamLogLine {
  text: string;
  cssClass: string;
}

interface LoopMeta {
  iterations: number;
  totalMs: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  terminationReason?: string;
}

interface ChatMessage {
  confidence?: number;
  content: string;
  data?: AgentChatResponseData;
  loopMeta?: LoopMeta;
  role: 'assistant' | 'user';
  toolTrace?: AgentToolTraceRow[];
  warnings?: string[];
}

interface ToolStatusRow {
  ok: boolean;
  tool: string;
}

interface PersistedChatMessage {
  confidence?: number;
  content: string;
  data?: AgentChatResponseData;
  loopMeta?: LoopMeta;
  role: 'assistant' | 'user';
  toolTrace?: AgentToolTraceRow[];
  warnings?: string[];
}

interface NormalizedChatMessage {
  confidence?: number;
  content: string;
  data?: AgentChatResponseData;
  loopMeta?: LoopMeta;
  role: 'assistant' | 'user';
  toolTrace?: AgentToolTraceRow[];
  warnings?: string[];
}

const DEFAULT_HISTORY_KEY = 'agentChatHistory';
const MAX_HISTORY_MESSAGES = 50;

/** Tools that create/update orders — trigger portfolio refresh when they succeed. */
const PORTFOLIO_MODIFYING_TOOLS = ['logPaperTrade', 'logFundMovement'];

@Component({
  host: { class: 'page' },
  imports: [
    CommonModule,
    FormsModule,
    MarkdownModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule
  ],
  selector: 'gf-agent-page',
  styleUrls: ['./agent-page.scss'],
  templateUrl: './agent-page.html'
})
export class GfAgentPageComponent implements OnDestroy, OnInit {
  @ViewChild('messagesContainer') messagesContainer: ElementRef<HTMLElement>;
  @ViewChild('scrollAnchor') scrollAnchor: ElementRef<HTMLElement>;

  public draftMessage = '';
  public isSending = false;
  public messages: ChatMessage[] = [];
  public queuedMessages: string[] = [];
  public streamLogLines: StreamLogLine[] = [];
  public streamingAnswer = '';
  public streamingAnswerVisibleLength = 0;
  public user: User;

  private activeRequestSubscription: Subscription | null = null;
  private activeRequestId = 0;
  private abortController: AbortController | null = null;
  private requestCounter = 0;
  private unsubscribeSubject = new Subject<void>();
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsMessageHandler: ((event: AgentStreamEvent) => void) | null = null;

  public constructor(
    private dataService: DataService,
    private notificationService: NotificationService,
    private tokenStorageService: TokenStorageService,
    private userService: UserService
  ) {}

  public ngOnInit() {
    this.userService.stateChanged
      .pipe(takeUntil(this.unsubscribeSubject))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;
          this.messages = this.loadMessages();
          setTimeout(() => this.scrollMessagesToBottom(), 0);

          const token = this.tokenStorageService.getToken();
          if (token && !this.ws) {
            this.connectWebSocket(token);
          }
        }
      });

    this.userService.get().pipe(takeUntil(this.unsubscribeSubject)).subscribe();
  }

  public sendMessage() {
    const message = this.draftMessage.trim();

    if (!message) {
      return;
    }

    if (this.isSending) {
      this.enqueueMessage(message);
      this.draftMessage = '';
      return;
    }

    this.draftMessage = '';
    this.dispatchMessage(message);
  }

  public interjectMessage() {
    const message = this.draftMessage.trim();
    if (!message) {
      return;
    }

    this.draftMessage = '';
    this.enqueueMessage(message, true);

    if (this.isSending) {
      this.activeRequestSubscription?.unsubscribe();
      this.activeRequestSubscription = null;
      this.activeRequestId = 0;
      this.isSending = false;
    }

    this.flushQueue();
  }

  public cancelMessage(): void {
    if (!this.isSending) {
      return;
    }

    if (this.wsConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel' }));
      this.wsMessageHandler = null;
    } else {
      this.abortController?.abort();
    }
    this.abortController = null;
    this.activeRequestSubscription?.unsubscribe();
    this.activeRequestSubscription = null;
    this.activeRequestId = 0;
    this.isSending = false;
    this.flushQueue();
  }

  public get hasDraftMessage(): boolean {
    return this.draftMessage.trim().length > 0;
  }

  public get queueCount(): number {
    return this.queuedMessages.length;
  }

  public getToolStatuses(entry: ChatMessage): ToolStatusRow[] {
    return (entry.toolTrace ?? []).map((item) => ({
      ok: item.ok,
      tool: item.tool
    }));
  }

  public trackByIndex(index: number) {
    return index;
  }

  /** Warnings to hide from user (tone, or hallucination when value came from user input). */
  public getDisplayWarnings(entry: ChatMessage): string[] {
    const raw = entry.warnings ?? [];
    const hidden =
      /unprofessional tone|ROLEPLAY|EXCESSIVE_EMOJI|slang|sarcasm|profanity|hallucination|could not be traced/i;
    return raw.filter((w) => !hidden.test(w));
  }

  public getMetricsText(loopMeta: LoopMeta): string {
    const iters = loopMeta.iterations;
    const sec = (loopMeta.totalMs / 1000).toFixed(1);
    let out = `${iters} iters · ${sec}s`;
    const u = loopMeta.tokenUsage;
    if (u) {
      const tokens =
        u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      const cost =
        ((u.inputTokens ?? 0) * 3 + (u.outputTokens ?? 0) * 15) / 1e6;
      out += ` · ${tokens.toLocaleString()} tokens · $${cost.toFixed(4)} cost`;
    }
    return out;
  }

  public ngOnDestroy() {
    this.closeWebSocket();
    this.activeRequestSubscription?.unsubscribe();
    this.activeRequestSubscription = null;
    this.unsubscribeSubject.next();
    this.unsubscribeSubject.complete();
  }

  private dispatchMessage(message: string) {
    const conversationHistory = this.messages.map((entry) => ({
      content: entry.content,
      role: entry.role
    }));

    this.appendMessage({
      content: message,
      role: 'user'
    });

    this.streamingAnswer = '';
    this.streamingAnswerVisibleLength = 0;
    this.isSending = true;

    // Scroll so user's command is at top (Cursor-style)
    setTimeout(() => this.scrollCommandToTop(), 0);
    const requestId = ++this.requestCounter;
    this.activeRequestId = requestId;

    const token = this.tokenStorageService.getToken();
    if (token && this.wsConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.dispatchMessageOverWebSocket(requestId, {
        conversationHistory,
        message
      });
      return;
    }
    if (token) {
      this.dispatchMessageStream(
        requestId,
        { conversationHistory, message },
        token
      );
      return;
    }

    this.activeRequestSubscription = this.dataService
      .postAgentChat({
        conversationHistory,
        message
      })
      .pipe(
        catchError((error) => {
          const fallback = $localize`The agent request failed. Please try again.`;
          const title = error?.error?.error || error?.message || fallback;
          this.notificationService.alert({ title });
          return EMPTY;
        }),
        finalize(() => {
          if (this.activeRequestId === requestId) {
            this.isSending = false;
            this.activeRequestSubscription = null;
            this.activeRequestId = 0;
            this.flushQueue();
          }
        }),
        takeUntil(this.unsubscribeSubject)
      )
      .subscribe((response: AgentChatResponse) => {
        this.appendMessage({
          confidence: response.confidence,
          content: response.answer,
          data: response.data,
          loopMeta: response.loopMeta as LoopMeta | undefined,
          role: 'assistant',
          toolTrace: response.toolTrace,
          warnings: response.warnings
        });
      });
  }

  private connectWebSocket(token: string): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/v1/agent/ws?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);

    socket.onopen = () => {
      this.wsConnected = true;
    };

    socket.onmessage = (ev: MessageEvent) => {
      const handler = this.wsMessageHandler;
      if (!handler) return;
      try {
        const event = JSON.parse(ev.data as string) as AgentStreamEvent;
        handler(event);
      } catch {
        this.appendStreamLog('STREAM PARSE ERROR', 'stream-fail');
      }
    };

    socket.onclose = () => {
      this.wsConnected = false;
      this.ws = null;
      if (this.isSending) {
        this.appendStreamLog('Connection closed', 'stream-fail');
      }
    };

    socket.onerror = () => {
      this.wsConnected = false;
      this.ws = null;
    };

    this.ws = socket;
  }

  private closeWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
    }
  }

  private didPortfolioChange(toolTrace: AgentToolTraceRow[]): boolean {
    return (toolTrace ?? []).some(
      (t) => PORTFOLIO_MODIFYING_TOOLS.includes(t.tool) && t.ok
    );
  }

  private formatIteration(iteration: number): string {
    return String(iteration).padStart(2, '0');
  }

  private appendStreamLog(text: string, cssClass: string): void {
    this.streamLogLines = [...this.streamLogLines, { text, cssClass }];
    this.scrollMessagesToBottom();
  }

  private dispatchMessageOverWebSocket(
    requestId: number,
    body: {
      conversationHistory: { role: string; content: string }[];
      message: string;
    }
  ): void {
    this.streamLogLines = [];
    this.appendStreamLog('STREAMING EVENTS...', 'stream-thinking');

    let finalAnswer: string | null = null;
    let finalConfidence = 0;
    let finalWarnings: string[] = [];
    let finalToolTrace: AgentToolTraceRow[] = [];
    let finalData: AgentChatResponseData | undefined;
    let finalLoopMeta: LoopMeta | undefined;
    let streamError: string | null = null;

    const handleStreamEvent = (event: AgentStreamEvent): void => {
      switch (event.type) {
        case 'iteration_start':
          this.appendStreamLog(
            `ITER ${this.formatIteration(event.iteration)} | THINKING...`,
            'stream-thinking'
          );
          break;
        case 'thinking':
          this.appendStreamLog(
            `ITER ${this.formatIteration(event.iteration)} | LLM STEP READY`,
            'stream-thinking'
          );
          break;
        case 'tool_start':
          this.appendStreamLog(
            `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [RUNNING]`,
            'stream-tool-running'
          );
          break;
        case 'tool_end': {
          const blocked = event.detail?.toUpperCase().includes('BLOCKED');
          if (blocked) {
            this.appendStreamLog(
              `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [BLOCKED] ${event.detail ?? ''}`.trim(),
              'stream-tool-blocked'
            );
          } else if (event.ok) {
            this.appendStreamLog(
              `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [OK ${event.ms}ms]${event.detail ? ` ${event.detail}` : ''}`,
              'stream-tool-ok'
            );
          } else {
            this.appendStreamLog(
              `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [FAIL ${event.ms}ms]${event.detail ? ` ${event.detail}` : ''}`,
              'stream-tool-fail'
            );
          }
          break;
        }
        case 'done': {
          finalAnswer = event.answer;
          finalConfidence = event.confidence;
          finalWarnings = event.warnings ?? [];
          finalToolTrace = event.toolTrace ?? [];
          finalData = event.data;
          finalLoopMeta = (event as { loopMeta?: LoopMeta })?.loopMeta;
          const iters = finalLoopMeta?.iterations ?? '-';
          const totalMs = finalLoopMeta?.totalMs ?? 0;
          this.appendStreamLog(
            `DONE — ${iters} iters · ${(totalMs / 1000).toFixed(1)}s`,
            'stream-done'
          );
          const meta = finalLoopMeta;
          const trace = event.toolTrace ?? [];
          if (meta) {
            const COST_PER_INPUT = 3.0 / 1_000_000;
            const COST_PER_OUTPUT = 15.0 / 1_000_000;
            const cost =
              (meta.tokenUsage?.inputTokens ?? 0) * COST_PER_INPUT +
              (meta.tokenUsage?.outputTokens ?? 0) * COST_PER_OUTPUT;
            const tokens =
              meta.tokenUsage?.totalTokens ??
              (meta.tokenUsage?.inputTokens ?? 0) +
                (meta.tokenUsage?.outputTokens ?? 0);
            const toolsList = trace.length
              ? trace.map((t) => t.tool).join(', ')
              : '—';
            const success = meta.terminationReason === 'end_turn';
            this.appendStreamLog(
              `METRICS: cost $${cost.toFixed(4)} · tokens ${tokens} · tools: ${toolsList} · success: ${success}`,
              'stream-metrics'
            );
          }
          this.wsMessageHandler = null;
          this.finishStreamRequest(requestId);
          if (streamError) {
            this.notificationService.alert({ title: streamError });
          } else {
            this.streamingAnswer = finalAnswer!;
            this.streamingAnswerVisibleLength = 0;
            this.runTypewriterEffect(finalAnswer!, () => {
              this.streamLogLines = [];
              this.streamingAnswer = '';
              this.streamingAnswerVisibleLength = 0;
              this.appendMessage({
                confidence: finalConfidence,
                content: finalAnswer!,
                data: finalData,
                loopMeta: finalLoopMeta,
                role: 'assistant',
                toolTrace: finalToolTrace,
                warnings: finalWarnings
              });
              if (this.didPortfolioChange(finalToolTrace)) {
                this.userService
                  .get(true)
                  .pipe(takeUntil(this.unsubscribeSubject))
                  .subscribe();
              }
            });
          }
          break;
        }
        case 'error':
          this.appendStreamLog(`ERROR — ${event.message}`, 'stream-fail');
          streamError = event.message;
          this.wsMessageHandler = null;
          this.finishStreamRequest(requestId);
          this.notificationService.alert({ title: event.message });
          break;
      }
    };

    this.wsMessageHandler = handleStreamEvent;
    this.ws?.send(JSON.stringify({ type: 'chat', ...body }));
  }

  private async dispatchMessageStream(
    requestId: number,
    body: {
      conversationHistory: { role: string; content: string }[];
      message: string;
    },
    token: string
  ): Promise<void> {
    this.streamLogLines = [];
    this.appendStreamLog('CONNECTING TO AGENT...', 'stream-thinking');

    this.abortController = new AbortController();

    const streamRequest = (): Promise<Response> =>
      fetch('/api/v1/agent/chat/stream', {
        method: 'POST',
        signal: this.abortController?.signal,
        headers: {
          'Content-Type': 'application/json',
          [HEADER_KEY_TOKEN]: `Bearer ${token}`
        },
        body: JSON.stringify(body)
      });

    try {
      const response = await streamRequest();

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 503) {
          this.appendStreamLog(
            `ERROR — Agent service not configured. Set AGENT_SERVICE_URL.`,
            'stream-fail'
          );
        } else {
          this.appendStreamLog(
            `ERROR — Request failed (HTTP ${response.status}). ${text || ''}`.trim(),
            'stream-fail'
          );
        }
        this.finishStreamRequest(requestId);
        return;
      }

      if (!response.body) {
        this.appendStreamLog(
          'ERROR — Streaming response was empty.',
          'stream-fail'
        );
        this.finishStreamRequest(requestId);
        return;
      }

      this.appendStreamLog('CONNECTED. STREAMING EVENTS...', 'stream-thinking');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalAnswer: string | null = null;
      let finalConfidence = 0;
      let finalWarnings: string[] = [];
      let finalToolTrace: AgentToolTraceRow[] = [];
      let finalData: AgentChatResponseData | undefined;
      let finalLoopMeta: LoopMeta | undefined;
      let streamError: string | null = null;

      const handleStreamEvent = (event: AgentStreamEvent): void => {
        switch (event.type) {
          case 'iteration_start':
            this.appendStreamLog(
              `ITER ${this.formatIteration(event.iteration)} | THINKING...`,
              'stream-thinking'
            );
            break;
          case 'thinking':
            this.appendStreamLog(
              `ITER ${this.formatIteration(event.iteration)} | LLM STEP READY`,
              'stream-thinking'
            );
            break;
          case 'tool_start':
            this.appendStreamLog(
              `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [RUNNING]`,
              'stream-tool-running'
            );
            break;
          case 'tool_end': {
            const blocked = event.detail?.toUpperCase().includes('BLOCKED');
            if (blocked) {
              this.appendStreamLog(
                `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [BLOCKED] ${event.detail ?? ''}`.trim(),
                'stream-tool-blocked'
              );
            } else if (event.ok) {
              this.appendStreamLog(
                `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [OK ${event.ms}ms]${event.detail ? ` ${event.detail}` : ''}`,
                'stream-tool-ok'
              );
            } else {
              this.appendStreamLog(
                `ITER ${this.formatIteration(event.iteration)} | TOOL ${event.tool} [FAIL ${event.ms}ms]${event.detail ? ` ${event.detail}` : ''}`,
                'stream-tool-fail'
              );
            }
            break;
          }
          case 'done': {
            finalAnswer = event.answer;
            finalConfidence = event.confidence;
            finalWarnings = event.warnings ?? [];
            finalToolTrace = event.toolTrace ?? [];
            finalData = event.data;
            finalLoopMeta = (event as { loopMeta?: LoopMeta })?.loopMeta;
            const iters = finalLoopMeta?.iterations ?? '-';
            const totalMs = finalLoopMeta?.totalMs ?? 0;
            this.appendStreamLog(
              `DONE — ${iters} iters · ${(totalMs / 1000).toFixed(1)}s`,
              'stream-done'
            );
            const meta = finalLoopMeta;
            const trace = event.toolTrace ?? [];
            if (meta) {
              const COST_PER_INPUT = 3.0 / 1_000_000;
              const COST_PER_OUTPUT = 15.0 / 1_000_000;
              const cost =
                (meta.tokenUsage?.inputTokens ?? 0) * COST_PER_INPUT +
                (meta.tokenUsage?.outputTokens ?? 0) * COST_PER_OUTPUT;
              const tokens =
                meta.tokenUsage?.totalTokens ??
                (meta.tokenUsage?.inputTokens ?? 0) +
                  (meta.tokenUsage?.outputTokens ?? 0);
              const toolsList = trace.length
                ? trace.map((t) => t.tool).join(', ')
                : '—';
              const success = meta.terminationReason === 'end_turn';
              this.appendStreamLog(
                `METRICS: cost $${cost.toFixed(4)} · tokens ${tokens} · tools: ${toolsList} · success: ${success}`,
                'stream-metrics'
              );
            }
            break;
          }
          case 'error':
            this.appendStreamLog(`ERROR — ${event.message}`, 'stream-fail');
            streamError = event.message;
            break;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const dataPayload = rawEvent
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');

          if (dataPayload) {
            try {
              const parsed = JSON.parse(dataPayload) as AgentStreamEvent;
              handleStreamEvent(parsed);
            } catch {
              this.appendStreamLog('STREAM PARSE ERROR', 'stream-fail');
            }
          }

          if (streamError) break;
          separatorIndex = buffer.indexOf('\n\n');
        }

        if (streamError) break;
      }

      if (streamError) {
        this.notificationService.alert({
          title: streamError
        });
      } else if (finalAnswer !== null) {
        this.streamingAnswer = finalAnswer;
        this.streamingAnswerVisibleLength = 0;
        this.runTypewriterEffect(finalAnswer, () => {
          this.streamLogLines = [];
          this.streamingAnswer = '';
          this.streamingAnswerVisibleLength = 0;
          this.appendMessage({
            confidence: finalConfidence,
            content: finalAnswer,
            data: finalData,
            loopMeta: finalLoopMeta,
            role: 'assistant',
            toolTrace: finalToolTrace,
            warnings: finalWarnings
          });
          if (this.didPortfolioChange(finalToolTrace)) {
            this.userService
              .get(true)
              .pipe(takeUntil(this.unsubscribeSubject))
              .subscribe();
          }
        });
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        this.appendStreamLog('CANCELLED', 'stream-fail');
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.appendStreamLog(`ERROR — ${msg}`, 'stream-fail');
        this.notificationService.alert({
          title: $localize`The agent request failed. ${msg}`
        });
      }
    } finally {
      this.abortController = null;
      this.finishStreamRequest(requestId);
    }
  }

  private finishStreamRequest(requestId: number): void {
    if (this.activeRequestId === requestId) {
      this.isSending = false;
      this.activeRequestId = 0;
      this.flushQueue();
    }
  }

  private enqueueMessage(message: string, prepend = false) {
    if (prepend) {
      this.queuedMessages = [message, ...this.queuedMessages];
      return;
    }

    this.queuedMessages = [...this.queuedMessages, message];
  }

  private flushQueue() {
    if (this.isSending || this.queuedMessages.length === 0) {
      return;
    }

    const [nextMessage, ...remaining] = this.queuedMessages;
    this.queuedMessages = remaining;
    this.dispatchMessage(nextMessage);
  }

  private appendMessage(message: ChatMessage) {
    this.messages = [...this.messages, message].slice(-MAX_HISTORY_MESSAGES);
    this.persistMessages();
    this.scrollMessagesToBottom();
  }

  private scrollCommandToTop(): void {
    const container = this.messagesContainer?.nativeElement;
    if (!container) return;
    const userRows = container.querySelectorAll('.message-row.user');
    const lastUserRow = userRows[userRows.length - 1];
    if (lastUserRow) {
      (lastUserRow as HTMLElement).scrollIntoView({
        block: 'start',
        behavior: 'smooth'
      });
    }
  }

  private scrollMessagesToBottom(): void {
    // Cursor-style: keep view anchored to the present (newest content).
    const anchor = this.scrollAnchor?.nativeElement;
    if (anchor) {
      anchor.scrollIntoView({ block: 'end', behavior: 'auto' });
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = this.messagesContainer?.nativeElement;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
  }

  private runTypewriterEffect(
    fullText: string,
    onComplete: () => void,
    charsPerTick = 30
  ): void {
    let pos = 0;
    const tick = () => {
      pos = Math.min(pos + charsPerTick, fullText.length);
      this.streamingAnswerVisibleLength = pos;
      this.scrollMessagesToBottom();

      if (pos < fullText.length) {
        setTimeout(tick, 16);
      } else {
        onComplete();
      }
    };
    setTimeout(tick, 50);
  }

  private getStorageKey() {
    return this.user?.id
      ? `${DEFAULT_HISTORY_KEY}_${this.user.id}`
      : DEFAULT_HISTORY_KEY;
  }

  private loadMessages(): ChatMessage[] {
    const rawValue = window.localStorage.getItem(this.getStorageKey());
    if (!rawValue) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue) as PersistedChatMessage[];
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((entry: PersistedChatMessage) => {
          return (
            typeof entry?.content === 'string' &&
            (entry?.role === 'assistant' || entry?.role === 'user')
          );
        })
        .map(
          (entry: PersistedChatMessage): NormalizedChatMessage => ({
            confidence: entry.confidence,
            content: entry.content,
            data: entry.data,
            loopMeta: entry.loopMeta,
            role: entry.role,
            toolTrace: entry.toolTrace,
            warnings: entry.warnings
          })
        )
        .slice(-MAX_HISTORY_MESSAGES);
    } catch {
      return [];
    }
  }

  private persistMessages() {
    window.localStorage.setItem(
      this.getStorageKey(),
      JSON.stringify(this.messages)
    );
  }
}
