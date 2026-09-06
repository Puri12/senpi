/**
 * A2A protocol v1.0 JSON shapes.
 *
 * JSON is camelCase and enums are ProtoJSON string names, exactly as the normative
 * `a2a.proto` serializes them. Nothing here depends on a transport or a runtime.
 */

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_VERSION_HEADER = "a2a-version";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Metadata = Record<string, unknown>;

export type TaskState =
	| "TASK_STATE_UNSPECIFIED"
	| "TASK_STATE_SUBMITTED"
	| "TASK_STATE_WORKING"
	| "TASK_STATE_COMPLETED"
	| "TASK_STATE_FAILED"
	| "TASK_STATE_CANCELED"
	| "TASK_STATE_INPUT_REQUIRED"
	| "TASK_STATE_REJECTED"
	| "TASK_STATE_AUTH_REQUIRED";

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_REJECTED",
]);

export const INTERRUPTED_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
	"TASK_STATE_INPUT_REQUIRED",
	"TASK_STATE_AUTH_REQUIRED",
]);

export function isTerminalTaskState(state: TaskState): boolean {
	return TERMINAL_TASK_STATES.has(state);
}

export function isInterruptedTaskState(state: TaskState): boolean {
	return INTERRUPTED_TASK_STATES.has(state);
}

/** `Part` is a proto `oneof` discriminated by member presence — there is no `kind` field in v1.0. */
export type TextPart = { readonly text: string; readonly mediaType?: string; readonly metadata?: Metadata };
export type RawPart = {
	readonly raw: string;
	readonly filename?: string;
	readonly mediaType?: string;
	readonly metadata?: Metadata;
};
export type UrlPart = {
	readonly url: string;
	readonly filename?: string;
	readonly mediaType?: string;
	readonly metadata?: Metadata;
};
export type DataPart = { readonly data: JsonValue; readonly mediaType?: string; readonly metadata?: Metadata };
export type Part = TextPart | RawPart | UrlPart | DataPart;

export type Message = {
	readonly messageId: string;
	readonly role: Role;
	readonly parts: readonly Part[];
	readonly contextId?: string;
	readonly taskId?: string;
	readonly metadata?: Metadata;
	readonly extensions?: readonly string[];
	readonly referenceTaskIds?: readonly string[];
};

export type TaskStatus = { readonly state: TaskState; readonly message?: Message; readonly timestamp?: string };

export type Artifact = {
	readonly artifactId: string;
	readonly parts: readonly Part[];
	readonly name?: string;
	readonly description?: string;
	readonly metadata?: Metadata;
	readonly extensions?: readonly string[];
};

export type Task = {
	readonly id: string;
	readonly status: TaskStatus;
	readonly contextId?: string;
	readonly artifacts?: readonly Artifact[];
	readonly history?: readonly Message[];
	readonly metadata?: Metadata;
};

export type TaskStatusUpdateEvent = {
	readonly taskId: string;
	readonly contextId: string;
	readonly status: TaskStatus;
	readonly metadata?: Metadata;
};

export type TaskArtifactUpdateEvent = {
	readonly taskId: string;
	readonly contextId: string;
	readonly artifact: Artifact;
	readonly append?: boolean;
	readonly lastChunk?: boolean;
	readonly metadata?: Metadata;
};

export type AuthenticationInfo = { readonly scheme: string; readonly credentials?: string };

export type TaskPushNotificationConfig = {
	readonly url: string;
	readonly tenant?: string;
	readonly id?: string;
	readonly taskId?: string;
	readonly token?: string;
	readonly authentication?: AuthenticationInfo;
};

export type SendMessageConfiguration = {
	readonly acceptedOutputModes?: readonly string[];
	readonly taskPushNotificationConfig?: TaskPushNotificationConfig;
	readonly historyLength?: number;
	readonly returnImmediately?: boolean;
};

export type SendMessageRequest = {
	readonly message: Message;
	readonly tenant?: string;
	readonly configuration?: SendMessageConfiguration;
	readonly metadata?: Metadata;
};

