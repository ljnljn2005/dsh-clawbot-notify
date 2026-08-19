// dsh-clawbot-notify
// DSH 插件：任务完成 / 报错 / 需要用户选择时，通过个人微信（ilink 协议，
// Weixin ClawBot 通道）发送主动通知。内置微信扫码登录流程。
//
// 事件信号（与 wecom-notify 相同）：
//   - agent/status   running -> idle 且最后一个 turn/end reason 为 completed => 任务完成
//   - agent/error    出错                                          => 报错通知
//   - session/event  tool/call (ask_user_question) 或 turn/end reason blocked => 需要用户选择
//
// 凭据来源（优先级从高到低）：
//   1. Config 内联 token / baseUrl / toUserId
//   2. codex-wechat 账号文件 ~/.codex-wechat/accounts/<id>.json（登录流程自动写入）
//   3. 环境变量 WXCLAW_TOKEN / WXCLAW_BASE_URL
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { sendText } from "./send.js";
import {
	DEFAULT_BASE_URL,
	startLogin,
	confirmLogin,
	normalizeAccountId,
} from "./login.js";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { InProcessApiClient, toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";
import { startIncomingDaemon, normalizeIncoming, sendReply, chunkReplyText } from "./daemon.js";
import {
	loadSenderState,
	rememberCurrentSession,
} from "./wechat-state.js";

const name = "clawbot-notify";
/**
 * 设置命名空间：WebUI 设置界面编辑的 section（client 侧镜像同名常量）。
 * 依赖 tools（登录工具）与 settings（设置面板可编辑配置）。
 */
const CLAWBOT_SETTINGS_NS = settingsNamespace("clawbot-notify");
const inject = ["tools", "settings", "webServer", "agents", "sessions", "sessionProjections", "sessionPersistence", "workspaceRegistry", "apiProxy", "userQuestions"];

const Config = z.object({
	/** 通知标题前缀 */
	title: z.string().default("DSH 提醒").description("通知标题前缀"),
	/** 任务完成时发送通知 */
	notifyComplete: z.boolean().default(true).description("任务完成时发送通知"),
	/** 任务出错时发送通知 */
	notifyError: z.boolean().default(true).description("任务出错时发送通知"),
	/** 需要用户选择/确认时发送通知 */
	notifyQuestion: z.boolean().default(true).description("需要用户选择/确认时发送通知"),
	/** ilink 服务地址（默认官方） */
	baseUrl: z.string().default(DEFAULT_BASE_URL).description("ilink 服务地址（默认官方 https://ilinkai.weixin.qq.com）"),
	/** 直接指定微信 bot token（可选，留空则从账号文件读取） */
	token: z.string().default("").description("微信 bot token（可选，留空则从账号文件读取）"),
	/** 目标用户 ID（可选，留空则用账号文件的 userId 或最近账号） */
	toUserId: z.string().default("").description("目标用户 ID（可选，留空则发给自己/最近账号绑定用户）"),
	/** 指定账号 ID（多账号时选择；留空用最近登录的） */
	accountId: z.string().default("").description("指定账号 ID（多账号时选择；留空用最近登录的）"),
	/** 账号文件目录（默认 ~/.codex-wechat/accounts，与 codex-wechat 复用） */
	accountsDir: z.string().default(join(homedir(), ".codex-wechat", "accounts")).description("账号文件目录（默认 ~/.codex-wechat/accounts）"),
	/** 发送超时（毫秒） */
	timeoutMs: z.number().default(15000).description("发送超时（毫秒）"),
	/** 消息正文（摘要/错误/问题）最大字符数 */
	maxContentLength: z.number().default(500).description("消息正文最大字符数"),
	/** 试运行：只打印不真正发送 */
	dryRun: z.boolean().default(false).description("试运行：只记录日志不真正发送"),
	/** 双向控制：手机微信发消息驱动 agent（daemon 长轮询收消息） */
	incomingEnabled: z.boolean().default(false).description("双向控制：允许手机微信发消息驱动本机 agent（需已扫码登录）"),
	/** 双向控制：允许哪些微信用户驱动（空 = 仅账号绑定用户本人） */
	allowedSenders: z.string().default("").description("允许驱动的微信用户 ID（逗号分隔；空 = 仅绑定用户本人）"),
	/** 双向控制：微信消息驱动 agent 的工作目录（空 = 当前工作区） */
	incomingCwd: z.string().default("").description("微信驱动 agent 的工作目录（空 = 默认工作区）"),
	/** 启动自检：验证 /choose 回答链路（mux 捕获 + respond 闭环），结果发微信 */
	runSelfTestOnStart: z.boolean().default(false).description("启动时自检 /choose 链路（mux+respond 闭环），结果发微信诊断")
});

/** 截断为短 id，便于展示。 */
function shortId(value) {
	if (typeof value !== "string") return String(value);
	return value.length > 8 ? value.slice(0, 8) : value;
}

/** 截断文本。 */
function truncate(text, max) {
	const value = String(text).replace(/\s+$/g, "");
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 本地时间戳。 */
function timestamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 解析默认工作目录（从 ctx.workspaces 或环境变量）。 */
async function safeDefaultCwd(ctx) {
	try {
		if (ctx?.workspaces?.current) {
			const ws = await ctx.workspaces.current();
			if (typeof ws?.path === "string" && ws.path) return ws.path;
		}
	} catch {}
	return process.env.DSH_CWD || "";
}

/** 从会话日志中取出最后一个 assistant 消息的纯文本。 */
function extractAssistantText(session) {
	const events = session?.events;
	if (!Array.isArray(events)) return "";
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type !== "assistant/message") continue;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) continue;
		return content
			.filter((block) => block && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** 从会话日志中取出最后一个 turn/end 的 reason。 */
function lastTurnReason(session) {
	const events = session?.events;
	if (!Array.isArray(events)) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === "turn/end") return events[i].data?.reason ?? null;
	}
	return null;
}

/** 取会话中最后一个 turn 编号。 */
function lastTurnNumber(session) {
	const events = session?.events;
	if (!Array.isArray(events)) return 0;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === "turn/start") return events[i].data?.turn ?? 0;
	}
	return 0;
}

/** 解析 ask_user_question 的 arguments 为问题列表。 */
function parseQuestions(rawArguments) {
	if (typeof rawArguments !== "string") return [];
	try {
		const args = JSON.parse(rawArguments);
		return Array.isArray(args?.questions) ? args.questions : [];
	} catch {
		return [];
	}
}

/** 从 config + 账号文件解析出可用的发送凭据。 */
function resolveCredentials(config) {
	// 1. 内联 token
	if (config.token) {
		return {
			baseUrl: config.baseUrl || DEFAULT_BASE_URL,
			token: config.token,
			toUserId: config.toUserId,
		};
	}
	// 2. 账号文件（账号目录可能被配置覆盖）
	const dir = config.accountsDir || join(homedir(), ".codex-wechat", "accounts");
	const accounts = listAccountsFromDir(dir);
	let account = null;
	if (config.accountId) {
		account = accounts.find((a) => a.accountId === normalizeAccountId(config.accountId)) || null;
		if (!account) account = loadAccountFromDir(dir, config.accountId);
	} else {
		account = accounts[0] || null;
	}
	if (!account) return null;
	return {
		baseUrl: account.baseUrl || config.baseUrl || DEFAULT_BASE_URL,
		token: account.token,
		toUserId: config.toUserId || account.userId || "",
	};
}

