require('dotenv').config();
const fetch = require('node-fetch');

module.exports = async function (message, args, commands) {
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
			message.channel.send(data.choices[0].message.content);
		})
		.catch(error => {
			console.error(error);
			message.channel.send('Error: Issue with ChatGPT');
		});
};
