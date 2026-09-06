/**
 * In-memory task storage for an A2A server: lifecycle state, history, artifacts and listing.
 *
 * Cancelation policy lives in the server; this store only records the state it is told to record.
 */

import { randomUUID } from "node:crypto";
import { invalidParamsError, taskNotFoundError } from "./errors.ts";
import { nowTimestamp } from "./json-rpc.ts";
import type { Artifact, ListTasksResponse, Message, Part, Task, TaskState } from "./types.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type ArtifactChunk = {
	readonly part: Part;
	readonly artifactId?: string;
	readonly append?: boolean;
	readonly lastChunk?: boolean;
	readonly name?: string;
};

export type TaskListQuery = {
	readonly contextId?: string;
	readonly status?: TaskState;
	readonly pageSize?: number;
	readonly pageToken?: string;
};

type StoredTask = {
	id: string;
	contextId: string;
	sequence: number;
	state: TaskState;
	statusMessage?: Message;
	timestamp: string;
	history: Message[];
	artifacts: Artifact[];
};

function encodeCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64");
}

function decodeCursor(token: string): number {
	const offset = Number(Buffer.from(token, "base64").toString("utf8"));
	if (!Number.isInteger(offset) || offset < 0) throw invalidParamsError("pageToken is not a valid cursor");
	return offset;
}

function limitHistory(history: readonly Message[], historyLength: number | undefined): readonly Message[] | undefined {
	if (historyLength === undefined) return history;
	if (historyLength <= 0) return undefined;
	return history.slice(-historyLength);
}

function toTask(stored: StoredTask, historyLength?: number): Task {
	const history = limitHistory(stored.history, historyLength);
	return structuredClone({
		id: stored.id,
		contextId: stored.contextId,
		status: {
			state: stored.state,
			...(stored.statusMessage === undefined ? {} : { message: stored.statusMessage }),
			timestamp: stored.timestamp,
		},
		...(stored.artifacts.length === 0 ? {} : { artifacts: stored.artifacts }),
		...(history === undefined ? {} : { history }),
	});
}

function mergeChunk(artifact: Artifact, chunk: ArtifactChunk): Artifact {
	const last = artifact.parts.at(-1);
	if (chunk.append === true && last !== undefined && "text" in last && "text" in chunk.part) {
		return { ...artifact, parts: [...artifact.parts.slice(0, -1), { ...last, text: last.text + chunk.part.text }] };
	}
	return { ...artifact, parts: [...artifact.parts, chunk.part] };
}

export class TaskStore {
	readonly #tasks = new Map<string, StoredTask>();
	#sequence = 0;

	create(contextId: string, initialMessage: Message): Task {
		const stored: StoredTask = {
			id: randomUUID(),
			contextId,
			sequence: ++this.#sequence,
			state: "TASK_STATE_SUBMITTED",
			timestamp: nowTimestamp(),
			history: [initialMessage],
			artifacts: [],
		};
		this.#tasks.set(stored.id, stored);
		return toTask(stored);
	}

	get(id: string): Task {
		return toTask(this.#require(id));
	}

	snapshot(id: string, historyLength?: number): Task {
		return toTask(this.#require(id), historyLength);
	}

	setState(id: string, state: TaskState, statusMessage?: Message): Task {
		const stored = this.#require(id);
		stored.state = state;
		stored.timestamp = nowTimestamp();
		if (statusMessage !== undefined) stored.statusMessage = statusMessage;
		return toTask(stored);
	}

	appendHistory(id: string, message: Message): Task {
		const stored = this.#require(id);
		stored.history.push(message);
		return toTask(stored);
	}

	appendArtifactChunk(id: string, chunk: ArtifactChunk): Artifact {
		const stored = this.#require(id);
		const artifactId = chunk.artifactId ?? randomUUID();
		const index = stored.artifacts.findIndex((artifact) => artifact.artifactId === artifactId);
		const existing = stored.artifacts[index];
		const base: Artifact = existing ?? {
			artifactId,
			parts: [],
			...(chunk.name === undefined ? {} : { name: chunk.name }),
		};
		const merged = mergeChunk(base, chunk);
		if (existing === undefined) {
			stored.artifacts.push(merged);
		} else {
			stored.artifacts[index] = merged;
		}
		return structuredClone(merged);
	}

	list(query: TaskListQuery = {}): ListTasksResponse {
		const filtered = [...this.#tasks.values()]
			.filter((task) => query.contextId === undefined || task.contextId === query.contextId)
			.filter((task) => query.status === undefined || task.state === query.status)
			.sort((left, right) =>
				left.timestamp === right.timestamp
					? right.sequence - left.sequence
					: right.timestamp.localeCompare(left.timestamp),
			);
		const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
		const offset = query.pageToken === undefined || query.pageToken === "" ? 0 : decodeCursor(query.pageToken);
		const page = filtered.slice(offset, offset + pageSize);
		const nextOffset = offset + page.length;
		return {
			tasks: page.map((task) => toTask(task)),
			nextPageToken: nextOffset < filtered.length ? encodeCursor(nextOffset) : "",
			pageSize,
			totalSize: filtered.length,
		};
	}

	#require(id: string): StoredTask {
		const stored = this.#tasks.get(id);
		if (stored === undefined) throw taskNotFoundError(id);
		return stored;
	}
}
