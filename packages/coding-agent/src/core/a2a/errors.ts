/**
 * A2A v1.0 typed errors and their JSON-RPC representation.
 *
 * Every A2A error carries a `google.rpc.ErrorInfo` detail object as `data[0]`, as the
 * spec's error-handling section prescribes.
 */

export const A2A_ERROR_CODES = {
	JSONParseError: -32700,
	InvalidRequestError: -32600,
	MethodNotFoundError: -32601,
	InvalidParamsError: -32602,
	InternalError: -32603,
	TaskNotFoundError: -32001,
	TaskNotCancelableError: -32002,
	PushNotificationNotSupportedError: -32003,
	UnsupportedOperationError: -32004,
	ContentTypeNotSupportedError: -32005,
	InvalidAgentResponseError: -32006,
	ExtendedAgentCardNotConfiguredError: -32007,
	ExtensionSupportRequiredError: -32008,
	VersionNotSupportedError: -32009,
} as const;

export type A2aErrorName = keyof typeof A2A_ERROR_CODES;

export const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
export const ERROR_DOMAIN = "a2a-protocol.org";

export type ErrorInfo = {
	readonly "@type": typeof ERROR_INFO_TYPE;
	readonly reason: string;
	readonly domain: typeof ERROR_DOMAIN;
	readonly metadata: Record<string, string>;
};

export type JsonRpcErrorObject = {
	readonly code: number;
	readonly message: string;
	readonly data?: readonly unknown[];
};

export class A2aError extends Error {
	readonly code: number;
	readonly data?: readonly unknown[];

	constructor(code: number, message: string, data?: readonly unknown[]) {
		super(message);
		this.name = "A2aError";
		this.code = code;
		if (data !== undefined) this.data = data;
	}
}

function errorInfo(reason: string, metadata: Record<string, string>): ErrorInfo {
	return { "@type": ERROR_INFO_TYPE, reason, domain: ERROR_DOMAIN, metadata };
}

function a2aError(
	name: A2aErrorName,
	message: string,
	reason: string,
	metadata: Record<string, string> = {},
): A2aError {
	return new A2aError(A2A_ERROR_CODES[name], message, [errorInfo(reason, metadata)]);
}

export function jsonParseError(detail?: string): A2aError {
	return a2aError("JSONParseError", "Invalid JSON payload", "JSON_PARSE", detail === undefined ? {} : { detail });
}

export function invalidRequestError(detail?: string): A2aError {
	return a2aError(
		"InvalidRequestError",
		"Request payload validation error",
		"INVALID_REQUEST",
		detail === undefined ? {} : { detail },
	);
}

export function methodNotFoundError(method: string): A2aError {
	return a2aError("MethodNotFoundError", "Method not found", "METHOD_NOT_FOUND", { method });
}

export function invalidParamsError(detail: string): A2aError {
	return a2aError("InvalidParamsError", "Invalid parameters", "INVALID_PARAMS", { detail });
}

export function internalError(detail?: string): A2aError {
	return a2aError("InternalError", "Internal error", "INTERNAL", detail === undefined ? {} : { detail });
}

export function taskNotFoundError(taskId: string): A2aError {
	return a2aError("TaskNotFoundError", "Task not found", "TASK_NOT_FOUND", { taskId });
}

export function taskNotCancelableError(taskId: string): A2aError {
	return a2aError("TaskNotCancelableError", "Task cannot be canceled", "TASK_NOT_CANCELABLE", { taskId });
}

export function pushNotificationNotSupportedError(): A2aError {
	return a2aError(
		"PushNotificationNotSupportedError",
		"Push Notification is not supported",
		"PUSH_NOTIFICATION_NOT_SUPPORTED",
	);
}

export function unsupportedOperationError(detail: string): A2aError {
	return a2aError("UnsupportedOperationError", "This operation is not supported", "UNSUPPORTED_OPERATION", { detail });
}

export function contentTypeNotSupportedError(mediaType: string): A2aError {
	return a2aError("ContentTypeNotSupportedError", "Incompatible content types", "CONTENT_TYPE_NOT_SUPPORTED", {
		mediaType,
	});
}

export function invalidAgentResponseError(detail: string): A2aError {
	return a2aError("InvalidAgentResponseError", "Invalid agent response", "INVALID_AGENT_RESPONSE", { detail });
}

export function extendedAgentCardNotConfiguredError(): A2aError {
	return a2aError(
		"ExtendedAgentCardNotConfiguredError",
		"Extended agent card not configured",
		"EXTENDED_AGENT_CARD_NOT_CONFIGURED",
	);
}

export function extensionSupportRequiredError(uri: string): A2aError {
	return a2aError("ExtensionSupportRequiredError", "Extension support required", "EXTENSION_SUPPORT_REQUIRED", {
		uri,
	});
}

export function versionNotSupportedError(requested: string, supported: string): A2aError {
	return a2aError("VersionNotSupportedError", "Version not supported", "VERSION_NOT_SUPPORTED", {
		requestedVersion: requested,
		supportedVersion: supported,
	});
}

/** Maps A2A errors verbatim; anything else becomes an opaque internal error (no stack leakage). */
export function toJsonRpcError(error: unknown): JsonRpcErrorObject {
	if (error instanceof A2aError) {
		return error.data === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, data: error.data };
	}
	return { code: A2A_ERROR_CODES.InternalError, message: "Internal error" };
}
