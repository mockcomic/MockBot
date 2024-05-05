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
	if (process.env.BARD == null) {
		return message.channel.send('Error: GPT API key not set');
	}
	const requestBody = {
		contents: [
			{
				parts: [
					{
						text: args.toString(),
					},
				],
			},
		],
	};

	fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.BARD}`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(requestBody),
		}
	)
		.then(response => {
			if (!response.ok) {
				throw new Error(`HTTP error! Status: ${response.status}`);
			}
			return response.json();
		})
		.then(data => {
			const result = parseResponse(data.candidates[0].content.parts[0].text);
			result.forEach(msg => {
				message.channel.send(msg);
			});
		})
		.catch(error => {
			console.error(error);
			message.channel.send('Error: Issue with BARD');
		});
};
