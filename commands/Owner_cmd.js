
module.exports = async function (message, arg, commands) {    
    require("dotenv").config();
    if (message.author.id == process.env.OWNER) {
        const {exec} = require("child_process");

        exec(`${arg.join(" ")}`, (error, stdout, stderr) => {
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
    };
}