export function normalizePreviewPath(path: string): string {
	return path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

export function samePreviewPath(left: string, right: string): boolean {
	const a = normalizePreviewPath(left);
	const b = normalizePreviewPath(right);
	const windowsPath = (path: string) => /^[a-z]:\//i.test(path) || path.startsWith("//");
	return windowsPath(a) || windowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}
