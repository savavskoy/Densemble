import type {
  Attachment, Conversation, DeliveryPayload, IncomingMessage, Json, LogicalInput, ModelInfo,
  NormalizedIngress, OutboxItem, PendingRequest, PreparedInput, RequestAnswer, RequestPayload,
  Run, RunIdentity, RuntimeCommand, RuntimeEvent, Scope, Session, TerminalRunStatus,
} from "./domain.js";

export interface SessionStore {
  conversation(scope: Scope): Conversation | null;
  create(scope: Scope, options: { agentId: string; workspace: string; model: string; now?: number }): Session;
  current(scope: Scope): Session | null;
  get(scope: Scope, sessionId: string): Session | null;
  list(scope: Scope): Session[];
  activate(scope: Scope, sessionId: string, now?: number): boolean;
  setProviderSessionId(scope: Scope, sessionId: string, providerSessionId: string): boolean;
  requestModel(scope: Scope, sessionId: string, model: string, now?: number): boolean;
  applyModel(scope: Scope, sessionId: string, expectedModel: string, now?: number): boolean;
  clearPendingModel(scope: Scope, sessionId: string, expectedModel: string): boolean;
  delete(scope: Scope, sessionId: string): SessionDeletion | null;
}
export interface SessionDeletion {
  sessionId: string;
  providerSessionId: string | null;
  artifacts: Attachment[];
}
export interface AdmissionOptions {
  sessionId: string;
  reserveRun?: boolean;
  albumDelayMs?: number;
  now?: number;
}
export interface Admission {
  accepted: boolean;
  disposition: "accepted" | "duplicate" | "late-album";
  input: LogicalInput | null;
  run: Run | null;
}
export interface InboxStore {
  admit(message: IncomingMessage, options: AdmissionOptions): Admission;
  recordControl(ingress: NormalizedIngress): boolean;
  recordIgnored(botId: string, updateId: number, now?: number): boolean;
  acknowledge(botId: string, updateId: number): number;
  offset(botId: string): number;
  get(scope: Scope, inputId: string): LogicalInput | null;
  queued(scope?: Scope): LogicalInput[];
  reserve(scope: Scope, inputId: string, now?: number): Run | null;
  attachToRun(identity: RunIdentity, inputId: string, now?: number): LogicalInput | null;
  cancelQueued(scope: Scope, sessionId: string, now?: number): number;
}
export interface RunStore {
  active(scope: Scope): Run | null;
  get(scope: Scope, runId: string): Run | null;
  isLive(identity: RunIdentity): boolean;
  markRunning(identity: RunIdentity, now?: number): boolean;
  markWaiting(identity: RunIdentity, now?: number): boolean;
  cancel(identity: RunIdentity, now?: number): boolean;
  finish(identity: RunIdentity, status: TerminalRunStatus, now?: number): boolean;
  complete(identity: RunIdentity, deliveries: RunDelivery[], now?: number): OutboxItem[] | null;
}
export type RunDelivery = Pick<EnqueueDelivery, "dedupKey" | "payload" | "attachmentIds" | "replyToMessageId">;
export interface RequestStore {
  create(identity: RunIdentity, payload: RequestPayload, options: { expiresAt: number; id?: string; now?: number }): PendingRequest;
  get(scope: Scope, requestId: string): PendingRequest | null;
  pending(scope: Scope): PendingRequest[];
  setPrompt(scope: Scope, requestId: string, messageId: number): boolean;
  saveDraft(identity: RunIdentity, requestId: string, draft: Record<string, string[]>, now?: number): boolean;
  claim(identity: RunIdentity, requestId: string, answer: RequestAnswer, now?: number): PendingRequest | null;
  resolve(identity: RunIdentity, requestId: string, now?: number): boolean;
  cancel(scope: Scope, requestId: string): boolean;
  invalidateRun(identity: RunIdentity): number;
  expire(now?: number): number;
}
export interface EnqueueDelivery {
  scope: Scope;
  sessionId: string;
  runId?: string;
  dedupKey: string;
  payload: DeliveryPayload;
  attachmentIds?: string[];
  replyToMessageId?: number;
  now?: number;
}
export interface DeliveryOutcome {
  status: "sent" | "failed" | "uncertain";
  remoteMessageIds?: number[];
  retryAfter?: number;
  errorCode?: string;
}
export interface OutboxStore {
  enqueue(delivery: EnqueueDelivery): OutboxItem;
  get(scope: Scope, id: string): OutboxItem | null;
  list(scope: Scope): OutboxItem[];
  claim(options?: { now?: number; maxAttempts?: number; botId?: string }): OutboxItem | null;
  settle(id: string, attempt: number, outcome: DeliveryOutcome, now?: number): boolean;
  retry(scope: Scope, id: string, options?: { allowUncertain?: boolean; now?: number }): boolean;
  discard(scope: Scope, id: string, now?: number): boolean;
  pinnedAttachmentIds(): string[];
}
export interface AttachmentStore {
  add(attachment: Omit<Attachment, "id" | "createdAt" | "expiresAt"> & { id?: string; createdAt?: number; expiresAt?: number | null }): Attachment;
  get(scope: Scope, id: string): Attachment | null;
  list(scope: Scope, sessionId: string): Attachment[];
  pin(scope: Scope, id: string, pinId: string): boolean;
  unpin(pinId: string): number;
  expired(now?: number): Attachment[];
  removeExpired(id: string, now?: number): Attachment | null;
}
export interface Recovery {
  interruptedRuns: Run[];
  invalidatedRequests: number;
  uncertainDeliveries: number;
  queuedInputs: LogicalInput[];
}
export interface StateStore {
  sessions: SessionStore;
  inbox: InboxStore;
  runs: RunStore;
  requests: RequestStore;
  outbox: OutboxStore;
  attachments: AttachmentStore;
  recover(now?: number): Recovery;
  cleanup(options: { before: number; now?: number }): { inputs: number; requests: number; outbox: number };
  backup(destination: string): Promise<void>;
  close(): void;
}