/** 从指定目录读取账号列表。 */
function listAccountsFromDir(dir) {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json") && !f.includes(".context-tokens"))
			.map((f) => f.slice(0, -5))
			.map((id) => loadAccountFromDir(dir, id))
			.filter(Boolean)
			.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
	} catch {
		return [];
	}
}

/** 从指定目录读取单个账号。 */
function loadAccountFromDir(dir, accountId) {
	try {
		const raw = readFileSync(join(dir, `${normalizeAccountId(accountId)}.json`), "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return {
			accountId: normalizeAccountId(accountId),
			token: typeof parsed.token === "string" ? parsed.token : "",
			baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
				? parsed.baseUrl.trim()
				: DEFAULT_BASE_URL,
			userId: typeof parsed.userId === "string" ? parsed.userId : "",
			savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
		};
	} catch {
		return null;
	}
}

const buildComplete = (config, agent, excerpt) => [
	`${config.title}`,
	"✅ 任务完成",
	`Agent: ${shortId(agent.id)}`,
	`时间: ${timestamp()}`,
	...(excerpt ? ["----------", truncate(excerpt, config.maxContentLength)] : []),
].join("\n");

const buildError = (config, agent, turn, message) => [
	`${config.title}`,
	"❌ 任务出错",
	`Agent: ${shortId(agent.id)}`,
	`时间: ${timestamp()}`,
	...(turn ? [`轮次: ${turn}`] : []),
	`错误: ${truncate(message, config.maxContentLength)}`,
].join("\n");

const buildQuestion = (config, sessionId, questions) => [
	`${config.title}`,
	"❓ 需要您的确认 / 选择",
	`Agent: ${shortId(sessionId)}`,
	`时间: ${timestamp()}`,
	...(questions.length === 0
		? ["（无具体问题文本，请到会话中查看）"]
		: questions.slice(0, 5).map((question) => {
			const header = question?.header ? `[${question.header}] ` : "";
			const options = Array.isArray(question?.options) && question.options.length
				? `  选项: ${question.options.map((option) => option?.label ?? option).join(" / ")}`
				: "";
			return `- ${header}${question?.question ?? "(无问题文本)"}${options ? `\n${options}` : ""}`;
		})),
	"",
	"📮 直接回复 /choose 选择",
	"   例: /choose 选项A（或 /choose 1）",
].join("\n");

/** 发送一条微信通知；任何失败只记日志，绝不影响主流程。 */
async function sendNotify(ctx, config, content) {
	if (config.dryRun) {
		ctx.logger.info(`[clawbot-notify][dry-run] ${content}`);
		return;
	}
	const creds = resolveCredentials(config);
	if (!creds) {
		ctx.logger.warn("clawbot-notify: 未找到微信凭据。请先用 clawbot_login 扫码登录，或在配置中填写 token/toUserId。");
		return;
	}
	const result = await sendText({
		baseUrl: creds.baseUrl,
		token: creds.token,
		toUserId: creds.toUserId,
		text: content,
		timeoutMs: config.timeoutMs,
	});
	if (!result.ok) {
		ctx.logger.warn(`clawbot-notify: 发送失败: ${result.error}`);
		return;
	}
	ctx.logger.info(`clawbot-notify: 已发送微信通知 → ${result.to}`);
}

/** 取会话显示名：title 投影优先，fallback 用 cwd 末段。 */
function displaySessionTitle(ctx, session, cwd) {
	try {
		const title = ctx.sessionProjections?.snapshot?.(session)?.values?.title;
		if (typeof title === "string" && title.trim()) return title.trim();
	} catch {}
	const fallback = String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
	return fallback || "(未命名)";
}

