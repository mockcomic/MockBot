module.exports = async function (message, args, command) {
    const fs = require('fs')
    const cc = require('../bot')
    const json = require('../package.json')
    
    const Files = fs.readdirSync('./commands').filter(f => f.split(".").pop() === "js")
    const fixedFiles = []
    Files.forEach(file => {
        if(file.startsWith('Admin_') || file.startsWith('Owner_')) return;
        fix = file.slice(0, -3)
        fixedFiles.push(fix)
    })
    message.channel.send(cc.embedTitle
        .setTitle(`Prefix ${cc.config.prefix} \nBot version ${json.version}\nList of loaded commands.`)
        .setDescription(fixedFiles))
    console.log(Files)
} 