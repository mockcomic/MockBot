module.exports = async function (message, args, commands) {
    require("dotenv").config();

    const {
        exec
    } = require("child_process");

    function consoleInput(write) {
        exec(`${`${write}`.join(" ")}`, (error, stdout, stderr) => {
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
    }

    if (message.author.id == process.env.OWNER) {
        consoleInput('git stash');
        consoleInput('git stash drop');
        consoleInput('git pull');
        consoleInput('mockcomic');
        consoleInput('Acdf#1221991');
        consoleInput('npm install');
        consoleInput('sudo reboot');
    } else {
        message.channel.send("⛔Access Denied⛔");
    }
}