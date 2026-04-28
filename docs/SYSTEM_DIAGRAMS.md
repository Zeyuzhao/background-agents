# Open-Inspect System Diagrams

This document captures the current service relationships, interface boundaries, and durable state
machines behind session execution. It follows the current implementation in `packages/web`,
`packages/control-plane`, `packages/shared`, and `packages/modal-infra`.

## Runtime Boundaries

```mermaid
flowchart LR
    subgraph Clients["Clients and Entry Points"]
        Browser["Browser / Next.js UI"]
        Slack["Slack Bot"]
        GitHubBot["GitHub Bot"]
        Linear["Linear Bot"]
        Scheduler["Scheduler / Automations"]
    end

    subgraph Web["Web App (Next.js)"]
        WebRoutes["Route Handlers<br>/api/auth/*<br>/api/sessions<br>/api/sessions/:id/*"]
    end

    subgraph ControlPlane["Control Plane (Cloudflare Workers)"]
        Router["Public Router<br>/sessions*<br>/repositories*<br>/settings*"]
        SessionDO["Session Durable Object<br>per-session SQLite<br>WS hub + queue + lifecycle"]
    end

    subgraph SessionState["Per-Session Durable State"]
        SQLite["SQLite in Durable Object<br>session<br>participants<br>messages<br>events<br>artifacts<br>sandbox<br>ws_client_mapping"]
        Presence["In-Memory Only<br>presence map<br>live WebSocket handles<br>spawn flags"]
    end

    subgraph SharedState["Cross-Session Shared State"]
        D1["D1<br>session index<br>repo metadata<br>secrets<br>integrations<br>model prefs<br>repo images<br>automations"]
        R2["R2<br>screenshot/media objects"]
    end

    subgraph DataPlane["Data Plane"]
        Provider["Sandbox Provider<br>Modal / provider adapter"]
        Sandbox["Sandbox Runtime<br>agent bridge + tools + repo checkout"]
    end

    GitHub["GitHub OAuth / GitHub API / Git transport"]

    Browser -->|"HTTPS + cookies"| WebRoutes
    Browser -->|"WS token + WebSocket<br>/sessions/:id/ws"| SessionDO
    WebRoutes -->|"server-to-server HTTPS"| Router

    Slack -->|"POST /sessions<br>POST /sessions/:id/prompt"| Router
    GitHubBot -->|"POST /sessions<br>POST /sessions/:id/prompt"| Router
    Linear -->|"POST /sessions<br>POST /sessions/:id/prompt<br>POST /sessions/:id/stop"| Router
    Scheduler -->|"POST /sessions<br>POST /sessions/:id/prompt"| Router

    Router -->|"internal fetch<br>/internal/*"| SessionDO
    SessionDO --> SQLite
    SessionDO --> Presence
    Router --> D1
    SessionDO -->|"status + metrics sync"| D1
    Router -->|"media upload"| R2

    SessionDO -->|"spawn / restore / stop"| Provider
    Provider --> Sandbox
    Sandbox -->|"sandbox WebSocket<br>/sessions/:id/ws"| SessionDO

    Router --> GitHub
    Sandbox --> GitHub
```

## Interface Boundaries

```mermaid
flowchart TB
    subgraph Public["Public Product Boundary"]
        Browser["Browser"]
        Bots["Slack / GitHub / Linear / Scheduler"]
        WebAPI["Next.js API Routes<br>/api/auth/[...nextauth]<br>/api/sessions<br>/api/sessions/:id/prompt<br>/api/sessions/:id/ws-token"]
        CPAPI["Control Plane Public APIs<br>POST /sessions<br>POST /sessions/:id/prompt<br>POST /sessions/:id/ws-token<br>POST /sessions/:id/stop<br>POST /sessions/:id/pr<br>POST /sessions/:id/media<br>PATCH /sessions/:id/title<br>POST /sessions/:id/archive<br>POST /sessions/:id/unarchive<br>POST /sessions/:id/children"]
    end

    subgraph Internal["Control Plane Internal Boundary"]
        InternalAPI["Session DO Internal APIs<br>/internal/init<br>/internal/prompt<br>/internal/stop<br>/internal/ws-token<br>/internal/sandbox-event<br>/internal/create-media-artifact<br>/internal/create-pr<br>/internal/archive<br>/internal/unarchive<br>/internal/cancel<br>/internal/spawn-context<br>/internal/child-session-update"]
        SessionCore["Session DO Core<br>message queue<br>presence service<br>sandbox event processor<br>lifecycle manager"]
    end

    subgraph Runtime["Session Runtime Boundary"]
        ClientWS["Client WebSocket<br>subscribe / prompt / typing / load_more_events"]
        SandboxWS["Sandbox WebSocket<br>heartbeat / token / tool_* / git_sync /<br>execution_complete / artifact / push_*"]
    end

    subgraph Storage["State Ownership"]
        DOState["Durable SQLite<br>session-local durable state"]
        Shared["D1 and R2<br>cross-session metadata and blobs"]
    end

    Browser --> WebAPI
    Browser --> ClientWS
    Bots --> CPAPI
    WebAPI --> CPAPI
    CPAPI --> InternalAPI
    InternalAPI --> SessionCore
    ClientWS --> SessionCore
    SandboxWS --> SessionCore
    SessionCore --> DOState
    SessionCore --> Shared
```

