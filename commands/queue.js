module.exports = async function (message, tokens, command) {
    const bot = require('../bot')
    try {
        let queue = bot.distube.getQueue(message);
        message.channel.send('Current queue:\n' + queue.songs.map((song, id) =>
            `**${id + 1}**. ${song.name} - \`${song.formattedDuration}\``
        ).slice(0, 10).join("\n"));

    } catch {
        message.reply("Not playing music!")
    }
}