require('dotenv').config();
const fetch = require('node-fetch');

const parseResponse = message => {
	const messageArr = [];
	while (message.length > 199) {
		messageArr.push(message.slice(0, 199));
		message = message.slice(199, message.length);
	}
	messageArr.push(message);
	return messageArr;
};

module.exports = async function (message, args, commands) {
	if (process.env.GPT == null) {
		return message.channel.send('Error: GPT API key not set');
	}
	fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Bearer ' + process.env.GPT,
		},
		body: JSON.stringify({
			model: 'gpt-3.5-turbo',
			messages: [{ role: 'user', content: `${args}` }],
		}),
	})
		.then(response => response.json())
		.then(data => {
			console.log(args + ':' + data.choices[0].message.content);

			const result = parseResponse(data.choices[0].message.content);

			result.forEach(msg => {
				message.channel.send(msg);
			});
		})
		.catch(error => {
			console.error(error);
			message.channel.send('Error: Issue with ChatGPT');
		});
};