export type SendMessageResponse = { readonly task: Task } | { readonly message: Message };

export type StreamResponse =
	| { readonly task: Task }
	| { readonly message: Message }
	| { readonly statusUpdate: TaskStatusUpdateEvent }
	| { readonly artifactUpdate: TaskArtifactUpdateEvent };

export type GetTaskRequest = { readonly id: string; readonly tenant?: string; readonly historyLength?: number };

export type ListTasksRequest = {
	readonly tenant?: string;
	readonly contextId?: string;
	readonly status?: TaskState;
	readonly pageSize?: number;
	readonly pageToken?: string;
	readonly historyLength?: number;
	readonly statusTimestampAfter?: string;
	readonly includeArtifacts?: boolean;
};

export type ListTasksResponse = {
	readonly tasks: readonly Task[];
	readonly nextPageToken: string;
	readonly pageSize: number;
	readonly totalSize: number;
};

export type CancelTaskRequest = { readonly id: string; readonly tenant?: string; readonly metadata?: Metadata };

export type SubscribeToTaskRequest = { readonly id: string; readonly tenant?: string };

export type GetExtendedAgentCardRequest = { readonly tenant?: string };

export type AgentInterface = {
	readonly url: string;
	readonly protocolBinding: string;
	readonly protocolVersion: string;
	readonly tenant?: string;
};

export type AgentProvider = { readonly url: string; readonly organization: string };

export type AgentExtension = {
	readonly uri: string;
	readonly description?: string;
	readonly required?: boolean;
	readonly params?: Metadata;
};

export type AgentCapabilities = {
	readonly streaming?: boolean;
	readonly pushNotifications?: boolean;
	readonly extensions?: readonly AgentExtension[];
	readonly extendedAgentCard?: boolean;
};

export type SecurityRequirement = { readonly schemes: Record<string, { readonly list: readonly string[] }> };

export type HttpAuthSecurityScheme = {
	readonly scheme: string;
	readonly bearerFormat?: string;
	readonly description?: string;
};
export type ApiKeySecurityScheme = { readonly location: string; readonly name: string; readonly description?: string };
export type OpenIdConnectSecurityScheme = { readonly openIdConnectUrl: string; readonly description?: string };

export type SecurityScheme =
	| { readonly httpAuthSecurityScheme: HttpAuthSecurityScheme }
	| { readonly apiKeySecurityScheme: ApiKeySecurityScheme }
	| { readonly openIdConnectSecurityScheme: OpenIdConnectSecurityScheme };

export type AgentSkill = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly tags: readonly string[];
	readonly examples?: readonly string[];
	readonly inputModes?: readonly string[];
	readonly outputModes?: readonly string[];
	readonly securityRequirements?: readonly SecurityRequirement[];
};

export type AgentCardSignature = { readonly protected: string; readonly signature: string; readonly header?: Metadata };

export type AgentCard = {
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly supportedInterfaces: readonly AgentInterface[];
	readonly capabilities: AgentCapabilities;
	readonly defaultInputModes: readonly string[];
	readonly defaultOutputModes: readonly string[];
	readonly skills: readonly AgentSkill[];
	readonly provider?: AgentProvider;
	readonly documentationUrl?: string;
	readonly iconUrl?: string;
	readonly securitySchemes?: Record<string, SecurityScheme>;
	readonly securityRequirements?: readonly SecurityRequirement[];
	readonly signatures?: readonly AgentCardSignature[];
};

/** The eleven PascalCase JSON-RPC methods of the A2A v1.0 binding, in spec order. */
export const A2A_JSON_RPC_METHODS = [
	"SendMessage",
	"SendStreamingMessage",
	"GetTask",
	"ListTasks",
	"CancelTask",
	"SubscribeToTask",
	"CreateTaskPushNotificationConfig",
	"GetTaskPushNotificationConfig",
	"ListTaskPushNotificationConfigs",
	"DeleteTaskPushNotificationConfig",
	"GetExtendedAgentCard",
] as const;

export type A2aJsonRpcMethod = (typeof A2A_JSON_RPC_METHODS)[number];
