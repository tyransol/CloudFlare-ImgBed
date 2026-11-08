/**
 * Discord 渠道连通性自检
 *
 * 为什么单独一个文件：上传失败时真正的原因（HTTP 状态 + Discord code）
 * 只写在 Worker 日志里，前端拿不到。这里在 Worker 内部把同样的请求重放
 * 一遍，把原始响应交回给管理接口。
 *
 * 不依赖任何存储层，方便单测。
 */

const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (CloudFlare-ImgBed, 1.0)';

// 1x1 透明 PNG，只验证权限，不验证大小限制
const PNG_1X1 = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
    c => c.charCodeAt(0)
);

async function readBody(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function step(name, response, body) {
    return {
        step: name,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        code: body && typeof body === 'object' ? body.code : undefined,
        message: body && typeof body === 'object' ? body.message : String(body || '').slice(0, 300),
    };
}

const CODE_HINTS = {
    50001: 'Missing Access：Bot 没有该频道的查看权限，或不在服务器里',
    50013: 'Missing Permissions：Bot 缺少「发送消息」或「附加文件」权限',
    10003: 'Unknown Channel：这个 ID 不是频道（填成服务器 ID 也会落到这里）',
    50035: 'Invalid Form Body：频道类型不对（论坛/公告频道要先建 thread）',
    40005: 'Request entity too large：超过频道大小上限',
    40333: 'CloudflareIsBlockingYourRequest：请求被 Discord 前置的 Cloudflare 拦了，Worker 出口绕不过去',
};

function verdictOf(steps) {
    const me = steps.find(s => s.step === 'botToken');
    const ch = steps.find(s => s.step === 'channel');
    const guild = steps.find(s => s.step === 'guildProbe');
    const send = steps.find(s => s.step === 'sendFile');

    if (!me || !me.ok) return 'Bot Token 无效，去 Developer Portal 重新复制';
    // 404 之后探测一下：这个 ID 是服务器（guild）而不是频道，是填错字段最常见的原因
    if (guild && guild.ok) {
        return `填的是服务器 ID（${guild.guildName || '未命名服务器'}），不是频道 ID。右键某个频道 → 复制频道 ID`;
    }
    if (!ch || !ch.ok) {
        if (ch && ch.status === 404) return '频道 ID 不存在，或 Bot 不在该服务器里';
        if (ch && ch.status === 403) return 'Bot 看不到这个频道（缺少查看频道权限）';
        return '频道读取失败，看 channel 这一步的 message';
    }
    if (send && send.ok) {
        return 'Discord 侧完全正常。如果上传仍然失败，问题在别处（大小限制 / 分块 / 自动换渠道）';
    }
    if (send && send.code && CODE_HINTS[send.code]) return CODE_HINTS[send.code];
    return `发送失败：HTTP ${send ? send.status : '?'}，看 sendFile 这一步的 message`;
}

export async function diagnoseDiscord(channel) {
    const steps = [];
    const headers = { 'Authorization': `Bot ${channel.botToken}`, 'User-Agent': UA };

    const meResponse = await fetch(`${API}/users/@me`, { headers });
    steps.push(step('botToken', meResponse, await readBody(meResponse)));

    if (meResponse.ok) {
        const chResponse = await fetch(`${API}/channels/${channel.channelId}`, { headers });
        const chBody = await readBody(chResponse);
        const chStep = step('channel', chResponse, chBody);
        if (chResponse.ok && chBody && typeof chBody === 'object') {
            chStep.channelName = chBody.name;
            chStep.channelType = chBody.type;
            chStep.guildId = chBody.guild_id;
        }
        steps.push(chStep);

        // 404 时多问一句：这个 ID 会不会其实是服务器 ID？两种填错长得一模一样，
        // 但服务器 ID 在 GET /guilds/{id} 上是能读到的，一次就能分辨。
        if (!chResponse.ok && chResponse.status === 404) {
            const guildResponse = await fetch(`${API}/guilds/${channel.channelId}`, { headers });
            if (guildResponse.ok) {
                const guildBody = await readBody(guildResponse);
                const guildStep = step('guildProbe', guildResponse, guildBody);
                guildStep.guildName = guildBody && typeof guildBody === 'object' ? guildBody.name : undefined;
                steps.push(guildStep);
            }
        }

        if (chResponse.ok) {
            const formData = new FormData();
            formData.append('files[0]', new Blob([PNG_1X1], { type: 'image/png' }), 'imgbed-selftest.png');
            const sendResponse = await fetch(`${API}/channels/${channel.channelId}/messages`, {
                method: 'POST',
                headers,
                body: formData,
            });
            const sendBody = await readBody(sendResponse);
            steps.push(step('sendFile', sendResponse, sendBody));

            if (sendResponse.ok && sendBody && sendBody.id) {
                const delResponse = await fetch(`${API}/channels/${channel.channelId}/messages/${sendBody.id}`, {
                    method: 'DELETE',
                    headers,
                });
                steps.push({
                    step: 'cleanup',
                    ok: delResponse.ok,
                    status: delResponse.status,
                    message: delResponse.ok ? '测试消息已删除' : '测试消息删除失败，可手动删',
                });
            }
        }
    }

    return { steps, verdict: verdictOf(steps) };
}
