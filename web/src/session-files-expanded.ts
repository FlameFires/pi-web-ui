const STORAGE_PREFIX = "pi-web-ui:session-files-expanded:";
const MAX_PATHS = 200;

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Remembered expanded file paths for one session scope. */
export function readExpandedPaths(scope: string): string[] {
	if (!scope) return [];
	const store = storage();
	if (!store) return [];
	try {
		const value = JSON.parse(store.getItem(STORAGE_PREFIX + scope) ?? "null");
		if (!Array.isArray(value)) return [];
		return value.filter((path): path is string => typeof path === "string" && path !== "").slice(-MAX_PATHS);
	} catch {
		return [];
	}
}

/** Persist expanded file paths; an empty set clears the remembered entry. */
export function writeExpandedPaths(scope: string, paths: Iterable<string>): void {
	if (!scope) return;
	const store = storage();
	if (!store) return;
	const list = [...paths].filter((path) => typeof path === "string" && path !== "").slice(-MAX_PATHS);
	try {
		if (list.length) store.setItem(STORAGE_PREFIX + scope, JSON.stringify(list));
		else store.removeItem(STORAGE_PREFIX + scope);
	} catch {
		// Expanded state stays in memory when storage is disabled or full.
	}
}
