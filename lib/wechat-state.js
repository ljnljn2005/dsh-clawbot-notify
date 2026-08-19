// dsh-clawbot-notify — 微信双向控制会话选择状态
// 每个微信 sender 只存一个「当前会话」偏好（复用工作区现有会话，不隔离）。
// 数据存 <accountsDir>/../wechat-sessions/<sender-hash>.json。
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

/** 状态文件路径。 */
function stateFileFor(accountsDir, senderId) {
	const dir = join(accountsDir, "..", "wechat-sessions");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {}
	return join(dir, `${createHash("sha1").update(String(senderId)).digest("hex").slice(0, 16)}.json`);
}

/**
 * 读取某发送者的会话偏好。
 * @returns {{ current: string }}
 */
export function loadSenderState(accountsDir, senderId) {
	const file = stateFileFor(accountsDir, senderId);
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && typeof parsed.current === "string") {
			return { current: parsed.current };
		}
	} catch {}
	return { current: "" };
}

/** 保存发送者会话偏好。 */
export function saveSenderState(accountsDir, senderId, state) {
	const file = stateFileFor(accountsDir, senderId);
	try {
		writeFileSync(file, JSON.stringify(state, null, 2));
	} catch {}
}

/** 记录当前会话偏好（不校验存在性，由调用方确认活跃）。 */
export function rememberCurrentSession(accountsDir, senderId, sessionId) {
	saveSenderState(accountsDir, senderId, { current: sessionId });
}

/** 清空偏好。 */
export function forgetSenderState(accountsDir, senderId) {
	saveSenderState(accountsDir, senderId, { current: "" });
}
