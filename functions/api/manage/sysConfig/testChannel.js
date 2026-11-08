import { getDatabase } from '../../../utils/databaseAdapter.js';
import { getUploadConfig } from './upload.js';
import { diagnoseDiscord } from '../../../utils/storage/discordDiagnose.js';

/**
 * 渠道连通性自检（目前支持 Discord）
 *
 * 为什么放在后端：Discord 上传失败时，真正的原因（HTTP 状态 + Discord code）
 * 只写在 Worker 日志里，前端拿不到，用户只能看到「上传失败」。这个接口在
 * Worker 内部把同样的请求重放一遍，把原始响应直接吐出来。
 *
 * 用法：登录管理面板后，在浏览器直接打开
 *   /api/manage/sysConfig/testChannel?type=discord&name=渠道名称
 * name 省略时用该类型的第一个渠道。
 */

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload, null, 2), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || 'discord').toLowerCase();
    const name = url.searchParams.get('name') || '';

    const db = getDatabase(env);
    const settings = await getUploadConfig(db, env);
    const group = settings[type];

    if (!group || !Array.isArray(group.channels) || group.channels.length === 0) {
        return jsonResponse({
            ok: false,
            verdict: `没有配置任何 ${type} 渠道`,
            available: Object.keys(settings).filter(key => settings[key] && settings[key].channels),
        }, 400);
    }

    const channel = name ? group.channels.find(c => c.name === name) : group.channels[0];
    if (!channel) {
        return jsonResponse({
            ok: false,
            verdict: `找不到名为「${name}」的 ${type} 渠道`,
            channels: group.channels.map(c => c.name),
        }, 404);
    }

    // 只回显够定位问题的字段，绝不把 botToken 原样吐给前端
    const channelInfo = {
        name: channel.name,
        type: channel.type,
        channelId: channel.channelId,
        savePath: channel.savePath,
        enabled: channel.enabled,
        isNitro: channel.isNitro,
        hasBotToken: !!channel.botToken,
        botTokenLength: channel.botToken ? channel.botToken.length : 0,
        botTokenHasWhitespace: channel.botToken ? /\s/.test(channel.botToken) : false,
    };

    if (type !== 'discord') {
        return jsonResponse({ ok: false, channel: channelInfo, verdict: `暂不支持 ${type} 渠道自检` }, 400);
    }

    try {
        const result = await diagnoseDiscord(channel);
        return jsonResponse({ ok: result.steps.every(s => s.ok || s.step === 'cleanup'), channel: channelInfo, ...result });
    } catch (error) {
        return jsonResponse({
            ok: false,
            channel: channelInfo,
            verdict: `请求本身失败：${error.message}`,
            hint: '如果这里是 fetch failed，说明 Worker 根本连不上 discord.com',
        }, 500);
    }
}
