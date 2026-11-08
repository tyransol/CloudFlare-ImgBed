#!/usr/bin/env node
/**
 * Discord 渠道连通性诊断
 *
 * 为什么需要它：上传失败时后端只把错误写进 console，前端只弹「上传失败」，
 * 拿不到 Discord 返回的真实原因。这个脚本在本地用与 Worker 完全相同的请求
 * 形状重放一遍，把 Discord 的原始响应打出来。
 *
 * 用法：
 *   DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=123 node scripts/diagnose-discord.mjs
 *   node scripts/diagnose-discord.mjs --token xxx --channel 123 [--file path]
 *
 * 判读：本地成功、线上失败 → 问题在 Worker 出口（Cloudflare 被 Discord 拦截，40333）；
 *      本地也失败 → 配置或权限问题，脚本会直接说差哪一项。
 */

const API = 'https://discord.com/api/v10';

// 与 functions/utils/storage/discordAPI.js 保持一致
const WORKER_UA = 'DiscordBot (CloudFlare-ImgBed, 1.0)';
// Telegram 渠道用的是浏览器 UA，这里作为对照
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0';

// 1x1 透明 PNG，用作上传测试的最小文件
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function parseArgs(argv) {
  const args = { token: process.env.DISCORD_BOT_TOKEN, channel: process.env.DISCORD_CHANNEL_ID, file: '' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--token') args.token = argv[++i];
    else if (key === '--channel') args.channel = argv[++i];
    else if (key === '--file') args.file = argv[++i];
  }
  return args;
}

function line(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function showResult(label, response, body) {
  const ok = response.ok;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: HTTP ${response.status} ${response.statusText}`);
  if (body && typeof body === 'object') {
    if (body.code !== undefined) console.log(`    Discord code: ${body.code}`);
    if (body.message) console.log(`    message: ${body.message}`);
    if (body.errors) console.log(`    errors: ${JSON.stringify(body.errors)}`);
  } else if (body) {
    console.log(`    body: ${String(body).slice(0, 300)}`);
  }
  return ok;
}

async function getMe(token) {
  line('1. Bot Token 是否有效');
  const response = await fetch(`${API}/users/@me`, {
    headers: { 'Authorization': `Bot ${token}`, 'User-Agent': WORKER_UA }
  });
  const body = await readBody(response);
  if (!showResult('GET /users/@me', response, body)) {
    if (response.status === 401) {
      console.log('\n  结论：Bot Token 无效或已被重置，去 Developer Portal 重新复制。');
    }
    return null;
  }
  console.log(`    bot: ${body.username}#${body.discriminator} (id ${body.id})`);
  return body;
}

async function getChannel(token, channelId) {
  line('2. 频道 ID 是否可用');
  const response = await fetch(`${API}/channels/${channelId}`, {
    headers: { 'Authorization': `Bot ${token}`, 'User-Agent': WORKER_UA }
  });
  const body = await readBody(response);
  const ok = showResult('GET /channels/:id', response, body);
  if (!ok) {
    if (response.status === 404) {
      console.log('\n  结论：频道 ID 不存在，或 Bot 不在该服务器里。');
      console.log('  频道 ID 是右键频道「复制频道 ID」得到的一串数字，不是频道名。');
    } else if (response.status === 403) {
      console.log('\n  结论：Bot 在这个服务器里，但没有该频道的「查看频道」权限。');
    }
    return null;
  }
  const typeName = {
    0: 'text', 2: 'voice', 4: 'category', 5: 'announcement',
    13: 'stage', 15: 'forum', 16: 'media'
  }[body.type] || `type ${body.type}`;
  console.log(`    #${body.name} (${typeName}), guild ${body.guild_id}`);
  if (body.type === 15) {
    console.log('    注意：论坛频道不能直接发消息，必须开一个 thread。');
  }
  return body;
}

// 与 discordAPI.sendFile 完全一致：只带 files[0]，不带 payload_json
async function postFile(token, channelId, userAgent, payload, name) {
  const formData = new FormData();
  formData.append('files[0]', new Blob([payload], { type: 'image/png' }), name);
  const response = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bot ${token}`, 'User-Agent': userAgent },
    body: formData
  });
  return { response, body: await readBody(response) };
}

async function deleteMessage(token, channelId, messageId) {
  const response = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bot ${token}`, 'User-Agent': WORKER_UA }
  });
  console.log(`    已删除测试消息：HTTP ${response.status}`);
}

