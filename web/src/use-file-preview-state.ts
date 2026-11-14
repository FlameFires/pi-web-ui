import { useCallback, useEffect, useMemo, useState } from "react";
import type { PreviewFile } from "./components/FilePreview";

export interface PreviewSnapshot {
	files: PreviewFile[];
	index: number;
}

const STORAGE_PREFIX = "pi-web-ui:recent-preview:";

export function readPreviewSnapshot(scope: string): PreviewSnapshot | null {
	if (!scope) return null;
	try {
		const value = JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + scope) ?? "null");
		if (!value || !Array.isArray(value.files) || !value.files.length) return null;
		if (
			!value.files.every(
				(file: PreviewFile) => file && typeof file.path === "string" && file.path && typeof file.name === "string",
			)
		)
			return null;
		return {
			files: value.files.map(({ path, name }: PreviewFile) => ({ path, name })),
			index: Number.isInteger(value.index) ? Math.min(Math.max(value.index, 0), value.files.length - 1) : 0,
		};
	} catch {
		return null;
	}
}

export function useFilePreviewState(scope: string) {
	const [snapshots, setSnapshots] = useState<Record<string, PreviewSnapshot>>({});
	const [openScope, setOpenScope] = useState<string | null>(null);
	const recentPreview = useMemo(() => snapshots[scope] ?? readPreviewSnapshot(scope), [snapshots, scope]);
	const isOpen = !!scope && openScope === scope;

	useEffect(() => {
		if (!scope || !recentPreview) return;
		try {
			sessionStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(recentPreview));
		} catch {
			// The in-memory preview remains available when browser storage is disabled or full.
		}
	}, [scope, recentPreview]);

	useEffect(() => setOpenScope(null), [scope]);

	const setPreviewFiles = useCallback(
		(files: PreviewFile[] | null) => {
			if (!files?.length) {
				setOpenScope(null);
				return;
			}
			setSnapshots((prev) => ({ ...prev, [scope]: { files, index: 0 } }));
			setOpenScope(scope);
		},
		[scope],
	);

	const setPreviewIndex = useCallback(
		(index: number) => {
			setSnapshots((prev) => {
				const snapshot = prev[scope] ?? readPreviewSnapshot(scope);
				if (!snapshot) return prev;
				return {
					...prev,
					[scope]: { ...snapshot, index: Math.min(Math.max(index | 0, 0), snapshot.files.length - 1) },
				};
			});
		},
		[scope],
	);

	const reopenPreview = useCallback(() => setOpenScope(scope), [scope]);
	return {
		previewFiles: isOpen ? (recentPreview?.files ?? null) : null,
		previewIndex: recentPreview?.index ?? 0,
		setPreviewFiles,
		setPreviewIndex,
		recentPreview,
		reopenPreview,
	};
}
