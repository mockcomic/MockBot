//work in progress

module.exports = async function (message, tokens, command) {
    let fs = require("fs")
    const content = `${message.author.username} ${tokens}\n`

    fs.appendFile('./feedback.txt', content, err => {
        if (err) {
            message.channel.send(err)
            return
        }
    })
}