export interface RuntimeSessionOptions {
  session: Session;
  onEvent: (event: RuntimeEvent) => void;
}
export interface AgentRuntime {
  open(options: RuntimeSessionOptions): Promise<{ providerSessionId: string }>;
  execute(command: RuntimeCommand): Promise<void>;
  setModel(scope: Scope, sessionId: string, model: string): Promise<void>;
  models(scope: Scope, sessionId: string): Promise<ModelInfo[]>;
  disconnect(scope: Scope, sessionId: string): Promise<void>;
  deleteSession(scope: Scope, sessionId: string, providerSessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}
export interface MediaPreparation {
  prepare(input: LogicalInput, identity: RunIdentity, signal: AbortSignal): Promise<PreparedInput>;
  transcribe(attachment: IncomingMessage["attachments"][number], scope: Scope, signal: AbortSignal): Promise<string>;
  exportFile(identity: RunIdentity, path: string, signal: AbortSignal): Promise<Attachment>;
  cleanup(): Promise<void>;
  releaseRun?(identity: RunIdentity): void;
  removeArtifacts?(artifacts: Attachment[]): Promise<void>;
}
export interface DeliveryTransport {
  deliver(item: OutboxItem, signal?: AbortSignal): Promise<DeliveryOutcome>;
  preview(identity: RunIdentity, text: string): Promise<void>;
  acknowledgeCallback(botId: string, callbackId: string, text?: string): Promise<void>;
  invalidatePreview?(identity: RunIdentity): Promise<void>;
}
export interface IngressHandler {
  handle(ingress: NormalizedIngress): Promise<void>;
}
export interface DiagnosticSink {
  record(code: string, metadata?: Record<string, Exclude<Json, object>>): void;
}
