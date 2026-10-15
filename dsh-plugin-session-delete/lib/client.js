/**
 * dsh-plugin-session-delete — browser half.
 *
 * Adds a danger-colored "删除会话" row to the sidebar Session overflow menu and
 * one `shell.overlay` entry that owns the confirmation dialog and the result
 * notice. Confirming calls the Host's `sessionDelete/deleteSession` Typert
 * Remote through the live Connection carrier, then refreshes the Session list
 * baseline so the removed row disappears.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** The sidebar Session overflow-menu list slot. */
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		/** The shell overlay slot every dialog and toast renders through. */
		const OVERLAY_SLOT = "shell.overlay";
		/** How long a result notice stays on screen. */
		const NOTICE_HOLD_MS = 6000;

		/**
		 * One menu row: opens the confirmation overlay instead of deleting
		 * immediately, so a destructive action always passes through a dialog.
		 */
		function DeleteSessionMenuItem(props) {
			const menu = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : undefined;
			const setMenuOpen = menu === undefined ? undefined : menu[1];
			return React.createElement(primitives.MenuItemButton, {
				danger: true,
				separatorBefore: true,
				icon: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					if (typeof setMenuOpen === "function") setMenuOpen(false);
					props.requestDelete(props.sessionId, props.displayTitle);
				},
			}, "删除会话");
		}

		/**
		 * The overlay seat: the pending confirmation modal, otherwise the last
		 * result notice, otherwise nothing.
		 */
		function DeleteSessionOverlay(props) {
			const request = props.useDeleteRequest((value) => value);
			const notice = props.useDeleteNotice((value) => value);
			if (request !== null && request !== undefined) {
				const busy = request.busy === true;
				return React.createElement(primitives.Modal, {
					open: true,
					onClose: () => {
						if (!busy) props.cancelDelete();
					},
					title: "删除会话",
					closeLabel: "关闭",
					description: "会话日志、投影缓存与工作区记录将被永久删除，且无法恢复。",
					footer: [
						React.createElement(primitives.Button, {
							key: "cancel",
							variant: "outline",
							onClick: () => props.cancelDelete(),
							disabled: busy,
						}, "取消"),
						React.createElement(primitives.Button, {
							key: "confirm",
							variant: "primary",
							onClick: () => props.confirmDelete(),
							disabled: busy,
						}, busy ? "正在删除…" : "确认删除"),
					],
				}, React.createElement("p", {
					style: { margin: 0, wordBreak: "break-all" },
				}, `即将删除：${request.displayTitle === undefined || request.displayTitle === "" ? request.sessionId : request.displayTitle}`));
			}
			if (notice !== null && notice !== undefined) {
				const success = notice.tone === "success";
				return React.createElement(primitives.Toast, {
					key: notice.seq,
					text: notice.text,
					tone: success ? "success" : undefined,
					icon: success ? undefined : React.createElement(primitives.IconWarningOutlineRegular, {}),
					holdMs: NOTICE_HOLD_MS,
					onDone: () => props.dismissNotice(),
				});
			}
			return null;
		}

		/**
		 * Mount both seats.
		 * @param ctx - client root context carrying the slots service.
		 */
		function apply(ctx) {
			const pending = createSnapshotStore(null);
			const notice = createSnapshotStore(null);
			let noticeSeq = 0;

			const requestDelete = (sessionId, displayTitle) => {
				notice.set(null);
				pending.set({
					sessionId,
					displayTitle: displayTitle === undefined || displayTitle === "" ? sessionId : displayTitle,
					busy: false,
				});
			};
			const cancelDelete = () => {
				pending.set(null);
			};
			const dismissNotice = () => {
				notice.set(null);
			};

			/** Call the Host endpoint and report the outcome on the notice seat. */
			const confirmDelete = async () => {
				const current = pending.getSnapshot();
				if (current === null || current.busy === true) return;
				pending.set({ ...current, busy: true });
				try {
					const connection = ctx.get("connection");
					const rpc = connection === undefined ? undefined : connection.rpc;
					if (rpc === undefined || typeof rpc.call !== "function") {
						throw new Error("Host 连接不可用，请稍后重试。");
					}
					const result = await rpc.call("/api", "sessionDelete/deleteSession", {
						args: { sessionId: current.sessionId },
					});
					if (result === undefined || result.ok !== true) {
						const failure = result === undefined ? undefined : result.error;
						const error = new Error(failure !== undefined && failure !== null && failure.message !== undefined
							? failure.message
							: "Host 拒绝了删除请求");
						error.code = failure === undefined ? undefined : failure.code;
						throw error;
					}
					pending.set(null);
					notice.set({
						text: `已删除会话「${current.displayTitle}」`,
						tone: "success",
						seq: ++noticeSeq,
					});
					const sessions = ctx.get("sessions");
					if (sessions !== undefined && typeof sessions.refresh === "function") {
						await Promise.resolve(sessions.refresh()).catch((reason) => {
							console.warn("[session-delete] session list refresh failed:", reason);
						});
					}
				} catch (error) {
					pending.set(null);
					notice.set({
						text: `删除失败：${error instanceof Error ? error.message : String(error)}`,
						tone: "error",
						seq: ++noticeSeq,
					});
					console.warn("[session-delete] delete failed:", error);
				}
			};

			ctx.slots.inject(MENU_SLOT, function* () {
				yield ctx.slots.register({
					name: MENU_SLOT,
					id: "session-delete",
					order: 500,
					inject: () => ({ requestDelete }),
				}, DeleteSessionMenuItem);
			});

			ctx.slots.inject(OVERLAY_SLOT, function* () {
				yield ctx.slots.register({
					name: OVERLAY_SLOT,
					id: "session-delete",
					inject: () => ({
						hooks: { deleteRequest: pending, deleteNotice: notice },
						confirmDelete,
						cancelDelete,
						dismissNotice,
					}),
				}, DeleteSessionOverlay);
			});
		}

		/** Required client services: the slot ledger is the only hard dependency. */
		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
