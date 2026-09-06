import { randomUUID } from "node:crypto";
import { ENV_SESSION_DIR } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";

export type CreateA2aSessionOptions = {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
};

export type CreateA2aSession = (options: CreateA2aSessionOptions) => Promise<{ readonly session: AgentSession }>;

export type A2aSessionEntry = {
	readonly session: AgentSession;
	readonly cwd: string;
};

export class A2aSessionRegistry {
	private readonly sessions = new Map<string, A2aSessionEntry>();
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly cwd: string;
	private readonly createSession: CreateA2aSession;
	private readonly stderr: Pick<NodeJS.WriteStream, "write">;

	constructor(options: {
		readonly cwd: string;
		readonly createSession?: CreateA2aSession;
		readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	}) {
		this.cwd = options.cwd;
		this.stderr = options.stderr ?? process.stderr;
		this.createSession =
			options.createSession ?? ((sessionOptions) => defaultCreateSession(sessionOptions, this.stderr));
	}

	newContextId(): string {
		return randomUUID();
	}

	async getOrCreate(contextId: string): Promise<A2aSessionEntry> {
		const existing = this.sessions.get(contextId);
		if (existing !== undefined) {
			return existing;
		}
		const sessionManager = SessionManager.create(this.cwd, process.env[ENV_SESSION_DIR]);
		const created = await this.createSession({ cwd: this.cwd, sessionManager });
		const entry: A2aSessionEntry = { session: created.session, cwd: this.cwd };
		this.sessions.set(contextId, entry);
		return entry;
	}

	enqueue<T>(contextId: string, work: (entry: A2aSessionEntry) => Promise<T>): Promise<T> {
		const previous = this.chains.get(contextId) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				const entry = await this.getOrCreate(contextId);
				return work(entry);
			});
		this.chains.set(
			contextId,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	dispose(): void {
		for (const entry of this.sessions.values()) {
			entry.session.dispose();
		}
		this.sessions.clear();
		this.chains.clear();
	}
}

async function defaultCreateSession(
	options: CreateA2aSessionOptions,
	stderr: Pick<NodeJS.WriteStream, "write">,
): Promise<{ session: AgentSession }> {
	const result = await createAgentSession({
		cwd: options.cwd,
		sessionManager: options.sessionManager,
	});
	await result.session.bindExtensions({
		mode: "app-server",
		onError: (error) => {
			stderr.write(`${error.extensionPath}: ${error.error}\n`);
		},
	});
	return { session: result.session };
}
