require('dotenv').config();
const Discord = require('discord.js');
const DisTube = require('distube');
const commandHandler = require('./commands_Handler');
const config = require('./config.json');
const fs = require('fs');
const musicBot = require('./Event_listeners/musicBot');
const embed = new Discord.MessageEmbed();
const embedTitle = new Discord.MessageEmbed();
const client = new Discord.Client({
	partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});
const distube = new DisTube(client, {
	searchSongs: false,
	emitNewSongOnly: true,
	leaveOnEmpty: true,
});

const initialize = () => {
	const eventFiles = fs
		.readdirSync('./Event_listeners')
		.filter(f => f.split('.').pop() === 'js');
	const gameFiles = fs
		.readdirSync('./Games')
		.filter(f => f.split('.').pop() === 'js');
	console.log(eventFiles);
	console.log(gameFiles);
};

musicBot(distube);

client.on('ready', () => {
	console.log('I am ready!');
});

client.on('message', async message => {
	const prefix = config.prefix;
	if (!message.content.startsWith(prefix)) return;
	commandHandler(message);
});

// function sendMessage(description) {
// 	embed.setColor('#0099ff').description(description);
// 	message.channel.send(embed);
// }

// function sendMessageTitle(title) {
// 	embed.setColor('#0099ff').setTitle(title);
// 	message.channel.send(embed);
// }

module.exports = {
	distube,
	config,
	Discord,
	embed,
	embedTitle,
	client,
};

client.login(process.env.TOKEN);
initialize();
