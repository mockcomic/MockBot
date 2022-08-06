module.exports = async function (message, tokens, command) {
    const bot = require('../bot')

    try {
        bot.distube.jump(message, parseInt(tokens))
    } catch (err) {
        message.channel.send("Invalid song number.");
    }
}