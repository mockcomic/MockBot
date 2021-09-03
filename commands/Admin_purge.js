//work in progress
module.exports = async function (message, arg, command) {
    require("dotenv").config();
    if (message.author.id == process.env.OWNER) {
        let number = parseInt(arg) + 1;
        try {
            if (isNaN(number)) {
                message.reply("That's not a number");
            } else if (number >100){
                message.reply("Value larger than 100");
            }else {
                message.channel.bulkDelete(number);
            };
        } catch (error) {
            console.log(error);
            message.channel.send(`Uh oh, error \n ${error}`);
        };
    }
}