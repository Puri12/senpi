/**
 * Jev compaction: read/write the TypeSafe key in senpi's credential store.
 *
 * The key is stored under the `typesafe` provider as a plain api_key credential
 * (`auth.json`), the same store senpi uses for every provider. Reads are
 * synchronous against the store's in-memory snapshot so the compaction route
 * can resolve a key without turning its synchronous snapshot builder async;
 * writes go through the locked file backend.
 */
import { AuthStorage } from "../../../../auth-storage.ts";
import { JEV_CREDENTIAL_PROVIDER } from "./settings.ts";

/** The subset of `AuthStorage` this module needs; lets tests pass an in-memory store. */
export interface JevCredentialStore {
	get(provider: string): { type: string; key?: string } | undefined;
	set(provider: string, credential: { type: "api_key"; key: string }): void;
	remove(provider: string): void;
}

/** Reads the stored TypeSafe api_key, or `undefined` when none is stored. */
export function readStoredJevKey(store: Pick<JevCredentialStore, "get">): string | undefined {
	const credential = store.get(JEV_CREDENTIAL_PROVIDER);
	if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0) {
		return credential.key;
	}
	return undefined;
}

/** Stores (or replaces) the TypeSafe api_key in the credential store. */
export function storeJevKey(store: Pick<JevCredentialStore, "set" | "remove">, key: string): void {
	// Replace rather than append: a second `/jev-login` must not stack pool slots.
	store.remove(JEV_CREDENTIAL_PROVIDER);
	store.set(JEV_CREDENTIAL_PROVIDER, { type: "api_key", key });
}

let sharedStore: AuthStorage | undefined;

/** The process-wide `AuthStorage` for the default `auth.json`, created once. */
export function defaultJevCredentialStore(): AuthStorage {
	sharedStore ??= AuthStorage.create();
	return sharedStore;
}
