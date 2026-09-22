export type KernelToolFunction = {
	readonly name: string;
};

export function createToolNamespace(
	define: (fn: KernelToolFunction, metadata?: unknown) => unknown,
	callHost: (name: string, args: unknown) => Promise<unknown>,
): ((fn: KernelToolFunction, metadata?: unknown) => unknown) & {
	readonly [name: string]: (args?: unknown) => Promise<unknown>;
};
