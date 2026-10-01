import type { Attachment, LogicalInput, OutboxItem, PendingRequest, Run } from "../domain.js";
import type { Connection, Row } from "./database.js";

export function runRow(db: Connection, row: Row): Run {
  return {
    scope: db.scope(row.conversation_id as string), runId: row.id as string, sessionId: row.session_id as string,
    generation: row.generation as number, inputId: row.input_id as string, status: row.status as Run["status"],
    createdAt: row.created_at as number, updatedAt: row.updated_at as number,
  };
}
export function inputRow(db: Connection, row: Row): LogicalInput {
  return {
    id: row.id as string, scope: db.scope(row.conversation_id as string), sessionId: row.session_id as string,
    runId: row.run_id as string | null,
    status: row.status as LogicalInput["status"], mediaGroupId: row.album_id as string | null,
    messages: db.all("SELECT payload FROM incoming_messages WHERE input_id=? AND payload IS NOT NULL ORDER BY message_id", row.id as string)
      .map((message) => JSON.parse(message.payload as string) as LogicalInput["messages"][number]),
    readyAt: row.ready_at as number, createdAt: row.created_at as number,
  };
}
export function requestRow(db: Connection, row: Row): PendingRequest {
  return {
    id: row.id as string, scope: db.scope(row.conversation_id as string),
    sessionId: row.session_id as string, runId: row.run_id as string, generation: row.generation as number,
    payload: JSON.parse(row.payload as string) as PendingRequest["payload"],
    answer: row.answer === null ? null : JSON.parse(row.answer as string) as PendingRequest["answer"],
    draft: JSON.parse(row.draft as string) as PendingRequest["draft"],
    status: row.status as PendingRequest["status"], promptMessageId: row.prompt_message_id as number | null,
    createdAt: row.created_at as number, expiresAt: row.expires_at as number,
  };
}
export function attachmentRow(db: Connection, row: Row): Attachment {
  return {
    id: row.id as string, scope: db.scope(row.conversation_id as string), sessionId: row.session_id as string,
    runId: row.run_id as string | null, kind: row.kind as Attachment["kind"], relativePath: row.relative_path as string,
    fileName: row.file_name as string, mimeType: row.mime_type as string, sizeBytes: row.size_bytes as number,
    createdAt: row.created_at as number, expiresAt: row.expires_at as number | null,
  };
}
export function outboxRow(db: Connection, row: Row): OutboxItem {
  return {
    id: row.id as string, scope: db.scope(row.conversation_id as string), sessionId: row.session_id as string,
    runId: row.run_id as string | null, dedupKey: row.dedup_key as string,
    payload: JSON.parse(row.payload as string) as OutboxItem["payload"],
    replyToMessageId: row.reply_to_message_id as number | null, status: row.status as OutboxItem["status"],
    attempts: row.attempts as number, retryAfter: row.retry_after as number | null,
    errorCode: row.error_code as string | null, remoteMessageIds: JSON.parse(row.remote_message_ids as string) as number[],
    createdAt: row.created_at as number, updatedAt: row.updated_at as number,
  };
}