## Prompt Lifecycle

```mermaid
sequenceDiagram
    actor User
    participant Browser as Browser / UI
    participant Web as Next.js API Routes
    participant Router as Control Plane Router
    participant SessionDO as Session Durable Object
    participant Provider as Sandbox Provider
    participant Sandbox as Sandbox Runtime

    User->>Browser: Create session
    Browser->>Web: POST /api/sessions
    Web->>Router: POST /sessions
    Router->>SessionDO: POST /internal/init
    SessionDO->>SessionDO: Insert session + sandbox + owner participant
    Router-->>Browser: Session id

    Browser->>Web: POST /api/sessions/:id/ws-token
    Web->>Router: POST /sessions/:id/ws-token
    Router->>SessionDO: POST /internal/ws-token
    SessionDO->>SessionDO: Upsert participant + rotate ws_auth_token
    Router-->>Browser: WS token
    Browser->>SessionDO: WS /sessions/:id/ws subscribe
    SessionDO-->>Browser: subscribed + replay + presence sync

    User->>Browser: Send prompt
    alt HTTP path
        Browser->>Web: POST /api/sessions/:id/prompt
        Web->>Router: POST /sessions/:id/prompt
        Router->>SessionDO: POST /internal/prompt
    else Existing client WebSocket
        Browser->>SessionDO: prompt
    end

    SessionDO->>SessionDO: Create pending message
    SessionDO->>SessionDO: Write user_message event
    SessionDO->>SessionDO: Transition session to active

    alt No sandbox connected
        SessionDO-->>Browser: sandbox_spawning
        SessionDO->>Provider: spawn / restore / resume
        Provider->>Sandbox: Create or resume runtime
        Sandbox->>SessionDO: Sandbox WS authenticate
        SessionDO->>SessionDO: sandbox.status = ready
    end

    SessionDO->>Sandbox: prompt command
    Sandbox-->>SessionDO: token / tool_call / tool_result / step_* / git_sync
    Sandbox-->>SessionDO: execution_complete
    SessionDO->>SessionDO: Update message status
    SessionDO->>SessionDO: Persist events / artifacts / cost / SHAs
    SessionDO->>SessionDO: Reconcile session status
    SessionDO-->>Browser: processing_status + sandbox_event + session_status
```

## State Ownership

| State location        | Owned by           | What lives there                                                                                                           |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Durable Object SQLite | Session DO         | `session`, `participants`, `messages`, `events`, `artifacts`, `sandbox`, `ws_client_mapping`                               |
| Durable Object memory | Session DO process | Connected client sockets, presence, typing, current sandbox socket, in-flight spawn flags                                  |
| D1                    | Control plane      | Session index, repo metadata, encrypted secrets, integration settings, model preferences, automations, repo image metadata |
| R2                    | Control plane      | Screenshot and media object bytes                                                                                          |
| Sandbox filesystem    | Data plane         | Repo checkout, dependencies, working tree, local agent scratch state, pre-upload artifacts                                 |

## Session State Machine

Session status is user-facing progress for the whole session, not the same thing as sandbox status.

```mermaid
stateDiagram-v2
    [*] --> Created: /internal/init

    Created --> Active: first prompt enqueued
    Active --> Active: queued or concurrent work remains
    Active --> Completed: execution_complete(success)<br>queue empty
    Active --> Failed: execution_complete(failure)<br>queue empty

    Completed --> Active: new prompt
    Failed --> Active: new prompt

    Created --> Archived: archive
    Active --> Archived: archive
    Completed --> Archived: archive
    Failed --> Archived: archive
    Archived --> Active: unarchive

    Created --> Cancelled: cancel child session
    Active --> Cancelled: cancel child session
```

## Sandbox State Machine

The current code defines more sandbox statuses than it uses as primary durable transitions. The main
persisted lifecycle today is `pending -> spawning -> connecting -> ready`, plus the terminal paths
below.

```mermaid
stateDiagram-v2
    [*] --> Pending: session initialized

    Pending --> Spawning: warmSandbox or prompt without sandbox
    Spawning --> Connecting: provider create or restore succeeds
    Spawning --> Failed: provider create or restore fails

    Connecting --> Ready: sandbox websocket authenticated
    Connecting --> Failed: connect timeout or resume failure

    Ready --> Snapshotting: snapshot trigger
    Snapshotting --> Ready: snapshot completes

    Ready --> Stopped: inactivity timeout or cancel
    Ready --> Stale: heartbeat timeout
    Ready --> Failed: provider or bridge failure

    Stopped --> Connecting: provider-managed resume
    Stopped --> Spawning: fresh spawn or snapshot restore
    Stale --> Spawning: next prompt retry
    Failed --> Spawning: next prompt retry
```

Secondary statuses exist in shared types (`warming`, `syncing`, `running`) but are not the primary
durable state transitions used by the current control-plane lifecycle manager.

## Message State Machine

```mermaid
stateDiagram-v2
    [*] --> Pending: prompt accepted
    Pending --> Pending: waiting behind earlier work
    Pending --> Processing: dequeued and sent to sandbox
    Processing --> Completed: execution_complete(success)
    Processing --> Failed: execution_complete(failure)
    Processing --> Failed: stop, cancel, or sandbox termination
```
