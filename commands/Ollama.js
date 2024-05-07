require('dotenv').config();
const fetch = require('node-fetch');
const Discord = require('discord.js');

const parseResponse = message => {
	const messageArr = [];
	while (message.length > 199) {
		messageArr.push(message.slice(0, 1999));
		message = message.slice(199, message.length);
	}
	messageArr.push(message);
	return messageArr;
};

module.exports = async function (message, args, commands) {
	message.channel.send('Fetching Data...');

	const response = await fetch(process.env.OLLAMAAPI, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			role: 'user',
			model: 'dolphin-mixtral',
			prompt: args.join(' '),
			stream: false,
		}),
	});

	if (response.ok) {
		const data = await response.json();
		const result = parseResponse(data.response);

		message.reply('');
		result.forEach(msg => {
			message.channel.send(msg);
		});
	} else {
		console.error(response.status);
		message.channel.send('Error: Issue with Ollama API');
	}
};
