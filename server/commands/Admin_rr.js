
module.exports = async function (message, tokens, command, client) {
    require("dotenv").config();
    const cc = require('../bot');
    const Discord = require('discord.js');
    const channel = "845386774327197726";
    const config = require('../config.json');

    if (message.author.id == process.env.OWNER) {
        const HOTSRole = message.guild.roles.cache.find(role => role.name === "HOTS");
        const LOLRole = message.guild.roles.cache.find(role => role.name === "LOL");
        const HuntRole = message.guild.roles.cache.find(role => role.name === "Hunt");
        const OverwatchRole = message.guild.roles.cache.find(role => role.name === "Overwatch");
        const StarCraft2Role = message.guild.roles.cache.find(role => role.name === "StarCraft2");
        const NorthgardRole = message.guild.roles.cache.find(role => role.name === "Northgard");
        const RocketLeagueRole = message.guild.roles.cache.find(role => role.name === "Rocket League");
        const TarkovRole = message.guild.roles.cache.find(role => role.name === "Tarkov");
        const RemmantRole = message.guild.roles.cache.find(role => role.name === "Remnant");

        const MemberEmoji = '';
        const HOTSEmoji = `${config.emoji.one}`;
        const LOLEmoji = `${config.emoji.two}`;
        const HuntEmoji = `${config.emoji.three}`;
        const OverwatchEmoji = `${config.emoji.four}`;
        const StarCraft2Emoji = `${config.emoji.five}`;
        const NorthgardEmoji = `${config.emoji.six}`;
        const RocketLeagueEmoji = `${config.emoji.seven}`;
        const TarkovEmoji = `${config.emoji.eight}`;
        const RemmantEmoji = `${config.emoji.nine}`;

        const embed = new Discord.MessageEmbed()
            .setColor('#0099ff')
            .setTitle(`After reading the #rules click ${MemberEmoji}`)
            .setDescription(`
         ${HOTSEmoji} Heroes of the Storm\n
         ${LOLEmoji} League of Legends\n
         ${HuntEmoji} Hunt Showdown\n
         ${OverwatchEmoji} Overwatch\n
         ${StarCraft2Emoji} StarCraft 2\n
         ${NorthgardEmoji} Northgard\n
         ${RocketLeagueEmoji} Rocket League\n
         ${TarkovEmoji} Escape from Tarkov\n
         ${RemmantEmoji} Remmant\n`);


        let messageEmbed = await message.channel.send(embed);

        messageEmbed.react(HOTSEmoji);
        messageEmbed.react(LOLEmoji);
        messageEmbed.react(HuntEmoji);
        messageEmbed.react(OverwatchEmoji);
        messageEmbed.react(StarCraft2Emoji);
        messageEmbed.react(NorthgardEmoji);
        messageEmbed.react(RocketLeagueEmoji);
        messageEmbed.react(TarkovEmoji);
        messageEmbed.react(RemmantEmoji);


        cc.client.on('messageReactionAdd', async (reaction, user) => {
            if (reaction.message.partial) await reaction.message.fetch();
            if (reaction.partial) await reaction.fetch();
            if (user.bot) return;
            if (!reaction.message.guild) return;

            if (reaction.message.channel.id == channel) {
                if (reaction.emoji.name === HOTSEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(HOTSRole);
                };
                if (reaction.emoji.name === LOLEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(LOLRole);
                };
                if (reaction.emoji.name === HuntEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(HuntRole);
                };
                if (reaction.emoji.name === OverwatchEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(OverwatchRole);
                };
                if (reaction.emoji.name === StarCraft2Emoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(StarCraft2Role);
                };
                if (reaction.emoji.name === NorthgardEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(NorthgardRole);
                };
                if (reaction.emoji.name === RocketLeagueEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(RocketLeagueRole);
                };
                if (reaction.emoji.name === TarkovEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(TarkovRole);
                };
                if (reaction.emoji.name === RemmantEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.add(RemmantRole);
                };
            } else {
                return;
            };
        });

        cc.client.on('messageReactionRemove', async (reaction, user) => {
            if (reaction.message.partial) await reaction.message.fetch();
            if (reaction.partial) await reaction.fetch();
            if (user.bot) return;
            if (!reaction.message.guild) return;

            if (reaction.message.channel.id == channel) {
                if (reaction.emoji.name === MemberEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(MemberRole);
                };
                if (reaction.emoji.name === HOTSEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(HOTSRole);
                };
                if (reaction.emoji.name === LOLEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(LOLRole);
                };
                if (reaction.emoji.name === HuntEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(HuntRole);
                };
                if (reaction.emoji.name === OverwatchEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(OverwatchRole);
                };
                if (reaction.emoji.name === StarCraft2Emoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(StarCraft2Role);
                };
                if (reaction.emoji.name === NorthgardEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(NorthgardRole);
                };
                if (reaction.emoji.name === RocketLeagueEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(RocketLeagueRole);
                };
                if (reaction.emoji.name === TarkovEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(TarkovRole);
                };
                if (reaction.emoji.name === RemmantEmoji) {
                    await reaction.message.guild.members.cache.get(user.id).roles.remove(RemmantRole);
                };
            } else {
                return;
            };
        });
    };
};