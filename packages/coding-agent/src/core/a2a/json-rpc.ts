/**
 * JSON-RPC 2.0 envelope handling and A2A request parsing for the JSONRPC binding.
 *
 * Untrusted payloads are parsed into typed values here and nowhere else; callers downstream
 * receive `SendMessageRequest` & friends and never re-validate.
 */

import {
	invalidParamsError,
	invalidRequestError,
	type JsonRpcErrorObject,
	jsonParseError,
	toJsonRpcError,
} from "./errors.ts";
import type {
	CancelTaskRequest,
	GetTaskRequest,
	JsonValue,
	ListTasksRequest,
	Message,
	Metadata,
	Part,
	Role,
	SendMessageConfiguration,
	SendMessageRequest,
	SubscribeToTaskRequest,
	TaskPushNotificationConfig,
	TaskState,
} from "./types.ts";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly id?: JsonRpcId;
	readonly params?: unknown;
};

export type JsonRpcSuccess<T> = { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: T };
export type JsonRpcFailure = { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject };
export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

const TASK_STATES: readonly TaskState[] = [
	"TASK_STATE_UNSPECIFIED",
	"TASK_STATE_SUBMITTED",
	"TASK_STATE_WORKING",
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_INPUT_REQUIRED",
	"TASK_STATE_REJECTED",
	"TASK_STATE_AUTH_REQUIRED",
];

const PART_MEMBERS = ["text", "raw", "url", "data"] as const;
type PartMember = (typeof PART_MEMBERS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops `undefined` members so the result satisfies `exactOptionalPropertyTypes`-style optionality. */
function definedEntries<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: NonNullable<T[K]> } {
	const result: Partial<T> = {};
	for (const key of Object.keys(fields) as (keyof T)[]) {
		const value = fields[key];
		if (value !== undefined) result[key] = value;
	}
	return result as { [K in keyof T]?: NonNullable<T[K]> };
}

function assertNever(value: never): never {
	throw invalidParamsError(`Unhandled variant: ${JSON.stringify(value)}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalidParamsError(`${field} must be an object`);
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw invalidParamsError(`${field} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requireString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw invalidParamsError(`${field} must be a non-negative integer`);
	}
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw invalidParamsError(`${field} must be a boolean`);
	return value;
}

function optionalMetadata(value: unknown, field: string): Metadata | undefined {
	if (value === undefined) return undefined;
	return requireRecord(value, field);
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw invalidParamsError(`${field} must be an array of strings`);
	return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function toJsonValue(value: unknown, field: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map((entry, index) => toJsonValue(entry, `${field}[${index}]`));
	if (isRecord(value)) {
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry, `${field}.${key}`);
		return result;
	}
	throw invalidParamsError(`${field} must be a JSON value`);
}

function validatePart(value: unknown, field: string): Part {
	const record = requireRecord(value, field);
	const present = PART_MEMBERS.filter((member) => record[member] !== undefined);
	const member: PartMember | undefined = present.length === 1 ? present[0] : undefined;
	if (member === undefined) {
		throw invalidParamsError(`${field} must contain exactly one of text, raw, url or data`);
	}
	const mediaType = optionalString(record.mediaType, `${field}.mediaType`);
	const metadata = optionalMetadata(record.metadata, `${field}.metadata`);
	const filename = optionalString(record.filename, `${field}.filename`);
	const shared = {
		...(mediaType === undefined ? {} : { mediaType }),
		...(metadata === undefined ? {} : { metadata }),
	};
	const file = { ...shared, ...(filename === undefined ? {} : { filename }) };
	switch (member) {
		case "text":
			return { text: requireString(record.text, `${field}.text`), ...shared };
		case "raw":
			return { raw: requireString(record.raw, `${field}.raw`), ...file };
		case "url":
			return { url: requireString(record.url, `${field}.url`), ...file };
		case "data":
			return { data: toJsonValue(record.data, `${field}.data`), ...shared };
		default:
			return assertNever(member);
	}
}

function validateRole(value: unknown, field: string): Role {
	if (value !== "ROLE_USER" && value !== "ROLE_AGENT") {
		throw invalidParamsError(`${field} must be ROLE_USER or ROLE_AGENT`);
	}
	return value;
}

function validateMessage(value: unknown, field: string): Message {
	const record = requireRecord(value, field);
	if (!Array.isArray(record.parts) || record.parts.length === 0) {
		throw invalidParamsError(`${field}.parts must contain at least one part`);
	}
	const optional = {
		contextId: optionalString(record.contextId, `${field}.contextId`),
		taskId: optionalString(record.taskId, `${field}.taskId`),
		metadata: optionalMetadata(record.metadata, `${field}.metadata`),
		extensions: optionalStringArray(record.extensions, `${field}.extensions`),
		referenceTaskIds: optionalStringArray(record.referenceTaskIds, `${field}.referenceTaskIds`),
	};
	return {
		messageId: requireString(record.messageId, `${field}.messageId`),
		role: validateRole(record.role, `${field}.role`),
		parts: record.parts.map((part, index) => validatePart(part, `${field}.parts[${index}]`)),
		...definedEntries(optional),
	};
}

