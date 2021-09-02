const bot = require('../bot')

function sendEmbed(description) {
    bot.embed
        .setColor('#0099ff')
        .setDescription(`${description}`)
}

function sendEmbedTitle(title, description) {
    bot.embed
        .setColor('#0099ff')
        .setTitle(`${title}`)
        .setDescription(`${description}`)

}
module.exports = {
    sendEmbed,
    sendEmbedTitle

}