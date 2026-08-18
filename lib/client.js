// dsh-clawbot-notify — client 设置面板
// 在 WebUI 设置页面注册「Clawbot 提醒」配置区块（settings.section）。
// 零构建：__ModuleLoader__ + require("react") 手写 React 组件。
// host 侧同名 namespace：clawbot-notify（见 lib/index.js CLAWBOT_SETTINGS_NS）。
window.__ModuleLoader__.load({
	id: "dsh-clawbot-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { bindSnapshotSelector } = require("@deepseek-ai/dsh-client-web-react");

		const NS = "clawbot-notify";

		// ------------------------------------------------------------------
		// 样式（内联 <style>，复用 shell 的 CSS 变量）
		// ------------------------------------------------------------------
		function ensureCss() {
			if (ensureCss.done) return;
			ensureCss.done = true;
			const style = document.createElement("style");
			style.textContent = `
				.dcn-wrap { padding: 6px 2px 16px; display: flex; flex-direction: column; gap: 18px; }
				.dcn-card { border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); background: var(--dsw-alias-bg-layer-2, #fff); border-radius: 10px; padding: 14px 16px; }
				.dcn-cardTitle { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #172a45); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
				.dcn-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
				.dcn-rowLabel { font-size: 13px; color: var(--dsw-alias-label-primary, #172a45); }
				.dcn-rowDesc { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #64748b); margin-top: 2px; }
				.dcn-input { width: 220px; border: 1px solid var(--dsw-alias-border-l2, #cbd5e1); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #172a45); border-radius: 6px; padding: 5px 9px; font-size: 12.5px; }
				.dcn-input:focus { outline: 2px solid var(--dsw-alias-brand-primary, #2b7cd9); outline-offset: 1px; border-color: transparent; }
				.dcn-input[type=number] { width: 90px; }
				.dcn-switch { position: relative; width: 40px; height: 22px; flex: none; }
				.dcn-switch input { opacity: 0; width: 0; height: 0; }
				.dcn-switch .dcn-track { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, #94a3b8); transition: background .15s; cursor: pointer; }
				.dcn-switch .dcn-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
				.dcn-switch input:checked + .dcn-track { background: var(--dsw-alias-state-success-primary, #0f6b3a); }
				.dcn-switch input:checked + .dcn-track .dcn-thumb { transform: translateX(18px); }
				.dcn-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #64748b); line-height: 1.6; }
				.dcn-status { font-size: 12.5px; padding: 8px 12px; border-radius: 8px; line-height: 1.6; }
				.dcn-status-ok { color: var(--dsw-alias-state-success-primary, #0f6b3a); background: var(--dsw-alias-state-success-tertiary, #dcf3e5); }
				.dcn-status-warn { color: var(--dsw-alias-state-warning-primary, #92400e); background: var(--dsw-alias-state-warning-tertiary, #fef3c7); }
			`;
			document.head.appendChild(style);
		}

		// ------------------------------------------------------------------
		// 表单字段定义（字段名与 host Config 对齐）
		// ------------------------------------------------------------------
		const FIELDS = [
			{ key: "title", type: "text", label: "通知标题", desc: "消息第一行的标题前缀" },
			{ key: "notifyComplete", type: "switch", label: "任务完成通知", desc: "任务完成时发送 ✅ 通知" },
			{ key: "notifyError", type: "switch", label: "任务出错通知", desc: "任务出错时发送 ❌ 通知" },
			{ key: "notifyQuestion", type: "switch", label: "需确认通知", desc: "需要您的选择/确认时发送 ❓ 通知" },
			{ key: "token", type: "text", label: "微信 Bot Token", desc: "留空则读取 ~/.codex-wechat 账号文件（扫码登录自动写入）" },
			{ key: "toUserId", type: "text", label: "目标用户 ID", desc: "留空则发给账号绑定的用户（自己）" },
			{ key: "baseUrl", type: "text", label: "ilink 服务地址", desc: "默认官方 https://ilinkai.weixin.qq.com" },
			{ key: "accountId", type: "text", label: "账号 ID", desc: "多账号时指定；留空用最近登录的" },
			{ key: "accountsDir", type: "text", label: "账号文件目录", desc: "默认 ~/.codex-wechat/accounts" },
			{ key: "timeoutMs", type: "number", label: "发送超时 (ms)", desc: "默认 15000" },
			{ key: "maxContentLength", type: "number", label: "正文最大长度", desc: "消息正文截断长度，默认 500" },
			{ key: "dryRun", type: "switch", label: "试运行", desc: "只记录日志、不真正发送（用于调试）" },
		];

		// ------------------------------------------------------------------
		// 组件：设置区块主体
		// ------------------------------------------------------------------
		function ClawbotSection({ useScope, scope }) {
			const snap = useScope();
			const ready = snap && snap.status === "ready";
			const value = ready ? (snap.value || {}) : {};
			// 本地编辑覆写：key → 用户输入值（仅记录被改动的字段）
			const [edited, setEdited] = useState(null);
			const [saving, setSaving] = useState(false);
			const [flash, setFlash] = useState("");

			// snapshot 未就绪时显示加载态
			if (!ready) return jsx("div", { className: "dcn-wrap", children: "加载中…" });

			// 展示值 = 编辑覆写 ?? 配置值
			const display = (key, fallback = "") => {
				if (edited && key in edited) return edited[key];
				const v = value[key];
				return v === undefined || v === null ? fallback : v;
			};

			const markDirty = (key, typedValue) => {
				setEdited((prev) => ({ ...(prev || {}), [key]: typedValue }));
			};

			const save = async () => {
				setSaving(true);
				try {
					const entries = Object.entries(edited || {});
					for (const [k, v] of entries) {
						const field = FIELDS.find((f) => f.key === k);
						let out = v;
						if (field) {
							if (field.type === "number") {
								const n = Number(v);
								out = Number.isFinite(n) ? n : v;
							} else if (field.type === "switch") {
								out = !!v;
							} else {
								out = String(v);
							}
						}
						await scope.set(k, out);
					}
					setFlash(entries.length ? "已保存 ✓" : "没有改动");
					setEdited(null);
					setTimeout(() => setFlash(""), 2000);
				} catch (error) {
					setFlash("保存失败: " + (error && error.message ? error.message : String(error)));
				} finally {
					setSaving(false);
				}
			};

			return jsxs("div", {
				className: "dcn-wrap",
				children: [
					jsx("div", {
						className: "dcn-card",
						children: jsxs("div", {
							children: [
								jsx("div", { className: "dcn-cardTitle", children: "Clawbot 微信提醒" }),
								jsx("div", {
									className: "dcn-note",
									children: "任务完成 / 报错 / 需要确认时，自动发微信通知。修改后点「保存」，立即生效。"
								}),
							]
						})
					}),
					jsx("div", {
						className: "dcn-card",
						children: [
							jsx("div", { className: "dcn-cardTitle", children: "事件开关" }),
							...FIELDS.filter((f) => f.type === "switch").map((f) =>
								jsxs("div", {
									className: "dcn-row",
									key: f.key,
									children: [
										jsxs("div", { children: [
											jsx("div", { className: "dcn-rowLabel", children: f.label }),
											jsx("div", { className: "dcn-rowDesc", children: f.desc }),
										]}),
										jsx("label", {
											className: "dcn-switch",
											children: [
												jsx("input", {
													type: "checkbox",
													checked: !!display(f.key),
													onChange: (e) => markDirty(f.key, e.target.checked),
												}),
												jsx("span", { className: "dcn-track", children: jsx("span", { className: "dcn-thumb" }) }),
											]
										}),
									]
								})
							),
						]
					}),
					jsx("div", {
						className: "dcn-card",
						children: [
							jsx("div", { className: "dcn-cardTitle", children: "发送设置" }),
							...FIELDS.filter((f) => f.type === "text").map((f) =>
								jsxs("div", {
									className: "dcn-row",
									key: f.key,
									children: [
										jsxs("div", { children: [
											jsx("div", { className: "dcn-rowLabel", children: f.label }),
											jsx("div", { className: "dcn-rowDesc", children: f.desc }),
										]}),
										jsx("input", {
											className: "dcn-input",
											value: display(f.key),
											placeholder: f.key === "baseUrl" ? "https://ilinkai.weixin.qq.com" : "",
											onChange: (e) => markDirty(f.key, e.target.value),
										}),
									]
								})
							),
							...FIELDS.filter((f) => f.type === "number").map((f) =>
								jsxs("div", {
									className: "dcn-row",
									key: f.key,
									children: [
										jsxs("div", { children: [
											jsx("div", { className: "dcn-rowLabel", children: f.label }),
											jsx("div", { className: "dcn-rowDesc", children: f.desc }),
										]}),
										jsx("input", {
											className: "dcn-input",
											type: "number",
											value: display(f.key),
											onChange: (e) => markDirty(f.key, e.target.value),
										}),
									]
								})
							),
						]
					}),
					jsx("div", {
						className: "dcn-card",
						children: jsxs("div", {
							children: [
								jsx("div", { className: "dcn-cardTitle", children: "登录状态" }),
								jsx("div", {
									className: "dcn-status " + (value.token ? "dcn-status-ok" : "dcn-status-warn"),
									children: value.token
										? "✓ 已配置微信凭据（token 已填写或账号文件可用）。任务完成后自动通知。"
										: "未配置微信凭据。在任务中让 agent 调用 clawbot_login 扫码登录，或将 token 填入上方「微信 Bot Token」。",
								}),
								jsx("div", {
									className: "dcn-note",
									style: { marginTop: 8 },
									children: "提示：扫码登录入口在任务中进行（调用 clawbot_login 工具），登录后凭据自动写入账号文件，本页会自动识别。",
								}),
							]
						})
					}),
					jsxs("div", {
						className: "dcn-row",
						style: { justifyContent: "flex-start", gap: 12 },
						children: [
							jsx("button", {
								className: "dcn-input",
								style: { width: "auto", cursor: "pointer", fontWeight: 600 },
								disabled: saving,
								onClick: save,
								children: saving ? "保存中…" : "保存设置",
							}),
							flash && jsx("span", { className: "dcn-rowDesc", style: { color: flash.startsWith("保存失败") ? "#d33" : undefined }, children: flash }),
						]
					}),
				]
			});
		}

		// ------------------------------------------------------------------
		// 插件入口
		// ------------------------------------------------------------------
		function apply(ctx) {
			ensureCss();
			const scope = ctx.settingsScope.bind({ namespace: NS });
			const useScope = bindSnapshotSelector(scope);

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "clawbot-notify",
				order: 140,
				label: () => "Clawbot 提醒",
				inject: () => ({ useScope, scope }),
			}, ClawbotSection), "dsh-clawbot-notify: settings section");
		}

		exports.apply = apply;
		exports.inject = ["slots", "settingsScope"];
		return module.exports;
	}
});