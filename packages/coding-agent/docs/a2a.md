# A2A (Agent2Agent)

senpi speaks [A2A v1.0](https://a2a-protocol.org/latest/specification/) in both directions. As an A2A **server**, `senpi a2a-server` puts a JSON-RPC + SSE listener in front of real agent sessions, publishes a public agent card, and lets any A2A client send it coding tasks. As an A2A **client**, the builtin `a2a` extension reads an `a2a.json` file and turns each remote agent into a regular tool the model can call mid-turn, so delegating a subtask to another vendor's agent looks exactly like calling `webfetch`.

## Serving senpi over A2A

```bash
senpi a2a-server
```

Usage:

```text
senpi a2a-server [--listen <http://IP:PORT>] [--auth <token-file|off>] [--cwd <dir>] [--name <agent name>] [--extension <path>]...
```

### Flags

### `--listen`
Where the HTTP listener binds. Default `http://127.0.0.1:41241`. The value must be `http://` with an **IP literal** host and an explicit port; hostnames, `https://`, credentials, paths, query strings, and fragments are all rejected with:

```text
Invalid --listen value. Use http://IP:PORT with an IP literal host and an explicit port.
```

### `--auth`
`token-file` semantics by default. Pass a path (`--auth /path/to/token`) to read the expected bearer token from that file, or `--auth off` to disable auth entirely. With `--auth` omitted, senpi creates or reuses a token at `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/a2a-server/token` (mode `0600`) and prints the path to stderr at startup.

`--auth off` works only on a loopback host (`127.0.0.0/8` or `::1`). Anything else fails to start with exit code 2:

```text
Refusing unauthenticated a2a-server on non-loopback host.
```

### `--cwd`
Workspace directory every session runs in. Default: the process cwd.

### `--name`
Agent name published in the agent card. Default `senpi`.

### `--extension`
Repeatable path to an extra extension loaded into every server session (for example the omo plugin, so remote sessions have its tools). Relative and other local values are resolved against the process cwd. When at least one `--extension` is loaded, the agent card advertises the `https://omo.dev/a2a/ext/omo-remote/v1` capability and an `ultrawork` skill.

`--help` / `-h` prints the usage line and exits.

### Startup output

Startup writes three lines to stderr (the token line only when bearer auth is on):

```text
senpi a2a-server listening on http://127.0.0.1:41241
agent card http://127.0.0.1:41241/.well-known/agent-card.json
token /Users/you/.senpi/agent/a2a-server/token
```

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/.well-known/agent-card.json` | public | Agent card (ETag + `max-age=300`) |
| `GET` | `/readyz`, `/healthz` | public | Liveness, returns `ok` |
| `POST` | `/`, `/rpc` | bearer | JSON-RPC 2.0, SSE for streaming methods |

POST bodies must be `application/json` or `application/a2a+json` (otherwise 415) and stay under 8 MiB (otherwise 413). A missing or wrong bearer token gets `401` with `WWW-Authenticate: Bearer`. The agent card stays public even when auth is on, so clients can discover the interface before they hold a token.

The card advertises one interface (`protocolBinding: "JSONRPC"`, `protocolVersion: "1.0"`), `capabilities.streaming: true`, `pushNotifications: false`, `extendedAgentCard: false`, `text/plain` in and out, and a single `coding-agent` skill.

### Curl quickstart

```bash
senpi a2a-server --listen http://127.0.0.1:41241 &
token="$(cat ~/.senpi/agent/a2a-server/token)"
```

Fetch the card (no auth needed):

```bash
curl -s http://127.0.0.1:41241/.well-known/agent-card.json
```

Send a blocking message and wait for the finished task:

```bash
curl -s http://127.0.0.1:41241/ \
  -H "authorization: Bearer $token" \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "msg-ping",
        "role": "ROLE_USER",
        "parts": [{ "text": "ping" }]
      }
    }
  }'
