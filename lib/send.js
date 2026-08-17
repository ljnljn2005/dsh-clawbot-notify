// 微信 ilink 发送器（移植自 wxclawbot-cli client.js + codex-wechat api.js）
// 主动推送：sendmessage，无需 context_token（主动消息）
import crypto from "node:crypto";

const SEND_TIMEOUT_MS = 15_000;
const CHANNEL_VERSION = "0.1.0";

const KNOWN_ERRORS = {
	[-2]: "rate limited (约 7 条/5 分钟)，请稍后重试",
	[-14]: "session expired，登录态过期，请重新扫码登录",
};

function randomUIN() {
	const n = crypto.randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(n), "utf8").toString("base64");
}

function buildClientVersion(version) {
	const parts = String(version || "0.0.0").split(".").map((p) => Number.parseInt(p, 10));
	const major = Number.isFinite(parts[0]) ? parts[0] : 0;
	const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
	const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
	return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

async function post(endpoint, body, { baseUrl, token, timeoutMs = SEND_TIMEOUT_MS }) {
	const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;
	const bodyStr = JSON.stringify(body);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				AuthorizationType: "ilink_bot_token",
				Authorization: `Bearer ${token}`,
				"Content-Length": String(Buffer.byteLength(bodyStr, "utf8")),
				"X-WECHAT-UIN": randomUIN(),
				"iLink-App-ClientVersion": buildClientVersion(CHANNEL_VERSION),
			},
			body: bodyStr,
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) throw new Error(`sendmessage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		return await res.json();
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}
}

/**
 * 发送一条主动文本消息。
 * @param {object} opts { baseUrl, token, toUserId, text, timeoutMs }
 * @returns {Promise<{ok: boolean, to?: string, error?: string}>}
 */
export async function sendText({ baseUrl, token, toUserId, text, timeoutMs }) {
	if (!token) return { ok: false, error: "缺少 token，请先扫码登录（clawbot_login）" };
	if (!toUserId) return { ok: false, error: "缺少目标用户 ID（toUserId），请登录后确认账号 userId" };
	if (!text) return { ok: false, error: "消息内容为空" };

	const resp = await post("/ilink/bot/sendmessage", {
		msg: {
			from_user_id: "",
			to_user_id: toUserId,
			client_id: crypto.randomUUID(),
			message_type: 2,   // BOT
			message_state: 2,  // FINISH
			item_list: [{ type: 1, text_item: { text } }],
			context_token: "",
		},
		base_info: { channel_version: CHANNEL_VERSION },
	}, { baseUrl, token, timeoutMs });

	const ret = typeof resp.ret === "number" ? resp.ret : 0;
	if (ret !== 0) {
		const hint = KNOWN_ERRORS[ret] || "";
		return { ok: false, error: `ret=${ret}${hint ? ` (${hint})` : ""}` };
	}
	return { ok: true, to: toUserId };
}