function validatePushConfig(value: unknown, field: string): TaskPushNotificationConfig | undefined {
	if (value === undefined) return undefined;
	const record = requireRecord(value, field);
	const optional = {
		tenant: optionalString(record.tenant, `${field}.tenant`),
		id: optionalString(record.id, `${field}.id`),
		taskId: optionalString(record.taskId, `${field}.taskId`),
		token: optionalString(record.token, `${field}.token`),
	};
	return { url: requireString(record.url, `${field}.url`), ...definedEntries(optional) };
}

function validateConfiguration(value: unknown, field: string): SendMessageConfiguration | undefined {
	if (value === undefined) return undefined;
	const record = requireRecord(value, field);
	return definedEntries({
		acceptedOutputModes: optionalStringArray(record.acceptedOutputModes, `${field}.acceptedOutputModes`),
		historyLength: optionalNumber(record.historyLength, `${field}.historyLength`),
		returnImmediately: optionalBoolean(record.returnImmediately, `${field}.returnImmediately`),
		taskPushNotificationConfig: validatePushConfig(
			record.taskPushNotificationConfig,
			`${field}.taskPushNotificationConfig`,
		),
	});
}

function validateTaskState(value: unknown, field: string): TaskState | undefined {
	if (value === undefined) return undefined;
	const state = TASK_STATES.find((candidate) => candidate === value);
	if (state === undefined) throw invalidParamsError(`${field} must be a TaskState enum name`);
	return state;
}

export function parseJsonRpcRequest(body: string): JsonRpcRequest {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch (error) {
		throw jsonParseError(error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(payload)) throw invalidRequestError("request must be a JSON object");
	if (payload.jsonrpc !== "2.0") throw invalidRequestError("jsonrpc must be '2.0'");
	const method = payload.method;
	if (typeof method !== "string" || method.length === 0) {
		throw invalidRequestError("method must be a non-empty string");
	}
	const id = payload.id;
	if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
		throw invalidRequestError("id must be a string, number or null");
	}
	return {
		jsonrpc: "2.0",
		method,
		...(id === undefined ? {} : { id }),
		...("params" in payload ? { params: payload.params } : {}),
	};
}

export function successResponse<T>(id: JsonRpcId, result: T): JsonRpcSuccess<T> {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: JsonRpcId, error: unknown): JsonRpcFailure {
	return { jsonrpc: "2.0", id, error: toJsonRpcError(error) };
}

export function validateSendMessageRequest(params: unknown): SendMessageRequest {
	const record = requireRecord(params, "params");
	const optional = {
		tenant: optionalString(record.tenant, "tenant"),
		configuration: validateConfiguration(record.configuration, "configuration"),
		metadata: optionalMetadata(record.metadata, "metadata"),
	};
	return { message: validateMessage(record.message, "message"), ...definedEntries(optional) };
}

export function validateGetTaskRequest(params: unknown): GetTaskRequest {
	const record = requireRecord(params, "params");
	const optional = {
		tenant: optionalString(record.tenant, "tenant"),
		historyLength: optionalNumber(record.historyLength, "historyLength"),
	};
	return { id: requireString(record.id, "id"), ...definedEntries(optional) };
}

export function validateCancelTaskRequest(params: unknown): CancelTaskRequest {
	const record = requireRecord(params, "params");
	const optional = {
		tenant: optionalString(record.tenant, "tenant"),
		metadata: optionalMetadata(record.metadata, "metadata"),
	};
	return { id: requireString(record.id, "id"), ...definedEntries(optional) };
}

export function validateSubscribeToTaskRequest(params: unknown): SubscribeToTaskRequest {
	const record = requireRecord(params, "params");
	return {
		id: requireString(record.id, "id"),
		...definedEntries({ tenant: optionalString(record.tenant, "tenant") }),
	};
}

export function validateListTasksRequest(params: unknown): ListTasksRequest {
	const record = requireRecord(params ?? {}, "params");
	return definedEntries({
		tenant: optionalString(record.tenant, "tenant"),
		contextId: optionalString(record.contextId, "contextId"),
		status: validateTaskState(record.status, "status"),
		pageSize: optionalNumber(record.pageSize, "pageSize"),
		pageToken: optionalString(record.pageToken, "pageToken"),
		historyLength: optionalNumber(record.historyLength, "historyLength"),
		statusTimestampAfter: optionalString(record.statusTimestampAfter, "statusTimestampAfter"),
		includeArtifacts: optionalBoolean(record.includeArtifacts, "includeArtifacts"),
	});
}

export function partText(part: Part): string | undefined {
	return "text" in part ? part.text : undefined;
}

export function messageText(message: Message): string {
	return message.parts
		.map(partText)
		.filter((text): text is string => text !== undefined)
		.join("\n");
}

export function textPart(text: string): Part {
	return { text };
}

/** ISO 8601 UTC with millisecond precision, as the A2A timestamp convention requires. */
export function nowTimestamp(): string {
	return new Date().toISOString();
}
