// dsh-clawbot-notify 本地测试：
// 1. Config 校验与默认值
// 2. 发送器：mock ilink 服务器验证 sendmessage body（主动推送，无 context_token）
// 3. 限速/错误码 (ret=-2) 处理
// 4. 账号文件读取（codex-wechat 格式兼容）
// 5. 登录流程（mock get_bot_qrcode / get_qrcode_status → confirmed 保存凭据）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";
import { sendText } from "../lib/send.js";
import { startLogin, confirmLogin, loadAccount, accountsDir } from "../lib/login.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- mock ilink 服务器 ----
function startMockServer({ onSend }) {
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/ilink/bot/sendmessage") {
			const parsed = JSON.parse(body);
			if (onSend) onSend(parsed);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ret: 0 }));
			return;
		}
		if (url.pathname === "/ilink/bot/get_bot_qrcode") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ qrcode: "mock-qrcode-123", qrcode_img_content: "https://weixin.qq.com/mock-login" }));
			return;
		}
		if (url.pathname === "/ilink/bot/get_qrcode_status") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "confirmed", bot_token: "mock-bot-token", ilink_bot_id: "mock-bot", ilink_user_id: "wx_user_123", baseurl: `http://127.0.0.1:${server.address().port}` }));
			return;
		}
		res.writeHead(404); res.end("not found");
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

async function main() {
	// 1. Config 校验
	const config = plugin.Config({});
	assert.equal(config.title, "DSH 提醒", "默认 title");
	assert.equal(config.notifyComplete, true, "默认 notifyComplete");
	assert.equal(config.notifyError, true, "默认 notifyError");
	assert.equal(config.notifyQuestion, true, "默认 notifyQuestion");
	assert.equal(config.baseUrl, "https://ilinkai.weixin.qq.com", "默认 baseUrl");
	console.log("✓ 场景1 Config 默认值");

	// 2. 发送器：mock 验证 body
	const sent = [];
	const server = await startMockServer({ onSend: (payload) => sent.push(payload) });
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	const result = await sendText({
		baseUrl,
		token: "mock-token",
		toUserId: "wx_user_123",
		text: "测试消息",
	});
	assert.equal(result.ok, true, "发送成功");
	assert.equal(sent.length, 1, "收到 1 次 sendmessage");
	const msg = sent[0].msg;
	assert.equal(msg.to_user_id, "wx_user_123", "目标用户正确");
	assert.equal(msg.message_type, 2, "BOT 类型");
	assert.equal(msg.message_state, 2, "FINISH 状态");
	assert.equal(msg.item_list[0].type, 1, "文本类型");
	assert.equal(msg.item_list[0].text_item.text, "测试消息", "文本内容正确");
	assert.equal(msg.context_token, "", "主动推送 context_token 为空");
	console.log("✓ 场景2 sendmessage body 正确（主动推送）");

	// 3. 限速错误码
	const rateServer = createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ret: -2 }));
	});
	await new Promise((resolve) => rateServer.listen(0, "127.0.0.1", resolve));
	const rateResult = await sendText({
		baseUrl: `http://127.0.0.1:${rateServer.address().port}`,
		token: "t", toUserId: "u", text: "x",
	});
	assert.equal(rateResult.ok, false, "限速应失败");
	assert.ok(rateResult.error.includes("rate limited"), "错误含限速提示");
	console.log("✓ 场景3 限速错误码处理");
	rateServer.close();

	// 4. 登录流程（mock）
	process.env.CODEX_WECHAT_STATE_DIR = mkdtempSync(join(tmpdir(), "clawbot-test-"));
	process.env.FINAL_ENV_DIR = process.env.CODEX_WECHAT_STATE_DIR;
	const login = await startLogin({ baseUrl });
	assert.ok(login.url.includes("mock-login"), "二维码 URL 获取成功");
	const confirmed = await confirmLogin({ baseUrl });
	assert.equal(confirmed.status, "confirmed", "登录确认成功");
	assert.equal(confirmed.account.token, "mock-bot-token", "token 保存");
	assert.equal(confirmed.account.userId, "wx_user_123", "userId 保存");
	assert.equal(confirmed.account.baseUrl, baseUrl, "baseUrl 保存指向 mock");
	// 凭据文件落盘
	const accountId = loadAccount("mock-bot");
	assert.ok(accountId, "账号可读取");
	console.log("✓ 场景4 登录流程 + 凭据落盘");
	server.close();

	// 5. 插件事件集成：完成事件触发发送
	delete process.env.CODEX_WECHAT_STATE_DIR;
	const server2 = await startMockServer({ onSend: (payload) => sent.push(payload) });
	const testDir = mkdtempSync(join(tmpdir(), "clawbot-e2e-"));
	writeFileSync(join(testDir, "mock-bot.json"), JSON.stringify({
		accountId: "mock-bot",
		token: "mock-bot-token",
		baseUrl: `http://127.0.0.1:${server2.address().port}`,
		userId: "wx_user_123",
		savedAt: new Date().toISOString(),
	}));
	const ctx = new Context();
	ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
	ctx.provide("tools", { register: () => {}, check: () => {} }, true);
	// 先装探针：证明事件通道可用
	let probeCount = 0;
	ctx.on("agent/status", () => probeCount++);
	plugin.apply(ctx, plugin.Config({
		accountsDir: testDir,
		title: "测试提醒",
	}));
	// 模拟 agent/status running → idle(completed)
	const events = [{
		type: "turn/end",
		data: { reason: { kind: "completed", turn: 1 } },
	}];
	const session = { id: "session-abc", events };
	const agent = { id: "agent-1", session };
	ctx.emit("agent/status", { agent, status: "running" });
	await sleep(50);
	ctx.emit("agent/status", { agent, status: "idle" });
	await sleep(500);
	assert.equal(probeCount, 2, "事件通道应收到 running+idle");
	assert.ok(sent.length >= 2, `收到 E2E 发送（当前 ${sent.length} 条）`);
	const completeMsg = sent[sent.length - 1].msg;
	assert.ok(completeMsg.item_list[0].text_item.text.includes("✅ 任务完成"), "完成通知内容正确");
	console.log("✓ 场景5 事件触发微信通知");

	// 清理
	server2.close();
	rmSync(testDir, { recursive: true, force: true });
	const envDir = process.env.FINAL_ENV_DIR;
	if (envDir) rmSync(envDir, { recursive: true, force: true });

	console.log("\n全部测试通过 ✅");
}

main().catch((error) => {
	console.error("测试失败:", error);
	process.exit(1);
});