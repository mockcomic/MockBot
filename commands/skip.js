module.exports = async function (message, tokens, command) {
    const cc = require('../bot');
    try {
        cc.distube.skip(message);
    } catch {
        message.reply("Not playing music!")
    }
}