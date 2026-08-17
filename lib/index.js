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

const name = "clawbot-notify";
/**
 * 设置命名空间：WebUI 设置界面编辑的 section（client 侧镜像同名常量）。
 * 依赖 tools（登录工具）与 settings（设置面板可编辑配置）。
 */
const CLAWBOT_SETTINGS_NS = settingsNamespace("clawbot-notify");
const inject = ["tools", "settings"];

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
	dryRun: z.boolean().default(false).description("试运行：只记录日志不真正发送")
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

function apply(ctx, config) {
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
		void sendNotify(ctx, cfg, buildError(cfg, agent, turn, message));
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
		},
	});
}

/** 工具：clawbot_login —— 获取微信扫码登录二维码。 */
function loginTool(ctx, config) {
	return {
		name: "clawbot_login",
		description: "获取微信登录二维码（个人微信，ilink/ClawBot 通道）。用户扫码确认后调用 clawbot_login_confirm 完成登录。首次使用微信通知前必须执行。",
		parameters: {},
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
		parameters: {},
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
		parameters: {},
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