```

The result is `{"task": {...}}` with `status.state: "TASK_STATE_COMPLETED"`, the assistant's reply in `artifacts[].parts[].text`, and the user message in `history`. Add `"configuration": {"returnImmediately": true}` to get the `TASK_STATE_SUBMITTED` / `TASK_STATE_WORKING` snapshot back straight away and poll `GetTask` later. `"configuration": {"historyLength": N}` trims the returned history.

Stream the same turn:

```bash
curl -sN http://127.0.0.1:41241/ \
  -H "authorization: Bearer $token" \
  -H "content-type: application/json" \
  -H "accept: text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "messageId": "msg-ping",
        "role": "ROLE_USER",
        "parts": [{ "text": "ping" }]
      }
    }
  }'
```

Every SSE frame is a full JSON-RPC success envelope sharing the request `id`. The order is: one `{"task": ...}` snapshot, then `statusUpdate` (`TASK_STATE_WORKING`), then `artifactUpdate` frames whose text chunks concatenate into the reply, then a terminal `statusUpdate`. The server closes the stream as soon as a terminal state goes out.

### Contexts, tasks, and sessions

`contextId` is the session; `taskId` is one turn inside it.

- A message with no `contextId` and no `taskId` gets a fresh UUID context and a fresh agent session.
- Reusing a `contextId` reuses that session, so history carries over. Turns on one context are serialized: a second `SendMessage` queues behind the first.
- Sending `taskId` continues that task's context. If you also send a `contextId` that disagrees with the task's, you get `-32602`.
- Referring to a task that already reached a terminal state (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`) is `-32004`.

### The omo-remote/v1 extension

When the server runs with at least one `--extension`, it advertises `https://omo.dev/a2a/ext/omo-remote/v1` on the agent card and turns on the three behaviours below. Without `--extension` the server behaves exactly as documented above and none of them apply.

**Extension params.** The advertised extension carries its versions in `params`:

```json
{
  "uri": "https://omo.dev/a2a/ext/omo-remote/v1",
  "description": "omo remote delegation: workspace metadata, steer, usage reporting",
  "required": false,
  "params": { "pluginVersion": "1.4.191", "engineVersion": "2026.9.5-3" }
}
```

`engineVersion` is the senpi version serving the card. `pluginVersion` is read from the `OMO_PLUGIN_VERSION` environment variable (the omo launcher sets it) and is omitted when that variable is unset or empty.

**Steering a running turn.** A `SendMessage` / `SendStreamingMessage` whose message carries `metadata.omo.steer: true` and a `taskId` in `TASK_STATE_WORKING` injects the text into that turn instead of starting a new one:

```json
{
  "message": {
    "messageId": "m2",
    "role": "ROLE_USER",
    "parts": [{ "text": "skip the refactor, just fix the test" }],
    "taskId": "<running task id>",
    "metadata": { "omo": { "steer": true } }
  }
}
```

The non-streaming response is `{"task": <snapshot of the same task>}` — the id is unchanged and no task is created. The streaming form attaches the SSE stream to that existing task, so you receive its remaining `artifactUpdate` frames and its terminal `statusUpdate`. Steering a task that is not `TASK_STATE_WORKING` (already terminal, still `SUBMITTED`) is `-32602` with detail `task is not running`; steering with a `contextId` that disagrees with the task's is the same `-32602` as elsewhere.

**Follow-up queueing.** The same message *without* the steer flag keeps the standard A2A semantics: one task per turn. The server creates a new task that reuses the named task's `contextId`, and the context's turn queue serializes it — the new turn's prompt only starts after the running task reaches a terminal state. Send `taskId` (or just the `contextId`) and read the new task id from the response.

**Usage reporting.** The terminal `statusUpdate` carries this turn's token and cost delta, computed from the session statistics captured at turn start:

```json
{
  "taskId": "…",
  "contextId": "…",
  "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "…" },
  "metadata": {
    "omo": {
      "usage": { "input": 812, "output": 240, "cacheRead": 4096, "cacheWrite": 128, "cost": 0.0113, "model": "claude-sonnet-4-5" }
    }
  }
}
```

All five numbers are this turn's delta, not session totals; `model` is the model that ran the turn and is omitted when no model is selected. With the extension inactive the terminal `statusUpdate` has no `metadata` key at all.

### Cancellation

`CancelTask` with `{"id": "<taskId>"}` aborts the in-flight turn, moves the task to `TASK_STATE_CANCELED`, returns the updated task, and pushes that `statusUpdate` to every open SSE subscriber before closing their streams. Canceling an already-terminal task is `-32002`.

