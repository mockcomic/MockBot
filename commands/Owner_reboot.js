module.exports = async function (message, args, commands) {
    const cc = require('../bot');
    require("dotenv").config();
    
    if (message.author.id == process.env.OWNER) {
        const {
            exec
        } = require("child_process");
        message.channel.send(cc.embed.setDescription('Goodbye :,('))

        exec('shutdown /r', (error, stdout, stderr) => {
            if (error) {
                message.channel.send(`error: ${error.message}`);
                return;
            }
            if (stderr) {
                message.channel.send(`stderr: ${stderr}`);
                return;
            }
            message.channel.send(`stdout: ${stdout}`);
        });
    } else {
        message.channel.send("⛔Access Denied⛔");
    }
}