function apply(ctx, config) {
	ctx.logger.info("[clawbot-notify] apply 开始, settings 服务在 ctx:", !!ctx.settings);
	/** 当前生效的配置（settings 面板变更后由 installSettingsSection 更新）。 */
	let current = () => config ?? {};
	const resolve = () => current();

	/** 当前处于运行中的 agent 集合（WeakSet，避免泄漏）。 */
	const runningAgents = new WeakSet();
	/** 已通知过的错误，按 agent:turn:step 去重。 */
	const sentErrors = new Set();
	/** 已通知过的用户询问，按 agentId:turn 去重。 */
	const sentQuestions = new Set();

	ctx.on("agent/status", ({ agent, status }) => {
		const cfg = resolve();
		if (status === "running") {
			runningAgents.add(agent);
			return;
		}
		if (status !== "idle" || !runningAgents.has(agent)) return;
		runningAgents.delete(agent);
		if (!cfg.notifyComplete && !cfg.notifyQuestion) return;
		const reason = lastTurnReason(agent.session);
		if (cfg.notifyComplete && reason?.kind === "completed") {
			const excerpt = extractAssistantText(agent.session);
			void sendNotify(ctx, cfg, buildComplete(cfg, agent, excerpt));
		} else if (cfg.notifyQuestion && reason?.kind === "blocked") {
			const key = `${agent.id}:${reason.turn ?? lastTurnNumber(agent.session)}`;
			if (sentQuestions.has(key)) return;
			sentQuestions.add(key);
			void sendNotify(ctx, cfg, buildQuestion(cfg, agent.id, []));
		}
	});

	ctx.on("agent/error", ({ agent, turn, step, error }) => {
		const cfg = resolve();
		if (!cfg.notifyError) return;
		const key = `${agent.id}:${turn}:${step}`;
		if (sentErrors.has(key)) return;
		sentErrors.add(key);
		const message = error instanceof Error ? error.message : String(error);
		// 附带堆栈前几行便于定位（截断到 maxContentLength）
		let detail = message;
		if (error instanceof Error && error.stack) {
			const stackLines = error.stack.split("\n").slice(1, 4).join("\n");
			if (stackLines.trim()) detail = `${message}\n${stackLines}`;
		}
		void sendNotify(ctx, cfg, buildError(cfg, agent, turn, truncate(detail, cfg.maxContentLength * 2)));
	});

	ctx.on("session/event", (session, event) => {
		const cfg = resolve();
		if (!cfg.notifyQuestion) return;
		if (event?.type !== "tool/call") return;
		const data = event.data ?? {};
		if (data.name !== "ask_user_question") return;
		const key = `${session.id}:${data.turn}`;
		if (sentQuestions.has(key)) return;
		sentQuestions.add(key);
		void sendNotify(ctx, cfg, buildQuestion(cfg, session.id, parseQuestions(data.arguments)));
	});

	// ---- 登录工具注册（随配置变更重挂） ----
	let disposeTools = null;
	const syncTools = () => {
		if (disposeTools) {
			disposeTools();
			disposeTools = null;
		}
		if (!ctx.tools?.register) return;
		const cfg = resolve();
		const disposers = [
			ctx.tools.register(loginTool(ctx, cfg)),
			ctx.tools.register(loginConfirmTool(ctx, cfg)),
			ctx.tools.register(accountTool(ctx, cfg)),
		];
		disposeTools = () => {
			for (const dispose of disposers) if (typeof dispose === "function") dispose();
		};
	};
	if (ctx.tools?.register) syncTools();

	// ---- 设置面板：注册命名空间，配置变更时更新 current 并重挂工具 ----
	installSettingsSection(ctx, CLAWBOT_SETTINGS_NS, Config, config ?? {}, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {
			syncTools();
			if (typeof syncDaemon === "function") syncDaemon();
		},
	});

	// ---- 自建设置读写路由（因核心 apiproxy 白名单不含第三方 ns，settingsScope 无法跨进程读） ----
	// GET  /api/clawbot-notify/settings  -> 当前生效配置
	// POST /api/clawbot-notify/settings  -> 写配置（仅回环）
	if (ctx.webServer?.register) {
		const writeJson = (res, status, obj) => {
			const body = JSON.stringify(obj);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
			res.end(body);
		};
		const isLoopback = (req) => {
			const host = req.socket?.remoteAddress ?? "";
			return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
		};
		ctx.effect(() => {
			const disposers = [
				ctx.webServer.register({
					kind: "exact",
					path: "/api/clawbot-notify/settings",
					handler: async (req, res) => {
						const method = req.method ?? "GET";
						if (!isLoopback(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
						const url = new URL(req.url ?? "/", "http://localhost");
						if (method === "GET") {
							return writeJson(res, 200, { ok: true, value: resolve() });
						}
						if (method === "POST") {
							let body = "";
							for await (const chunk of req) body += chunk;
							let patch;
							try {
								patch = JSON.parse(body || "{}");
							} catch {
								return writeJson(res, 400, { error: "invalid JSON body" });
							}
							if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
								return writeJson(res, 400, { error: "patch must be an object" });
							}
							try {
								// 写入 settings 服务（installSettingsSection 注册的 ns），
								// 触发 setSource -> current 更新 + onChange -> 工具重挂
								const settingsSvc = ctx.get("settings");
								if (settingsSvc?.update) {
									await settingsSvc.update(String(CLAWBOT_SETTINGS_NS), patch);
								} else {
									// 没有 settings 服务时直接合并到 current
									const next = { ...resolve(), ...patch };
									current = () => next;
									syncTools();
								}
								return writeJson(res, 200, { ok: true, value: resolve() });
							} catch (error) {
								return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
							}
						}
						return writeJson(res, 405, { error: `method not allowed: ${method}` });
					},
				}),
			];
			return () => { for (const d of disposers) if (typeof d === "function") d(); };
		}, "clawbot-notify: settings routes");
	} else {
		ctx.logger.warn("clawbot-notify: 无 webServer 服务，设置读写路由未挂载（面板将只读展示本地默认）");
	}

	// ---- 双向控制 daemon：手机微信发消息驱动 agent ----
	/** senderId -> context_token 记忆（回发定位会话）。 */
	const contextTokens = new Map();
	/** sessionId -> { senderId, contextToken }：agent 完成时回发。 */
	const pendingReplies = new Map();
	let disposeDaemon = null;

	const replyToSender = async (creds, senderId, text, contextToken) => {
		const token = contextToken || contextTokens.get(senderId) || "";
		// 微信通道支持 markdown 渲染：直接发原文，保留标题/列表/粗体/换行
		const chunks = chunkReplyText(text, 1800);
		for (const chunk of chunks.length ? chunks : ["已完成。"]) {
			console.error(`[clawbot-notify] 回发 to=${senderId} token=${token ? token.slice(0, 12) + "…" : "无"} text=${JSON.stringify(chunk.slice(0, 30))}`);
			try {
				const result = await sendReply({
					baseUrl: creds.baseUrl,
					token: creds.token,
					toUserId: senderId,
					text: chunk,
					contextToken: token,
				});
				if (!result.ok) {
					console.error(`[clawbot-notify] 回发失败 ${result.error}`);
					return;
				}
			} catch (error) {
				console.error(`[clawbot-notify] 回发抛错: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}
	};

	/** 微信文本 → agent 会话驱动（对齐 codex-wechat：按 sender 的当前会话）。 */

	// ---- 诊断：关键路径双通道输出（console.error + 文件，live 终端/日志双保险） ----
	const debugLog = (msg) => {
		try { console.error(`[clawbot-notify] ${msg}`); } catch {}
		try {
			require("node:fs").appendFileSync("/tmp/clawbot-debug.log", `${new Date().toISOString()} ${msg}\n`);
		} catch {}
		try {
			require("node:fs").appendFileSync("/root/.dsh/clawbot-debug.log", `${new Date().toISOString()} ${msg}\n`);
		} catch {}
	};
	let lastFrameLog = 0;

	/** 自测：创建临时 agent → ctx.userQuestions.ask → 期望 mux 捕获 → respond 闭环。 */
	const runMuxSelfTest = async () => {
		const sendWechat = async (text) => {
			try {
				const creds = resolveCredentials(config);
				if (creds) await sendText({ baseUrl: creds.baseUrl, token: creds.token, toUserId: creds.toUserId, text, timeoutMs: 10000 });
			} catch {}
		};
		const report = (ok, detail) => {
			const line = `自测${ok ? "✅ 通过" : "❌ 失败"}: ${detail}`;
			debugLog(line);
			void sendWechat(`[clawbot-notify 诊断] ${line}`);
		};
		debugLog("自测开始");
		if (!ctx.userQuestions?.ask) { report(false, "ctx.userQuestions 不可用"); return; }
		let handle;
		try {
			const created = await ctx.agents.create({
				sessionId: `clawbot-selftest-${Date.now()}`,
				agentOptions: {},
				meta: { cwd: process.cwd(), source: "selftest" },
				setup: undefined,
			});
			handle = created;
		} catch (error) {
			report(false, `create agent 失败: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const agent = handle?.agent ?? handle;
		debugLog(`自测 agent=${agent?.id}`);
		// 触发 ask（带 agent → provider 校验 live）
		const askPromise = ctx.userQuestions.ask({
			agent,
			questions: [{ id: "selftest", question: "自测：选哪个？", options: [{ label: "选项A" }, { label: "选项B" }] }],
		}).then(
			(ans) => { debugLog(`自测 ask 已回答: ${JSON.stringify(ans)}`); return ans; },
			(err) => { debugLog(`自测 ask 失败: ${err instanceof Error ? err.message : String(err)}`); return null; }
		);
		// 等 mux 捕获
		await new Promise((r) => setTimeout(r, 1500));
		const waiting = waitingQuestions.get(agent.id);
		if (!waiting) {
			report(false, `mux 未捕获 question/requested（agent=${agent.id}）`);
			await handle?.dispose?.().catch?.(() => {});
			return;
		}
		debugLog(`自测 mux 捕获 rpcId=${String(waiting.rpcId).slice(0, 12)}`);
		// respond
		let receipt;
		try {
			receipt = await apiClient.respond({
				type: "client-response",
				rpcId: waiting.rpcId,
				result: { ok: true, value: { sessionId: agent.id, answer: { answers: [{ id: "selftest", selected: ["选项A"] }] } } },
			});
			debugLog(`自测 respond: ${JSON.stringify(receipt)}`);
		} catch (error) {
			debugLog(`自测 respond 抛错: ${error instanceof Error ? error.message : String(error)}`);
		}
		waitingQuestions.delete(agent.id);
		const answer = await Promise.race([askPromise, new Promise((r) => setTimeout(() => r("TIMEOUT")), 2000)]);
		debugLog(`自测 ask 结果: ${JSON.stringify(answer)}`);
		await handle?.dispose?.().catch?.(() => {});
		const ok = receipt?.accepted === true && answer !== "TIMEOUT" && answer !== null;
		report(ok, `mux 捕获+respond 闭环 ${ok ? "正常" : `异常 receipt=${JSON.stringify(receipt)} answer=${JSON.stringify(answer)}`}`);
		debugLog("自测结束");
	};

	// ---- /choose：微信回答 agent 的 ask_user_question（经 apiProxy respond） ----
	/** sessionId → { rpcId, sessionId, questions }：agent 等待中的问题（来自 mux 的 question/requested）。 */
	const waitingQuestions = new Map();
	/** apiProxy in-process client：订阅 mux + respond。 */
	let apiClient = null;
	let muxAbort = null;

	const startQuestionMux = () => {
		if (!ctx.apiProxy) {
			console.error("[clawbot-notify] apiProxy 服务不可用，/choose 不可用");
			debugLog("apiProxy 不可用");
			return;
		}
		try {
			apiClient = new InProcessApiClient(toFetchHandler(ctx.apiProxy));
			muxAbort = new AbortController();
			console.error(`[clawbot-notify] mux 订阅启动 apiProxy=${typeof ctx.apiProxy} client=${apiClient ? "ok" : "null"}`);
			debugLog("mux 订阅启动");
			(async () => {
				try {
					const stream = apiClient.events.mux({}, muxAbort.signal, () => {});
					console.error("[clawbot-notify] mux 流已建立，等待 question/requested…");
					debugLog("mux 流已建立");
					// 可选自测（配置 runSelfTestOnStart）：验证 /choose 回答链路闭环
					if (config.runSelfTestOnStart) runMuxSelfTest();
					for await (const frame of stream) {
						const payload = frame?.payload;
						const now = Date.now();
						if (payload?.type === "session/event" && payload.event?.type === "tool/call" && payload.event?.data?.name === "ask_user_question") {
							console.error(`[clawbot-notify] mux 看到 ask_user_question 调用 session=${payload.sessionId}`);
							debugLog(`mux 看到 ask_user_question 调用 session=${payload.sessionId}`);
						}
						if (payload?.type === "question/requested") {
							debugLog(`mux 收到 question/requested session=${payload.sessionId} rpcId=${String(frame.rpcId).slice(0, 12)}`);
						}
						if (payload?.type !== "question/requested") {
							if (now - lastFrameLog > 5000) {
								lastFrameLog = now;
								debugLog(`mux 帧类型: ${payload?.type}`);
							}
							continue;
						}
						const sessionId = payload.sessionId;
						const questions = Array.isArray(payload.questions) ? payload.questions : [];
						if (!questions.length) continue;
						waitingQuestions.set(sessionId, { rpcId: frame.rpcId, sessionId, questions });
						console.error(`[clawbot-notify] 捕获等待问题 session=${sessionId} rpcId=${String(frame.rpcId).slice(0, 12)}…`);
						debugLog(`捕获等待问题 session=${sessionId}`);
						notifyQuestionToWechat(sessionId, questions);
					}
				} catch (error) {
					if (!muxAbort?.signal.aborted) {
						console.error(`[clawbot-notify] mux 订阅中断: ${error instanceof Error ? error.message : String(error)}`);
						debugLog(`mux 订阅中断: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			})();
		} catch (error) {
			console.error(`[clawbot-notify] 启动 mux 订阅失败: ${error instanceof Error ? error.message : String(error)}`);
			debugLog(`启动 mux 订阅失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** 微信通知 agent 等待中的问题（找该会话的 sender + contextToken）。 */
	const notifyQuestionToWechat = async (sessionId, questions) => {
		const pending = pendingReplies.get(sessionId);
		if (!pending) return;
		const { senderId } = pending;
		const creds = resolveCredentials(config);
		if (!creds) return;
		const lines = ["❓ 需要您的确认 / 选择", `Agent: ${sessionId.slice(0, 12)}…`, ""];
		questions.forEach((q, qi) => {
			lines.push(`${qi + 1}. ${q.question}`);
			if (q.options?.length) {
				q.options.forEach((opt, oi) => {
					lines.push(`   ${oi + 1}. ${opt.label}${opt.description ? `（${opt.description}）` : ""}`);
				});
			}
		});
		lines.push("", `回复 /choose <序号或选项> 选择`);
		const text = lines.join("\n");
		console.error(`[clawbot-notify] 提问通知 session=${sessionId} sender=${senderId}`);
		try {
			await replyToSender(creds, senderId, text, contextTokens.get(senderId) || "");
		} catch {}
	};

	/** 历史会话标题缓存（sessionId → title），避免重复 inspect。 */
	const historicalTitleCache = new Map();

	/** 从持久化会话提取标题：优先 session/title 事件，否则首条用户消息，否则 cwd 末段。 */
	const titleForHistorical = async (id, cwd) => {
		if (historicalTitleCache.has(id)) return historicalTitleCache.get(id);
		let title = "";
		try {
			const loaded = await ctx.sessionPersistence?.inspect?.(id);
			const events = loaded?.events || loaded?.header?.events || [];
			if (Array.isArray(events)) {
				for (const event of events) {
					if (event?.type === "session/title" && typeof event.data?.title === "string" && event.data.title.trim()) {
						title = event.data.title.trim();
						break;
					}
				}
				if (!title) {
					for (const event of events) {
						if (event?.type !== "user/message") continue;
						const content = event.data?.message?.content;
						if (!Array.isArray(content)) continue;
						const text = content
							.filter((block) => block && block.type === "text" && typeof block.text === "string")
							.map((block) => block.text)
							.join(" ")
							.trim()
							.slice(0, 30);
						if (text) { title = text; break; }
					}
				}
			}
		} catch {}
		if (!title) {
			const fallback = String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
			title = fallback || "(未命名)";
		}
		historicalTitleCache.set(id, title);
		return title;
	};

	/**
	 * 列出全部会话（活跃 + 持久化历史），按最近活动排序。
	 * @returns {Promise<Array<{id: string, cwd?: string, live?: boolean, title: string}>>}
	 */
	const listAllSessions = async () => {
		const liveSessions = ctx.sessions?.list?.() || [];
		const liveMap = new Map(liveSessions.map((s) => [s.id, s]));
		// 过滤已归档会话（registry 全局归档集合）
		const archived = new Set(ctx.workspaceRegistry?.archivedSessionIds || []);
		let all = [];
		try {
			const persisted = await ctx.sessionPersistence?.list?.();
			if (Array.isArray(persisted)) {
				// 并行解析历史会话标题（限并发，超时保护）
				const entries = persisted
					.filter((header) => !archived.has(header.id))
					.map(async (header) => {
						const liveSession = liveMap.get(header.id);
						const title = liveSession
							? displaySessionTitle(ctx, liveSession, header.cwd)
							: await Promise.race([
								titleForHistorical(header.id, header.cwd),
								new Promise((resolve) => setTimeout(() => resolve(String(header.cwd || "").split(/[\\/]/).pop() || "(未命名)"), 250)),
							]);
						return { id: header.id, cwd: header.cwd, live: !!liveSession, title };
					});
				all = await Promise.all(entries);
			}
		} catch {}
		// 活跃但不在持久化的（刚创建未落盘）——归档的也排除
		for (const session of liveSessions) {
			if (archived.has(session.id)) continue;
			if (!all.some((x) => x.id === session.id)) {
				all.push({
					id: session.id,
					cwd: session.header?.cwd,
					live: true,
					title: displaySessionTitle(ctx, session, session.header?.cwd),
				});
			}
		}
		// 持久化里按 updatedAt 排序（若 header 带），否则保持
		return all;
	};

	/**
	 * 解析发送者的目标会话：
	 * 1. sender 偏好里存的 current（若存在：活跃或持久化）
	 * 2. 否则全部会话里最近一个
	 * 3. 都没有 → 返回 null（调用方决定新建）
	 */
	const resolveTargetSession = async (accountsDir, senderId) => {
		const { current } = loadSenderState(accountsDir, senderId);
		if (current) {
			if (ctx.sessions?.get?.(current)) return current;
			const persisted = await ctx.sessionPersistence?.list?.().catch(() => []) || [];
			if (persisted.some((h) => h.id === current)) return current;
		}
		const all = await listAllSessions();
		return all.length ? all[all.length - 1].id : "";
	};

	/** 微信文本 → agent 会话驱动（复用工作区会话，不隔离）。 */
	const driveAgentForMessage = async (cfg, creds, senderId, text, contextToken) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const defaultCwd = cfg.incomingCwd || (await safeDefaultCwd(ctx)) || process.cwd();

		// 1. 解析目标会话（sender 偏好优先，否则工作区最新会话，否则新建）
		let sessionId = await resolveTargetSession(accountsDir, senderId);
		if (!sessionId) {
			// 新建：交给 agents.create 分配 id（用默认工作区 cwd）
			sessionId = `workspace-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			rememberCurrentSession(accountsDir, senderId, sessionId);
		}

		// 2. 若已有活跃 agent 且正在运行 → 排队提示（不打断）
		const liveAgent = ctx.agents?.get ? ctx.agents.get(sessionId) : undefined;
		if (liveAgent && liveAgent.status === "running") {
			await replyToSender(creds, senderId, "⏳ 上一个任务还在运行中，请稍候再试（或发 /stop 停止）。", contextToken);
			return;
		}

		// 3. 记录 pending：agent idle 时回发
		pendingReplies.set(sessionId, { senderId, contextToken: contextToken || contextTokens.get(senderId) || "" });
		contextTokens.set(senderId, contextToken || contextTokens.get(senderId) || "");

		try {
			if (!ctx.agents?.create) {
				await replyToSender(creds, senderId, "❌ agents 服务不可用，无法驱动 agent。", contextToken);
				return;
			}
			// ctx.agents.create 返回 { agent, dispose }——agent 才是 ReactLoopAgent（有 followup/steer）
			let published;
			if (liveAgent) {
				published = { agent: liveAgent };
			} else {
				// 未加载：若是持久化会话 → resume（保留历史），否则 create
				let persistedExists = false;
				try {
					const persisted = await ctx.sessionPersistence?.list?.();
					persistedExists = Array.isArray(persisted) && persisted.some((h) => h.id === sessionId);
				} catch {}
				if (persistedExists && typeof ctx.agents?.resume === "function") {
					published = await ctx.agents.resume({
						resumeSessionId: sessionId,
						agentOptions: {},
						setup: undefined,
					});
				} else {
					published = await ctx.agents.create({
						sessionId,
						agentOptions: {},
						meta: { cwd: defaultCwd, source: "wechat" },
						setup: undefined,
					});
				}
			}
			const agent = published?.agent ?? published;
			// 发用户消息
			const message = {
				role: "user",
				content: [{ type: "text", text }],
			};
			if (typeof agent?.followup === "function") agent.followup(message);
			else if (typeof agent?.steer === "function") agent.steer(message);
			else {
				console.error(`[clawbot-notify] agent 对象方法: ${Object.getOwnPropertyNames(Object.getPrototypeOf(agent ?? {})).join(",")}`);
				await replyToSender(creds, senderId, "❌ 无法驱动 agent（缺少 followup/steer）", contextToken);
			}
		} catch (error) {
			pendingReplies.delete(sessionId);
			await replyToSender(creds, senderId, `❌ 启动 agent 失败：${error instanceof Error ? error.message : String(error)}`, contextToken);
		}
	};

	/** 命令：查看当前会话信息（/where）。 */
	const cmdWhere = async (cfg, creds, senderId, token) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const sessionId = await resolveTargetSession(accountsDir, senderId);
		if (!sessionId) return replyToSender(creds, senderId, "当前还没有会话。直接发文字即可自动创建。", token);
		const session = ctx.sessions?.get?.(sessionId);
		const live = ctx.agents?.get ? ctx.agents.get(sessionId) : undefined;
		const all = await listAllSessions();
		const wsCount = (ctx.workspaceRegistry?.list?.() || []).length;
		const currentItem = all.find((x) => x.id === sessionId);
		const lines = [
			`当前会话: ${currentItem?.title ? `${currentItem.title}（${sessionId}）` : sessionId}`,
			`工作目录: ${session?.header?.cwd || currentItem?.cwd || "(默认)"}`,
			`状态: ${live ? (live.status === "running" ? "运行中" : "空闲") : "未加载"}`,
			`工作区: ${wsCount} 个（/workspaces） · 会话: ${all.length} 个（/sessions）`,
		];
		return replyToSender(creds, senderId, lines.join("\n"), token);
	};

	/** 命令：列出工作区（/workspaces [页码]）。 */
	const cmdWorkspaces = async (cfg, creds, senderId, arg, token) => {
		const archived = new Set(ctx.workspaceRegistry?.archivedSessionIds || []);
		const workspaces = (ctx.workspaceRegistry?.list?.() || []).map((ws) => {
			const sessionIds = (ws.sessionIds || []).filter((id) => !archived.has(id));
			return { id: ws.id, title: ws.title || ws.path.split(/[\\/]/).pop() || ws.path, path: ws.path, count: sessionIds.length };
		});
		if (!workspaces.length) return replyToSender(creds, senderId, "还没有工作区。", token);

		let page = 1;
		if (arg) {
			const num = Number(arg.trim());
			if (Number.isFinite(num) && num >= 1) page = num;
		}
		const perPage = 12;
		const pages = Math.max(1, Math.ceil(workspaces.length / perPage));
		if (page > pages) page = pages;
		const slice = workspaces.slice((page - 1) * perPage, page * perPage);
		const lines = [`工作区 ${workspaces.length} 个 · 共 ${pages} 页（当前第 ${page} 页）`, ""];
		for (const ws of slice) {
			lines.push(`📁 ${ws.title} — ${ws.count} 会话`);
		}
		if (pages > 1) {
			const next = page + 1 > pages ? 1 : page + 1;
			lines.push("", `翻页: /workspaces ${next}（第 ${next} 页）`);
		}
		lines.push("", `查看某工作区会话: /sessions <工作区名>`, `新建会话: /new`);
		return replyToSender(creds, senderId, lines.join("\n"), token);
	};

	/** 命令：列出会话（/sessions [工作区名] [页码]）。 */
	const cmdSessions = async (cfg, creds, senderId, arg, token) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const { current } = loadSenderState(accountsDir, senderId);
		const all = await listAllSessions();
		if (!all.length) return replyToSender(creds, senderId, "还没有会话。直接发文字即可创建。", token);

		// 参数解析：/sessions [工作区名] [页码]
		let filterDir = "";
		let page = 1;
		if (arg) {
			const parts = arg.trim().split(/\s+/);
			const first = Number(parts[0]);
			if (Number.isFinite(first) && first >= 1) {
				page = first;
			} else {
				// 工作区名匹配：前缀/包含匹配 title 或 path 末段
				const needle = parts[0].toLowerCase();
				const wsList = (ctx.workspaceRegistry?.list?.() || []);
				const matchedWs = wsList.find((ws) => {
					const title = (ws.title || "").toLowerCase();
					const base = (ws.path || "").split(/[\\/]/).pop().toLowerCase();
					return title.includes(needle) || base.includes(needle) || (ws.path || "").toLowerCase().includes(needle);
				});
				if (matchedWs) {
					filterDir = matchedWs.path;
					if (parts.length > 1) {
						const n2 = Number(parts[1]);
						if (Number.isFinite(n2) && n2 >= 1) page = n2;
					}
				} else {
					return replyToSender(creds, senderId, `未找到工作区: ${parts[0]}\n/workspaces 查看工作区列表`, token);
				}
			}
		}

		const items = filterDir ? all.filter((x) => x.cwd === filterDir) : all;
		if (!items.length) {
			return replyToSender(creds, senderId, filterDir
				? `工作区「${filterDir.split(/[\\/]/).pop()}」暂无会话。`
				: "还没有会话。直接发文字即可创建。", token);
		}

		const perPage = 15;
		const pages = Math.max(1, Math.ceil(items.length / perPage));
		if (page > pages) page = pages;
		const slice = items.slice((page - 1) * perPage, page * perPage);
		const lines = [
			`会话 ${items.length} 个${filterDir ? ` · ${filterDir.split(/[\\/]/).pop()}` : ""} · 共 ${pages} 页（当前第 ${page} 页）`,
			"",
		];
		for (const item of slice) {
			const live = ctx.agents?.get ? ctx.agents.get(item.id) : undefined;
			const marker = item.id === current ? "→" : " ";
			const title = item.title ? `「${item.title}」` : "";
			const liveFlag = live ? (live.status === "running" ? "[运行中]" : "[空闲]") : (item.live ? "" : "[历史]");
			lines.push(`${marker} ${item.id.slice(0, 12)}… ${title} ${liveFlag}`);
		}
		if (pages > 1) {
			const next = page + 1 > pages ? 1 : page + 1;
			const pageCmd = filterDir ? `"${filterDir.split(/[\\/]/).pop()}" ${next}` : String(next);
			lines.push("", `翻页: /sessions ${pageCmd}（第 ${next} 页）`);
		}
		lines.push("", `切换: /switch <id前缀>  ← 当前: ${current ? current.slice(0, 12) + "…" : "无"}`);
		return replyToSender(creds, senderId, lines.join("\n"), token);
	};

	/** 命令：新建会话（/new）。 */
	const cmdNew = async (cfg, creds, senderId, token) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const defaultCwd = cfg.incomingCwd || (await safeDefaultCwd(ctx)) || process.cwd();
		const sessionId = `workspace-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		try {
			if (!ctx.agents?.create) throw new Error("agents 服务不可用");
			await ctx.agents.create({
				sessionId,
				agentOptions: {},
				meta: { cwd: defaultCwd, source: "wechat" },
				setup: undefined,
			});
			rememberCurrentSession(accountsDir, senderId, sessionId);
			return replyToSender(creds, senderId, `✅ 已新建会话: ${sessionId}\n直接发文字开始。`, token);
		} catch (error) {
			return replyToSender(creds, senderId, `❌ 新建会话失败: ${error instanceof Error ? error.message : String(error)}`, token);
		}
	};

	/** 命令：切换会话（/switch <id 或前缀>）。 */
	const cmdSwitch = async (cfg, creds, senderId, target, token) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		if (!target) return replyToSender(creds, senderId, "用法: /switch <会话id或前缀>", token);
		// 精确匹配优先，否则前缀匹配
		let matched = ctx.sessions?.get?.(target) ? target : "";
		if (!matched) {
			const all = await listAllSessions();
			const hits = all.filter((x) => x.id.startsWith(target));
			if (hits.length === 1) matched = hits[0].id;
			else if (hits.length > 1) {
				return replyToSender(creds, senderId, `前缀 ${target} 匹配多个会话：\n${hits.map((x) => ` ${x.id}`).join("\n")}`, token);
			}
		}
		if (!matched) {
			return replyToSender(creds, senderId, `会话不存在: ${target}\n/sessions 查看可用会话`, token);
		}
		rememberCurrentSession(accountsDir, senderId, matched);
		const all2 = await listAllSessions();
		const item = all2.find((x) => x.id === matched);
		return replyToSender(creds, senderId, `✅ 已切换到会话: ${item?.title ? `${item.title}（${matched}）` : matched}`, token);
	};

	/** 命令：查看最近消息（/message）。 */
	const cmdMessage = async (cfg, creds, senderId, token) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const sessionId = await resolveTargetSession(accountsDir, senderId);
		if (!sessionId) return replyToSender(creds, senderId, "当前还没有会话。", token);
		const session = ctx.sessions?.get?.(sessionId);
		if (!session) return replyToSender(creds, senderId, `会话 ${sessionId} 未加载（无历史可查）。`, token);
		const events = session.events || [];
		const lines = [`会话 ${sessionId} 最近消息：`, ""];
		let count = 0;
		for (let i = events.length - 1; i >= 0 && count < 10; i--) {
			const event = events[i];
			if (event?.type !== "user/message" && event?.type !== "assistant/message") continue;
			const content = event.data?.message?.content;
			if (!Array.isArray(content)) continue;
			const text = content
				.filter((block) => block && block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n")
				.slice(0, 200);
			if (!text) continue;
			lines.push(`${event.type === "user/message" ? "👤" : "🤖"}: ${text}`);
			count++;
		}
		if (count === 0) lines.push("暂无消息。");
		return replyToSender(creds, senderId, lines.join("\n"), token);
	};

	/** 命令：停止运行中任务（/stop）。 */
	/** 命令：回答 agent 等待中的问题（/choose [序号或选项]）。 */
	const cmdChoose = async (cfg, creds, senderId, arg, token) => {
		// 全局：找该 sender 的所有等待问题（pendingReplies 映射 sessionId → senderId）
		debugLog(`cmdChoose arg=${arg} waiting总=${waitingQuestions.size} pending总=${pendingReplies.size}`);
		const candidates = [];
		let fallback = null; // sender 无法匹配时：任何等待问题都算（用户要求全局）
		for (const [sid, waiting] of waitingQuestions) {
			const pending = pendingReplies.get(sid);
			if (pending && pending.senderId === senderId) candidates.push({ sid, waiting });
			else if (!fallback && waiting) fallback = { sid, waiting };
		}
		if (!candidates.length && fallback) candidates.push(fallback);
		debugLog(`cmdChoose 候选=${candidates.length}`);
		if (!candidates.length) return replyToSender(creds, senderId, "当前没有等待中的问题。", token);
		// 有多个等待 → 优先当前会话，否则第一个
		const targetSession = await resolveTargetSession(
			cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts"),
			senderId
		);
		let pick = candidates.find((c) => c.sid === targetSession) || candidates[0];
		const { sid, waiting } = pick;
		const questions = waiting.questions;

		// 解析选中的选项
		const parseAnswer = (input) => {
			const parts = (input || "").trim().split(/\s*[,，]\s*|\s+/).filter(Boolean);
			if (!parts.length) return null;
			const answers = [];
			for (const qi in questions) {
				const q = questions[qi];
				if (!q.options?.length) continue; // 无选项的问题无法 /choose 选择
				const selected = [];
				for (const part of parts) {
					const num = Number(part);
					if (Number.isInteger(num) && num >= 1 && num <= q.options.length) {
						selected.push(q.options[num - 1].label);
					} else {
						// 文本匹配：前缀/包含（忽略大小写）
						const match = q.options.find((o) => {
							const label = o.label.toLowerCase();
							const needle = part.toLowerCase();
							return label.startsWith(needle) || label.includes(needle);
						});
						if (match) selected.push(match.label);
					}
				}
				if (selected.length) answers.push({ id: q.id, selected: [...new Set(selected)] });
			}
			return answers.length ? answers : null;
		};

		const answers = parseAnswer(arg);
		if (!answers) {
			// 无有效选择 → 重新列出问题
			const lines = ["❓ 等待中的问题：", ""];
			questions.forEach((q, qi) => {
				lines.push(`${qi + 1}. ${q.question}`);
				if (q.options?.length) {
					q.options.forEach((opt, oi) => {
						lines.push(`   ${oi + 1}. ${opt.label}`);
					});
				}
			});
			lines.push("", "用法: /choose <序号或选项文本>", "如: /choose 1 或 /choose 选项A");
			return replyToSender(creds, senderId, lines.join("\n"), token);
		}

		// 经 apiProxy respond 回答（rpcId 来自 mux 的 question/requested）
		if (!apiClient || !waiting.rpcId) {
			return replyToSender(creds, senderId, "❌ 回答通道不可用（apiProxy 未连接）。", token);
		}
		let accepted = false;
		try {
			const receipt = await apiClient.respond({
				type: "client-response",
				rpcId: waiting.rpcId,
				result: { ok: true, value: { sessionId: sid, answer: { answers } } },
			});
			accepted = receipt?.accepted === true;
			debugLog(`respond 结果: ${JSON.stringify(receipt)} rpcId=${String(waiting.rpcId).slice(0, 12)}`);
		} catch (error) {
			console.error(`[clawbot-notify] respond 失败: ${error instanceof Error ? error.message : String(error)}`);
			debugLog(`respond 抛错: ${error instanceof Error ? error.message : String(error)}`);
		}
		waitingQuestions.delete(sid);
		const chosen = answers.map((a) => a.selected.join("、")).join("；");
		if (!accepted) {
			return replyToSender(creds, senderId, `⚠️ 回答可能未送达（${chosen}）。\n若 agent 仍在等待，请重试 /choose ${arg}`, token);
		}
		return replyToSender(creds, senderId, `✅ 已选择: ${chosen}\nAgent 继续执行中…`, token);
	};

	/** 命令：停止当前任务（/stop）。 */
	const cmdStop = async (cfg, creds, senderId, token) => {
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const sessionId = await resolveTargetSession(accountsDir, senderId);
		if (!sessionId) return replyToSender(creds, senderId, "当前还没有会话。", token);
		const live = ctx.agents?.get ? ctx.agents.get(sessionId) : undefined;
		if (!live || live.status !== "running") return replyToSender(creds, senderId, "当前会话没有运行中的任务。", token);
		try {
			live.cancel?.(new Error("user cancelled via wechat /stop"));
			return replyToSender(creds, senderId, "⏹ 已发送停止请求。", token);
		} catch (error) {
			return replyToSender(creds, senderId, `停止失败: ${error instanceof Error ? error.message : String(error)}`, token);
		}
	};

	/** 命令：绑定工作目录（/bind <绝对路径>）。 */
	const cmdBind = async (cfg, creds, senderId, pathArg, token) => {
		if (!pathArg) return replyToSender(creds, senderId, "用法: /bind /绝对路径", token);
		const accountsDir = cfg.accountsDir || join(homedir(), ".codex-wechat", "accounts");
		const sessionId = await resolveTargetSession(accountsDir, senderId);
		if (!sessionId) return replyToSender(creds, senderId, "当前还没有会话，先发文字创建再绑定。", token);
		return replyToSender(creds, senderId, `ℹ️ /bind 已记录意图：${pathArg}\n（工作区会话的目录由 DSH 管理；可用 /new 在目标目录新建会话）`, token);
	};

	/** 帮助文本。 */
	const buildHelpText = () => [
		"DSH 微信助手（双向控制）",
		"",
		"直接发文字 → 驱动本机 agent（复用当前工作区会话）并回发结果",
		"",
		"命令：",
		"/help 本帮助",
		"/status 服务状态",
		"/account 微信账号",
		"/where 当前会话信息",
		"/workspaces 工作区列表",
		"/sessions [工作区名] 会话列表（可过滤/翻页）",
		"/new 新建会话",
		"/switch <id前缀> 切换会话",
		"/message 查看最近消息",
		"/choose <序号或选项> 回答等待中的问题",
		"/stop 停止运行中任务",
	].join("\n");

	/** agent 完成时：若该 session 有 pending 微信回复，提取并回发。 */
	const handleAgentIdleForWechat = (agent) => {
		const pending = pendingReplies.get(agent.id);
		if (!pending) return;
		pendingReplies.delete(agent.id);
		const cfg = resolve();
		const creds = resolveCredentials(cfg);
		if (!creds) return;
		const excerpt = extractAssistantText(agent.session) || "已完成。";
		void replyToSender(creds, pending.senderId, excerpt, pending.contextToken);
	};

	const syncDaemon = () => {
		if (disposeDaemon) {
			disposeDaemon();
			disposeDaemon = null;
		}
		const cfg = resolve();
		if (!cfg.incomingEnabled) return;
		const creds = resolveCredentials(cfg);
		if (!creds?.token) {
			ctx.logger.warn("clawbot-notify: 双向控制已启用但无微信凭据，请先扫码登录");
			return;
		}
		const allowed = new Set(
			String(cfg.allowedSenders || "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		);
		const daemon = startIncomingDaemon({
			baseUrl: creds.baseUrl,
			token: creds.token,
			onError: (message) => {
				ctx.logger.warn(`clawbot-notify: 双向控制 ${message}`);
				console.error(`[clawbot-notify] 双向控制: ${message}`);
			},
			handler: async (rawMessage) => {
				const normalized = normalizeIncoming(rawMessage);
				if (!normalized) return;
				console.error(`[clawbot-notify] 收到微信消息 sender=${normalized.senderId} text=${JSON.stringify(normalized.text.slice(0, 50))} token=${normalized.contextToken ? "有" : "无"}`);
				const cfg2 = resolve();
				const creds2 = resolveCredentials(cfg2);
				if (!creds2?.token) return;
				// 允许名单：空 = 允许所有发送者（与 codex-wechat 默认一致）
				const bound = cfg2.toUserId || creds2.toUserId || "";
				if (allowed.size && !allowed.has(normalized.senderId)) {
					console.error(`[clawbot-notify] 发送者 ${normalized.senderId} 不在允许名单`);
					return;
				}
				// 记忆 context token
				if (normalized.contextToken) contextTokens.set(normalized.senderId, normalized.contextToken);
				const token = normalized.contextToken || contextTokens.get(normalized.senderId) || "";
				// 命令处理（前缀匹配：/switch xxx、/bind /path）
				const raw = normalized.text.trim();
				const lower = raw.toLowerCase();
				const [cmdWord, ...rest] = raw.split(/\s+/);
				const cmd = cmdWord?.toLowerCase() || "";
				const arg = rest.join(" ").trim();

				if (cmd === "/help" || cmd === "帮助" || cmd === "help") {
					await replyToSender(creds2, normalized.senderId, buildHelpText(), token);
					return;
				}
				if (cmd === "/status") {
					const acct = contextTokens.size ? `已记住 ${contextTokens.size} 个会话` : "无会话记录";
					await replyToSender(creds2, normalized.senderId, `✅ DSH 双向控制运行中\n账号: ${creds2.toUserId || "已登录"}\n${acct}`, token);
					return;
				}
				if (cmd === "/account") {
					const dir = cfg2.accountsDir || join(homedir(), ".codex-wechat", "accounts");
					const accounts = listAccountsFromDir(dir);
					await replyToSender(creds2, normalized.senderId, `微信账号:\n${accounts.map((a) => `${a.accountId}${a.userId ? ` → ${a.userId}` : ""}`).join("\n") || "无"}`, token);
					return;
				}
				if (cmd === "/where") { await cmdWhere(cfg2, creds2, normalized.senderId, token); return; }
				if (cmd === "/workspaces" || cmd === "/workspace") { await cmdWorkspaces(cfg2, creds2, normalized.senderId, arg, token); return; }
				if (cmd === "/sessions" || cmd === "/session") { await cmdSessions(cfg2, creds2, normalized.senderId, arg, token); return; }
				if (cmd === "/new") { await cmdNew(cfg2, creds2, normalized.senderId, token); return; }
				if (cmd === "/switch") { await cmdSwitch(cfg2, creds2, normalized.senderId, arg, token); return; }
				if (cmd === "/message") { await cmdMessage(cfg2, creds2, normalized.senderId, token); return; }
				if (cmd === "/choose") { await cmdChoose(cfg2, creds2, normalized.senderId, arg, token); return; }
				if (cmd === "/stop") { await cmdStop(cfg2, creds2, normalized.senderId, token); return; }
				if (cmd === "/bind") { await cmdBind(cfg2, creds2, normalized.senderId, arg, token); return; }
				if (cmd.startsWith("/")) {
					await replyToSender(creds2, normalized.senderId, `未知命令: ${cmd}\n\n${buildHelpText()}`, token);
					return;
				}
				// 普通文本 → 驱动 agent
				await driveAgentForMessage(cfg2, creds2, normalized.senderId, normalized.text, token);
			},
		});
		disposeDaemon = () => daemon.stop();
		ctx.logger.info("clawbot-notify: 双向控制 daemon 已启动");
	};

	// agent idle 时回发微信
	ctx.on("agent/status", ({ agent, status }) => {
		if (status === "idle") handleAgentIdleForWechat(agent);
	});

	syncDaemon();

	// 订阅 apiProxy mux：捕获 ask_user_question 等待（/choose 全局回答）
	startQuestionMux();

	ctx.effect(() => () => {
		if (disposeDaemon) disposeDaemon();
		muxAbort?.abort();
	}, "clawbot-notify: incoming daemon");
}

/** 工具：clawbot_login —— 获取微信扫码登录二维码。 */
function loginTool(ctx, config) {
	return {
		name: "clawbot_login",
		description: "获取微信登录二维码（个人微信，ilink/ClawBot 通道）。用户扫码确认后调用 clawbot_login_confirm 完成登录。首次使用微信通知前必须执行。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute() {
			try {
				const result = await startLogin({ baseUrl: config.baseUrl });
				return [
					"微信登录二维码已生成（约 5 分钟有效），请用微信扫描：",
					`![微信扫码登录](${result.qrImgUrl})`,
					"",
					"若二维码无法显示，把下面的链接发到微信任意聊天（如“文件传输助手”）点开登录：",
					result.url,
					"",
					"扫码确认后，请调用 clawbot_login_confirm 完成登录。",
				].join("\n");
			} catch (error) {
				return `获取微信登录二维码失败：${error instanceof Error ? error.message : String(error)}`;
			}
		},
	};
}

/** 工具：clawbot_login_confirm —— 轮询登录状态并保存凭据。 */
function loginConfirmTool(ctx, config) {
	return {
		name: "clawbot_login_confirm",
		description: "确认微信扫码登录状态；用户扫码并在手机上确认后调用，成功即保存凭据到账号文件，之后 clawbot 通知即可发送。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute() {
			const result = await confirmLogin({ baseUrl: config.baseUrl });
			switch (result.status) {
				case "confirmed":
					return `✅ 登录成功！账号 ${result.account.accountId} 已保存。现在任务完成/报错/需选择时会自动发微信通知。`;
				case "scaned":
					return "已扫码，请在手机上点确认，然后再次调用 clawbot_login_confirm。";
				case "wait":
					return "尚未检测到扫码。请先用微信扫二维码，然后再次调用 clawbot_login_confirm。";
				case "expired":
					return "二维码已过期，请重新调用 clawbot_login 获取新二维码。";
				default:
					return result.message || `状态未知: ${result.status}`;
			}
		},
	};
}

/** 工具：clawbot_account —— 查看当前微信账号状态。 */
function accountTool(ctx, config) {
	return {
		name: "clawbot_account",
		description: "查看当前 clawbot 微信账号状态（是否已登录、目标用户、可用账号列表）。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute() {
			const creds = resolveCredentials(config);
			const dir = config.accountsDir || join(homedir(), ".codex-wechat", "accounts");
			const accounts = listAccountsFromDir(dir);
			const lines = [
				`账号目录: ${dir}`,
				`已保存账号: ${accounts.length ? accounts.map((a) => `${a.accountId}${a.userId ? `(→${shortId(a.userId)})` : ""}`).join(", ") : "无"}`,
			];
			if (creds) {
				lines.push(`当前发送凭据: ${creds.baseUrl} / token ${creds.token ? "已配置" : "无"} / 目标 ${creds.toUserId || "(未设置，会发给账号绑定用户)"}`);
			} else {
				lines.push("⚠️ 未找到可用的微信凭据，请先调用 clawbot_login 扫码登录。");
			}
			return lines.join("\n");
		},
	};
}

export { Config, CLAWBOT_SETTINGS_NS, apply, inject, name };