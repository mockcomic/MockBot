//work in progress
module.exports = async function (message, tokens, command) {
    const fs = require('fs')
    require("dotenv").config();

    if (message.author.id !== process.env.OWNER) {

        fs.readFile('./sample.txt', (err, data) => {
            if (err) {
                console.error(err)
                return
            }
            message.channel.send(data)
        })
    }else{
        message.channel.send("⛔Access Denied⛔");
    }
}