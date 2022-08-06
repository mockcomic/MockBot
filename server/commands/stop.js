module.exports = async function (message, tokens, command) {
    const cc = require('../bot');
    try {
        cc.distube.stop(message);
        message.channel.send("Stopped the music!");
    } catch {
        message.reply("Not playing music!")
    }
}