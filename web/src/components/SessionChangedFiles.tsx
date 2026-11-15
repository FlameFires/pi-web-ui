import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiFileText, FiHelpCircle, FiRefreshCw, FiX } from "react-icons/fi";
import type { UiState } from "../types";
import { useT } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import { useOverlayZIndex } from "../overlay-stack";
import type { SessionChangedFile } from "../session-changed-files";
import { useSessionFileLedger } from "../use-session-file-ledger";
import { openFilePreview } from "../file-preview-bridge";
import { FileChangeCard } from "./FileChangeCard";

export function SessionChangedFiles({ state }: { state: UiState }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const ledger = useSessionFileLedger(state, open);
	const files = (ledger.page?.files ?? []).map((file) => ({ ...file, operations: ledger.operations[file.path] ?? [] }));
	useEffect(() => setOpen(false), [state.sessionId, state.cwd]);
	return (
		<>
			<button
				type="button"
				ref={anchor}
				className="session-files-trigger"
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen((value) => !value)}
				title={t("sessionFiles.title")}
			>
				<FiFileText aria-hidden="true" />
				<span>{open ? t("sessionFiles.count", { count: files.length }) : t("sessionFiles.title")}</span>
			</button>
			{open && (
				<SessionFilesPanel
					key={`${state.sessionId}:${state.cwd}`}
					files={files}
					anchor={anchor.current}
					partial={ledger.page?.coverage !== "available-transcript"}
					ledger={ledger}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function SessionFilesPanel({
	files,
	anchor,
	partial,
	ledger,
	onClose,
}: {
	files: (SessionChangedFile & { operationCount: number })[];
	anchor: HTMLElement | null;
	partial: boolean;
	ledger: ReturnType<typeof useSessionFileLedger>;
	onClose: () => void;
}) {
	const t = useT();
	const { panelRef, style, measure } = useFloatingPanel({ anchor, side: "top", align: "right", onClose });
	const zIndex = useOverlayZIndex();
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const help = partial ? `${t("sessionFiles.scope")}\n${t("sessionFiles.partial")}` : t("sessionFiles.scope");
	useEffect(() => {
		panelRef.current?.focus({ preventScroll: true });
		return () => {
			if (anchor?.isConnected) anchor.focus({ preventScroll: true });
		};
	}, [anchor, panelRef]);
	useEffect(() => {
		if (typeof ResizeObserver === "undefined" || !panelRef.current) return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(panelRef.current);
		return () => observer.disconnect();
	}, [panelRef, measure]);
	return createPortal(
		<div
			ref={panelRef}
			style={{ ...style, zIndex }}
			className="session-files-panel"
			role="dialog"
			aria-label={t("sessionFiles.title")}
			tabIndex={-1}
		>
			<div className="session-files-heading cwd-picker-head">
				<strong>{t("sessionFiles.title")}</strong>
				<span className="session-files-help" title={help} aria-label={help} role="img" tabIndex={0}>
					<FiHelpCircle aria-hidden="true" />
				</span>
				<button type="button" className="file-diff-action-btn cwd-close" onClick={onClose} aria-label={t("close")}>
					<FiX />
				</button>
			</div>
			{!files.length && <p className="session-files-empty">{t("sessionFiles.empty")}</p>}
			<div className="session-files-list">
				{files.map((file) => (
					<details
						key={file.path}
						className={`session-files-item${file.status !== "present" ? ` is-${file.status}` : ""}`}
					>
						<summary
							onClick={() => {
								if (!expanded.has(file.path)) ledger.request(file.path);
								setExpanded((previous) => {
									const next = new Set(previous);
									if (next.has(file.path)) next.delete(file.path);
									else next.add(file.path);
									return next;
								});
							}}
						>
							<FiFileText aria-hidden="true" />
							<span className="session-files-path" title={file.path}>
								{file.path}
							</span>
							{file.status === "present" && file.kind === "file" && (
								<button
									type="button"
									className="session-files-preview"
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										onClose();
										openFilePreview({ path: file.path, name: file.path.split("/").pop() || file.path });
									}}
								>
									{t("diffOpenFile")}
								</button>
							)}
							<span>{t("sessionFiles.operations", { count: file.operationCount })}</span>
							{(file.status !== "present" || file.kind === "dir") && (
								<span className={`session-files-state ${file.status}`}>
									{file.kind === "dir" && file.status === "present"
										? t("sessionFiles.state.directory")
										: t(file.status === "deleted" ? "sessionFiles.state.deleted" : "sessionFiles.state.moved")}
								</span>
							)}
						</summary>
						{expanded.has(file.path) && (
							<div className="session-files-detail">
								<LedgerEvidence path={file.path} ledger={ledger} />
								{file.operations.map((op) => (
									<div key={op.id} className="session-files-operation">
										<div className="session-files-operation-label">
											{op.label
												? t(
														op.label === "created"
															? "sessionFiles.operation.created"
															: op.label === "deleted"
																? "sessionFiles.state.deleted"
																: op.label === "moved"
																	? "sessionFiles.state.moved"
																	: "sessionFiles.operation.edited",
													)
												: op.toolName}
										</div>
										{op.toolName !== "bash" ? (
											<FileChangeCard
												toolName={op.toolName}
												argumentsText={op.argumentsText}
												details={op.details}
												output={op.output}
											/>
										) : (
											<pre>{op.output || t("sessionFiles.noDetail")}</pre>
										)}
										{op.truncated && (
											<button
												type="button"
												disabled={ledger.busy}
												onClick={() => ledger.request(file.path, undefined, { operationId: op.id })}
											>
												{t("sessionFiles.rawDetail")}
											</button>
										)}
									</div>
								))}
								{ledger.cursors[file.path] && (
									<button
										type="button"
										disabled={ledger.busy}
										onClick={() => ledger.request(file.path, ledger.cursors[file.path])}
									>
										{t("sessionFiles.loadMore")}
									</button>
								)}
							</div>
						)}
					</details>
				))}
			</div>
			{ledger.error && <p className="session-files-note">{ledger.error}</p>}
			<div className="session-files-pager">
				{ledger.page?.nextCursor && (
					<button
						type="button"
						className="session-files-pager-btn"
						disabled={ledger.busy}
						onClick={() => ledger.request(undefined, ledger.page?.nextCursor)}
					>
						{t("sessionFiles.loadMore")}
					</button>
				)}
				<button
					type="button"
					className="session-files-pager-btn"
					disabled={ledger.busy}
					onClick={() => ledger.request()}
					title={t("sessionFiles.firstPage")}
					aria-label={t("sessionFiles.firstPage")}
				>
					<FiRefreshCw aria-hidden="true" />
				</button>
			</div>
		</div>,
		document.body,
	);
}

function LedgerEvidence({ path, ledger }: { path: string; ledger: ReturnType<typeof useSessionFileLedger> }) {
	const t = useT();
	const page = ledger.contents[path];
	if (!page) return <p className="session-files-note">{t("loading")}</p>;
	return (
		<>
			{page.cumulative.status === "exact" ? (
				<>
					<strong>{t("sessionFiles.cumulative")}</strong>
					<pre>{page.cumulative.patch || t("sessionFiles.noNetChange")}</pre>
					{page.cumulative.nextOffset !== undefined && (
						<button
							type="button"
							disabled={ledger.busy}
							onClick={() =>
								ledger.request(path, undefined, {
									cumulative: true,
									offset: page.cumulative.status === "exact" ? page.cumulative.nextOffset : undefined,
								})
							}
						>
							{t("sessionFiles.loadMore")}
						</button>
					)}
				</>
			) : (
				<p className="session-files-note">{t("sessionFiles.cumulativeUnavailable")}</p>
			)}
			{page.rawText !== undefined && (
				<>
					<pre>{page.rawText}</pre>
					{page.nextOffset !== undefined && (
						<button
							type="button"
							disabled={ledger.busy}
							onClick={() =>
								ledger.request(path, undefined, { operationId: page.operationId, offset: page.nextOffset })
							}
						>
							{t("sessionFiles.loadMore")}
						</button>
					)}
				</>
			)}
		</>
	);
}