`SubscribeToTask` attaches a new SSE stream to a running task and replays the current snapshot first. Subscribing to a terminal task is `-32004`.

### The `A2A-Version` header

The `a2a-version` request header is optional. When present it must be `1.0` or `1.0.<patch>`; anything else (`0.3`, `2.0`, …) is rejected with `-32009` and metadata naming the requested and supported versions. Omitting the header is treated as "current version" and passes.

### Methods

| Method | Supported | Notes |
|--------|-----------|-------|
| `SendMessage` | yes | Blocking by default; `configuration.returnImmediately` for fire-and-poll |
| `SendStreamingMessage` | yes | SSE: task, statusUpdate, artifactUpdate…, terminal statusUpdate |
| `GetTask` | yes | `-32001` when the task id is unknown |
| `ListTasks` | yes | Params optional |
| `CancelTask` | yes | `-32002` when the task is already terminal |
| `SubscribeToTask` | yes | `-32004` on a terminal task |
| `GetExtendedAgentCard` | no | `-32004`, no extended card is configured |
| `CreateTaskPushNotificationConfig` | no | `-32003` |
| `GetTaskPushNotificationConfig` | no | `-32003` |
| `ListTaskPushNotificationConfigs` | no | `-32003` |
| `DeleteTaskPushNotificationConfig` | no | `-32003` |

Error codes you can hit:

| Code | Name | When |
|------|------|------|
| `-32700` | JSONParseError | Body is not JSON (returned with HTTP 200) |
| `-32600` | InvalidRequestError | Bad envelope, unauthorized (401), wrong content type (415), oversized body (413) |
| `-32601` | MethodNotFoundError | Unknown method name |
| `-32602` | InvalidParamsError | Empty `parts`, mismatched `contextId`, other param validation |
| `-32603` | InternalError | Anything unexpected, deliberately opaque |
| `-32001` | TaskNotFoundError | Unknown task id |
| `-32002` | TaskNotCancelableError | `CancelTask` on a terminal task |
| `-32003` | PushNotificationNotSupportedError | Any push notification config method |
| `-32004` | UnsupportedOperationError | Terminal-task follow-up, terminal-task subscribe, extended card |
| `-32009` | VersionNotSupportedError | Unsupported `a2a-version` header |

Every error carries a `google.rpc.ErrorInfo` object as `data[0]` with `domain: "a2a-protocol.org"`, a `reason`, and metadata.

## Calling A2A agents from senpi

The builtin `a2a` extension registers one tool per configured remote agent at session start and shows `a2a: N agents` in the status line.

### Config files

- `<agentDir>/a2a.json` (global, typically `~/.senpi/agent/a2a.json`)
- `.senpi/a2a.json` (project, loaded only when the project is trusted; project entries override global ones with the same name)

Shape:

```json
{
  "agents": {
    "reviewer": {
      "url": "http://127.0.0.1:41241",
      "description": "Second-opinion code reviewer running on the build box.",
      "headers": { "x-team": "platform" },
      "bearerTokenEnv": "REVIEWER_A2A_TOKEN",
      "enabled": true,
      "timeoutMs": 120000
    }
  }
}
```

### Agent fields (`agents.<name>`)

### `url`
Required. `http://` or `https://`. Either the agent's base URL or its card URL directly; senpi appends `/.well-known/agent-card.json` when the URL doesn't already end with it.

### `headers`
Optional string map of extra HTTP headers sent with every request, including the card fetch.

### `bearerTokenEnv`
Optional name of an environment variable holding the bearer token. senpi reads it and sets `Authorization: Bearer <value>`. If the variable is unset or empty the agent is skipped with a diagnostic; the token itself never lives in the config file.

### `enabled`
Boolean, default `true`. Disabled agents stay in config and register no tool.

### `timeoutMs`
Optional finite number. Per-request timeout for the client, and the timeout `/a2a status` uses when probing the card. The probe falls back to 10000 ms when unset.

### `description`
Optional. Becomes the tool description. Default: `Send a message to the remote A2A agent '<name>' and return its reply.`

Agent names match `^[a-z0-9][a-z0-9_-]*$` (case-insensitive). Anything invalid, along with malformed JSON or bad field types, surfaces as a warning notification at session start instead of failing the session.

### The generated tool

