import { useCallback, useEffect, useRef, useState } from "react";
import { appSend } from "./app-globals";
import type { SessionFileLedgerIdentity, SessionFileLedgerPage, SessionFileLedgerOperation, UiState } from "./types";

type ContentRequest = { operationId?: string; offset?: number; cumulative?: boolean };
type Pending = {
	path?: string;
	cursor?: string;
	options: ContentRequest;
	scope: string;
	timer: ReturnType<typeof setTimeout>;
};
export function useSessionFileLedger(state: UiState, open: boolean) {
	const identityKey = `${state.conversationId}\0${state.sessionFile}\0${state.cwd}`;
	const identity = useRef<SessionFileLedgerIdentity | null>(null);
	identity.current =
		state.sessionFile && state.conversationId
			? { conversationId: state.conversationId, sessionFile: state.sessionFile, cwd: state.cwd }
			: null;
	const [page, setPage] = useState<SessionFileLedgerPage | null>(null);
	const [operations, setOperations] = useState<Record<string, SessionFileLedgerOperation[]>>({});
	const [cursors, setCursors] = useState<Record<string, string | undefined>>({});
	const [contents, setContents] = useState<Record<string, SessionFileLedgerPage>>({});
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const pending = useRef(new Map<string, Pending>());
	const currentCursor = useRef<string | undefined>(undefined);
	const detailPages = useRef(new Map<string, string | undefined>());
	const request = useCallback((path?: string, cursor?: string, options: ContentRequest = {}) => {
		const target = identity.current;
		if (!target || pending.current.size >= 32) return;
		const scope = `${path ?? ""}\0${options.operationId ?? ""}\0${options.cumulative ?? false}`;
		if ([...pending.current.values()].some((value) => value.scope === scope)) return;
		const reqId = crypto.randomUUID();
		if (!appSend({ type: "session_file_ledger", ...target, reqId, path, cursor, ...options })) {
			setError("Connection unavailable");
			return;
		}
		const timer = setTimeout(() => {
			pending.current.delete(reqId);
			setBusy(pending.current.size > 0);
			setError("File ledger request timed out; retry available.");
		}, 20000);
		pending.current.set(reqId, { path, cursor, options, scope, timer });
		setBusy(true);
		setError("");
	}, []);
	useEffect(() => {
		const clear = () => {
			for (const value of pending.current.values()) clearTimeout(value.timer);
			pending.current.clear();
		};
		clear();
		currentCursor.current = undefined;
		setPage(null);
		setOperations({});
		setCursors({});
		setContents({});
		setError("");
		setBusy(false);
		detailPages.current.clear();
		if (!open || !identity.current) return;
		const matches = (value: SessionFileLedgerIdentity) => {
			const current = identity.current;
			return (
				current &&
				current.conversationId === value.conversationId &&
				current.sessionFile === value.sessionFile &&
				current.cwd === value.cwd
			);
		};
		const receive = (event: Event) => {
			const value = (event as CustomEvent<SessionFileLedgerPage>).detail;
			if (!matches(value)) return;
			const expected = pending.current.get(value.reqId);
			if (!expected || expected.path !== value.path) return;
			clearTimeout(expected.timer);
			pending.current.delete(value.reqId);
			setBusy(pending.current.size > 0);
			if (value.error) {
				setError(value.error);
				return;
			}
			if (value.path === undefined) {
				if (currentCursor.current !== expected.cursor) {
					setOperations({});
					setCursors({});
					setContents({});
					detailPages.current.clear();
				}
				currentCursor.current = expected.cursor;
				setPage(value);
			} else {
				const path = value.path;
				if (!expected.options.operationId && !expected.options.cumulative) {
					detailPages.current.set(path, expected.cursor);
					setOperations((previous) => ({ ...previous, [path]: value.operations }));
					setCursors((previous) => ({ ...previous, [path]: value.nextCursor }));
				}
				setContents((previous) => ({ ...previous, [path]: value }));
			}
		};
		const changed = (event: Event) => {
			if (!matches((event as CustomEvent<SessionFileLedgerIdentity>).detail)) return;
			clear();
			setBusy(false);
			request(undefined, currentCursor.current);
			for (const [path, cursor] of detailPages.current) request(path, cursor);
		};
		window.addEventListener("pi:session_file_ledger_page", receive);
		window.addEventListener("pi:session_file_ledger_changed", changed);
		request();
		return () => {
			clear();
			window.removeEventListener("pi:session_file_ledger_page", receive);
			window.removeEventListener("pi:session_file_ledger_changed", changed);
		};
	}, [identityKey, open, request]);
	return { page, operations, cursors, contents, error, busy, request };
}
