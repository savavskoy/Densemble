export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ChatKind = "private" | "group" | "forum";

export interface Scope {
  ownerId: number;
  botId: string;
  chatId: number;
  topicId: number | null;
}

export function scopeKey(scope: Scope): string {
  assertScope(scope);
  return JSON.stringify([scope.ownerId, scope.botId, scope.chatId, scope.topicId]);
}

export function assertScope(scope: Scope): void {
  if (!Number.isSafeInteger(scope.ownerId) || scope.ownerId <= 0 ||
      !Number.isSafeInteger(scope.chatId) || scope.chatId === 0 ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(scope.botId) ||
      (scope.topicId !== null && (!Number.isSafeInteger(scope.topicId) || scope.topicId <= 0))) {
    throw new Error("INVALID_SCOPE");
  }
}

export interface IncomingAttachment {
  kind: "photo" | "document" | "voice";
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSeconds?: number;
}

export interface NormalizedCommand {
  name: string;
  targetBotUsername?: string;
  arguments: string;
}

export interface IncomingMessage {
  kind: "message";
  scope: Scope;
  chatKind: ChatKind;
  updateId: number;
  messageId: number;
  receivedAt: number;
  text: string;
  attachments: IncomingAttachment[];
  mediaGroupId?: string;
  replyToMessageId?: number;
  command?: NormalizedCommand;
}

export interface IncomingCallback {
  kind: "callback";
  scope: Scope;
  chatKind: ChatKind;
  updateId: number;
  messageId: number;
  receivedAt: number;
  callbackId: string;
  data: string;
}
export type NormalizedIngress = IncomingMessage | IncomingCallback;

export interface Conversation {
  id: string;
  scope: Scope;
  currentSessionId: string | null;
  createdAt: number;
}

export interface Session {
  id: string;
  conversationId: string;
  scope: Scope;
  agentId: string;
  workspace: string;
  providerSessionId: string | null;
  appliedModel: string;
  pendingModel: string | null;
  generation: number;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "preparing" | "running" | "waiting" | "cancelling" |
  "succeeded" | "failed" | "cancelled" | "interrupted";
export type TerminalRunStatus = Extract<RunStatus, "succeeded" | "failed" | "cancelled" | "interrupted">;
export interface RunIdentity {
  scope: Scope;
  sessionId: string;
  runId: string;
  generation: number;
}
export interface Run extends RunIdentity {
  inputId: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
}

export type InputStatus = "queued" | "reserved" | "completed" | "cancelled" | "interrupted";
export interface LogicalInput {
  id: string;
  scope: Scope;
  sessionId: string;
  runId: string | null;
  status: InputStatus;
  mediaGroupId: string | null;
  messages: IncomingMessage[];
  readyAt: number;
  createdAt: number;
}

export interface QuestionField {
  id: string;
  prompt: string;
  choices: string[];
  multiple: boolean;
  allowFreeform: boolean;
}
export type RequestPayload =
  | { kind: "question"; fields: QuestionField[] }
  | { kind: "permission"; action: string; parameters: Json };
export type RequestAnswer =
  | { kind: "question"; answers: Record<string, string[]> }
  | { kind: "permission"; approved: boolean };
export type RequestStatus = "pending" | "claimed" | "resolved" | "cancelled" | "invalidated" | "expired";
export interface PendingRequest extends RunIdentity {
  id: string;
  payload: RequestPayload;
  status: RequestStatus;
  answer: RequestAnswer | null;
  draft: Record<string, string[]>;
  promptMessageId: number | null;
  createdAt: number;
  expiresAt: number;
}

export interface Attachment {
  id: string;
  scope: Scope;
  sessionId: string;
  runId: string | null;
  kind: "input" | "output" | "audio";
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number | null;
}

export interface PreparedInput {
  text: string;
  images: { path: string; mimeType: string; displayName: string }[];
  attachmentIds: string[];
  notices: string[];
}

export type DeliveryPayload =
  | { kind: "text"; text: string }
  | { kind: "file"; attachmentId: string; caption?: string }
  | { kind: "request"; requestId: string; text: string; buttons: { text: string; data: string }[][] };
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "uncertain";
export interface OutboxItem {
  id: string;
  scope: Scope;
  sessionId: string;
  runId: string | null;
  dedupKey: string;
  payload: DeliveryPayload;
  replyToMessageId: number | null;
  status: DeliveryStatus;
  attempts: number;
  retryAfter: number | null;
  errorCode: string | null;
  remoteMessageIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  supportsImages: boolean;
}

export type RuntimeEvent =
  | ({ kind: "delta"; text: string } & RunIdentity)
  | ({ kind: "status"; status: string } & RunIdentity)
  | ({ kind: "request"; requestId: string; payload: RequestPayload } & RunIdentity)
  | ({ kind: "completed"; text: string } & RunIdentity)
  | ({ kind: "failed"; code: string } & RunIdentity)
  | ({ kind: "stopped"; forced: boolean; externalOutcomeUnknown: boolean } & RunIdentity);

export type RuntimeCommand =
  | { kind: "send"; identity: RunIdentity; input: PreparedInput }
  | { kind: "steer"; identity: RunIdentity; input: PreparedInput }
  | { kind: "stop"; identity: RunIdentity }
  | { kind: "answer"; identity: RunIdentity; requestId: string; answer: RequestAnswer };
