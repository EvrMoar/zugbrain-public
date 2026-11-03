// A Discord guild/channel event proves where a message was posted. This policy
// does not enumerate guild members, infer role membership or grant admin powers.
export const inChannel = (discord, message) => message.guildId === discord.guildId && discord.channelIds.includes(message.channelId);
export function humanAllowed(discord, message, botId) {
  return inChannel(discord, message) && typeof message.authorId === 'string' && /^\d{1,20}$/.test(message.authorId) &&
    message.authorId !== botId && message.bot === false && !message.webhook &&
    (discord.userPolicy === 'channel-members' || (discord.userPolicy === undefined || discord.userPolicy === 'allowlist') && discord.userIds.includes(message.authorId));
}
