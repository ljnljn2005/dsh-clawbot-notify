// dsh-clawbot-notify — 双向控制 daemon
// 手机微信 → ilink getupdates 长轮询 → 消息归一化 → 命令/文本回调 → 回发。
// 复用账号凭据（~/.codex-wechat/accounts/<id>.json），token/context_token 会话。
import { post } from "./send.js";
import { DEFAULT_BASE_URL } from "./login.js";

const CHANNEL_VERSION = "1.0.0";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 3000;
const BACKOFF_DELAY_MS = 15000;
const MAX_CONSECUTIVE_FAILURES = 5;

/** 构造 ilink API 请求头（带 token）。 */
function authHeaders(token) {
	return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

/**
 * 长轮询拉取更新（getupdates）。
 * @returns {Promise<{ret:number, msgs:any[], get_updates_buf:string, longpolling_timeout_ms?:number, errcode?:number, errmsg?:string}>}
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS }) {
	return post("/ilink/bot/getupdates", {
		get_updates_buf: getUpdatesBuf,
		base_info: { channel_version: CHANNEL_VERSION },
	}, { baseUrl, token, timeoutMs });
}

/**
 * 回发消息给指定用户（携带 context_token，回复同一会话）。
 */
export async function sendReply({ baseUrl, token, toUserId, text, contextToken = "" }) {
	if (!toUserId) return { ok: false, error: "缺少 toUserId" };
	if (!contextToken) return { ok: false, error: "缺少 context_token（无法定位会话）" };
	const { randomUUID } = await import("node:crypto");
	const resp = await post("/ilink/bot/sendmessage", {
		msg: {
			from_user_id: "",
			to_user_id: toUserId,
			client_id: randomUUID(),
			message_type: 2,
			message_state: 2,
			item_list: [{ type: 1, text_item: { text } }],
			context_token: contextToken,
		},
		base_info: { channel_version: CHANNEL_VERSION },
	}, { baseUrl, token });
	const ret = typeof resp.ret === "number" ? resp.ret : 0;
	if (ret !== 0) return { ok: false, error: `ret=${ret}` };
	return { ok: true, to: toUserId };
}

/** 从 item_list 提取文本正文。 */
export function extractTextBody(itemList) {
	if (!Array.isArray(itemList) || !itemList.length) return "";
	let text = "";
	for (const item of itemList) {
		if (!item || typeof item !== "object") continue;
		const t = item.text_item?.text;
		if (typeof t === "string") text += t;
	}
	return text;
}

/**
 * 归一化收到的消息：忽略 bot 自身（message_type===2）、提取文本/发送者/会话 token。
 * @returns {null | {senderId:string, text:string, messageId:string, contextToken:string, raw:any}}
 */
export function normalizeIncoming(message) {
	if (!message || typeof message !== "object") return null;
	// message_type 2 = BOT（自己发的），忽略避免回声
	if (Number(message.message_type) === 2) return null;
	const senderId = typeof message.from_user_id === "string" ? message.from_user_id.trim() : "";
	if (!senderId) return null;
	const text = extractTextBody(message.item_list);
	if (!text) return null;
	return {
		senderId,
		text,
		messageId: String(message.message_id || "").trim(),
		contextToken: typeof message.context_token === "string" ? message.context_token.trim() : "",
		raw: message,
	};
}

/** 切分长回复为微信可发的分段（每段约 1800 字符）。 */
export function chunkReplyText(text, max = 1800) {
	const str = String(text ?? "");
	if (str.length <= max) return str ? [str] : [];
	const chunks = [];
	let rest = str;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
		if (cut < max * 0.5) cut = max;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/** 简易 markdown → 微信纯文本（去 `、**、#、链接语法）。 */
export function markdownToPlainText(text) {
	return String(text ?? "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[图片:$1]")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "`"))
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "• ")
		.replace(/^\s*\d+\.\s+/gm, "")
		.trim();
}

/**
 * 双向控制 daemon：长轮询收消息，逐条交给 handler，失败退避重试。
 * @param {object} opts { baseUrl, token, handler, onError, getSessionId }
 *   handler({senderId, text, contextToken}) -> Promise<回复文本或 null>
 * @returns {{ stop: () => void }}
 */
export function startIncomingDaemon(opts) {
	let stopped = false;
	let getUpdatesBuf = "";
	let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
	let consecutiveFailures = 0;
	let inFlight = Promise.resolve();

	const loop = async () => {
		while (!stopped) {
			try {
				const response = await getUpdates({
					baseUrl: opts.baseUrl,
					token: opts.token,
					getUpdatesBuf,
					timeoutMs: nextTimeoutMs,
				});
				if (stopped) return;

				if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
					nextTimeoutMs = response.longpolling_timeout_ms;
				}

				const isApiError =
					(response.ret !== undefined && response.ret !== 0)
					|| (response.errcode !== undefined && response.errcode !== 0);
				if (isApiError) {
					consecutiveFailures += 1;
					opts.onError?.(`getupdates ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg || ""}`);
					await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
					continue;
				}

				consecutiveFailures = 0;
				if (typeof response.get_updates_buf === "string" && response.get_updates_buf) {
					getUpdatesBuf = response.get_updates_buf;
				}

				const messages = Array.isArray(response.msgs) ? response.msgs : [];
				for (const message of messages) {
					if (stopped) return;
					inFlight = inFlight.then(() => opts.handler(message)).catch((error) => {
						opts.onError?.(`处理消息失败: ${error instanceof Error ? error.message : String(error)}`);
					});
				}
			} catch (error) {
				consecutiveFailures += 1;
				opts.onError?.(`长轮询错误 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error instanceof Error ? error.message : String(error)}`);
				await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
			}
		}
	};

	const task = loop();

	return {
		stop() {
			stopped = true;
		},
		async settled() {
			await inFlight;
			await task;
		},
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
