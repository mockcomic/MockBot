//work in progress
module.exports = async function (message, arg, command) {
    require("dotenv").config();
    if (message.author.id == process.env.OWNER) {

        let number = parseInt(arg) + 1;
        try {
            if (isNaN(number)) {
                message.reply("That's not a number")
            } else {
                message.channel
                    .fetchMessages({
                        limit: number
                    })
                    .then(messages => {
                        message.channel.bulkDelete(messages);
                        message.channel
                            .send
                    }).then(message => message.delete(5000));
            }

        } catch (error) {
            console.log(error);
            message.channel.send(`Uh oh, error \n ${error}`);
        }
    }
}