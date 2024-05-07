require('dotenv').config();
const fetch = require('node-fetch');
const Discord = require('discord.js');

const parseResponse = message => {
	const messageArr = [];
	while (message.length > 2000) {
		messageArr.push(message.slice(0, 2000));
		message = message.slice(2000, message.length);
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
			prompt: `${args.join(' ')}, limit the response to 2000 characters.`,
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