async function uploadTest(token, channelId, filePath) {
  line('3. 实际发一条带附件的消息（与 Worker 同一请求形状）');
  let payload;
  let name = 'diagnose.png';
  if (filePath) {
    const { readFile } = await import('node:fs/promises');
    payload = await readFile(filePath);
    name = filePath.split(/[\\/]/).pop();
    console.log(`  使用文件：${name}（${(payload.length / 1024).toFixed(1)} KB）`);
  } else {
    payload = PNG_1X1;
    console.log('  使用内置 1x1 PNG（68 字节），只验证权限，不验证大小限制');
  }

  const first = await postFile(token, channelId, WORKER_UA, payload, name);
  const ok = showResult('POST (User-Agent = DiscordBot ...)', first.response, first.body);

  if (ok) {
    const attachment = first.body.attachments?.[0];
    console.log(`    message id: ${first.body.id}`);
    console.log(`    attachment: ${attachment?.filename} ${attachment?.size} bytes`);
    await deleteMessage(token, channelId, first.body.id);
    return { ok: true, ua: 'bot' };
  }

  // UA 对照：换成浏览器 UA 能过，就说明是 UA / 风控问题
  line('3b. 用浏览器 UA 再试一次（Telegram 渠道就是这么发的）');
  const second = await postFile(token, channelId, BROWSER_UA, payload, name);
  const okSecond = showResult('POST (User-Agent = Mozilla/5.0 ...)', second.response, second.body);
  if (okSecond) {
    await deleteMessage(token, channelId, second.body.id);
    console.log('\n  结论：DiscordBot UA 被拦、浏览器 UA 能过 → 换 UA 即可解决。');
    return { ok: true, ua: 'browser' };
  }
  return { ok: false, status: first.response.status, code: first.body?.code };
}

function verdict({ me, channelInfo, upload, token, channelId }) {
  line('结论');
  if (!token || !channelId) {
    console.log('  缺少 Bot Token 或频道 ID，先补齐再跑。');
    return;
  }
  if (!me) {
    console.log('  Bot Token 无效 → 到 https://discord.com/developers/applications 重新复制。');
    return;
  }
  if (!channelInfo) {
    console.log('  频道不可用 → 确认频道 ID（右键频道「复制频道 ID」），');
    console.log('  并把 Bot 邀请进该服务器：OAuth2 URL Generator 勾 bot + Send Messages + Attach Files。');
    return;
  }
  if (upload.ok) {
    console.log('  本地发送成功。如果线上 Worker 仍然失败，那就是出口被拦：');
    console.log('  Discord 对 Cloudflare Workers 网段会返回 403 / 40333 CloudflareIsBlockingYourRequest，');
    console.log('  这种情况只能换渠道，或把上传请求转给非 Cloudflare 的中转。');
    return;
  }
  const code = upload.code;
  const hints = {
    50001: 'Missing Access：Bot 没有该频道的「查看频道」权限，或不在服务器里。',
    50013: 'Missing Permissions：Bot 缺少「发送消息」或「附加文件」权限。',
    10003: 'Unknown Channel：频道 ID 不对。',
    50035: 'Invalid Form Body：频道类型不对（论坛/公告频道要先建 thread）。',
    40005: 'Request entity too large：超过当前频道的大小上限（免费 10MB，Nitro 25MB）。',
    40333: 'CloudflareIsBlockingYourRequest：请求被 Discord 前置的 Cloudflare 拦截。'
  };
  console.log(`  Discord 返回 ${upload.status}${code ? ` / code ${code}` : ''}`);
  console.log(`  ${hints[code] || '未收录的错误码，把上面 body 原文发我。'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Discord 渠道诊断');
  console.log(`  API: ${API}`);
  console.log(`  channel: ${args.channel || '(未提供)'}`);
  if (!args.token || !args.channel) {
    console.log('\n用法：node scripts/diagnose-discord.mjs --token <BOT_TOKEN> --channel <CHANNEL_ID>');
    console.log('或设置环境变量 DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID。');
    process.exit(1);
  }

  let me = null;
  let channel = null;
  let upload = { ok: false };
  try {
    me = await getMe(args.token);
    if (me) {
      channel = await getChannel(args.token, args.channel);
    }
    if (me && channel) {
      upload = await uploadTest(args.token, args.channel, args.file);
    }
  } catch (error) {
    console.log(`\n  请求本身失败了：${error.message}`);
    console.log('  如果这是 fetch failed / ENOTFOUND，先确认本机能访问 discord.com。');
    verdict({ me, channelInfo: channel, upload: { ok: false }, token: args.token, channelId: args.channel });
    process.exit(1);
  }
  verdict({ me, channelInfo: channel, upload, token: args.token, channelId: args.channel });
}

main();
