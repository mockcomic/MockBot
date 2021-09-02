module.exports = async function (message, tokens, command) {
    const bot = require('../bot')
    try {
        bot.distube.setVolume(message, tokens[0]);
        message.channel.send(`Volume set to ${tokens[0]}`)
    } catch {
        message.reply("Not playing music!")

    }

}