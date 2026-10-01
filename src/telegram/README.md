# Telegram adapter

`createTelegramAdapter({ config, store, diagnostics, resolveAttachment? })`
exports:

- `transport: TelegramDeliveryTransport` extends the shared `DeliveryTransport`
  with `invalidatePreview(identity: RunIdentity): Promise<void>`.
- `start(handler: IngressHandler): Promise<void>` — bounded identity/webhook
  checks, then independent polling and outbox loops per configured bot.
- `stop(): Promise<void>` — aborts polling, rate waits, sends and downloads;
  waits at most five seconds, then logs and rejects with
  `TelegramError("TG_SHUTDOWN_INCOMPLETE")` if any owned work remains.
  The caller must retain SQLite and its process lock after this failure;
  shutdown is not confirmed and `stop()` may be retried once work settles.
- `downloadFile(botId, fileId, destination, signal, maxBytes):
  Promise<{ sizeBytes: number }>`

`resolveAttachment(scope, attachmentId)` returns (or resolves to)
`{ path, fileName, mimeType }`. Supply the media module's validated lookup, never
a model-provided path. Upload also requires a same-scope, same-session output
record and a regular non-symlink file within `runtimeDataPath`.
Telegram uses the resolver's absolute path; it does not reconstruct stored
`relativePath` values. Their canonical base belongs to the
[media module](../media/README.md).

## Wiring and durability

Acquire the process lock and call `store.recover()` **before** starting this
adapter. It owns the only outbox claim worker: the application enqueues outbox
items (or uses `runs.complete`) and must not run a second worker.
`transport.deliver` accepts only persisted `sending` items and returns an outcome;
the worker settles that exact attempt. Application code normally need not call it.

The ingress handler must resolve after **durable admission or control dispatch**,
not after SDK generation, parsing, ASR, a permission answer, or full cancellation.
Each bot processes updates in received order. The next `getUpdates` offset is
read from SQLite only after every prior handled update has a durable receipt.
Handler failure leaves that update unacknowledged for deduplicated replay. Even
ignored updates receive a durable receipt; sparse IDs are never treated as gaps.
grammY provides independent API clients; its automatic polling/runner is
deliberately not used because it can acknowledge before durable acceptance.

Numeric owner, sender-not-bot, sender-chat rejection, chat kind and exact binding
are checked before normalization or effects. Only real `getMe` identity/username
is trusted. Commands require an offset-zero UTF-16 `bot_command` entity.
Replies expose IDs only for outgoing messages owned by that bot in that topic;
the application must additionally match a **live** prompt/run/generation.
Callback messages must be accessible, bot-owned and in the authorized topic.
ACK is immediate and independent of application work; the application validates
opaque payload IDs and must never interpret arbitrary callback parameters.

Photos retain the largest resolution, captions and album IDs. No normalization
downloads media. SQLite/application album quiet-window admission makes one turn.
Authorized unsupported content receives a durable, controlled explanation,
never an invented model input. The first such message may initialize its normal
configured conversation/session solely to hold that response.

## Delivery and formatting

Plain content is HTML-escaped. Supported Markdown-like syntax is complete fenced
code, inline code, `**bold**`/`__bold__`, `*italic*`/`_italic_`, and `~~strike~~`.
Unrecognized syntax stays literal. Code never overlaps other formatting.
Emphasis requires valid whitespace/punctuation boundaries; arithmetic such as
`2 * 3 * 4` remains literal. Inline code matches whole, equal-length backtick
runs, preserving unmatched runs and interior ticks, spaces and delimiters.
Each chunk has balanced tags and at most 4096 decoded UTF-16 units (1024 for
file captions); Unicode scalars and escaped entities are not split. Long
unbroken/code text is retained. Extra caption chunks are sent as messages.
No reasoning/tool arguments are requested or displayed by this module; previews
must be supplied only user-visible answer deltas by the application.

