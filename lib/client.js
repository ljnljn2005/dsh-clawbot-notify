// dsh-clawbot-notify — client 设置面板
// 在 WebUI 设置页面注册「Clawbot 提醒」配置区块（settings.section）。
// 零构建：__ModuleLoader__ + require("react") 手写 React 组件。
// 配置读写走插件自建路由（GET/POST /api/clawbot-notify/settings），
// 不依赖 settingsScope —— 核心 apiproxy 白名单不暴露第三方命名空间。
window.__ModuleLoader__.load({
	id: "dsh-clawbot-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { useState, useEffect, useCallback } = react;
		const { jsx, jsxs } = require("react/jsx-runtime");

		const NS = "clawbot-notify";
		const API = "/api/clawbot-notify/settings";

		// ------------------------------------------------------------------
		// 样式（内联 <style>，复用 shell 的 CSS 变量）
		// ------------------------------------------------------------------
		function ensureCss() {
			if (ensureCss.done) return;
			ensureCss.done = true;
			if (typeof document === "undefined") return;
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
			`;
			document.head.appendChild(style);
		}

		// ------------------------------------------------------------------
		// 字段清单
		// ------------------------------------------------------------------
		const FIELDS = [
			{ key: "title", label: "通知标题", desc: "通知消息的标题前缀", type: "text" },
			{ key: "notifyComplete", label: "任务完成通知", desc: "任务完成后发送微信通知", type: "switch" },
			{ key: "notifyError", label: "任务报错通知", desc: "任务出错时发送微信通知", type: "switch" },
			{ key: "notifyQuestion", label: "等待用户输入通知", desc: "需要用户选择/确认时发送微信通知", type: "switch" },
			{ key: "baseUrl", label: "ilink 服务地址", desc: "ilink 服务地址（默认官方 https://ilinkai.weixin.qq.com）", type: "text" },
			{ key: "token", label: "微信 Bot Token", desc: "ilink 会话 token（登录后自动保存，无需手动填）", type: "text" },
			{ key: "toUserId", label: "默认接收人", desc: "空 = 发给与自己对话的账号（推荐）", type: "text" },
			{ key: "accountId", label: "账号 ID", desc: "ilink 账号标识（登录后自动保存）", type: "text" },
			{ key: "accountsDir", label: "账号文件目录", desc: "codex-wechat 账号文件存放目录（默认 ~/.codex-wechat/accounts）", type: "text" },
			{ key: "timeoutMs", label: "请求超时 (ms)", desc: "发送请求超时毫秒数", type: "number" },
			{ key: "maxContentLength", label: "内容截断长度", desc: "通知正文最大字符数，超出截断", type: "number" },
			{ key: "dryRun", label: "模拟发送", desc: "开启后不真正发送，仅在日志打印内容", type: "switch" },
		];

		// ------------------------------------------------------------------
		// 组件：设置区块主体（fetch 读写路由）
		// ------------------------------------------------------------------
		function ClawbotSection() {
			const [cfg, setCfg] = useState(null);
			const [edited, setEdited] = useState(null);
			const [state, setState] = useState({ loading: true, error: "", flash: "", saving: false });

			// 载入配置
			const load = useCallback(async () => {
				try {
					const res = await fetch(API, { method: "GET" });
					const data = await res.json();
					if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
					setCfg(data.value || {});
					setState((s) => ({ ...s, loading: false, error: "" }));
				} catch (error) {
					setState((s) => ({ ...s, loading: false, error: error && error.message ? error.message : String(error) }));
				}
			}, []);

			useEffect(() => { load(); }, [load]);

			// 展示值 = 编辑覆写 ?? 配置值
			const display = (key, fallback = "") => {
				if (edited && key in edited) return edited[key];
				const v = cfg ? cfg[key] : undefined;
				return v === undefined || v === null ? fallback : v;
			};

			const markDirty = (key, typedValue) => {
				setEdited((prev) => ({ ...(prev || {}), [key]: typedValue }));
			};

			const save = async () => {
				setState((s) => ({ ...s, saving: true, flash: "" }));
				try {
					// 取出编辑字段并转类型
					const patch = {};
					for (const [k, v] of Object.entries(edited || {})) {
						const field = FIELDS.find((f) => f.key === k);
						if (field) {
							if (field.type === "number") {
								const n = Number(v);
								patch[k] = Number.isFinite(n) ? n : v;
							} else if (field.type === "switch") {
								patch[k] = !!v;
							} else {
								patch[k] = String(v);
							}
						}
					}
					const res = await fetch(API, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					const data = await res.json();
					if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
					setCfg(data.value || {});
					setEdited(null);
					setState((s) => ({ ...s, saving: false, flash: Object.keys(patch).length ? "已保存 ✓" : "没有改动" }));
					setTimeout(() => setState((s) => ({ ...s, flash: "" })), 2000);
				} catch (error) {
					setState((s) => ({ ...s, saving: false, flash: "保存失败: " + (error && error.message ? error.message : String(error)) }));
				}
			};

			if (state.loading) return jsx("div", { className: "dcn-wrap", children: "加载中…" });
			if (state.error) {
				return jsxs("div", {
					className: "dcn-wrap",
					children: [
						jsx("div", { className: "dcn-card", children: jsxs("div", { children: [
							jsx("div", { className: "dcn-cardTitle", children: "Clawbot 微信提醒" }),
							jsx("div", { className: "dcn-rowDesc", children: "配置读取失败：" + state.error }),
						]}) }),
						jsx("button", { className: "dcn-input", style: { width: "auto", cursor: "pointer", fontWeight: 600 }, onClick: load, children: "重试" }),
					]
				});
			}

			const value = cfg || {};
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
									children: "任务完成 / 报错 / 需要确认时，自动发微信通知。修改后点「保存」，立即生效。",
									style: { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary, #64748b)" },
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
											value: display(f.key, ""),
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
									style: { fontSize: 12.5, fontWeight: 500, color: value.token ? "var(--dsw-alias-state-success-primary, #0f6b3a)" : "#b45309" },
									children: value.token
										? "✓ 已配置微信凭据（token 已填写或账号文件可用）。任务完成后自动通知。"
										: "未配置微信凭据。在任务中让 agent 调用 clawbot_login 扫码登录，或将 token 填入上方「微信 Bot Token」。",
								}),
								jsx("div", {
									style: { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary, #64748b)", marginTop: 8 },
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
								disabled: state.saving,
								onClick: save,
								children: state.saving ? "保存中…" : "保存设置",
							}),
							state.flash && jsx("span", { className: "dcn-rowDesc", style: { color: state.flash.startsWith("保存失败") ? "#d33" : undefined }, children: state.flash }),
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

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "clawbot-notify",
				order: 140,
				label: () => "Clawbot 提醒",
			}, ClawbotSection), "dsh-clawbot-notify: settings section");
		}

		exports.apply = apply;
		exports.inject = ["slots", "settingsScope"];
		return module.exports;
	}
});