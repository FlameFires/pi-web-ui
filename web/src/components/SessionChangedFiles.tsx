import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiFileText, FiX } from "react-icons/fi";
import type { UiState } from "../types";
import { useT } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import { useOverlayZIndex } from "../overlay-stack";
import { collectSessionChangedFiles, type SessionChangedFile } from "../session-changed-files";
import { openFilePreview } from "../file-preview-bridge";
import { FileChangeCard } from "./FileChangeCard";

export function SessionChangedFiles({ state }: { state: UiState }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const files = useMemo(() => collectSessionChangedFiles(state.messages, state.cwd), [state.messages, state.cwd]);
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
				<span>{t("sessionFiles.count", { count: files.length })}</span>
			</button>
			{open && (
				<SessionFilesPanel
					key={`${state.sessionId}:${state.cwd}`}
					files={files}
					anchor={anchor.current}
					partial={(state.historyStart ?? 0) > 0 || (state.historyTotal ?? 0) > state.messages.length}
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
	onClose,
}: {
	files: SessionChangedFile[];
	anchor: HTMLElement | null;
	partial: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const { panelRef, style, measure } = useFloatingPanel({ anchor, side: "top", align: "left", onClose });
	const zIndex = useOverlayZIndex();
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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
			<div className="session-files-heading">
				<strong>{t("sessionFiles.title")}</strong>
				<button type="button" className="file-diff-action-btn" onClick={onClose} aria-label={t("close")}>
					<FiX />
				</button>
			</div>
			<p className="session-files-note">{t("sessionFiles.scope")}</p>
			{partial && <p className="session-files-note">{t("sessionFiles.partial")}</p>}
			{!files.length && <p className="session-files-empty">{t("sessionFiles.empty")}</p>}
			<div className="session-files-list">
				{files.map((file) => (
					<details
						key={file.path}
						className={`session-files-item${file.status !== "present" ? ` is-${file.status}` : ""}`}
					>
						<summary
							onClick={() =>
								setExpanded((previous) => {
									const next = new Set(previous);
									if (next.has(file.path)) next.delete(file.path);
									else next.add(file.path);
									return next;
								})
							}
						>
							<FiFileText aria-hidden="true" />
							<span className="session-files-path" title={file.path}>
								{file.path}
							</span>
							<span>{t("sessionFiles.operations", { count: file.operations.length })}</span>
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
								{file.status === "present" && file.kind === "file" && (
									<button
										type="button"
										className="btn"
										onClick={() => {
											onClose();
											openFilePreview({ path: file.path, name: file.path.split("/").pop() || file.path });
										}}
									>
										{t("diffOpenFile")}
									</button>
								)}
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
										{op.toolName === "edit" || op.toolName === "write" ? (
											<FileChangeCard
												toolName={op.toolName}
												argumentsText={op.argumentsText}
												details={op.details}
												output={op.output}
											/>
										) : (
											<pre>{op.output || t("sessionFiles.noDetail")}</pre>
										)}
									</div>
								))}
							</div>
						)}
					</details>
				))}
			</div>
		</div>,
		document.body,
	);
}