Each enabled agent becomes a tool named `a2a_<name>` with `-` replaced by `_`, so `code-reviewer` gives `a2a_code_reviewer`. Parameters:

| Parameter | Type | Meaning |
|-----------|------|---------|
| `message` | string, required | Text sent to the remote agent |
| `contextId` | string, optional | Continue an earlier conversation |
| `taskId` | string, optional | Continue a specific task |
| `returnImmediately` | boolean, optional | Return without waiting for completion. Default `false` |

The tool returns the remote artifact text (or the status message, or `(task <id> is <state>)` when the task produced nothing), plus details carrying the agent name, task id, state, artifact count, and context id. A protocol error comes back as an error result reading `A2A error <code>: <message>` rather than throwing.

### `/a2a`

| Subcommand | What it does |
|------------|--------------|
| `/a2a list` (default) | Prints `name — url [global\|project] [enabled\|disabled]` for every configured agent |
| `/a2a status` | Fetches each enabled agent's card and reports `name: <card name> v<version> (streaming: yes\|no)`, or the HTTP status / error |
| `/a2a refresh` | Rereads both config files, registers newly added agents, and tells you when removed or changed agents need `/reload` |

Newly registered agents are live in the current session. Removing or editing an existing agent needs a session reload, because a registered tool can't be rewritten in place.

### Worked example: one senpi calling another

Start a server in the repo you want the remote agent to work on:

```bash
senpi a2a-server --listen http://127.0.0.1:41241 --cwd ~/code/other-project --name other-project
```

Export its token and point your main senpi at it:

```bash
export OTHER_PROJECT_TOKEN="$(cat ~/.senpi/agent/a2a-server/token)"
```

`~/.senpi/agent/a2a.json`:

```json
{
  "agents": {
    "other-project": {
      "url": "http://127.0.0.1:41241",
      "bearerTokenEnv": "OTHER_PROJECT_TOKEN",
      "description": "senpi running in ~/code/other-project. Ask it to read or change files there.",
      "timeoutMs": 300000
    }
  }
}
```

Start senpi, run `/a2a status` to confirm the card resolves, and the model can now call `a2a_other_project` with a message like "find the failing test in the auth suite and summarize the cause".

## Troubleshooting

**`401 Unauthorized` on POST.** The server has bearer auth on and your request didn't carry a valid token. Read the token path from the server's startup line and send `Authorization: Bearer <token>`. From config, use `bearerTokenEnv`. The agent card is public, so a working card fetch tells you nothing about your token.

**`-32009 Version not supported`.** Your client sent an `a2a-version` header senpi doesn't accept. Send `1.0` (or `1.0.<patch>`), or drop the header.

**`-32004 This operation is not supported`.** Usually a follow-up on a task that already completed, failed, was canceled, or was rejected. Start a new task, keeping the same `contextId` if you want the conversation history. The same code comes back from `SubscribeToTask` on a terminal task and from `GetExtendedAgentCard`.

**`-32002 Task cannot be canceled`.** The task reached a terminal state before your `CancelTask` landed. Nothing to do.

**`415` or `413`.** Send `content-type: application/json` and keep bodies under 8 MiB.

**Agent missing from `/a2a list`.** Project config is only read when the project is trusted, and an agent whose `bearerTokenEnv` variable is unset is skipped with a warning at session start.

## Security

- **Bind to loopback.** The default listen address is `127.0.0.1:41241`. Exposing the listener on a routable address hands remote callers a shell-capable agent in your workspace; senpi refuses to do that without auth, and you should keep auth on even then.
- **Protect the token file.** The auto-generated token is written with mode `0600`. Keep any token file you supply yourself at the same permissions, and treat it like an SSH key. The server refuses to start on an empty token file.
- **Never write tokens into `a2a.json`.** Use `bearerTokenEnv` so the secret lives in the environment and the config file stays shareable and committable.
- **Project configs are trust-gated.** `.senpi/a2a.json` is ignored until you trust the project, so cloning a hostile repo doesn't silently register a remote agent tool. See [Security](security.md).
- **The workspace is the blast radius.** Every A2A caller shares the one `--cwd`, and the agent has the same tools it has interactively. Run untrusted callers against a scratch checkout or inside a container ([Containerization](containerization.md)).
