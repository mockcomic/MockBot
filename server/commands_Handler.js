const fs = require('fs');
const commands = {};

fs.readdir("./commands/", (err, files) => {
  if (err) return console.log("Could not find any commands!");

  const jsFiles = files.filter(f => f.split(".").pop() === "js");

  if (jsFiles.length <= 0) return console.log("Could not find any commands!");

  jsFiles.forEach(file => {
    if (file.startsWith("Admin_") || file.startsWith("Owner_")) {
      let nameFile = file;

      nameFile = require(`./commands/${file}`);

      console.log(`Loaded ${file}`);

      commands[file.slice(6, -3)] = nameFile;

    } else {
      let nameFile = file;

      nameFile = require(`./commands/${file}`);

      console.log(`Loaded ${file}`);

      commands[file.slice(0, -3)] = nameFile;

    }
  });
});

module.exports = async function (message) {
  if (message.author.bot) return;

  let args = message.content.split(" ");

  let command = args.shift();

  command = command.substring(1);

  try {
    commands[command](message, args, command, commands);

  } catch (err) {
    message.reply(`[commands_Handler] ${message} is not a command`);

  };
};

module.export = {
  commands

};