Previews are throttled to 1.5 seconds and recheck live run identity after rate
waits. They are explicitly transient (`⏳`) and removed best-effort after a
confirmed final send. A separate one-second sweep invalidates terminal-run
previews even without a subsequent delta or a stop notice carrying a run ID.
The application calls `transport.invalidatePreview?.(identity)` immediately
after marking a run cancelling/terminal. The shared port's optional hook keeps
test adapters compatible; the production Telegram transport implements it.
Invalidation synchronously
evicts cached text, cancels queued rate waits, and starts bounded best-effort
deletion. An initial send already in flight deletes its returned message ID
after completion; invalidation never waits for that send. Failed deletion or an
ambiguous send without a returned ID cannot guarantee remote removal. Shutdown
invalidates every preview and includes outstanding cleanup in its bounded wait.
Final output always goes through the durable outbox.
Initial preview network ambiguity disables further creation for that preview.
Request buttons appear only on the final prompt chunk; its exact message ID is
written with `requests.setPrompt`. Button data is opaque ASCII
`[A-Za-z0-9:_-]`, 1–64 UTF-8 bytes, never action parameters or secrets.
Application menus may use the structural text-payload extension
`{ kind: "text", text, buttons }`. The adapter renders those same keyboards on
the final chunk without requiring or fabricating an SDK request, remapping a
prompt, or removing an active preview. Telegram does not import application UI
types; the boundary is the button-bearing payload shape.

Pacing is conservative: 25 operations/second per bot, one/1.05 seconds per
private chat, one/3.1 seconds per group (shared across its topics). Telegram 429
blocks that bot and persists an **absolute** `retryAfter`. Five attempts are
allowed per retry budget. Known API rejections are distinct from ambiguous
network failures: the latter are `uncertain`, never automatic retries.
Any failure after a successful chunk is `uncertain` with known message IDs.
The application must warn about possible duplicates before explicitly retrying
uncertainty. SQLite recovery also treats an interrupted `sending` item as
uncertain; a crash between Telegram acceptance and SQLite cannot establish
whether a message was sent.
Rate permits use a cancellable FIFO queue per bot. Every wake-up rechecks the
latest cooldown and chat/bot deadlines; spacing is reserved from actual permit
grant times, so an extended cooldown never collapses concurrent reservations
into a burst. Cancelled queued callers cannot bypass the current head.

Reply fallback is only for Telegram's specific 400 “message to be replied [to]
not found” response. The retry omits the reply but **retains the original topic**.
There is no fallback to another topic/chat, including for missing-topic errors.

## Limits and operations

Standard hosted Bot API only: 20,000,000-byte download / 50,000,000-byte upload
ceilings, never automatically bypassed with a local server.
Downloads check metadata, HTTP content length and actual streamed bytes, reject
redirects/remote traversal, and use private files within the managed root.
An absent destination is exclusively created (`O_EXCL | O_NOFOLLOW`, 0600);
alternatively the media owner may pre-create an **empty**, 0600, single-link
regular file owned by the service user. That file is opened without truncation,
with `O_NOFOLLOW`, and the descriptor's device/inode, ownership, mode, size and
link count are rechecked before writing. Its inode is preserved. Existing
nonempty, symlinked, hardlinked or insufficiently private files are rejected.
On abort/failure the downloader removes only artifacts it created; the media
owner is responsible for cleanup of its own pre-created files.
Telegram filenames are display metadata, not filesystem paths.
Uploads use validated file descriptors and bounded streams, not URL/path strings
supplied to Telegram by the model.

Webhook conflicts are reported without `deleteWebhook`. Polling 409, token
401/404, identity mismatch and identity collision disable only affected bots.
Transient failures reconnect at 0.5–30 seconds; empty responses wait 100 ms.
`retry_after` is honored in cancellable waits of at most 60 seconds each.
Initialization has a ten-second deadline, API calls forty seconds (long polling
twenty-five), callback ACK three seconds, downloads two minutes.
Diagnostics contain fixed codes and bot configuration IDs only, never raw
exceptions, payloads or token-bearing URLs. Numeric `attempt` and absolute
`retryAfter` metadata expose retry budgets and planned waits to the content-free
production diagnostic sink.

The application's `/status` should expose per-bot diagnostics and uncertain
outbox items. BotFather tokens and group privacy/admin configuration must be
provisioned separately. These tests use synthetic grammY APIs, HTTP responses
and real SQLite; **no live Telegram or token validation is claimed**.
