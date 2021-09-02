module.exports = async function (message, arg, command) {
    const bot = require('../bot')
    

    console.log(`playing ${arg.join(" ")} requested by ${message.author}`)
    bot.distube.play(message, arg.join(" "));

    if ([`3d`, `bassboost`, `echo`, `karaoke`, `nightcore`, `vaporwave`].includes(command)) {
        let filter = bot.distube.setFilter(message, command);
        message.channel.send("Current queue filter: " + (filter || "Off"));
    }

    if (["repeat", "loop"].includes(command))
        bot.distube.setRepeatMode(message, parseInt(arg[0]));

}