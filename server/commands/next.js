module.exports = async function (message, tokens, command) {
    const bot = require('../bot')
    try {
        bot.distube.skip(message);
    } catch {
        message.reply("Not playing music!")
    }
}