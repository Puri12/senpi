/**
 * Request-side rules of the `https://omo.dev/a2a/ext/omo-remote/v1` extension.
 *
 * Only the steer seam lives here: how an inbound message asks to join a running turn, and which
 * task it may join. The handler owns dispatch; the runner owns usage reporting.
 */

import { invalidParamsError } from "../../core/a2a/errors.ts";
import type { TaskStore } from "../../core/a2a/task-store.ts";
import type { Message } from "../../core/a2a/types.ts";

export const OMO_REMOTE_EXTENSION_URI = "https://omo.dev/a2a/ext/omo-remote/v1";

export type SteerTarget = {
	readonly taskId: string;
	readonly contextId: string;
};

/** `message.metadata.omo.steer === true` marks an omo-remote steer of an already running task. */
export function isSteerRequest(message: Message): boolean {
	const omo = message.metadata?.omo;
	if (typeof omo !== "object" || omo === null) {
		return false;
	}
	return "steer" in omo && omo.steer === true;
}

/**
 * Resolves the running task a steer applies to, or `undefined` when the message names no task
 * (which starts a new turn, exactly as an unflagged message would).
 */
export function resolveSteerTarget(
	message: Message,
	store: TaskStore,
	fallbackContextId: () => string,
): SteerTarget | undefined {
	const taskId = message.taskId;
	if (taskId === undefined) {
		return undefined;
	}
	const task = store.get(taskId);
	if (message.contextId !== undefined && task.contextId !== undefined && message.contextId !== task.contextId) {
		throw invalidParamsError("message.contextId does not match task context");
	}
	if (task.status.state !== "TASK_STATE_WORKING") {
		throw invalidParamsError("task is not running");
	}
	return { taskId, contextId: message.contextId ?? task.contextId ?? fallbackContextId() };
}
