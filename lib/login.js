// 微信 ilink 登录（移植自 codex-wechat 的 login.js 核心逻辑）
// 流程：getQRCode → 轮询扫码状态 → confirmed 后保存凭据
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const QR_BOT_TYPE = "3";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const PENDING_QR_FILE = join(homedir(), ".clawbot-notify", "pending_qrcode.json");

// ---- 账号存储：复用 codex-wechat 的 ~/.codex-wechat/accounts/ ----

export function accountsDir() {
	const dir = process.env.CODEX_WECHAT_STATE_DIR
		|| join(homedir(), ".codex-wechat");
	return join(dir, "accounts");
}

export function normalizeAccountId(raw) {
	return String(raw || "").trim().toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export function accountFilePath(accountId) {
	return join(accountsDir(), `${normalizeAccountId(accountId)}.json`);
}

export function loadAccount(accountId) {
	try {
		const raw = readFileSync(accountFilePath(accountId), "utf8");
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

export function listAccounts() {
	try {
		return readdirSync(accountsDir())
			.filter((f) => f.endsWith(".json") && !f.includes(".context-tokens"))
			.map((f) => f.slice(0, -5))
			.map((id) => loadAccount(id))
			.filter(Boolean)
			.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
	} catch {
		return [];
	}
}

export function saveAccount(accountId, data) {
	const dir = accountsDir();
	mkdirSync(dir, { recursive: true });
	const file = accountFilePath(accountId);
	const existing = loadAccount(accountId) || {};
	const next = {
		accountId: normalizeAccountId(accountId),
		rawAccountId: accountId,
		token: data.token || existing.token || "",
		baseUrl: data.baseUrl || existing.baseUrl || DEFAULT_BASE_URL,
		userId: data.userId || existing.userId || "",
		savedAt: new Date().toISOString(),
	};
	writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
	return next;
}

// ---- 登录（codex-wechat 移植） ----

async function apiGetFetch(baseUrl, endpoint, timeoutMs = 10_000) {
	const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url.toString(), {
			method: "GET",
			headers: { "iLink-App-ClientVersion": "1" },
			signal: controller.signal,
		});
		clearTimeout(timer);
		const raw = await response.text();
		if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${raw.slice(0, 200)}`);
		return JSON.parse(raw);
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}
}

export async function fetchQrCode(baseUrl = DEFAULT_BASE_URL, botType = QR_BOT_TYPE) {
	return apiGetFetch(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, 10_000);
}

export async function pollQrStatus(qrcode, baseUrl = DEFAULT_BASE_URL) {
	try {
		return await apiGetFetch(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, QR_POLL_TIMEOUT_MS);
	} catch (error) {
		if (error?.name === "AbortError") return { status: "wait" };
		return { status: "wait", error: String(error?.message || error) };
	}
}

/** 启动登录：获取二维码并保存 pending 文件。返回 { qrcode, url, qrcodeImgUrl }。 */
export async function startLogin({ baseUrl = DEFAULT_BASE_URL, botType = QR_BOT_TYPE } = {}) {
	const qr = await fetchQrCode(baseUrl, botType);
	const url = qr.qrcode_img_content || qr.qrcode || "";
	const qrcode = qr.qrcode || "";
	if (!url || !qrcode) throw new Error(`登录接口返回异常: ${JSON.stringify(qr).slice(0, 300)}`);
	mkdirSync(dirname(PENDING_QR_FILE), { recursive: true });
	writeFileSync(PENDING_QR_FILE, JSON.stringify({ qrcode, url, createdAt: Date.now() }), "utf8");
	const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
	return { qrcode, url, qrImgUrl, pendingFile: PENDING_QR_FILE };
}

/** 确认登录：轮询状态，confirmed 后保存凭据。返回 { status, account? }。 */
export async function confirmLogin({ baseUrl = DEFAULT_BASE_URL } = {}) {
	let pending = {};
	try {
		pending = JSON.parse(readFileSync(PENDING_QR_FILE, "utf8"));
	} catch {
		return { status: "no-pending", message: "没有待确认的二维码，请先调用 clawbot_login" };
	}
	if (!pending.qrcode) return { status: "no-pending", message: "没有待确认的二维码（pending 文件为空）" };
	const status = await pollQrStatus(pending.qrcode, baseUrl);
	switch (status.status) {
		case "confirmed": {
			if (!status.bot_token || !status.ilink_bot_id) {
				return { status: "error", message: "登录成功但缺少 bot_token 或账号 ID" };
			}
			const account = saveAccount(status.ilink_bot_id, {
				token: status.bot_token,
				baseUrl: status.baseurl || baseUrl || DEFAULT_BASE_URL,
				userId: status.ilink_user_id || "",
			});
			return { status: "confirmed", account };
		}
		case "scaned":
			return { status: "scaned", message: "已扫码，请在手机上确认登录" };
		case "expired":
			return { status: "expired", message: "二维码已过期，请重新调用 clawbot_login" };
		case "wait":
			return { status: "wait", message: "尚未扫码，请先扫码后再次确认" };
		default:
			return { status: "unknown", message: `未知状态: ${JSON.stringify(status)}` };
	}
}